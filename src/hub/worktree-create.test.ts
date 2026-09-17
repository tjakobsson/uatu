import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertNoForceFlags,
  buildWorktreeAddArguments,
  destinationOccupied,
  mainCheckoutPathFor,
  planWorktreeCreation,
  runWorktreeAdd,
  targetBranchFor,
  type WorktreeCreationPlan,
} from "./worktree-create";
import { createGitRunner, listRefs, listWorktrees, repositoryContext, type GitRun } from "./worktree-git";
import { WorktreeOperationError, type WorktreeCreateRequest } from "../shared/worktree-contract";

// Real Git, real temporary repositories, never the Uatu checkout itself. The
// environment is built explicitly: developing Uatu inside a Hub-managed
// workspace projects Git/SSH wrappers and a global config, and creation
// tests must not discover them.
const temporaryDirectories: string[] = [];
let sharedHome: string | undefined;

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `uatu-worktree-create-${label}-`));
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

async function createRepository(label: string, folder = "atlas"): Promise<string> {
  const parent = await temporaryDirectory(label);
  const repository = path.join(parent, folder);
  await mkdir(repository, { recursive: true });
  await git(repository, ["init", "--initial-branch=main"]);
  await writeFile(path.join(repository, "README.md"), "# Readme\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "initial"]);
  return repository;
}

// A second repository fetched into the first as "origin": remote-tracking
// refs without a network.
async function addOrigin(repository: string, branches: string[]): Promise<string> {
  const origin = await createRepository("origin", "origin");
  for (const branch of branches) {
    await git(origin, ["checkout", "-b", branch]);
    await writeFile(path.join(origin, `${branch.replace(/\W/g, "-")}.md`), "content\n");
    await git(origin, ["add", "."]);
    await git(origin, ["commit", "-m", `on ${branch}`]);
  }
  await git(origin, ["checkout", "main"]);
  await git(repository, ["remote", "add", "origin", origin]);
  await git(repository, ["fetch", "origin"]);
  return origin;
}

async function options(): Promise<{ env: Record<string, string> }> {
  return { env: await cleanEnvironment() };
}

async function plan(repository: string, request: Pick<WorktreeCreateRequest, "mode" | "branch" | "base">): Promise<WorktreeCreationPlan> {
  const context = await repositoryContext(repository, await options());
  if (context.kind !== "checkout") throw new Error("expected a checkout");
  const refs = await listRefs(repository, await options());
  const inventory = await listWorktrees(repository, await options());
  if (refs.kind !== "refs" || inventory.kind !== "inventory") throw new Error("expected refs and inventory");
  return planWorktreeCreation({
    request,
    mainPath: mainCheckoutPathFor(context.commonDirectory),
    refs,
    records: inventory.records,
    occupied: destinationOccupied,
  });
}

async function create(repository: string, request: Pick<WorktreeCreateRequest, "mode" | "branch" | "base">) {
  const created = await plan(repository, request);
  const outcome = await runWorktreeAdd(createGitRunner(await options()), repository, created);
  return { plan: created, outcome };
}

function detail(error: unknown) {
  if (!(error instanceof WorktreeOperationError)) throw error;
  return error.detail;
}

async function rejection(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    return detail(error);
  }
  throw new Error("expected a refusal");
}

