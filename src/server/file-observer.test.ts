import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rename, rm, symlink, utimes, stat, lstat, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import chokidar from "chokidar";
import type { Stats, FSWatcher, watch } from "node:fs";
import { observeFiles, PolledBaselineCheck, type FileObserver } from "./file-observer";
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
async function observed(entry: WatchEntry, polling = false, onWork?: (kind: "watch" | "stat" | "directory") => void, renew = false, nativeWatch?: typeof watch) {
  const matcher = await loadIgnoreMatcher({ rootPath: entry.kind === "dir" ? entry.absolutePath : entry.parentDir,
    respectGitignore: true, isSingleFileRoot: entry.kind === "file" });
  const policy = createWatchPolicy(entry, matcher);
  const observer = observeFiles(entry, { ignored: policy.ignored, usePolling: polling, onWork, renew, watch: nativeWatch });
  observers.push(observer);
  const events: { event: string; file: string; stats?: Stats }[] = [];
  observer.on("all", (event, file, stats) => events.push({ event, file, stats }));
  await new Promise<void>((resolve, reject) => { observer.once("ready", resolve); observer.once("error", reject); });
  return { observer, events, policy };
}

function controlledNativeWatch() {
  let receive!: (event: string, file: string | null) => void;
  const watchFiles = ((_root: string, _options: unknown, listener: typeof receive) => {
    receive = listener;
    const watcher = new EventEmitter() as FSWatcher;
    watcher.close = () => { watcher.emit("close"); };
    return watcher;
  }) as typeof watch;
  return { watch: watchFiles, notify: (event: string, file: string) => receive(event, file) };
}

for (const singleFile of [false, true]) {
  test(`native source-only rename refreshes a ${singleFile ? "single-file" : "directory"} root`, async () => {
    const root = await fixture();
    const file = path.join(root, "a.md");
    const temporary = path.join(root, "save.tmp");
    await writeFile(file, "# Before\n");
    await writeFile(path.join(root, ".gitignore"), "*.tmp\n");
    await mkdir(path.join(root, "unrelated"));
    await writeFile(path.join(root, "unrelated", "b.md"), "# Unrelated\n");
    const native = controlledNativeWatch();
    const work: string[] = [];
    const entry: WatchEntry = singleFile ? { kind: "file", absolutePath: file, parentDir: root } : { kind: "dir", absolutePath: root };
    const { observer, events } = await observed(entry, false, kind => work.push(kind), false, native.watch);
    const previous = await stat(file);
    events.length = 0; work.length = 0;
    await writeFile(temporary, "# Replacement\n");
    await rename(temporary, file);
    // Preserve mtime so the observer must check identity/ctime/size.
    await utimes(file, previous.atime, previous.mtime);
    let idle = false;
    observer.once("idle", () => { idle = true; });
    // Some native backends report only the ignored, now-missing source name.
    // A burst should coalesce into one parent reconciliation.
    for (let i = 0; i < 20; i++) native.notify("rename", "save.tmp");
    await until(() => idle, "source-only rename reconciliation");
    expect(events.filter(event => event.event === "change").map(event => event.file)).toEqual([file]);
    expect(events.some(event => event.event === "unlink" && event.file === file)).toBe(false);
    expect(work.filter(kind => kind === "directory")).toHaveLength(singleFile ? 0 : 1);
    if (singleFile) expect(work).toEqual(["stat"]);

    events.length = 0; work.length = 0;
    await writeFile(file, "# Ordinary edit\n");
    const changed = new Promise<void>(resolve => observer.once("idle", resolve));
    native.notify("change", "a.md");
    await changed;
    expect(events.filter(event => event.event === "change").map(event => event.file)).toEqual([file]);
    expect(work).toEqual(["stat"]);
  }, 10000);
}

test("native rename reconciliation removes a target replaced with a symlink", async () => {
  const root = await fixture();
  const outside = await fixture();
  const file = path.join(root, "a.md");
  const target = path.join(outside, "outside.md");
  await writeFile(file, "# Before\n");
  await writeFile(target, "# Outside\n");
  const native = controlledNativeWatch();
  const { observer, events } = await observed({ kind: "dir", absolutePath: root }, false, undefined, false, native.watch);
  events.length = 0;
  await symlink(target, path.join(root, "save.tmp"));
  await rename(path.join(root, "save.tmp"), file);
  let idle = false;
  observer.once("idle", () => { idle = true; });
  native.notify("rename", "save.tmp");
  await until(() => idle, "symlink replacement reconciliation");
  expect(events.map(({ event, file }) => ({ event, file }))).toEqual([{ event: "unlink", file }]);
});

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

