import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IgnoredFolders } from "./ignored-folders";
import { createWatchSession, FolderListingError } from "./watch-session";
import { MetricsRegistry } from "../debug/metrics";
import type { RevisionedRoot } from "../shared/document-updates";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(git = true) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-ignored-folders-"));
  dirs.push(dir);
  if (git) expect(Bun.spawnSync(["git", "init", "-q"], { cwd: dir }).exitCode).toBe(0);
  return dir;
}
async function files(root: string, names: string[], content = "x") {
  for (const name of names) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
}
async function wait(predicate: () => boolean, what: string) {
  const end = Date.now() + 8000;
  while (!predicate()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await Bun.sleep(15); }
}
const rootOf = (session: ReturnType<typeof createWatchSession>): RevisionedRoot => session.getUnscopedRoots()[0]! as RevisionedRoot;
const paths = (root: RevisionedRoot) => root.docs.map(doc => doc.relativePath).sort();
const folders = (root: RevisionedRoot) => (root.folders ?? []).map(folder => `${folder.relativePath}${folder.listed ? " listed" : ""}`).sort();

test("IgnoredFolders separates unlisted levels, windowed files and published folders", () => {
  const state = new IgnoredFolders(["build", "pkg/node_modules"]);
  expect(state.isInside("build")).toBe(true);
  expect(state.isInside("build/renders/a.wav")).toBe(true);
  expect(state.isInside("buildings/a.md")).toBe(false);
  expect(state.isUnlistedDirectory("build/renders")).toBe(true);
  expect(state.isWindowed("build/renders/a.wav")).toBe(true);
  expect(state.isPublishedFolder("build/renders")).toBe(false);
  state.markListed("build");
  expect(state.isPublishedFolder("build/renders")).toBe(true);
  expect(state.isWindowed("build/a.o")).toBe(false);
  expect(state.isWindowed("build/renders/a.wav")).toBe(true);
  state.forget("build");
  expect(state.isInside("build/a.o")).toBe(false);
  expect(state.isListed("build")).toBe(false);
  expect(state.isInside("pkg/node_modules/x/y.js")).toBe(true);
});

test("discovery lists a Git-ignored folder as one entry without reading it, and knows ignored files up front", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, ".gitignore"), "node_modules/\n/references/*\n!/references/README.md\n");
  await files(cwd, Array.from({ length: 300 }, (_, i) => `node_modules/pkg${i}/index.js`));
  await files(cwd, ["docs/a.md", "references/README.md", "references/rec.wav"]);
  const metrics = new MetricsRegistry();
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], false, { metrics });
  try {
    await session.start();
    const root = rootOf(session);
    expect(paths(root)).toEqual([".gitignore", "docs/a.md", "references/README.md", "references/rec.wav"]);
    expect(folders(root)).toEqual(["node_modules/"]);
    // The partially ignored folder is walked and its ignored file is known as
    // ignored before any classification pass.
    expect(root.docs.find(doc => doc.relativePath === "references/rec.wav")?.gitIgnoreStatus).toBe("ignored");
    // Root, docs/ and references/ are read; node_modules/ is not.
    expect(metrics.get("index.directory_total")).toBe(3);
    expect(metrics.get("index.stat_total")).toBeLessThan(20);
  } finally { await session.stop(); }
});

test("a root outside Git is discovered completely", async () => {
  const cwd = await fixture(false);
  await writeFile(path.join(cwd, ".gitignore"), "node_modules/\n");
  await files(cwd, ["node_modules/pkg/index.js", "README.md"]);
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], false);
  try {
    await session.start();
    expect(paths(rootOf(session))).toEqual([".gitignore", "README.md", "node_modules/pkg/index.js"]);
    expect(rootOf(session).folders).toBeUndefined();
  } finally { await session.stop(); }
});

test("a folder Git ignores that appears at runtime becomes an entry without being read", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, ".gitignore"), "/build*/\n");
  await files(cwd, ["README.md"]);
  const staging = await fixture(false);
  await files(staging, Array.from({ length: 50 }, (_, i) => `build/objects/${i}.o`));
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], false);
  try {
    await session.start();
    await rename(path.join(staging, "build"), path.join(cwd, "build"));
    await wait(() => folders(rootOf(session)).includes("build/"), "runtime ignored folder");
    await Bun.sleep(1500);
    // Some native backends (Linux) report the files of a directory moved in;
    // those are live writes, captured as ignored entries within the window.
    // The folder itself stays unlisted and is never read by Uatu.
    expect(rootOf(session).folders?.find(folder => folder.relativePath === "build/")?.listed).toBe(false);
    expect(rootOf(session).docs.filter(doc => doc.relativePath.startsWith("build/")).every(doc => doc.gitIgnoreStatus === "ignored")).toBe(true);
  } finally { await session.stop(); }
});

