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