// A stand-in for Chokidar's polling watcher whose stat watcher took its
// baseline after the write, so it never reports the change itself.
function polledBaseline(settleMs: number, ignored: (file: string) => boolean = () => false) {
  const added: string[] = [];
  const chokidarWatcher = Object.assign(new EventEmitter(), { close: async () => {}, add: (file: string) => { added.push(file); } });
  const check = new PolledBaselineCheck(chokidarWatcher, ignored, settleMs);
  observers.push(check);
  const events: { event: string; file: string; stats?: Stats }[] = [];
  check.on("all", (event, file, stats) => events.push({ event, file, stats }));
  return { chokidarWatcher, events, added };
}

test("polling reports an edit written before the stat watcher's baseline", async () => {
  const root = await fixture();
  const file = path.join(root, ".uatu.json");
  await writeFile(file, "{}");
  const discovered = await stat(file);
  await writeFile(file, JSON.stringify({ ignore: { exclude: ["package-lock.json"] } }));
  const { chokidarWatcher, events } = polledBaseline(20);
  // Chokidar reports the file as discovered; the edit after it goes unseen.
  chokidarWatcher.emit("all", "add", file, discovered);
  await until(() => events.some(event => event.event === "change"), "missed edit reported");
  const change = events.find(event => event.event === "change")!;
  expect(change.file).toBe(file);
  expect(change.stats!.size).toBe((await stat(file)).size);
});

test("polling checks stay within one bounded batch while metadata reads are slow", async () => {
  const root = await fixture();
  const file = path.join(root, "a.md");
  await writeFile(file, "# A\n");
  const stats = await stat(file);
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const held: (() => void)[] = [];
  const slowStat = (async () => {
    calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>(resolve => held.push(resolve));
    inFlight--;
    return stats;
  }) as unknown as typeof stat;
  const chokidarWatcher = Object.assign(new EventEmitter(), { close: async () => {}, add: () => {} });
  const check = new PolledBaselineCheck(chokidarWatcher, () => false, 10, { lstat: slowStat as unknown as typeof lstat, readdir });
  observers.push(check);
  for (let i = 0; i < 40; i++) chokidarWatcher.emit("all", "add", path.join(root, `first-${i}.md`), stats);
  await until(() => inFlight === 16, "first batch saturated");
  // More paths come due while the first batch is still blocked.
  for (let i = 0; i < 40; i++) chokidarWatcher.emit("all", "add", path.join(root, `second-${i}.md`), stats);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(maxInFlight).toBe(16);
  while (calls < 80) {
    held.splice(0).forEach(release => release());
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  held.splice(0).forEach(release => release());
  await until(() => inFlight === 0, "every check finished");
  expect(maxInFlight).toBe(16);
  expect(calls).toBe(80);
});

test("polling reports a file replaced by a symlink before its baseline as removed", async () => {
  const root = await fixture();
  const target = path.join(root, "target.md");
  const file = path.join(root, "doc.md");
  await writeFile(target, "# Target, much longer than the original file\n");
  await writeFile(file, "# Doc\n");
  const discovered = await stat(file);
  await rm(file);
  await symlink(target, file);
  const { chokidarWatcher, events } = polledBaseline(20);
  chokidarWatcher.emit("all", "add", file, discovered);
  await until(() => events.some(event => event.event === "unlink"), "symlink replacement reported");
  expect(events.filter(event => event.event !== "add")).toEqual([{ event: "unlink", file, stats: undefined }]);
});

test("polling reports a file removed before its baseline, and nothing for an unchanged one", async () => {
  const root = await fixture();
  const kept = path.join(root, "kept.md");
  const removed = path.join(root, "removed.md");
  await writeFile(kept, "# Kept\n");
  await writeFile(removed, "# Removed\n");
  const removedStats = await stat(removed);
  await rm(removed);
  const { chokidarWatcher, events } = polledBaseline(20);
  chokidarWatcher.emit("all", "add", kept, await stat(kept));
  chokidarWatcher.emit("all", "add", removed, removedStats);
  // Checked after the others, so its report shows they have run.
  const marker = path.join(root, "marker.md");
  await writeFile(marker, "# Marker\n");
  const discovered = await stat(marker);
  await writeFile(marker, "# Marker, edited\n");
  chokidarWatcher.emit("all", "add", marker, discovered);
  await until(() => events.some(event => event.event === "change" && event.file === marker), "marker checked");
  expect(events.filter(event => event.event === "change").map(event => event.file)).toEqual([marker]);
  // Chokidar's baseline never saw the file, so it cannot report the removal.
  expect(events.filter(event => event.event === "unlink").map(event => event.file)).toEqual([removed]);
});

test("polling hands Chokidar the children a directory gained before its baseline", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "known.md"), "# Known\n");
  await writeFile(path.join(root, "missed.md"), "# Missed\n");
  await mkdir(path.join(root, "missed-dir"));
  await writeFile(path.join(root, "denied.md"), "# Denied\n");
  await symlink(path.join(root, "known.md"), path.join(root, "link.md"));
  const { chokidarWatcher, added, events } = polledBaseline(20, file => path.basename(file) === "denied.md");
  // A directory removed before its check is reported removed, not read.
  chokidarWatcher.emit("all", "addDir", path.join(root, "gone"));
  // Chokidar reported the root and one child; the rest arrived unseen.
  chokidarWatcher.emit("all", "addDir", root);
  chokidarWatcher.emit("all", "add", path.join(root, "known.md"), await stat(path.join(root, "known.md")));
  await until(() => added.length >= 2, "missed children handed to Chokidar");
  expect(added.sort()).toEqual([path.join(root, "missed-dir"), path.join(root, "missed.md")]);
  expect(events.filter(event => event.event === "unlinkDir").map(event => event.file)).toEqual([path.join(root, "gone")]);
});

