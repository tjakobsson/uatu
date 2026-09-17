import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertGitArgumentSafe,
  buildWorktreeProbeEnvironment,
  checkoutForBranch,
  createGitRunner,
  inspectCheckout,
  listRefs,
  listWorktrees,
  parseWorktreeListPorcelain,
  probeGitCapabilities,
  repositoryContext,
  WORKTREE_GIT_MINIMUM_VERSION,
} from "./worktree-git";
import { WorktreeOperationCoordinator } from "./worktree-coordinator";

// Real Git, real temporary repositories, never the Uatu checkout itself. The
// environment is built explicitly rather than inherited: developing Uatu
// inside a Hub-managed workspace projects Git/SSH wrappers and a global
// config, and a probe test must not discover them.
const temporaryDirectories: string[] = [];
let sharedHome: string | undefined;

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `uatu-worktree-${label}-`));
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

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: await cleanEnvironment(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout;
}

// Each repository gets its own temporary PARENT, so sibling destinations
// (`<main>.worktrees/…`, the linked trees below) never collide between tests.
async function createRepository(label = "repo", folder = "repo"): Promise<string> {
  const parent = await temporaryDirectory(label);
  const repository = path.join(parent, folder);
  await mkdir(repository, { recursive: true });
  await git(repository, ["init", "--initial-branch=main"]);
  await writeFile(path.join(repository, "README.md"), "# Readme\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "initial"]);
  return repository;
}

async function options(): Promise<{ env: Record<string, string> }> {
  return { env: await cleanEnvironment() };
}

afterAll(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("git capability floor", () => {
  test("reports the installed version and that it supports worktrees", async () => {
    const repository = await createRepository("capability");
    const capabilities = await probeGitCapabilities(repository, await options());
    expect(capabilities.available).toBe(true);
    expect(capabilities.version).toMatch(/^\d+\.\d+/);
    expect(`${capabilities.version} supported=${capabilities.supported}`).toBe(`${capabilities.version} supported=true`);
    expect(capabilities.reason).toBeUndefined();
  });

  test("an absent Git makes worktree operations unsupported rather than silent", async () => {
    const repository = await createRepository("no-git");
    const capabilities = await probeGitCapabilities(repository, {
      ...await options(),
      gitCommand: () => path.join(repository, "definitely-not-git"),
    });
    expect(capabilities).toEqual({ available: false, version: null, supported: false, reason: "Git is not available on this Hub." });
  });

  test("a Git below the floor is refused with its version", async () => {
    const repository = await createRepository("old-git");
    const capabilities = await probeGitCapabilities(repository, {
      run: async () => ({ exitCode: 0, stdout: "git version 2.20.1\n", stderr: "", timedOut: false, outputExceeded: false }),
    });
    expect(capabilities.supported).toBe(false);
    expect(capabilities.reason).toContain(WORKTREE_GIT_MINIMUM_VERSION);
    expect(capabilities.reason).toContain("2.20.1");
  });
});

describe("canonical repository and checkout identity", () => {
  test("a linked worktree shares its main checkout's repository identity", async () => {
    const repository = await createRepository("identity");
    const linked = path.join(path.dirname(repository), "linked");
    await git(repository, ["worktree", "add", "-b", "feature/login", "--", linked]);

    const main = await repositoryContext(repository, await options());
    const child = await repositoryContext(linked, await options());
    expect(main.kind).toBe("checkout");
    expect(child.kind).toBe("checkout");
    if (main.kind !== "checkout" || child.kind !== "checkout") return;
    expect(child.identity.repositoryId).toBe(main.identity.repositoryId);
    expect(child.identity.checkoutId).not.toBe(main.identity.checkoutId);
    expect(main.main).toBe(true);
    expect(child.main).toBe(false);
    expect(child.commonDirectory).toBe(main.commonDirectory);
  });

  test("two repositories never share an identity", async () => {
    const [first, second] = await Promise.all([createRepository("first"), createRepository("second")]);
    const [left, right] = await Promise.all([repositoryContext(first, await options()), repositoryContext(second, await options())]);
    if (left.kind !== "checkout" || right.kind !== "checkout") throw new Error("expected two repositories");
    expect(left.identity.repositoryId).not.toBe(right.identity.repositoryId);
  });

  test("a symlinked path resolves to the same identity as the real one", async () => {
    const repository = await createRepository("symlink");
    const link = path.join(await temporaryDirectory("symlink-alias"), "alias");
    await symlink(repository, link);
    const [real, aliased] = await Promise.all([repositoryContext(repository, await options()), repositoryContext(link, await options())]);
    if (real.kind !== "checkout" || aliased.kind !== "checkout") throw new Error("expected a repository through both paths");
    expect(aliased.identity).toEqual(real.identity);
  });

  test("paths with spaces, unicode and a leading dash are ordinary", async () => {
    const repository = await createRepository("unusual", "répö dir -weird");
    const linked = path.join(path.dirname(repository), "linked tree ✨");
    await git(repository, ["worktree", "add", "-b", "feature/sidebar", "--", linked]);
    const child = await repositoryContext(linked, await options());
    if (child.kind !== "checkout") throw new Error("expected a checkout");
    expect(child.main).toBe(false);

    const inventory = await listWorktrees(repository, await options());
    if (inventory.kind !== "inventory") throw new Error("expected an inventory");
    expect(inventory.records.map(record => path.basename(record.path))).toContain("linked tree ✨");
  });

  test("a directory outside any repository is proved absent, not guessed", async () => {
    const plain = await temporaryDirectory("plain");
    expect((await repositoryContext(plain, await options())).kind).toBe("not-a-repository");
  });

  test("an unreadable repository is indeterminate so callers can fail closed", async () => {
    const plain = await temporaryDirectory("dubious");
    const context = await repositoryContext(plain, {
      run: async () => ({ exitCode: 128, stdout: "", stderr: "fatal: detected dubious ownership in repository", timedOut: false, outputExceeded: false }),
    });
    expect(context.kind).toBe("indeterminate");
    if (context.kind === "indeterminate") expect(context.detail).toContain("dubious ownership");
  });
});

describe("worktree inventory", () => {
  test("lists main, linked, detached and locked trees with their branches", async () => {
    const repository = await createRepository("inventory");
    const parent = path.dirname(repository);
    await git(repository, ["worktree", "add", "-b", "feature/login", "--", path.join(parent, "feature")]);
    await git(repository, ["worktree", "add", "--detach", "--", path.join(parent, "detached")]);
    await git(repository, ["worktree", "add", "-b", "locked-branch", "--", path.join(parent, "locked")]);
    await git(repository, ["worktree", "lock", "--reason", "review in progress", "--", path.join(parent, "locked")]);

    const inventory = await listWorktrees(repository, await options());
    if (inventory.kind !== "inventory") throw new Error("expected an inventory");
    expect(inventory.records).toHaveLength(4);
    expect(checkoutForBranch(inventory.records, "feature/login")?.path).toContain("feature");
    expect(checkoutForBranch(inventory.records, "main")?.detached).toBe(false);
    expect(inventory.records.find(record => record.detached)?.branch).toBeNull();
    const locked = checkoutForBranch(inventory.records, "locked-branch");
    expect(locked?.locked).toBe(true);
    expect(locked?.lockReason).toBe("review in progress");
  });

  test("branch occupancy is scoped to one repository", async () => {
    const [first, second] = await Promise.all([createRepository("occupancy-first"), createRepository("occupancy-second")]);
    await git(first, ["worktree", "add", "-b", "feature/login", "--", path.join(path.dirname(first), "shared-name")]);
    const [left, right] = await Promise.all([listWorktrees(first, await options()), listWorktrees(second, await options())]);
    if (left.kind !== "inventory" || right.kind !== "inventory") throw new Error("expected inventories");
    expect(checkoutForBranch(left.records, "feature/login")).toBeDefined();
    expect(checkoutForBranch(right.records, "feature/login")).toBeUndefined();
  });

  test("the NUL-terminated form survives a path containing a newline", () => {
    const records = parseWorktreeListPorcelain(
      "worktree /repos/atlas\0HEAD abc123\0branch refs/heads/main\0\0worktree /repos/line\nbreak\0HEAD def456\0detached\0prunable gitdir file points nowhere\0\0",
    );
    expect(records).toHaveLength(2);
    expect(records[1]?.path).toBe("/repos/line\nbreak");
    expect(records[1]?.detached).toBe(true);
    expect(records[1]?.prunable).toBe(true);
    expect(records[0]?.branch).toBe("main");
  });

  test("an unreadable listing is indeterminate rather than an empty inventory", async () => {
    const inventory = await listWorktrees("/nowhere", {
      run: async () => ({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository", timedOut: false, outputExceeded: false }),
    });
    expect(inventory.kind).toBe("indeterminate");
  });
});

describe("cached ref listing", () => {
  test("lists local branches and remote-qualified refs without touching a network", async () => {
    const origin = await createRepository("origin");
    await git(origin, ["branch", "release"]);
    const clone = await temporaryDirectory("clone");
    await git(clone, ["clone", "--", origin, "checkout"]);
    const checkout = path.join(clone, "checkout");
    await git(checkout, ["branch", "feature/login"]);

    const refs = await listRefs(checkout, await options());
    if (refs.kind !== "refs") throw new Error("expected refs");
    expect([...refs.local].sort()).toEqual(["feature/login", "main"]);
    expect([...refs.remote].sort()).toEqual(["origin/main", "origin/release"]);
    expect(refs.remote.some(ref => ref.endsWith("/HEAD"))).toBe(false);
  });
});

describe("argument safety", () => {
  test("option-like and control-bearing values never reach a Git argument list", () => {
    for (const value of ["-f", "--force", "", "a b", "ab"]) {
      expect(() => assertGitArgumentSafe(value, "branch")).toThrow(/not a usable value/);
    }
    expect(assertGitArgumentSafe("feature/login", "branch")).toBe("feature/login");
  });

  test("the probe environment drops ambient repository redirection", () => {
    const env = buildWorktreeProbeEnvironment({
      PATH: "/bin",
      GIT_DIR: "/somewhere/.git",
      GIT_WORK_TREE: "/somewhere",
      GIT_INDEX_FILE: "/somewhere/.git/index",
      GIT_CEILING_DIRECTORIES: "/",
      GIT_ASKPASS: "/ambient/askpass",
      GIT_CONFIG_GLOBAL: "/kept/config",
    });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_CEILING_DIRECTORIES).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
    // safe.directory lives in the global config, so it is deliberately kept.
    expect(env.GIT_CONFIG_GLOBAL).toBe("/kept/config");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
  });

  test("a probe that hangs or floods is bounded, not awaited forever", async () => {
    const directory = await temporaryDirectory("bounded");
    const slow = path.join(directory, "slow-git");
    await writeFile(slow, "#!/bin/sh\nsleep 30\n");
    await chmod(slow, 0o755);
    const hang = await createGitRunner({ gitCommand: () => slow, timeoutMs: 250, env: await cleanEnvironment() })(["--version"], directory);
    expect(hang.timedOut).toBe(true);

    const loud = path.join(directory, "loud-git");
    await writeFile(loud, "#!/bin/sh\nyes uatu | head -c 200000\n");
    await chmod(loud, 0o755);
    const flood = await createGitRunner({ gitCommand: () => loud, outputLimit: 1024, env: await cleanEnvironment() })(["--version"], directory);
    expect(flood.outputExceeded).toBe(true);
    expect(flood.stdout.length).toBeLessThanOrEqual(1024);
  });
});

describe("checkout inspection", () => {
  test("distinguishes a live checkout, a missing path and an occupied one", async () => {
    const repository = await createRepository("inspect");
    const parent = path.dirname(repository);
    const linked = path.join(parent, "linked");
    await git(repository, ["worktree", "add", "-b", "feature/inspect", "--", linked]);

    const live = await inspectCheckout(linked, await options());
    expect(live.present).toBe(true);
    expect(live.identityReadable).toBe(true);
    const context = await repositoryContext(linked, await options());
    if (context.kind !== "checkout") throw new Error("expected a checkout");
    expect(live.identity).toEqual(context.identity);

    expect(await inspectCheckout(path.join(parent, "absent"), await options()))
      .toEqual({ present: false, identityReadable: true });

    const plain = path.join(parent, "occupant");
    await mkdir(plain, { recursive: true });
    await writeFile(path.join(plain, "notes.md"), "kept\n");
    const occupied = await inspectCheckout(plain, await options());
    expect(occupied.present).toBe(true);
    expect(occupied.identity).toBeUndefined();
    expect(occupied.identityReadable).toBe(true);
  });

  test("a subdirectory of a checkout is not mistaken for the checkout", async () => {
    const repository = await createRepository("subdirectory");
    const nested = path.join(repository, "docs");
    await mkdir(nested, { recursive: true });
    const inspection = await inspectCheckout(nested, await options());
    expect(inspection.identity).toBeUndefined();
    expect(inspection.detail).toBe("path is not a checkout root");
  });

  test("an unprovable identity is reported unreadable, never assumed absent", async () => {
    const repository = await createRepository("unreadable");
    const inspection = await inspectCheckout(repository, {
      run: async () => ({ exitCode: 128, stdout: "", stderr: "fatal: detected dubious ownership", timedOut: false, outputExceeded: false }),
    });
    expect(inspection).toEqual({ present: true, identityReadable: false, detail: "fatal: detected dubious ownership" });
  });
});

describe("concurrent operations against one repository", () => {
  test("probes on one repository serialize while other repositories proceed", async () => {
    const [first, second] = await Promise.all([createRepository("concurrent-first"), createRepository("concurrent-second")]);
    const [left, right] = await Promise.all([repositoryContext(first, await options()), repositoryContext(second, await options())]);
    if (left.kind !== "checkout" || right.kind !== "checkout") throw new Error("expected repositories");
    const coordinator = new WorktreeOperationCoordinator();
    const order: string[] = [];

    const probe = (label: string, repository: string, identity: string) =>
      coordinator.run({ repositoryId: identity, paths: [repository] }, async () => {
        order.push(`${label}:start`);
        const inventory = await listWorktrees(repository, await options());
        order.push(`${label}:end`);
        return inventory;
      });

    const results = await Promise.all([
      probe("a", first, left.identity.repositoryId),
      probe("b", first, left.identity.repositoryId),
      probe("c", second, right.identity.repositoryId),
    ]);
    expect(results.every(result => result.kind === "inventory")).toBe(true);
    expect(order.indexOf("a:end")).toBeLessThan(order.indexOf("b:start"));
    expect(coordinator.busy(left.identity.repositoryId)).toBe(false);
  });
});
