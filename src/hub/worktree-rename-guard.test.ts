import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createWorktreeRenameGuard } from "./worktree-rename-guard";

// Real repositories in temporary directories; the Uatu checkout is never
// touched. The environment is explicit so a Hub-managed workspace's
// projected Git configuration cannot influence a verdict.
const temporaryDirectories: string[] = [];
let sharedHome: string | undefined;

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `uatu-rename-guard-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

async function cleanEnvironment(): Promise<Record<string, string>> {
  sharedHome ??= await temporaryDirectory("home");
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: sharedHome,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Uatu Test",
    GIT_AUTHOR_EMAIL: "uatu@example.test",
    GIT_COMMITTER_NAME: "Uatu Test",
    GIT_COMMITTER_EMAIL: "uatu@example.test",
  };
}

async function git(cwd: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["git", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args], {
    cwd,
    env: await cleanEnvironment(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

async function repository(label: string, folder = "repo"): Promise<{ workspace: string; main: string }> {
  const workspace = await temporaryDirectory(label);
  const main = path.join(workspace, folder);
  await mkdir(main, { recursive: true });
  await git(main, ["init", "--initial-branch=main"]);
  await writeFile(path.join(main, "README.md"), "# Readme\n");
  await git(main, ["add", "."]);
  await git(main, ["commit", "-m", "initial"]);
  return { workspace, main };
}

async function guard(overrides: Parameters<typeof createWorktreeRenameGuard>[0] = {}) {
  return createWorktreeRenameGuard({ env: await cleanEnvironment(), ...overrides });
}

afterAll(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("folders with no Git dependency stay renameable", () => {
  test("an ordinary folder is safe, even on a host without Git", async () => {
    const directory = await temporaryDirectory("plain");
    await mkdir(path.join(directory, "notes", "deeper"), { recursive: true });
    await writeFile(path.join(directory, "notes", "a.md"), "hello\n");
    const withoutGit = await guard({ gitCommand: () => path.join(directory, "absent-git") });
    expect(await withoutGit(path.join(directory, "notes"))).toEqual({ kind: "safe" });
  });

  test("a repository with no linked worktrees can be renamed", async () => {
    const { main } = await repository("solo");
    expect(await (await guard())(main)).toEqual({ kind: "safe" });
  });

  test("a subfolder inside a checkout that owns worktrees is still safe", async () => {
    const { workspace, main } = await repository("subfolder");
    await git(main, ["worktree", "add", "-b", "feature/login", "--", path.join(workspace, "linked")]);
    await mkdir(path.join(main, "docs"), { recursive: true });
    expect(await (await guard())(path.join(main, "docs"))).toEqual({ kind: "safe" });
  });

  test("an unrelated sibling folder beside a worktree structure is safe", async () => {
    const { workspace, main } = await repository("sibling");
    await git(main, ["worktree", "add", "-b", "feature/login", "--", path.join(workspace, "linked")]);
    const unrelated = path.join(workspace, "unrelated");
    await mkdir(unrelated, { recursive: true });
    await writeFile(path.join(unrelated, "notes.md"), "kept\n");
    expect(await (await guard())(unrelated)).toEqual({ kind: "safe" });
  });
});

describe("moves that would break Git worktree links are refused", () => {
  test("the main checkout of a repository that owns a linked worktree", async () => {
    const { workspace, main } = await repository("main-checkout");
    await git(main, ["worktree", "add", "-b", "feature/login", "--", path.join(workspace, "linked")]);
    const verdict = await (await guard())(main);
    expect(verdict.kind).toBe("blocked");
    if (verdict.kind === "blocked") expect(verdict.reason).toContain("not registered in Uatu");
  });

  test("a linked checkout itself", async () => {
    const { workspace, main } = await repository("linked-checkout");
    const linked = path.join(workspace, "linked");
    await git(main, ["worktree", "add", "-b", "feature/login", "--", linked]);
    expect((await (await guard())(linked)).kind).toBe("blocked");
  });

  test("an ancestor that contains only the main checkout", async () => {
    const { workspace, main } = await repository("ancestor-main", path.join("group", "repo"));
    await git(main, ["worktree", "add", "-b", "feature/login", "--", path.join(workspace, "linked")]);
    expect((await (await guard())(path.join(workspace, "group"))).kind).toBe("blocked");
  });

  test("an ancestor that contains only the linked checkout", async () => {
    const { workspace, main } = await repository("ancestor-linked");
    await mkdir(path.join(workspace, "trees"), { recursive: true });
    await git(main, ["worktree", "add", "-b", "feature/login", "--", path.join(workspace, "trees", "linked")]);
    expect((await (await guard())(path.join(workspace, "trees"))).kind).toBe("blocked");
  });

  test("a worktree Uatu never registered still blocks the move", async () => {
    // The guard consults Git, never the Hub registry — which is precisely
    // what makes an unregistered linked tree count.
    const { workspace, main } = await repository("unregistered");
    await git(main, ["worktree", "add", "-b", "agent/exploration", "--", path.join(workspace, "agent-tree")]);
    expect((await (await guard())(main)).kind).toBe("blocked");
    expect((await (await guard())(path.join(workspace, "agent-tree"))).kind).toBe("blocked");
  });

  test("a separate common Git directory that owns worktrees", async () => {
    const { main } = await repository("bare-origin");
    const holder = await temporaryDirectory("bare-holder");
    const bare = path.join(holder, "store", "atlas.git");
    await mkdir(path.dirname(bare), { recursive: true });
    await git(holder, ["clone", "--bare", "--", main, bare]);
    await git(bare, ["worktree", "add", "-b", "feature/login", "--", path.join(holder, "linked")]);
    // Moving the folder that holds the bare repository would break the
    // linked tree's gitdir pointer, even though it carries no `.git` entry.
    expect((await (await guard())(path.join(holder, "store"))).kind).toBe("blocked");
  });
});

describe("uncertainty fails closed", () => {
  test("an unusable Git makes a Git-adjacent rename inconclusive, not safe", async () => {
    const { main } = await repository("no-git");
    const verdict = await (await guard({ gitCommand: () => path.join(main, "absent-git") }))(main);
    expect(verdict.kind).toBe("inconclusive");
    if (verdict.kind === "inconclusive") expect(verdict.reason).toContain("could not establish");
  });

  test("an unreadable or oversized subtree is inconclusive rather than partially scanned", async () => {
    const { workspace, main } = await repository("bounded");
    await git(main, ["worktree", "add", "-b", "feature/login", "--", path.join(workspace, "linked")]);
    const deep = path.join(workspace, "a", "b", "c", "d", "e", "f", "g");
    await mkdir(deep, { recursive: true });
    const truncated = await guard({ maxEntries: 1 });
    expect((await truncated(path.join(workspace, "a"))).kind).toBe("inconclusive");
  });

  test("a Git that cannot list worktrees is inconclusive", async () => {
    const { main } = await repository("list-failure");
    const probe = await guard({
      run: async args => args[0] === "rev-parse"
        ? { exitCode: 0, stdout: `${main}/.git\n${main}/.git\nfalse\n${main}\n`, stderr: "", timedOut: false, outputExceeded: false }
        : { exitCode: 128, stdout: "", stderr: "fatal: unable to read worktrees", timedOut: false, outputExceeded: false },
    });
    expect((await probe(main)).kind).toBe("inconclusive");
  });
});

describe("submodules", () => {
  test("a superproject with a submodule and no linked worktrees is renameable", async () => {
    const { main: dependency } = await repository("submodule-dependency");
    const { workspace, main } = await repository("submodule-super");
    await git(main, ["submodule", "add", "--", dependency, "vendor/dependency"]);
    await git(main, ["commit", "-m", "add submodule"]);
    // The submodule's gitdir link is relative, so the whole superproject
    // moves intact; nothing here is a worktree dependency.
    expect(await (await guard())(main)).toEqual({ kind: "safe" });
    expect(await (await guard())(workspace)).toEqual({ kind: "safe" });
  });

  test("a submodule that owns a linked worktree blocks its superproject's move", async () => {
    const { main: dependency } = await repository("submodule-worktree-dependency");
    const { workspace, main } = await repository("submodule-worktree-super");
    await git(main, ["submodule", "add", "--", dependency, "vendor/dependency"]);
    await git(main, ["commit", "-m", "add submodule"]);
    await git(path.join(main, "vendor", "dependency"), ["worktree", "add", "-b", "feature/login", "--", path.join(workspace, "submodule-linked")]);
    expect((await (await guard())(main)).kind).toBe("blocked");
  });
});
