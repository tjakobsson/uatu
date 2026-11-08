import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
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
    expect(paths(rootOf(session)).filter(file => file.startsWith("build/"))).toEqual([]);
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
  await files(cwd, ["README.md"]);
  const session = createWatchSession([{ kind: "dir", absolutePath: cwd }], false, { ignoredWindowLimit: 2 });
  const render = (name: string) => path.join(cwd, "build/renders", name);
  try {
    await session.start();
    await mkdir(path.join(cwd, "build/renders"), { recursive: true });
    for (const name of ["opened.md", "served.png"]) await writeFile(render(name), "x");
    await wait(() => !!session.findDocument(render("opened.md")) && !!session.findDocument(render("served.png")), "windowed renders");
    expect(await session.ensureDocument(render("opened.md"))).toBeDefined();
    session.pinDocument(render("served.png"));
    for (const name of ["a.wav", "b.wav", "c.wav"]) { await writeFile(render(name), "x"); await Bun.sleep(30); }
    await wait(() => !!session.findDocument(render("c.wav")), "later renders");
    expect(session.findDocument(render("opened.md"))).toBeDefined();
    expect(session.findDocument(render("served.png"))).toBeDefined();
    // Unpinned older writes left the window.
    expect(session.findDocument(render("a.wav"))).toBeUndefined();
  } finally { await session.stop(); }
});