test("editing .gitignore reconciles which folders are listed on demand", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, ".gitignore"), "node_modules/\n");
  await files(cwd, ["generated/out.md", "node_modules/pkg/index.js", "README.md"]);
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], false);
  try {
    await session.start();
    expect(paths(rootOf(session))).toContain("generated/out.md");
    await writeFile(path.join(cwd, ".gitignore"), "generated/\n");
    await wait(() => folders(rootOf(session)).join() === "generated/" && paths(rootOf(session)).includes("node_modules/pkg/index.js"), "reconciled ignored folders");
    expect(paths(rootOf(session))).not.toContain("generated/out.md");
  } finally { await session.stop(); }
});

test("listing a level admits its files and subfolders, honours exclusions, containment and removal", async () => {
  const cwd = await fixture();
  const outside = await fixture(false);
  await writeFile(path.join(cwd, ".gitignore"), "/build*/\n");
  await writeFile(path.join(cwd, ".uatu.json"), JSON.stringify({ ignore: { exclude: ["build/private/"] } }));
  await files(cwd, ["README.md", "build/CMakeCache.txt", "build/renders/take.wav", "build/private/key.txt", "build/.DS_Store"]);
  await files(outside, ["escape.txt"]);
  await symlink(outside, path.join(cwd, "build", "link"));
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], false);
  try {
    await session.start();
    expect(folders(rootOf(session))).toEqual(["build/"]);
    const listed = await session.listFolder(cwd, "build/");
    expect(listed.status).toBe("listed");
    expect(listed.revision).toBeGreaterThan(0);
    expect(paths(rootOf(session)).filter(file => file.startsWith("build/"))).toEqual(["build/CMakeCache.txt"]);
    expect(folders(rootOf(session))).toEqual(["build/ listed", "build/renders/"]);
    expect(rootOf(session).docs.find(doc => doc.relativePath === "build/CMakeCache.txt")?.gitIgnoreStatus).toBe("ignored");
    await session.listFolder(cwd, "build/renders");
    expect(paths(rootOf(session))).toContain("build/renders/take.wav");
    // A listed level stays current without listing it again.
    await writeFile(path.join(cwd, "build/renders/take-2.wav"), "audio");
    await wait(() => paths(rootOf(session)).includes("build/renders/take-2.wav"), "write in a listed level");
    for (const [relative, status] of [["build/private", 404], ["build/link", 404], ["README.md", 404], ["docs", 404], ["../x", 400], ["build/../x", 400], ["", 400]] as const) {
      const error = await session.listFolder(cwd, relative).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(FolderListingError);
      expect((error as FolderListingError).status).toBe(status);
    }
    await rm(path.join(cwd, "build/renders"), { recursive: true });
    const missing = await session.listFolder(cwd, "build/renders");
    expect(missing.status).toBe("missing");
    expect(folders(rootOf(session))).toEqual(["build/ listed"]);
    expect(paths(rootOf(session)).filter(file => file.startsWith("build/renders/"))).toEqual([]);
  } finally { await session.stop(); }
});

test("listed levels survive recovery while their folder is still ignored", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, ".gitignore"), "/build*/\n");
  await files(cwd, ["README.md", "build/CMakeCache.txt"]);
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], false);
  try {
    await session.start();
    await session.listFolder(cwd, "build");
    await session.recover();
    expect(folders(rootOf(session))).toEqual(["build/ listed"]);
    expect(paths(rootOf(session))).toContain("build/CMakeCache.txt");
  } finally { await session.stop(); }
});

