import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promises as nodeFs } from "node:fs";
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

  test("a leaf containing only files at the depth limit is fully examined", async () => {
    const directory = await temporaryDirectory("depth-leaf");
    const leaf = path.join(directory, "a", "b", "c", "d", "e", "f");
    await mkdir(leaf, { recursive: true });
    await writeFile(path.join(leaf, "notes.md"), "hello\n");
    expect(await (await guard())(directory)).toEqual({ kind: "safe" });
    expect(await (await guard({ maxDepth: 0 }))(leaf)).toEqual({ kind: "safe" });
  });

  test("a repository at the depth limit cannot establish safety without scanning its contents", async () => {
    const { workspace, main } = await repository("depth-solo", path.join("a", "b", "c", "d", "e", "repo"));
    await mkdir(path.join(main, "docs", "nested"), { recursive: true });
    expect((await (await guard())(workspace)).kind).toBe("inconclusive");
    expect((await (await guard({ maxDepth: 0 }))(main)).kind).toBe("inconclusive");
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
  test("an independent repository nested in a checkout owns an external linked tree", async () => {
    const { workspace, main } = await repository("nested-independent");
    const nested = path.join(main, "vendor", "independent");
    await mkdir(nested, { recursive: true });
    await git(nested, ["init", "--initial-branch=main"]);
    await git(nested, ["commit", "--allow-empty", "-m", "initial"]);
    await git(nested, ["worktree", "add", "-b", "external", path.join(workspace, "external")]);
    expect((await (await guard())(main)).kind).toBe("blocked");
  });
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
  test("unreadable nested checkout contents and Git markers are inconclusive", async () => {
    const { main } = await repository("unreadable-nested");
    await mkdir(path.join(main, "vendor"));
    for (const operation of ["lstat", "readdir"] as const) {
      const probe = await guard({ fs: {
        ...nodeFs,
        [operation]: async (candidate: string, options: unknown) => {
          if (String(candidate).includes(`${path.sep}vendor`)) throw Object.assign(new Error("denied"), { code: "EACCES" });
          return (nodeFs[operation] as Function)(candidate, options);
        },
      } });
      expect((await probe(main)).kind).toBe("inconclusive");
    }
  });
  test("an unregistered repository beyond the default scan depth makes its ancestor inconclusive", async () => {
    const { workspace, main } = await repository("deep-main", path.join("source", "a", "b", "c", "d", "e", "f", "repo"));
    await git(main, ["worktree", "add", "-b", "feature/deep", "--", path.join(workspace, "linked")]);
    const source = path.join(workspace, "source");
    expect((await (await guard())(source)).kind).toBe("inconclusive");
    // With enough scan depth, Git confirms the dependency rather than merely
    // refusing because some of the subtree could not be examined.
    expect((await (await guard({ maxDepth: 7 }))(source)).kind).toBe("blocked");
  });

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
  test("unreadable submodule directories fail closed, including nested name groups", async () => {
    const { main: dependency } = await repository("unreadable-submodule-dependency");
    const { main } = await repository("unreadable-submodule-super");
    await git(main, ["submodule", "add", "--", dependency, "vendor/dependency"]);
    for (const suffix of [path.join(".git", "modules"), path.join(".git", "modules", "vendor")]) {
      const probe = await guard({
        fs: {
          ...nodeFs,
          readdir: (async (directory: string, options: unknown) => {
            if (String(directory).endsWith(suffix)) throw Object.assign(new Error("denied"), { code: "EACCES" });
            return nodeFs.readdir(directory, options as { withFileTypes: true });
          }) as typeof nodeFs.readdir,
        },
      });
      expect((await probe(main)).kind).toBe("inconclusive");
    }
  });

  test("submodule scanning respects the entry budget and accepts a fully inspected boundary repository", async () => {
    const { main: dependency } = await repository("bounded-submodule-dependency");
    const { main } = await repository("bounded-submodule-super");
    await git(main, ["submodule", "add", "--", dependency, "vendor/dependency"]);
    expect((await (await guard({ maxEntries: 1 }))(main)).kind).toBe("inconclusive");
    expect(await (await guard({ maxDepth: 2, maxEntries: 2 }))(main)).toEqual({ kind: "safe" });
  });

  test("a deeply named submodule with an external linked worktree makes inspection inconclusive", async () => {
    const { main: dependency } = await repository("deep-submodule-dependency");
    const { workspace, main } = await repository("deep-submodule-super");
    const name = "a/b/c/d/e/f/g/h/dependency";
    await git(main, ["submodule", "add", "--", dependency, name]);
    await git(path.join(main, name), ["worktree", "add", "-b", "feature/deep", "--", path.join(workspace, "linked")]);
    expect((await (await guard())(main)).kind).toBe("inconclusive");
    expect((await (await guard({ maxDepth: 9 }))(main)).kind).toBe("blocked");
  });

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
