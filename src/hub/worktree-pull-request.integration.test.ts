import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { hashPassword, hubCookieName, HubSessionStore } from "./auth";
import type { RunningSession, SessionBackend } from "./backend";
import type { HubConfig } from "./config";
import { EMPTY_CREDENTIAL_CONTEXT_RESOLVER } from "./credential-context";
import { CredentialMetadataStore } from "./credential-store";
import { WorkspaceOnboardingCoordinator, type OnboardingGit } from "./onboarding";
import { PathReservationCoordinator } from "./path-reservations";
import { PersonalWorkspaceStateStore } from "./personal-state";
import { WorkspaceRegistry } from "./registry";
import { startHubServer } from "./server";
import { SessionManager } from "./sessions";
import { WORKTREE_API_PATH } from "./worktree-api";
import { WorktreeOperationCoordinator } from "./worktree-coordinator";
import { createGitRunner, type GitRunner } from "./worktree-git";
import { WorktreeJournal, WorktreeProvenanceStore } from "./worktree-journal";
import { createOnboardingWorktreeRegistrar } from "./worktree-registrar";
import { WorktreeService } from "./worktree-service";
import { parseWorktreeEndpointResult, parseWorktreeOperationResult, parseWorktreeRefsResponse } from "../shared/worktree-contract";

// The `pull-request` create mode (add-github-pr-review D12, tasks 4.2–4.3)
// against the REAL Hub pieces — Bun.serve, the registry, onboarding, the
// worktree service and its journal — over real temporary Git repositories.
// GitHub is simulated by a local bare remote whose `refs/pull/<n>/head` refs
// are written with `git update-ref`, exactly the refs GitHub publishes. No
// network, no `gh`, and no GitHub API call anywhere: the Hub needs only the
// number and the remote. The Git environment is explicit, never inherited
// from a Hub-managed development workspace.

// Real Git and real inventory reads; the parallel CI runner shares cores.
setDefaultTimeout(30_000);

const temporaryDirectories: string[] = [];
let root = "";
let home = "";
let origin = "";
let cookie = "";
let server: ReturnType<typeof startHubServer>;
let registry: WorkspaceRegistry;
let service: WorktreeService;
let journal: WorktreeJournal;
let atlas = "";
let atlasId = "";
// The simulated GitHub repository: a bare remote with pull request refs.
let remote = "";
// A clone standing in for contributors (the base repository's own branches
// and forks), used to make the commits the pull request refs point at.
let contributor = "";
// Every Git argument list the service runs; `crash` makes one throw, as a
// Hub process dying in the middle of that command would.
const gitCalls: string[][] = [];
let crash: ((args: readonly string[]) => boolean) | null = null;