test("files a client opens or is served stay indexed when later writes overflow the window", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, ".gitignore"), "/build*/\n");
  // Seed an existing ignored tree so discovery establishes its unlisted
  // status before any writes. Creating it later races asynchronous directory
  // classification: files admitted in the ordinary lane do not use the window.
  await files(cwd, ["README.md", "build/renders/.keep"]);
  // Pinned files count toward the total window. Leave one moving slot so
  // later writes can enter it while the two client-owned entries stay pinned.
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], false, { ignoredWindowLimit: 3 });
  const render = (name: string) => path.join(cwd, "build/renders", name);
  try {
    await session.start();
    expect(folders(rootOf(session))).toEqual(["build/"]);
    expect(paths(rootOf(session))).not.toContain("build/renders/.keep");
    for (const name of ["opened.md", "served.png"]) await writeFile(render(name), "x");
    await wait(() => !!session.findDocument(render("opened.md")) && !!session.findDocument(render("served.png")), "windowed renders");
    expect(await session.ensureDocument(render("opened.md"))).toBeDefined();
    session.pinDocument(render("served.png"));
    for (const name of ["a.wav", "b.wav", "c.wav"]) {
      await writeFile(render(name), "x");
      // Synchronize on observed writes rather than assuming a 30ms pause
      // establishes observer/classifier order under CI load.
      await wait(() => !!session.findDocument(render(name)), `later render ${name}`);
    }
    // The newest upsert and the older removal may arrive in separate patches.
    await wait(() => !session.findDocument(render("a.wav")), "older unpinned render eviction");
    expect(session.findDocument(render("opened.md"))).toBeDefined();
    expect(session.findDocument(render("served.png"))).toBeDefined();
    // Unpinned older writes left the window.
    expect(session.findDocument(render("a.wav"))).toBeUndefined();
    expect(session.findDocument(render("c.wav"))).toBeDefined();
    expect(folders(rootOf(session))).toEqual(["build/"]);
  } finally { await session.stop(); }
}, 20_000);

test("Follow skips ignored output in every batch, follows tracked output, and the default skips newer ignored files", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, ".gitignore"), "/build*/\n/references/*\n!/references/README.md\n");
  await files(cwd, ["docs/a.md", "dist/index.html", "build/report.md", "references/README.md"]);
  expect(Bun.spawnSync(["git", "add", "dist/index.html", ".gitignore"], { cwd }).exitCode).toBe(0);
  await Bun.sleep(20);
  await files(cwd, ["references/newer.md"]);
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], true);
  const frames: { changedId: string | null }[] = [];
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    await session.start();
    const doc = (relative: string) => path.join(cwd, ...relative.split("/"));
    await wait(() => session.findDocument(doc("references/newer.md"))?.gitIgnoreStatus === "ignored", "ignored reference");
    expect(session.getStatePayload().defaultDocumentId).not.toBe(doc("references/newer.md"));
    await session.listFolder(cwd, "build");
    reader = session.eventsResponse().body!.getReader();
    void (async () => { for (;;) { const value = await reader!.read(); if (value.done) return; for (const chunk of new TextDecoder().decode(value.value).split("\n\n")) if (chunk.startsWith("event: state")) frames.push(JSON.parse(chunk.split("data: ")[1]!)); } })();
    await wait(() => frames.length > 0, "initial snapshot");
    const followed = () => frames.map(frame => frame.changedId).filter(Boolean);
    // An ignored build output alone, with or without ignored files shown.
    await writeFile(doc("build/report.md"), "# rebuilt");
    await writeFile(doc("build/renders.md"), "# new");
    await Bun.sleep(1600);
    expect(followed()).toEqual([]);
    // A document saved during a build is followed even though output came later.
    await writeFile(doc("docs/a.md"), "# edited");
    await writeFile(doc("build/report.md"), "# rebuilt again");
    await wait(() => followed().includes(doc("docs/a.md")), "document edit followed");
    // A tracked file inside an output folder is ordinary content.
    await writeFile(doc("dist/index.html"), "<p>new</p>");
    await wait(() => followed().includes(doc("dist/index.html")), "tracked output followed");
    await Bun.sleep(1600);
    expect(followed().some(id => id!.includes(`${path.sep}build${path.sep}`))).toBe(false);
  } finally { await reader?.cancel(); await session.stop(); }
}, 20_000);

test("a .gitignore written inside an ignored folder is an ordinary file, not an ignore-policy change", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, ".gitignore"), "node_modules/\n");
  await files(cwd, ["README.md", "node_modules/pkg/index.js"]);
  const metrics = new MetricsRegistry();
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], false, { metrics });
  try {
    await session.start();
    const watcher = session._internalWatcher();
    const fullPasses = metrics.get("classification.full_total");
    await mkdir(path.join(cwd, "node_modules/pkg2"), { recursive: true });
    await writeFile(path.join(cwd, "node_modules/pkg2/.gitignore"), "*\n");
    await wait(() => !!session.findDocument(path.join(cwd, "node_modules/pkg2/.gitignore")), "package .gitignore indexed");
    await Bun.sleep(300);
    // No reclassification pass and no rebuild of the root.
    expect(metrics.get("classification.full_total")).toBe(fullPasses);
    expect(session._internalWatcher()).toBe(watcher);
    expect(session.getDiscoveryState().status).toBe("ready");
  } finally { await session.stop(); }
});

