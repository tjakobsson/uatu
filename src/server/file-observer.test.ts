import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rename, rm, symlink, utimes, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Stats } from "node:fs";
import { observeFiles, type FileObserver } from "./file-observer";
import { createWatchPolicy } from "./watch-policy";
import { loadIgnoreMatcher } from "../ignore/engine";
import { createWatchSession } from "./watch-session";
import type { WatchEntry } from "./roots";

const directories: string[] = [];
const observers: FileObserver[] = [];
afterEach(async () => {
  await Promise.all(observers.splice(0).map(observer => observer.close()));
  await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "uatu-observation-"));
  directories.push(root);
  return root;
}
async function until(predicate: () => boolean, description: string) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${description}`);
    await Bun.sleep(10);
  }
}
async function observed(entry: WatchEntry, polling = false, onWork?: (kind: "watch" | "stat" | "directory") => void, renew = false) {
  const matcher = await loadIgnoreMatcher({ rootPath: entry.kind === "dir" ? entry.absolutePath : entry.parentDir,
    respectGitignore: true, isSingleFileRoot: entry.kind === "file" });
  const policy = createWatchPolicy(entry, matcher);
  const observer = observeFiles(entry, { ignored: policy.ignored, usePolling: polling, onWork, renew });
  observers.push(observer);
  const events: { event: string; file: string; stats?: Stats }[] = [];
  observer.on("all", (event, file, stats) => events.push({ event, file, stats }));
  await new Promise<void>((resolve, reject) => { observer.once("ready", resolve); observer.once("error", reject); });
  return { observer, events, policy };
}

test("native discovery prunes denied directories and supplies file stats", async () => {
  const root = await fixture();
  for (const name of ["generated", "node_modules", "docs"]) await mkdir(path.join(root, name));
  await writeFile(path.join(root, ".gitignore"), "generated/\n");
  await Promise.all(["generated/skip.md", "node_modules/skip.md", "docs/keep.md", ".env"].map(file => writeFile(path.join(root, file), "# File\n")));
  await symlink(path.join(root, "docs"), path.join(root, "linked"));
  const work: string[] = [];
  const { events, policy } = await observed({ kind: "dir", absolutePath: root }, false, kind => work.push(kind));
  const files = events.filter(event => event.event === "add");
  expect(files.map(event => path.relative(root, event.file)).sort()).toEqual([".gitignore", "docs/keep.md"]);
  expect(files.every(event => event.stats?.isFile())).toBe(true);
  expect(work.filter(kind => kind === "watch")).toHaveLength(1);
  expect(work.filter(kind => kind === "directory")).toHaveLength(2);
  expect(policy.hidden.size).toBe(1);
});

test("closing native observation before discovery suppresses queued work", async () => {
  const root = await fixture();
  const matcher = await loadIgnoreMatcher({ rootPath: root, respectGitignore: true });
  const entry = { kind: "dir" as const, absolutePath: root };
  const work: string[] = [];
  const observer = observeFiles(entry, { ignored: createWatchPolicy(entry, matcher).ignored, onWork: kind => work.push(kind) });
  const events: string[] = [];
  observer.on("all", event => events.push(event));
  observer.on("ready", () => events.push("ready"));
  await observer.close();
  await Promise.resolve();
  expect(events).toEqual([]);
  expect(work).toEqual(["watch"]);
});

test("overlapping roots share observation and closing one does not stop the other", async () => {
  const root = await fixture();
  const inner = path.join(root, "docs");
  await mkdir(inner);
  const file = path.join(inner, "a.md");
  await writeFile(file, "# Before\n");
  let handles = 0;
  const count = (kind: string) => { if (kind === "watch") handles++; };
  const outer = await observed({ kind: "dir", absolutePath: root }, false, count);
  const nested = await observed({ kind: "dir", absolutePath: inner }, false, count);
  expect(handles).toBe(1);
  await outer.observer.close();
  await writeFile(file, "# After\n");
  await until(() => nested.events.some(event => event.event === "change" && event.file === file), "nested change after outer close");
});

test("renewal replaces native coverage and an obsolete close cannot release its successor", async () => {
  const root = await fixture();
  const file = path.join(root, "a.md");
  await writeFile(file, "# A\n");
  let handles = 0;
  const count = (kind: string) => { if (kind === "watch") handles++; };
  const old = await observed({ kind: "dir", absolutePath: root }, false, count);
  const current = await observed({ kind: "dir", absolutePath: root }, false, count, true);
  await old.observer.close();
  const shared = await observed({ kind: "dir", absolutePath: root }, false, count);
  expect(handles).toBe(2);
  await writeFile(file, "# New bytes\n");
  await until(() => current.events.some(event => event.event === "change") && shared.events.some(event => event.event === "change"), "replacement observation");
});

for (const polling of [false, true]) {
  test(`${polling ? "polling fallback" : "native"} observes atomic saves, creation, directory removal, and equal-mtime edits`, async () => {
    const root = await fixture();
    const file = path.join(root, "a.md");
    await writeFile(file, "# Before\n");
    const { events } = await observed({ kind: "dir", absolutePath: root }, polling);
    events.length = 0;
    await writeFile(path.join(root, "save.tmp"), "# Atomic replacement\n");
    await rename(path.join(root, "save.tmp"), file);
    await until(() => events.some(event => event.event === "change" && event.file === file), "atomic replacement");
    expect(events.some(event => event.event === "unlink" && event.file === file)).toBe(false);
    const before = await stat(file);
    events.length = 0;
    await writeFile(file, "# Different bytes at the same modification time\n");
    await utimes(file, before.atime, before.mtime);
    await until(() => events.some(event => event.event === "change" && event.file === file), "equal-mtime edit");
    const folder = path.join(root, "new");
    await mkdir(folder);
    const child = path.join(folder, "b.md");
    await writeFile(child, "# New\n");
    await until(() => events.some(event => event.event === "add" && event.file === child), "new nested file");
    await rm(folder, { recursive: true });
    await until(() => events.some(event => event.event === "unlinkDir" && event.file === folder), "removed directory");
    await until(() => events.some(event => event.event === "unlink" && event.file === child), "removed child");
  }, 15000);

  test(`${polling ? "polling fallback" : "native"} single-file roots survive deletion and recreation`, async () => {
    const root = await fixture();
    const file = path.join(root, "a.md");
    await writeFile(file, "# A\n");
    const { events } = await observed({ kind: "file", absolutePath: file, parentDir: root }, polling);
    await rm(file);
    await until(() => events.some(event => event.event === "unlink"), "single file removed");
    events.length = 0;
    await writeFile(file, "# Returned\n");
    await until(() => events.some(event => event.event === "add" && event.file === file), "single file returns");
  }, 15000);
}

test("native ignore-policy recovery discovers newly allowed paths and watches future edits", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "generated"));
  const file = path.join(root, "generated", "a.md");
  const config = path.join(root, ".uatu.json");
  await writeFile(file, "# A\n");
  await writeFile(config, JSON.stringify({ ignore: { exclude: ["generated/", ".uatu.json"] } }));
  const session = createWatchSession([{ kind: "dir", absolutePath: root }], false, { collectRepositories: async () => [] });
  try {
    await session.start();
    expect(session.findDocument(file)).toBeUndefined();
    await writeFile(config, JSON.stringify({ ignore: { exclude: [".uatu.json"] } }));
    await until(() => Boolean(session.findDocument(file)), "unignored subtree discovered");
    const revision = session.findDocument(file)!.revision;
    await writeFile(file, "# New content\n");
    await until(() => session.findDocument(file)!.revision > revision, "future edit in unignored subtree");
    await writeFile(config, JSON.stringify({ ignore: { exclude: ["generated/", ".uatu.json"] } }));
    await until(() => !session.findDocument(file), "new denial applies");
    expect(await session.ensureDocument(file)).toBeUndefined();
    expect(session.getDocumentRoots(file)).toEqual([]);
  } finally { await session.stop(); }
}, 15000);

for (const usePolling of [false, true]) {
  test(`${usePolling ? "polling fallback" : "native"} publishes progress while a writer is still running`, async () => {
    const root = await fixture();
    const file = path.join(root, "stream.md");
    await writeFile(file, "# Initial\n");
    const session = createWatchSession([{ kind: "dir", absolutePath: root }], true, { usePolling, collectRepositories: async () => [] });
    await session.start();
    const reader = session.eventsResponse().body!.getReader();
    let writes = 0;
    let pendingWrite = Promise.resolve();
    let timer: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await reader.read();
      timer = setInterval(() => { pendingWrite = pendingWrite.then(() => writeFile(file, `# Stream ${++writes}\n`)); }, 20);
      const changed = (async () => {
        for (;;) {
          const frame = await reader.read();
          if (frame.done) throw new Error("stream ended before file progress");
          const text = new TextDecoder().decode(frame.value);
          const data = text.split("data: ")[1];
          if (data && JSON.parse(data).changedId === file) return;
        }
      })();
      await Promise.race([changed, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("writer starved file publication")), 6000); })]);
      expect(writes).toBeGreaterThan(1);
      clearInterval(timer); timer = undefined;
      await pendingWrite;
      const previous = session.findDocument(file)!.revision;
      await writeFile(file, "# Final bytes\n");
      await until(() => session.findDocument(file)!.revision > previous, "final write observed");
    } finally {
      clearInterval(timer); clearTimeout(deadline);
      await pendingWrite;
      await reader.cancel(); await session.stop();
    }
  }, 15000);
}