function cleanEnvironment(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
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
  const child = Bun.spawn(["git", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args], {
    cwd, env: cleanEnvironment(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

// The config value, or null when unset.
async function config(cwd: string, key: string): Promise<string | null> {
  try {
    return await git(cwd, ["config", "--get", key]);
  } catch {
    return null;
  }
}

async function localBranches(): Promise<string[]> {
  return (await git(atlas, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"])).split("\n").filter(Boolean);
}

// A commit on top of `base` in the contributor clone, published to the
// remote as `ref`: what a pushed branch or GitHub's pull request ref is.
async function publish(ref: string, file: string, base = "main"): Promise<string> {
  await git(contributor, ["checkout", "--quiet", "--detach", base]);
  await writeFile(path.join(contributor, file), `${file}\n`);
  await git(contributor, ["add", file]);
  await git(contributor, ["commit", "--quiet", "-m", file]);
  const oid = await git(contributor, ["rev-parse", "HEAD"]);
  await git(contributor, ["push", "--quiet", remote, `HEAD:${ref}`]);
  return oid;
}

const onboardingGit: OnboardingGit = {
  async probe(folder) {
    const isRepository = await Bun.file(path.join(folder, ".git", "HEAD")).exists();
    return isRepository ? { kind: "repository", toplevel: folder } : { kind: "not-a-repository" };
  },
  async init() {
    throw new Error("these tests never initialize a repository");
  },
};

const backend: SessionBackend = {
  async start(workspace, basePath): Promise<RunningSession> {
    return {
      workspaceId: workspace.id,
      instanceId: crypto.randomUUID(), policyTrust: "unavailable",
      basePath,
      endpoint: { hostname: "127.0.0.1", port: 1 },
      token: null,
      exited: new Promise<number | null>(() => {}),
      async stop() {},
    };
  },
};

function recordingRunner(): GitRunner {
  const inner = createGitRunner({ env: cleanEnvironment() });
  return async (args, cwd, options) => {
    gitCalls.push([...args]);
    if (crash?.(args)) {
      crash = null;
      throw new Error("simulated Hub crash");
    }
    return inner(args, cwd, options);
  };
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "uatu-worktree-pull-request-")));
  temporaryDirectories.push(root);
  home = path.join(root, "home");
  await mkdir(home);
  const state = path.join(root, "state");
  await mkdir(state);

  atlas = path.join(root, "atlas");
  await mkdir(atlas);
  await git(atlas, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(path.join(atlas, "README.md"), "# atlas\n");
  await git(atlas, ["add", "."]);
  await git(atlas, ["commit", "--quiet", "-m", "initial"]);
  remote = path.join(root, "github", "atlas.git");
  await mkdir(path.dirname(remote), { recursive: true });
  await git(root, ["clone", "--quiet", "--bare", atlas, remote]);
  // An absolute URL: a linked checkout resolves its remote from its own
  // folder, so `git pull` there must not depend on a relative path.
  await git(atlas, ["remote", "add", "origin", remote]);
  await git(atlas, ["fetch", "--quiet", "origin"]);
  contributor = path.join(root, "contributor");
  await git(root, ["clone", "--quiet", remote, contributor]);

  const hubConfig: HubConfig = {
    port: 0,
    host: "127.0.0.1",
    tls: null,
    users: [{ name: "reviewer", passwordHash: await hashPassword("open sesame") }],
    stateDir: state,
  };
  registry = new WorkspaceRegistry(path.join(state, "registry.json"));
  const personalState = new PersonalWorkspaceStateStore(path.join(state, "personal-state.json"));
  const credentials = new CredentialMetadataStore(path.join(state, "credentials.json"));
  const sessionStore = new HubSessionStore(path.join(state, "sessions.json"));
  await Promise.all([registry.load(), personalState.load(), credentials.load(), sessionStore.load()]);
  const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER, workspaceId => service.assertStartable(workspaceId));
  const reservations = new PathReservationCoordinator();
  const onboarding = new WorkspaceOnboardingCoordinator({
    journalPath: path.join(state, "pending-onboarding.json"),
    registry,
    credentials,
    sessions,
    reservations,
    git: onboardingGit,
  });
  atlasId = (await onboarding.configureExisting({ path: atlas, displayName: "Atlas", authentication: [], signing: null, init: false, start: false })).entry.id;
  journal = new WorktreeJournal(path.join(state, "pending-worktree-operation.json"));
  service = new WorktreeService({
    registry,
    sessions,
    journal,
    provenance: new WorktreeProvenanceStore(path.join(state, "worktree-provenance.json")),
    registrar: createOnboardingWorktreeRegistrar({ onboarding, registry }),
    coordinator: new WorktreeOperationCoordinator(reservations),
    git: { env: cleanEnvironment(), run: recordingRunner() },
    // No credential is selected for a local remote: the fetch runs with
    // credentials switched off, exactly as for an unselected public remote.
    fetchPolicy: { async select() { return { kind: "none" }; } },
    fetchEnv: { ...cleanEnvironment(), GIT_ALLOW_PROTOCOL: "file" },
  });
  server = startHubServer({ config: hubConfig, registry, sessions, sessionStore, personalState, onboarding, worktrees: service });
  origin = `http://127.0.0.1:${server.port}`;
  cookie = `${hubCookieName(new URL(origin))}=${(await sessionStore.issue("reviewer", "test")).id}`;
});

afterAll(async () => {
  server?.worktreeReconciler?.dispose();
  server?.live.endAll();
  server?.stop(true);
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function post(action: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${origin}${WORKTREE_API_PATH}/${action}`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ sourceWorkspaceId: atlasId, ...body }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

const checkOut = async (number: number, remoteName = "origin") =>
  parseWorktreeEndpointResult(await post("create", { mode: "pull-request", pullRequest: { number, remote: remoteName } }), "create");

describe("a pull request becomes a worktree", () => {
  test("same repository: the existing fetch, then a remote-tracking worktree on the head branch", async () => {
    // Pull request #42's head is a branch of the base repository itself.
    const head = await publish("refs/heads/feature/login", "login.md");
    await git(remote, ["update-ref", "refs/pull/42/head", head]);
    const fetched = parseWorktreeRefsResponse(await post("fetch", {}));
    expect(fetched.ok && fetched.refs.remote).toContain("origin/feature/login");
    const created = parseWorktreeEndpointResult(await post("create", { mode: "remote-tracking", base: { kind: "remote", ref: "origin/feature/login" } }), "create");
    if (!created.ok) throw new Error(created.error.message);
    expect(created.checkout).toMatchObject({ branch: "feature/login", sourceRef: "origin/feature/login", upstream: "origin/feature/login" });
    const folder = created.checkout!.path;
    expect(folder).toBe(path.join(`${atlas}.worktrees`, "feature-login"));
    expect(await git(folder, ["rev-parse", "HEAD"])).toBe(head);
    // An ordinary tracking branch: it can be pushed back like any other.
    expect(await git(folder, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe("origin/feature/login");
  });

  test("fork: pr/<n> from refs/pull/<n>/head, with that ref as its upstream", async () => {
    const head = await publish("refs/pull/57/head", "fork.md");
    const created = await checkOut(57);
    if (!created.ok) throw new Error(created.error.message);
    expect(created.checkout).toMatchObject({ branch: "pr/57", sourceRef: "refs/pull/57/head", upstream: "refs/pull/57/head", ownership: "uatu", registered: true, head: head.slice(0, 12) });
    expect(created.pullRequestHead).toBe(head.slice(0, 12));
    const folder = created.checkout!.path;
    expect(folder).toBe(path.join(`${atlas}.worktrees`, "pr-57"));
    expect(registry.byId(created.checkout!.workspaceId!)?.displayName).toBe("pr/57");
    expect(await git(folder, ["rev-parse", "HEAD"])).toBe(head);
    expect(await git(folder, ["branch", "--show-current"])).toBe("pr/57");
    // The upstream the detection (D4) and `git pull` read.
    expect(await config(atlas, "branch.pr/57.remote")).toBe("origin");
    expect(await config(atlas, "branch.pr/57.merge")).toBe("refs/pull/57/head");
    // Nothing else was written: no scratch ref, no remote-tracking ref for
    // the pull request, and the main checkout's own HEAD is untouched.
    expect(await git(atlas, ["for-each-ref", "refs/uatu/", "refs/remotes/origin/pull/"])).toBe("");
    expect(await git(atlas, ["branch", "--show-current"])).toBe("main");
    // No force anywhere in what the service ran.
    expect(gitCalls.flat().filter(arg => /^(-f|--force|-B|--detach)$/.test(arg))).toEqual([]);
    // The fork pushes a new commit: `git pull` in the checkout follows it.
    const next = await publish("refs/pull/57/head", "fork-2.md", head);
    await git(folder, ["pull", "--quiet", "--ff-only"]);
    expect(await git(folder, ["rev-parse", "HEAD"])).toBe(next);
  });

  test("an existing pr/<n> tracking the pull request is checked out as it is, never reset", async () => {
    const old = await publish("refs/pull/61/head", "pr61.md");
    await git(atlas, ["fetch", "--quiet", "origin", "refs/pull/61/head"]);
    await git(atlas, ["branch", "--no-track", "pr/61", old]);
    await git(atlas, ["config", "branch.pr/61.remote", "origin"]);
    await git(atlas, ["config", "branch.pr/61.merge", "refs/pull/61/head"]);
    // The pull request moved on since.
    const moved = await publish("refs/pull/61/head", "pr61-2.md", old);
    const created = await checkOut(61);
    if (!created.ok) throw new Error(created.error.message);
    expect(created.checkout?.branch).toBe("pr/61");
    expect(await git(created.checkout!.path, ["rev-parse", "HEAD"])).toBe(old);
    expect(await git(atlas, ["rev-parse", "pr/61"])).toBe(old);
    // The difference is reported: the checkout's head is not the pull
    // request's head.
    expect(created.checkout?.head).toBe(old.slice(0, 12));
    expect(created.pullRequestHead).toBe(moved.slice(0, 12));
    // Someone else's branch: no creation history is claimed for it.
    expect(created.checkout?.sourceRef).toBeUndefined();
  });

  test("an existing pr/<n> with other history is refused, and nothing is touched", async () => {
    await publish("refs/pull/62/head", "pr62.md");
    await git(atlas, ["branch", "pr/62", "main"]);
    const before = await git(atlas, ["rev-parse", "pr/62"]);
    const refused = await checkOut(62);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatchObject({
      code: "branch-exists",
      message: "A branch named pr/62 already exists and does not track pull request #62 on origin. Nothing was reset; rename or delete that branch, then try again.",
    });
    expect(await git(atlas, ["rev-parse", "pr/62"])).toBe(before);
    expect(await config(atlas, "branch.pr/62.merge")).toBeNull();
    expect(existsSync(path.join(`${atlas}.worktrees`, "pr-62"))).toBe(false);
    expect(await journal.read()).toBeUndefined();
  });
});

describe("refusals", () => {
  test("a pull request the remote does not have: no branch, no checkout", async () => {
    const refused = await checkOut(99);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatchObject({
      code: "ref-unavailable",
      message: "Pull request #99 was not found on origin: it has no refs/pull/99/head. Check the number, and that origin is the pull request's GitHub repository. Nothing was created.",
    });
    expect(await localBranches()).not.toContain("pr/99");
    expect(await config(atlas, "branch.pr/99.merge")).toBeNull();
    expect(existsSync(path.join(`${atlas}.worktrees`, "pr-99"))).toBe(false);
    expect(await git(atlas, ["for-each-ref", "refs/uatu/"])).toBe("");
  });

  test("a remote the repository does not have is refused before any fetch", async () => {
    const before = gitCalls.length;
    const refused = await checkOut(57, "upstream");
    expect(refused.ok === false && refused.error).toMatchObject({ code: "invalid-input", message: "This repository has no remote named upstream. Nothing was fetched or created." });
    expect(gitCalls.slice(before).some(args => args.includes("fetch"))).toBe(false);
  });

  test("an invalid number or remote never reaches Git", async () => {
    for (const pullRequest of [{ number: 0, remote: "origin" }, { number: 1.5, remote: "origin" }, { number: 57, remote: "--upload-pack=x" }, { number: 57, remote: "../elsewhere" }]) {
      const before = gitCalls.length;
      const refused = parseWorktreeOperationResult(await post("create", { mode: "pull-request", pullRequest }));
      expect(refused.ok === false && refused.error.code).toBe("invalid-input");
      expect(gitCalls.length).toBe(before);
    }
  });
});

describe("crash recovery", () => {
  test("a crash after the branch and before its checkout recovers, and the retry reuses the branch", async () => {
    const head = await publish("refs/pull/63/head", "pr63.md");
    crash = args => args[0] === "worktree" && args[1] === "add";
    const crashed = await service.create("reviewer", { sourceWorkspaceId: atlasId, mode: "pull-request", pullRequest: { number: 63, remote: "origin" } });
    expect(crashed.ok).toBe(false);
    // The intent outlived the "crash", exactly as on disk after a restart.
    expect(await journal.read()).toMatchObject({ kind: "create", mode: "pull-request", branch: "pr/63", phase: "creating" });
    expect(await git(atlas, ["rev-parse", "pr/63"])).toBe(head);
    // Restart recovery: nothing at the destination, so nothing was created.
    expect(await service.recover()).toMatchObject({ kind: "nothing-created" });
    expect(await journal.read()).toBeUndefined();
    // The retry finds pr/63 with exactly its upstream and checks it out.
    const retried = await checkOut(63);
    if (!retried.ok) throw new Error(retried.error.message);
    // Reused as it is. The interrupted creation recorded no history for the
    // branch, so its origin stays unknown rather than inferred.
    expect(retried.checkout).toMatchObject({ branch: "pr/63", upstream: "refs/pull/63/head", head: head.slice(0, 12) });
    expect(retried.pullRequestHead).toBe(head.slice(0, 12));
    expect(await git(retried.checkout!.path, ["rev-parse", "HEAD"])).toBe(head);
  });

  test("a crash before the branch leaves only its upstream configuration, which the retry rewrites", async () => {
    const head = await publish("refs/pull/64/head", "pr64.md");
    crash = args => args[0] === "branch";
    const crashed = await service.create("reviewer", { sourceWorkspaceId: atlasId, mode: "pull-request", pullRequest: { number: 64, remote: "origin" } });
    expect(crashed.ok).toBe(false);
    expect(await localBranches()).not.toContain("pr/64");
    expect(await service.recover()).toMatchObject({ kind: "nothing-created" });
    const retried = await checkOut(64);
    if (!retried.ok) throw new Error(retried.error.message);
    expect(await git(retried.checkout!.path, ["rev-parse", "HEAD"])).toBe(head);
    expect(await config(atlas, "branch.pr/64.merge")).toBe("refs/pull/64/head");
  });
});