test("pinned files inside unlisted ignored folders survive recovery", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, ".gitignore"), "/build*/\n");
  await files(cwd, ["README.md", "build/take.wav"]);
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], false);
  const take = path.join(cwd, "build/take.wav");
  try {
    await session.start();
    expect(session.findDocument(take)).toBeUndefined();
    expect(await session.ensureDocument(take)).toBeDefined();
    await session.recover();
    expect(session.findDocument(take)).toBeDefined();
    expect(folders(rootOf(session))).toEqual(["build/"]);
  } finally { await session.stop(); }
});

test.skipIf(process.getuid?.() === 0)("an unreadable ignored folder stays, unlisted, instead of being treated as missing", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, ".gitignore"), "/build*/\n");
  await files(cwd, ["README.md", "build/locked/secret.o"]);
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], false);
  const locked = path.join(cwd, "build/locked");
  try {
    await session.start();
    await session.listFolder(cwd, "build");
    expect(folders(rootOf(session))).toEqual(["build/ listed", "build/locked/"]);
    // Traversable but unreadable. On Linux realpath works and readdir fails;
    // macOS fails earlier, in realpath. Either way the folder must stay.
    await chmod(locked, 0o311);
    const error = await session.listFolder(cwd, "build/locked").then(() => null, (caught: unknown) => caught);
    expect(error).not.toBeNull();
    expect(error).not.toBeInstanceOf(FolderListingError);
    expect(folders(rootOf(session))).toEqual(["build/ listed", "build/locked/"]);
  } finally { await chmod(locked, 0o755).catch(() => {}); await session.stop(); }
});

test("recovery does not restore a pinned file whose folder became a symlink out of the root", async () => {
  const cwd = await fixture();
  const outside = await fixture(false);
  await writeFile(path.join(cwd, ".gitignore"), "/build*/\n");
  await files(cwd, ["README.md", "build/a.md"]);
  await files(outside, ["a.md"], "# outside");
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], false);
  const opened = path.join(cwd, "build/a.md");
  try {
    await session.start();
    expect(await session.ensureDocument(opened)).toBeDefined();
    await rm(path.join(cwd, "build"), { recursive: true });
    await symlink(outside, path.join(cwd, "build"));
    await session.recover();
    expect(session.findDocument(opened)).toBeUndefined();
  } finally { await session.stop(); }
});

test("a file opened inside an unlisted ignored folder is removed when it is deleted", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, ".gitignore"), "/build*/\n");
  await files(cwd, ["README.md", "build/report.md"]);
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], false);
  const opened = path.join(cwd, "build/report.md");
  try {
    await session.start();
    expect(await session.ensureDocument(opened)).toBeDefined();
    await Bun.sleep(200);
    await rm(opened);
    await wait(() => !session.findDocument(opened), "deleted opened file leaves the index");
  } finally { await session.stop(); }
}, 15_000);

test("polling: deleting a file in a listed ignored folder removes it", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, ".gitignore"), "/build*/\n");
  await files(cwd, ["README.md", "build/a.md"]);
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], false, { usePolling: true });
  const file = path.join(cwd, "build/a.md");
  try {
    await session.start();
    await session.listFolder(cwd, "build");
    expect(session.findDocument(file)).toBeDefined();
    await writeFile(file, "# edited");
    await Bun.sleep(1500);
    await rm(file);
    await wait(() => !session.findDocument(file), "polled removal");
  } finally { await session.stop(); }
}, 20_000);

test("polling: an ancestor .gitignore change outside the root reconciles ignored folders", async () => {
  const repo = await fixture();
  const work = path.join(repo, "work");
  await writeFile(path.join(repo, ".gitignore"), "work/build/\n");
  await files(repo, ["work/README.md", "work/build/a.md"]);
  const session = createWatchSession([{ kind: "dir", absolutePath: work }], false, { usePolling: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    await session.start();
    // A subscriber creates demand; polling runs only while someone watches.
    reader = session.eventsResponse().body!.getReader();
    expect(folders(rootOf(session))).toEqual(["build/"]);
    await writeFile(path.join(repo, ".gitignore"), "");
    const end = Date.now() + 15_000;
    while (!paths(rootOf(session)).includes("build/a.md")) { if (Date.now() > end) throw new Error("not reconciled"); await Bun.sleep(100); }
    expect(rootOf(session).folders).toBeUndefined();
  } finally { await reader?.cancel(); await session.stop(); }
}, 25_000);

test("a file opens while the Git inventory is still running, and the inventory's folders arrive afterwards", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, ".gitignore"), "/build*/\n");
  await files(cwd, ["README.md", "build/a.o"]);
  const gate = Promise.withResolvers<void>();
  const { collectIgnoredInventory } = await import("./git-ignore");
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], false, {
    collectIgnored: async (root, signal) => { await gate.promise; return collectIgnoredInventory(root, signal); },
  });
  try {
    const started = session.start();
    const readme = await session.ensureDocument(path.join(cwd, "README.md"));
    expect(readme?.relativePath).toBe("README.md");
    gate.resolve();
    await started;
    expect(folders(rootOf(session))).toEqual(["build/"]);
    expect(paths(rootOf(session)).filter(file => file.startsWith("build/"))).toEqual([]);
  } finally { gate.resolve(); await session.stop(); }
});

