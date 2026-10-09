import { afterEach, expect, test } from "bun:test";
import { watch as nodeWatch } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { safeGit } from "../document/git-base-ref";
import { createGitObserver, isGitNoise } from "./git-observer";
import type { WatchEntry } from "./roots";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false"];
async function git(cwd: string, args: string[]) {
  const result = await safeGit(cwd, [...identity, ...args], { timeoutMs: 15_000 });
  if (!result.ok) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.message}`);
  return result.stdout.trim();
}

// A remote with one commit and a clone of it, the shape a real checkout has.
async function checkout() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "uatu-git-observer-")));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const remote = path.join(directory, "remote");
  const work = path.join(directory, "work");
  await mkdir(remote);
  await git(remote, ["init", "--initial-branch=main"]);
  await writeFile(path.join(remote, "README.md"), "# Readme\n");
  await git(remote, ["add", "."]);
  await git(remote, ["commit", "-m", "initial"]);
  await git(directory, ["clone", "--quiet", remote, work]);
  return { directory, remote, work };
}

function observe(entries: WatchEntry[], watch?: typeof nodeWatch) {
  const names: Array<string | null> = [];
  const failures: unknown[] = [];
  const observer = createGitObserver({ entries, onChange: name => { names.push(name); }, onFailure: error => { failures.push(error); }, watch });
  cleanup.push(() => observer.close());
  return { observer, names, failures };
}

async function until(check: () => boolean, what: string) {
  const deadline = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

// Events in one directory arrive in order, so once a sentinel written after
// an action is reported, anything that action caused has been reported too.
async function settle(gitDir: string, names: Array<string | null>) {
  const sentinel = `uatu-sentinel-${crypto.randomUUID()}`;
  await writeFile(path.join(gitDir, sentinel), "");
  await until(() => names.includes(sentinel), "the sentinel event");
  return names.filter(name => name !== sentinel);
}

const dir = (absolutePath: string): WatchEntry => ({ kind: "dir", absolutePath } as WatchEntry);

test("Git's lock, temp, object and fetch-head entries are noise", () => {
  for (const name of ["index.lock", "main.lock", "packed-refs.new", "objects", "FETCH_HEAD", "gc.pid", ".watchman-cookie-host-1-2"]) expect(isGitNoise(name)).toBe(true);
  for (const name of ["index", "HEAD", "packed-refs", "main", "ORIG_HEAD", "COMMIT_EDITMSG"]) expect(isGitNoise(name)).toBe(false);
});

test("a stage, a commit, a branch switch, a fetch and ref packing each trigger", async () => {
  const { remote, work } = await checkout();
  const { observer, names } = observe([dir(work)]);
  await observer.start();
  const seen = async (action: () => Promise<unknown>, expected: string) => {
    names.length = 0;
    await action();
    await until(() => names.includes(expected), `${expected} after the action`);
  };

  await writeFile(path.join(work, "notes.md"), "notes\n");
  await seen(() => git(work, ["add", "notes.md"]), "index");
  await seen(() => git(work, ["commit", "-m", "notes"]), "main");
  await seen(() => git(work, ["checkout", "-b", "feature"]), "HEAD");
  await writeFile(path.join(remote, "remote.md"), "remote\n");
  await git(remote, ["add", "."]);
  await git(remote, ["commit", "-m", "remote"]);
  await seen(() => git(work, ["fetch", "--quiet"]), "main");
  await seen(() => git(work, ["pack-refs", "--all"]), "packed-refs");
}, 30_000);

test("reading status and lock-file churn trigger nothing", async () => {
  const { work } = await checkout();
  const gitDir = path.join(work, ".git");
  const { observer, names } = observe([dir(work)]);
  await observer.start();
  // A touched file is the stat refresh a locking `git status` would cache.
  const later = new Date(Date.now() + 60_000);
  await utimes(path.join(work, "README.md"), later, later);
  await safeGit(work, ["status", "--porcelain=v1"]);
  await writeFile(path.join(gitDir, "index.lock"), "");
  await rm(path.join(gitDir, "index.lock"));
  expect(await settle(gitDir, names)).toEqual([]);
}, 20_000);

test("entries in one repository share handles, and closing releases them all", async () => {
  const { work } = await checkout();
  await mkdir(path.join(work, "docs"));
  let opened = 0;
  let closed = 0;
  const counting = ((directory: string, options: unknown, listener: never) => {
    opened++;
    const handle = nodeWatch(directory, options as never, listener);
    const close = handle.close.bind(handle);
    handle.close = () => { closed++; close(); };
    return handle;
  }) as unknown as typeof nodeWatch;

  const single = observe([dir(work)]);
  await single.observer.start();
  const shared = observe([dir(work), dir(path.join(work, "docs"))], counting);
  await shared.observer.start();
  expect(shared.observer.directories()).toEqual(single.observer.directories());
  // docs/ is narrower than the repository, so it adds one working-tree watch.
  expect(shared.observer.trees()).toEqual([work]);
  expect(opened).toBe(shared.observer.directories().length + 1);
  shared.observer.close();
  expect(closed).toBe(opened);
  expect(shared.observer.directories()).toEqual([]);
}, 20_000);

test("a branch switch moves the branch-ref watch", async () => {
  const { work } = await checkout();
  const { observer } = observe([dir(work)]);
  await observer.start();
  const nested = path.join(work, ".git", "refs", "heads", "feat");
  expect(observer.directories()).not.toContain(nested);
  await git(work, ["checkout", "-b", "feat/x"]);
  await until(() => observer.directories().includes(nested), "the new branch's ref directory to be watched");
}, 20_000);

test("a commit in a linked worktree triggers its observer", async () => {
  const { directory, work } = await checkout();
  const linked = path.join(directory, "linked");
  await git(work, ["worktree", "add", "-b", "linked-branch", linked]);
  const { observer, names } = observe([dir(linked)]);
  await observer.start();
  expect(observer.directories()).toContain(path.join(work, ".git", "refs", "heads"));
  await git(linked, ["commit", "--allow-empty", "-m", "linked"]);
  await until(() => names.includes("linked-branch"), "the linked branch's ref update");
}, 20_000);

test("a directory that cannot be watched rejects start", async () => {
  const { work } = await checkout();
  const refusing = (() => { throw Object.assign(new Error("too many watchers"), { code: "EMFILE" }); }) as unknown as typeof nodeWatch;
  const { observer } = observe([dir(work)], refusing);
  await expect(observer.start()).rejects.toThrow("too many watchers");
});

test("a watcher error after start is reported once and closes every handle", async () => {
  const { work } = await checkout();
  const handles: ReturnType<typeof nodeWatch>[] = [];
  const recording = ((directory: string, options: unknown, listener: never) => {
    const handle = nodeWatch(directory, options as never, listener);
    handles.push(handle);
    return handle;
  }) as unknown as typeof nodeWatch;
  const { observer, failures } = observe([dir(work)], recording);
  await observer.start();
  handles[0]!.emit("error", new Error("watch lost"));
  handles[1]!.emit("error", new Error("watch lost again"));
  expect(failures).toHaveLength(1);
  expect(observer.directories()).toEqual([]);
});

test("a narrow root watches its repository's working tree outside the root", async () => {
  const { work } = await checkout();
  await mkdir(path.join(work, "docs"));
  await writeFile(path.join(work, "docs", "guide.md"), "# Guide\n");
  await writeFile(path.join(work, ".gitignore"), "build/\n");
  await mkdir(path.join(work, "build"));
  await git(work, ["add", "."]);
  await git(work, ["commit", "-m", "layout"]);

  const { observer, names } = observe([dir(path.join(work, "docs"))]);
  await observer.start();
  expect(observer.trees()).toEqual([work]);

  // A tracked file outside the root triggers.
  await writeFile(path.join(work, "README.md"), "# Changed\n");
  await until(() => names.includes("README.md"), "the edit outside the narrow root");

  // Inside the root (the content watcher's job), ignored output, and Git's
  // own directory do not. A file outside the root that is not ignored marks
  // the end of the stream.
  names.length = 0;
  await writeFile(path.join(work, "docs", "guide.md"), "# Guide, edited\n");
  await writeFile(path.join(work, "build", "out.js"), "built\n");
  const sentinel = `sentinel-${crypto.randomUUID()}.txt`;
  await writeFile(path.join(work, sentinel), "");
  await until(() => names.includes(sentinel), "the sentinel outside the root");
  expect(names.filter(name => name !== sentinel && name !== null)).toEqual([]);
}, 20_000);

test("a whole-repository root opens no working-tree watch", async () => {
  const { work } = await checkout();
  const { observer } = observe([dir(work)]);
  await observer.start();
  expect(observer.trees()).toEqual([]);
});

test("narrow entries in one repository share one working-tree watch", async () => {
  const { work } = await checkout();
  await mkdir(path.join(work, "a"));
  await mkdir(path.join(work, "b"));
  const { observer } = observe([dir(path.join(work, "a")), dir(path.join(work, "b"))]);
  await observer.start();
  expect(observer.trees()).toEqual([work]);
  observer.close();
  expect(observer.trees()).toEqual([]);
});

test("the first fetch into a never-fetched remote is observed even when only FETCH_HEAD is reported", async () => {
  const { directory, remote } = await checkout();
  const fresh = path.join(directory, "fresh");
  await mkdir(fresh);
  await git(fresh, ["init", "--initial-branch=main"]);
  await git(fresh, ["remote", "add", "origin", remote]);
  // Linux's non-recursive watch on .git sees only FETCH_HEAD for a first
  // fetch; refs/remotes/origin is created below it, unwatched.
  const onlyFetchHead = ((target: string, options: unknown, listener: (event: string, name: string | null) => void) =>
    nodeWatch(target, options as never, (event, name) => { if (name?.toString() === "FETCH_HEAD") listener(event, name.toString()); })) as unknown as typeof nodeWatch;
  const { observer, names } = observe([dir(fresh)], onlyFetchHead);
  await observer.start();
  const origin = path.join(fresh, ".git", "refs", "remotes", "origin");
  expect(observer.directories()).not.toContain(origin);
  await git(fresh, ["fetch", "--quiet", "origin"]);
  await until(() => observer.directories().includes(origin), "the new remote ref directory to be watched");
  await until(() => names.includes(null), "a change for the newly watched directory");
}, 20_000);

test("a narrow root keeps tracked files that the .gitignore matches observable", async () => {
  const { work } = await checkout();
  await mkdir(path.join(work, "docs"));
  await mkdir(path.join(work, "build"));
  await writeFile(path.join(work, ".gitignore"), "build/\n");
  await writeFile(path.join(work, "build", "kept.txt"), "kept\n");
  await git(work, ["add", ".gitignore"]);
  await git(work, ["add", "-f", "build/kept.txt"]);
  await git(work, ["commit", "-m", "track a file the .gitignore matches"]);
  const { observer, names } = observe([dir(path.join(work, "docs"))]);
  await observer.start();

  await writeFile(path.join(work, "build", "kept.txt"), "kept, edited\n");
  await until(() => names.includes("kept.txt"), "the tracked-but-ignored edit");

  // Force-adding another one after start is picked up through the index.
  await writeFile(path.join(work, "build", "late.txt"), "late\n");
  await git(work, ["add", "-f", "build/late.txt"]);
  const deadline = performance.now() + 10_000;
  for (let attempt = 0; !names.includes("late.txt"); attempt++) {
    if (performance.now() > deadline) throw new Error("the force-added file never became observable");
    await writeFile(path.join(work, "build", "late.txt"), `late ${attempt}\n`);
    await Bun.sleep(50);
  }
}, 20_000);

for (const remote of [true, false]) {
  test(`lock churn never re-resolves paths ${remote ? "in a clone" : "in a repository without a remote"}`, async () => {
    const { directory, work } = await checkout();
    const root = remote ? work : path.join(directory, "local");
    if (!remote) {
      await mkdir(root);
      await git(root, ["init", "--initial-branch=main"]);
      await git(root, ["commit", "--allow-empty", "-m", "initial"]);
    }
    const gitDir = path.join(root, ".git");
    const { observer, names } = observe([dir(root)]);
    await observer.start();
    expect(observer.resolutions()).toBe(1);
    for (let i = 0; i < 5; i++) {
      await writeFile(path.join(gitDir, "index.lock"), "");
      await rm(path.join(gitDir, "index.lock"));
    }
    await settle(gitDir, names);
    expect(observer.resolutions()).toBe(1);
  }, 20_000);
}

test("a root that becomes a repository is observed from its first commit", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "uatu-git-observer-plain-")));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "README.md"), "# Plain\n");
  const { observer, names } = observe([dir(directory)]);
  await observer.start();
  expect(observer.directories()).toEqual([directory]);
  await git(directory, ["init", "--initial-branch=main"]);
  await until(() => names.includes(".git"), "the new .git directory");
  const gitDir = path.join(directory, ".git");
  // On Linux the half-made .git is watched first; wait for the full set.
  await until(() => observer.directories().includes(path.join(gitDir, "refs", "heads")), "the new repository's Git-metadata watches");
  expect(observer.directories()).toContain(gitDir);
  expect(observer.directories()).not.toContain(directory);
  names.length = 0;
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "first"]);
  await until(() => names.includes("main") || names.includes("HEAD") || names.includes("index"), "the first commit");
}, 20_000);

test("a .git directory that appears before git init finishes is still resolved", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "uatu-git-observer-halfmade-")));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const { observer, names } = observe([dir(directory)]);
  await observer.start();
  // Linux reports .git as soon as it exists, before HEAD is written.
  const gitDir = path.join(directory, ".git");
  await mkdir(gitDir);
  await until(() => names.includes(".git"), "the empty .git directory");
  await until(() => observer.directories().includes(gitDir), "the half-made .git to be watched");
  await git(directory, ["init", "--initial-branch=main"]);
  await until(() => observer.directories().includes(path.join(gitDir, "refs", "heads")), "the full Git-metadata watch set");
}, 20_000);

test("excluded working-tree paths count only when Git can see them", async () => {
  const { work } = await checkout();
  await mkdir(path.join(work, "build"));
  await mkdir(path.join(work, "dist"));
  await writeFile(path.join(work, ".gitignore"), "build/\n");
  await writeFile(path.join(work, "build", "kept.txt"), "kept\n");
  await writeFile(path.join(work, "dist", "bundle.js"), "bundle\n");
  await git(work, ["add", ".gitignore", "dist/bundle.js"]);
  await git(work, ["add", "-f", "build/kept.txt"]);
  await git(work, ["commit", "-m", "tracked output"]);
  const { observer, names } = observe([dir(work)]);
  await observer.start();
  // A whole-repository root needs no working-tree watch of its own.
  expect(observer.trees()).toEqual([]);

  // The content watcher excludes dist/ (built in) and build/ (.gitignore);
  // Git tracks files in both.
  observer.noteWorkingTreeChange(path.join(work, "dist", "bundle.js"));
  observer.noteWorkingTreeChange(path.join(work, "build", "kept.txt"));
  // Untracked output the .gitignore excludes, and Git's own files, do not count.
  observer.noteWorkingTreeChange(path.join(work, "build", "scratch.txt"));
  observer.noteWorkingTreeChange(path.join(work, ".git", "index"));
  expect(names).toEqual(["bundle.js", "kept.txt"]);
}, 20_000);

test("a nested .gitignore cannot hide a tracked file from repository updates", async () => {
  const { work } = await checkout();
  await mkdir(path.join(work, "docs"));
  await writeFile(path.join(work, "docs", "a.md"), "# A\n");
  await git(work, ["add", "docs/a.md"]);
  await git(work, ["commit", "-m", "docs"]);
  // The narrow root's own .gitignore now matches a tracked file; the content
  // watcher honours it.
  await writeFile(path.join(work, "docs", ".gitignore"), "a.md\n");
  const { observer, names } = observe([dir(path.join(work, "docs"))]);
  await observer.start();
  observer.noteWorkingTreeChange(path.join(work, "docs", "a.md"));
  expect(names).toEqual(["a.md"]);
}, 20_000);

test("a force-added file under the .gitignore counts once the index records it", async () => {
  const { work } = await checkout();
  await mkdir(path.join(work, "build"));
  await writeFile(path.join(work, ".gitignore"), "build/\n");
  await git(work, ["add", ".gitignore"]);
  await git(work, ["commit", "-m", "ignore build"]);
  const { observer, names } = observe([dir(work)]);
  await observer.start();
  const late = path.join(work, "build", "late.txt");
  await writeFile(late, "late\n");
  observer.noteWorkingTreeChange(late);
  expect(names).toEqual([]);
  await git(work, ["add", "-f", "build/late.txt"]);
  // The index event refreshes what is tracked but ignored.
  const deadline = performance.now() + 10_000;
  while (!names.includes("late.txt")) {
    if (performance.now() > deadline) throw new Error("the force-added file never counted");
    observer.noteWorkingTreeChange(late);
    await Bun.sleep(20);
  }
}, 20_000);

test("git init finishing before the half-made .git's watch opens is still resolved", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "uatu-git-observer-window-")));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const gitDir = path.join(directory, ".git");
  await mkdir(gitDir);
  // git init completes in the window between "no repository yet" and the
  // .git watch going live, so that watch never sees a write.
  const { execFileSync } = await import("node:child_process");
  let initialized = false;
  const lateWatch = ((target: string, options: unknown, listener: never) => {
    if (target === gitDir && !initialized) {
      initialized = true;
      execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: directory });
    }
    return nodeWatch(target, options as never, listener);
  }) as unknown as typeof nodeWatch;
  const { observer } = observe([dir(directory)], lateWatch);
  await observer.start();
  await until(() => observer.directories().includes(path.join(gitDir, "refs", "heads")), "the repository initialized inside the window");
}, 20_000);

test("editing .git/info/exclude is observed", async () => {
  const { work } = await checkout();
  const { observer, names } = observe([dir(work)]);
  await observer.start();
  expect(observer.directories()).toContain(path.join(work, ".git", "info"));
  await writeFile(path.join(work, ".git", "info", "exclude"), "scratch/\n");
  await until(() => names.includes("exclude"), "the info/exclude edit");
}, 20_000);