test("polling reports a directory replaced by a symlink before its baseline as removed", async () => {
  const root = await fixture();
  const outside = await fixture();
  await writeFile(path.join(outside, "secret.md"), "# Outside the root\n");
  const directory = path.join(root, "docs");
  await mkdir(directory);
  await writeFile(path.join(directory, "a.md"), "# A\n");
  const fileStats = await stat(path.join(directory, "a.md"));
  await rm(directory, { recursive: true });
  await symlink(outside, directory);
  const { chokidarWatcher, events, added } = polledBaseline(20);
  chokidarWatcher.emit("all", "addDir", directory);
  chokidarWatcher.emit("all", "add", path.join(directory, "a.md"), fileStats);
  await until(() => events.some(event => event.event === "unlinkDir"), "symlink replacement reported");
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(added).toEqual([]);
  expect(events.filter(event => event.event !== "add" && event.event !== "addDir")).toEqual([{ event: "unlinkDir", file: directory, stats: undefined }]);
});

test("a child handed to polling Chokidar is reported and then polled", async () => {
  const root = await fixture();
  const matcher = await loadIgnoreMatcher({ rootPath: root, respectGitignore: true, isSingleFileRoot: false });
  const policy = createWatchPolicy({ kind: "dir", absolutePath: root }, matcher);
  // An interval this long means Chokidar's own polling reports nothing here.
  const chokidarWatcher = chokidar.watch(root, { ignored: policy.ignored, usePolling: true, interval: 60_000,
    ignoreInitial: false, alwaysStat: true, followSymlinks: false, atomic: true, awaitWriteFinish: false });
  const check = new PolledBaselineCheck(chokidarWatcher, policy.ignored, 20);
  observers.push(check);
  const events: { event: string; file: string }[] = [];
  check.on("all", (event, file) => events.push({ event, file }));
  await new Promise<void>(resolve => check.once("ready", resolve));
  const folder = path.join(root, "generated");
  const file = path.join(folder, "a.md");
  await mkdir(folder);
  await writeFile(file, "# Generated\n");
  // Chokidar reporting the root again asks for its children to be checked.
  chokidarWatcher.emit("all", "addDir", root);
  await until(() => events.some(event => event.event === "add" && event.file === file), "child reported through Chokidar");
  expect(events.filter(event => event.event === "addDir" && event.file === folder)).toHaveLength(1);
  expect(chokidarWatcher.getWatched()[folder]).toEqual(["a.md"]);
});