test("a watched root that is itself ignored by an ancestor rule is read like any workspace", async () => {
  const repo = await fixture();
  await writeFile(path.join(repo, ".gitignore"), "build/\n");
  await files(repo, ["build/out.md", "build/renders/take.md"]);
  const session = createWatchSession([{ kind: "dir", absolutePath: path.join(repo, "build") }], false);
  try {
    await session.start();
    expect(rootOf(session).folders).toBeUndefined();
    expect(paths(rootOf(session))).toEqual(["out.md", "renders/take.md"]);
  } finally { await session.stop(); }
});

test("polling: a folder created inside a listed ignored level gets a row and lists", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, ".gitignore"), "/build*/\n");
  await files(cwd, ["README.md", "build/CMakeCache.txt"]);
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], false, { usePolling: true });
  try {
    await session.start();
    await session.listFolder(cwd, "build");
    await files(cwd, ["build/renders/a.md"]);
    await wait(() => folders(rootOf(session)).includes("build/renders/"), "new child folder row");
    expect(paths(rootOf(session))).not.toContain("build/renders/a.md");
    await session.listFolder(cwd, "build/renders");
    expect(paths(rootOf(session))).toContain("build/renders/a.md");
    // The earlier polling guarantees still hold in a listed level.
    await writeFile(path.join(cwd, "build/new.txt"), "x");
    await wait(() => paths(rootOf(session)).includes("build/new.txt"), "write in a listed level");
  } finally { await session.stop(); }
}, 20_000);

test("polling: a file opened inside an unlisted ignored folder sees its edits and deletion", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, ".gitignore"), "/build*/\n");
  await files(cwd, ["README.md", "build/a.md"]);
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], false, { usePolling: true });
  const opened = path.join(cwd, "build/a.md");
  try {
    await session.start();
    const first = await session.ensureDocument(opened);
    expect(first).toBeDefined();
    await Bun.sleep(1200);
    await writeFile(opened, "# edited, longer than before");
    await wait(() => (session.findDocument(opened)?.revision ?? 0) > first!.revision!, "edit observed");
    await rm(opened);
    await wait(() => !session.findDocument(opened), "deletion observed");
  } finally { await session.stop(); }
}, 20_000);

test("opening a file succeeds even when the live-write window is full of opened files", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, ".gitignore"), "/build*/\n");
  await files(cwd, ["README.md", "build/a.md", "build/b.md"]);
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], false, { ignoredWindowLimit: 1 });
  try {
    await session.start();
    expect(await session.ensureDocument(path.join(cwd, "build/a.md"))).toBeDefined();
    expect(await session.ensureDocument(path.join(cwd, "build/b.md"))).toBeDefined();
    expect(session.findDocument(path.join(cwd, "build/a.md"))).toBeDefined();
  } finally { await session.stop(); }
});

test("polling: an ignored folder created at runtime is adopted in place without re-indexing", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, ".gitignore"), "/build*/\n");
  await files(cwd, ["README.md"]);
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], false, { usePolling: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const render = path.join(cwd, "build/renders/take.wav");
  try {
    await session.start();
    reader = session.eventsResponse().body!.getReader();
    await files(cwd, ["build/renders/take.wav"]);
    await wait(() => !!session.findDocument(render), "render indexed while polling");
    const revision = session.findDocument(render)!.revision;
    const watcher = session._internalWatcher();
    // A poll (every 5 s while a client is subscribed) reconciles the inventory.
    const end = Date.now() + 15_000;
    while (!folders(rootOf(session)).includes("build/ listed")) { if (Date.now() > end) throw new Error("not adopted"); await Bun.sleep(100); }
    expect(folders(rootOf(session))).toEqual(["build/ listed", "build/renders/ listed"]);
    expect(session.findDocument(render)?.revision).toBe(revision);
    expect(session._internalWatcher()).toBe(watcher);
    // The adopted level stays current.
    await writeFile(render, "longer audio bytes");
    await wait(() => (session.findDocument(render)?.revision ?? 0) > revision!, "write after adoption");
  } finally { await reader?.cancel(); await session.stop(); }
}, 30_000);