afterAll(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("new branch from an explicitly selected base", () => {
  test("creates the branch at the selected base with no upstream", async () => {
    const repository = await createRepository("new-branch");
    await git(repository, ["branch", "release"]);
    await writeFile(path.join(repository, "extra.md"), "extra\n");
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "-m", "second"]);
    // The parent checkout deliberately sits on another branch: the base is
    // the explicit selection, never the current HEAD.
    await git(repository, ["checkout", "-b", "feature/current"]);

    const { plan: created, outcome } = await create(repository, {
      mode: "new-branch",
      branch: "feature/login",
      base: { kind: "local", ref: "release" },
    });
    expect(outcome.ok).toBe(true);
    expect(created.branch).toBe("feature/login");
    expect(created.sourceRef).toBe("release");
    expect(created.destination).toBe(`${await realpath(repository)}.worktrees/feature-login`);

    expect((await git(created.destination, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature/login");
    expect((await git(created.destination, ["rev-parse", "HEAD"])).trim())
      .toBe((await git(repository, ["rev-parse", "release"])).trim());
    // --no-track: a new branch never acquires an upstream by configuration.
    const upstream = await git(created.destination, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => "none");
    expect(upstream.trim()).toBe("none");
  });

  test("a remote base still produces an untracked new branch", async () => {
    const repository = await createRepository("new-from-remote");
    await addOrigin(repository, ["release"]);

    const { plan: created, outcome } = await create(repository, {
      mode: "new-branch",
      branch: "feature/from-remote",
      base: { kind: "remote", ref: "origin/release" },
    });
    expect(outcome.ok).toBe(true);
    expect(created.sourceRef).toBe("origin/release");
    expect(created.upstream).toBeUndefined();
    expect((await git(created.destination, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature/from-remote");
    expect((await git(created.destination, ["rev-parse", "HEAD"])).trim())
      .toBe((await git(repository, ["rev-parse", "origin/release"])).trim());
    const upstream = await git(created.destination, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => "none");
    expect(upstream.trim()).toBe("none");
  });

  test("an existing branch name is refused without resetting it", async () => {
    const repository = await createRepository("name-taken");
    await git(repository, ["branch", "feature/login"]);
    const before = (await git(repository, ["rev-parse", "feature/login"])).trim();
    await git(repository, ["commit", "--allow-empty", "-m", "moved main"]);

    const refusal = await rejection(plan(repository, {
      mode: "new-branch",
      branch: "feature/login",
      base: { kind: "local", ref: "main" },
    }));
    expect(refusal.code).toBe("branch-exists");
    expect((await git(repository, ["rev-parse", "feature/login"])).trim()).toBe(before);
  });

  test("a checked-out branch remains a valid base for another new branch", async () => {
    const repository = await createRepository("base-checked-out");
    const { outcome } = await create(repository, {
      mode: "new-branch",
      branch: "feature/from-main",
      base: { kind: "local", ref: "main" },
    });
    expect(outcome.ok).toBe(true);
  });
});

describe("existing local branch", () => {
  test("checks the branch out unchanged", async () => {
    const repository = await createRepository("existing-local");
    await git(repository, ["branch", "fix/navigation"]);
    const revision = (await git(repository, ["rev-parse", "fix/navigation"])).trim();

    const { plan: created, outcome } = await create(repository, {
      mode: "existing-local",
      base: { kind: "local", ref: "fix/navigation" },
    });
    expect(outcome.ok).toBe(true);
    expect(created.branch).toBe("fix/navigation");
    expect(buildWorktreeAddArguments(created)).toEqual(["worktree", "add", created.destination, "fix/navigation"]);
    expect((await git(created.destination, ["rev-parse", "HEAD"])).trim()).toBe(revision);
  });

  test("a branch checked out elsewhere offers that checkout instead of forcing", async () => {
    const repository = await createRepository("occupied");
    await git(repository, ["branch", "feature/sidebar"]);
    const first = await create(repository, { mode: "existing-local", base: { kind: "local", ref: "feature/sidebar" } });
    expect(first.outcome.ok).toBe(true);

    const refusal = await rejection(plan(repository, { mode: "existing-local", base: { kind: "local", ref: "feature/sidebar" } }));
    expect(refusal.code).toBe("branch-in-use");
    expect(refusal.retry).toBe("open-existing");
    // The hint names the existing checkout, so the UI can offer to open it.
    expect(refusal.conflictCheckoutId).toBe(first.plan.destination);
  });
});

describe("remote-tracking branch", () => {
  test("derives the local name and establishes exactly the selected upstream", async () => {
    const repository = await createRepository("tracking");
    await addOrigin(repository, ["feature/search"]);

    const { plan: created, outcome } = await create(repository, {
      mode: "remote-tracking",
      base: { kind: "remote", ref: "origin/feature/search" },
    });
    expect(outcome.ok).toBe(true);
    expect(created.branch).toBe("feature/search");
    expect(created.upstream).toBe("origin/feature/search");
    expect(created.sourceRef).toBe("origin/feature/search");
    expect((await git(created.destination, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature/search");
    expect((await git(created.destination, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).trim())
      .toBe("origin/feature/search");
  });

  test("an existing local name conflicts rather than resetting the branch", async () => {
    const repository = await createRepository("tracking-conflict");
    await addOrigin(repository, ["feature/search"]);
    await git(repository, ["branch", "feature/search", "main"]);
    const before = (await git(repository, ["rev-parse", "feature/search"])).trim();

    const refusal = await rejection(plan(repository, {
      mode: "remote-tracking",
      base: { kind: "remote", ref: "origin/feature/search" },
    }));
    expect(refusal.code).toBe("branch-exists");
    expect((await git(repository, ["rev-parse", "feature/search"])).trim()).toBe(before);
  });

  test("a client-supplied branch that disagrees with the derivation is refused", async () => {
    expect(() => targetBranchFor({ mode: "remote-tracking", branch: "other", base: { kind: "remote", ref: "origin/feature/search" } }))
      .toThrow(/does not match/);
    expect(targetBranchFor({ mode: "remote-tracking", base: { kind: "remote", ref: "origin/feature/search" } })).toBe("feature/search");
  });
});

describe("destinations", () => {
  test("two branches sanitizing to one folder are disambiguated without overwrite", async () => {
    const repository = await createRepository("collision");
    const first = await create(repository, { mode: "new-branch", branch: "feature/login", base: { kind: "local", ref: "main" } });
    const second = await create(repository, { mode: "new-branch", branch: "feature-login", base: { kind: "local", ref: "main" } });
    expect(first.outcome.ok).toBe(true);
    expect(second.outcome.ok).toBe(true);
    const canonical = await realpath(repository);
    expect(first.plan.destination).toBe(`${canonical}.worktrees/feature-login`);
    expect(second.plan.disambiguated).toBe(true);
    expect(second.plan.destination).not.toBe(first.plan.destination);
    expect(second.plan.destination.startsWith(`${canonical}.worktrees/feature-login-`)).toBe(true);
    // The first checkout is untouched — its own branch, its own content.
    expect((await git(first.plan.destination, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature/login");
    expect((await readdir(`${canonical}.worktrees`)).length).toBe(2);
  });

  test("both candidates occupied refuses rather than overwriting", async () => {
    const repository = await createRepository("occupied-destination");
    const occupied = async () => true;
    const refusal = await rejection(planWorktreeCreation({
      request: { mode: "new-branch", branch: "feature/login", base: { kind: "local", ref: "main" } },
      mainPath: repository,
      refs: { local: ["main"], remote: [] },
      records: [],
      occupied,
    }));
    expect(refusal.code).toBe("destination-occupied");
  });

  test("the displayed branch keeps its exact spelling while the folder is sanitized", async () => {
    const repository = await createRepository("spelling");
    const { plan: created } = await create(repository, { mode: "new-branch", branch: "Feature/Login_2", base: { kind: "local", ref: "main" } });
    expect(created.branch).toBe("Feature/Login_2");
    expect(path.basename(created.destination)).toBe("feature-login_2");
  });
});

describe("refusals before Git runs", () => {
  const base = { kind: "local", ref: "main" } as const;
  const refs = { local: ["main"], remote: ["origin/main"] };
  const never = async () => {
    throw new Error("the destination must not be inspected for an invalid request");
  };

  test.each(["-f", "--force", "../escape", "main~1", "feature/.hidden", "feature/x.lock", "with space", ""])(
    "refuses the branch name %p before any repository is touched", async branch => {
    const refusal = await rejection(planWorktreeCreation({
      request: { mode: "new-branch", branch, base },
      mainPath: "/tmp/atlas",
      refs,
      records: [],
      occupied: never,
    }));
    expect(refusal.code).toBe("invalid-input");
  });

  test("an unavailable base is refused without substituting another ref", async () => {
    const refusal = await rejection(planWorktreeCreation({
      request: { mode: "new-branch", branch: "feature/login", base: { kind: "local", ref: "gone" } },
      mainPath: "/tmp/atlas",
      refs,
      records: [],
      occupied: never,
    }));
    expect(refusal.code).toBe("ref-unavailable");
    expect(refusal.retry).toBe("refresh");
  });

  test("the same branch in another repository is not a conflict", async () => {
    const created = await planWorktreeCreation({
      request: { mode: "new-branch", branch: "feature/login", base },
      mainPath: "/tmp/atlas",
      refs,
      // Records come from ONE repository's `worktree list`; another
      // repository's identical branch never appears here.
      records: [],
      occupied: async () => false,
    });
    expect(created.branch).toBe("feature/login");
  });

  test("a bare or separate-git-dir repository is refused as a creation source", () => {
    expect(() => mainCheckoutPathFor("/tmp/atlas.git")).toThrow(/layout/);
    expect(mainCheckoutPathFor("/tmp/atlas/.git")).toBe("/tmp/atlas");
  });
});

describe("no force flags are ever passed", () => {
  const plans: WorktreeCreationPlan[] = [
    { mode: "new-branch", branch: "a", base: { kind: "local", ref: "main" }, sourceRef: "main", destination: "/tmp/a", disambiguated: false },
    { mode: "existing-local", branch: "b", base: { kind: "local", ref: "b" }, sourceRef: "b", destination: "/tmp/b", disambiguated: false },
    { mode: "remote-tracking", branch: "c", base: { kind: "remote", ref: "origin/c" }, sourceRef: "origin/c", upstream: "origin/c", destination: "/tmp/c", disambiguated: false },
  ];

  test("every mode's argument list is free of force and detach flags", () => {
    for (const plan of plans) {
      const args = buildWorktreeAddArguments(plan);
      expect(args.filter(arg => /^-(f|-force|-detach|-reason)$/.test(arg))).toEqual([]);
      expect(() => assertNoForceFlags(args)).not.toThrow();
    }
    expect(() => assertNoForceFlags(["worktree", "add", "--force", "/tmp/a"])).toThrow();
  });

  test("the recorded invocation of a real creation contains no force flag", async () => {
    const repository = await createRepository("recorded");
    const invocations: string[][] = [];
    const recording = createGitRunner(await options());
    const created = await plan(repository, { mode: "new-branch", branch: "feature/recorded", base: { kind: "local", ref: "main" } });
    const outcome = await runWorktreeAdd(async (args, cwd) => {
      invocations.push([...args]);
      return recording(args, cwd);
    }, repository, created);
    expect(outcome.ok).toBe(true);
    expect(invocations).toEqual([["worktree", "add", "--no-track", "-b", "feature/recorded", created.destination, "main"]]);
  });
});

describe("independent of the source working tree", () => {
  test("a dirty, untracked and staged source still creates a clean checkout", async () => {
    const repository = await createRepository("dirty");
    await writeFile(path.join(repository, "README.md"), "# Dirty\n");
    await writeFile(path.join(repository, "untracked.md"), "untracked\n");
    await writeFile(path.join(repository, "staged.md"), "staged\n");
    await git(repository, ["add", "staged.md"]);

    const { plan: created, outcome } = await create(repository, {
      mode: "new-branch",
      branch: "feature/clean",
      base: { kind: "local", ref: "main" },
    });
    expect(outcome.ok).toBe(true);
    expect((await git(created.destination, ["status", "--porcelain"])).trim()).toBe("");
    // Only the committed content plus the linked-tree pointer: no untracked
    // or staged source file is copied.
    expect((await readdir(created.destination)).sort()).toEqual([".git", "README.md"]);
    // The source keeps its own dirt: creation neither stashes nor resets.
    expect((await git(repository, ["status", "--porcelain"])).trim()).toContain("README.md");
  });
});

describe("bounded failures", () => {
  test("a timeout reports a timeout rather than a silent partial success", async () => {
    const timedOut: GitRun = { exitCode: -1, stdout: "", stderr: "", timedOut: true, outputExceeded: false };
    const outcome = await runWorktreeAdd(async () => timedOut, "/tmp/atlas", {
      mode: "new-branch", branch: "a", base: { kind: "local", ref: "main" }, sourceRef: "main", destination: "/tmp/a", disambiguated: false,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.detail.code).toBe("timeout");
    expect(outcome.error.detail.phase).toBe("creating");
  });

  test("Git's own refusals map onto the closed error vocabulary", async () => {
    const repository = await createRepository("git-refusal");
    await git(repository, ["branch", "feature/taken"]);
    const first = await create(repository, { mode: "existing-local", base: { kind: "local", ref: "feature/taken" } });
    expect(first.outcome.ok).toBe(true);
    // The pre-check is bypassed deliberately: this is the race where Git
    // itself is the one that refuses.
    const raced = await runWorktreeAdd(createGitRunner(await options()), repository, {
      ...first.plan,
      destination: `${first.plan.destination}-raced`,
    });
    expect(raced.ok).toBe(false);
    if (raced.ok) return;
    expect(raced.error.detail.code).toBe("branch-in-use");
    // Sanitized: no absolute host path reaches the user.
    expect(raced.error.detail.message).not.toContain(repository);
  });
});
