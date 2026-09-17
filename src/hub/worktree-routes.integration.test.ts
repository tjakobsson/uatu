import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { hashPassword, hubCookieName, HubSessionStore } from "./auth";
import type { HubConfig } from "./config";
import { CredentialMetadataStore } from "./credential-store";
import { EMPTY_CREDENTIAL_CONTEXT_RESOLVER } from "./credential-context";
import { PathReservationCoordinator } from "./path-reservations";
import { PersonalWorkspaceStateStore } from "./personal-state";
import { WorkspaceOnboardingCoordinator, type OnboardingGit } from "./onboarding";
import { WorkspaceRegistry } from "./registry";
import { startHubServer } from "./server";
import { SessionManager } from "./sessions";
import type { RunningSession, SessionBackend } from "./backend";
import { WorktreeService } from "./worktree-service";
import { createOnboardingWorktreeRegistrar } from "./worktree-registrar";
import { WorktreeJournal, WorktreeProvenanceStore } from "./worktree-journal";
import { createGitRunner } from "./worktree-git";
import { createParentFetchPolicy } from "./worktree-fetch";

// A real Hub server (Bun.serve) with a real registry, onboarding coordinator
// and Git repository in a temporary directory. No workspace child is ever
// spawned: the session backend is a stub, so "running" is a Hub-side fact.
// The Git environment is explicit, never inherited from a Hub-managed
// development workspace.
const temporaryDirectories: string[] = [];
let sharedHome = "";
let root = "";
let repository = "";
let origin = "";
let server: ReturnType<typeof startHubServer>;
let registry: WorkspaceRegistry;
let sessionStore: HubSessionStore;
let parentId = "";
let cookie = "";
let otherCookie = "";
let bearer = "";
let service: WorktreeService;
const started: string[] = [];

function cleanEnvironment(): Record<string, string> {
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
    cwd, env: cleanEnvironment(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout;
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

// No workspace child is ever spawned: "running" is a Hub-side fact here.
const stubBackend: SessionBackend = {
  async start(workspace, basePath): Promise<RunningSession> {
    started.push(workspace.id);
    return {
      workspaceId: workspace.id,
      basePath,
      endpoint: { hostname: "127.0.0.1", port: 1 },
      token: null,
      exited: new Promise<number | null>(() => {}),
      async stop() {},
    };
  },
};

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "uatu-worktree-routes-")));
  temporaryDirectories.push(root);
  sharedHome = path.join(root, "home");
  await mkdir(sharedHome);
  const state = path.join(root, "state");
  await mkdir(state);
  repository = path.join(root, "atlas");
  await mkdir(repository);
  await git(repository, ["init", "--initial-branch=main"]);
  await writeFile(path.join(repository, "README.md"), "# Readme\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "initial"]);
  await git(repository, ["branch", "release"]);

  const config: HubConfig = {
    port: 0,
    host: "127.0.0.1",
    tls: null,
    users: [
      { name: "reviewer", passwordHash: await hashPassword("open sesame") },
      { name: "intruder", passwordHash: await hashPassword("other secret") },
    ],
    stateDir: state,
  };
  registry = new WorkspaceRegistry(path.join(state, "registry.json"));
  const personalState = new PersonalWorkspaceStateStore(path.join(state, "personal-state.json"));
  const credentials = new CredentialMetadataStore(path.join(state, "credentials.json"));
  sessionStore = new HubSessionStore(path.join(state, "sessions.json"));
  await Promise.all([registry.load(), personalState.load(), credentials.load(), sessionStore.load()]);
  const sessions = new SessionManager(registry, { local: stubBackend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
  const onboarding = new WorkspaceOnboardingCoordinator({
    journalPath: path.join(state, "pending-onboarding.json"),
    registry,
    credentials,
    sessions,
    reservations: new PathReservationCoordinator(),
    git: onboardingGit,
  });
  const parent = await onboarding.configureExisting({
    path: repository, displayName: "Atlas", authentication: [], signing: null, init: false, start: false,
  });
  parentId = parent.entry.id;
  service = new WorktreeService({
    registry,
    sessions,
    journal: new WorktreeJournal(path.join(state, "pending-worktree-operation.json")),
    provenance: new WorktreeProvenanceStore(path.join(state, "worktree-provenance.json")),
    registrar: createOnboardingWorktreeRegistrar({ onboarding, registry }),
    git: { env: cleanEnvironment() },
    fetchEnv: cleanEnvironment(),
    // No credential is assigned to the parent, so every fetch runs with
    // credentials switched OFF rather than through anything ambient.
    fetchPolicy: createParentFetchPolicy({
      assignments: () => credentials.snapshot().assignments,
      resolve: async () => {
        throw new Error("no credential is selected on the parent");
      },
    }),
  });
  server = startHubServer({
    config, registry, sessions, sessionStore, personalState, onboarding,
    worktrees: service,
    credentialApi: {
      metadata: credentials,
      tools: { list: () => [], async set() { throw new Error("unused"); } } as never,
      ssh: null,
      openpgp: null as never,
      tokens: null as never,
      workspaceExists: workspaceId => registry.byId(workspaceId) !== undefined,
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  const name = hubCookieName(new URL(origin));
  cookie = `${name}=${(await sessionStore.issue("reviewer", "test")).id}`;
  otherCookie = `${name}=${(await sessionStore.issue("intruder", "test")).id}`;
  bearer = (await sessionStore.issue("reviewer", "native")).id;
});

afterAll(async () => {
  server?.stop(true);
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function authenticated(init: RequestInit = {}, credential = cookie): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), cookie: credential, origin } };
}

async function post(action: string, fields: Record<string, string>, init: RequestInit = {}): Promise<Response> {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return fetch(`${origin}/worktrees/${action}`, { method: "POST", body, ...init });
}

describe("authentication and CSRF", () => {
  test("an unauthenticated presentation request never reaches the worktree service", async () => {
    const response = await fetch(`${origin}/worktrees?view=inventory&source=${parentId}&fragment=1`, { redirect: "manual" });
    expect([302, 303, 401]).toContain(response.status);
    expect(await response.text()).not.toContain("Repository worktrees");
  });

  test("an unauthenticated operation is rejected", async () => {
    const response = await post("refresh", { source: parentId });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  test("a cookie-authenticated cross-origin operation is rejected", async () => {
    const response = await post("create", { source: parentId, mode: "new", branch: "feature/csrf", selection: "local:main" }, {
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "cross-origin request rejected" });
    // Nothing was created.
    expect(await readdir(root)).not.toContain("atlas.worktrees");
  });

  test("a bearer credential carries no ambient authority and needs no Origin", async () => {
    const response = await post("refresh", { source: parentId }, { headers: { authorization: `Bearer ${bearer}` } });
    expect(response.status).toBe(200);
    expect((await response.json() as { redirect: string }).redirect).toContain("view=inventory");
  });

  test("an unknown operation is refused rather than guessed", async () => {
    // Display-name rename and parent settings live on the Hub dashboard.
    for (const action of ["rename", "settings", "branch-delete"]) {
      const response = await post(action, { source: parentId, id: parentId }, authenticated());
      expect(response.status).toBe(405);
    }
  });

  test("a presentation POST and an operation GET are refused", async () => {
    expect((await fetch(`${origin}/worktrees`, { method: "POST", ...authenticated() })).status).toBe(405);
    expect((await fetch(`${origin}/worktrees/create`, authenticated())).status).toBe(405);
  });
});

describe("presentation", () => {
  test("the inventory fragment lists the repository's checkouts", async () => {
    const response = await fetch(`${origin}/worktrees?view=inventory&source=${parentId}&fragment=1`, authenticated());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Repository worktrees");
    expect(body).toContain("Atlas");
    // With no linked trees yet, the approved copy invites creating one.
    expect(body).toContain("No linked worktrees yet");
    // A fragment carries no page chrome and no script.
    expect(body).not.toContain("<!doctype html>");
    expect(body).not.toContain("<script");
  });

  test("a fresh new-branch dialog preselects the shared initial base", async () => {
    const response = await fetch(`${origin}/worktrees?view=create&mode=new&source=${parentId}&fragment=1`, authenticated());
    const body = await response.text();
    expect(body).toContain("New branch / worktree · Atlas");
    expect(body).toContain('name="selection" value="local:main"');
    expect(body).toContain('data-value="local:release"');
  });

  test("an existing-branch dialog commits no base by default", async () => {
    const body = await (await fetch(`${origin}/worktrees?view=create&mode=existing&source=${parentId}&fragment=1`, authenticated())).text();
    expect(body).toContain("Existing branch · Atlas");
    expect(body).toContain('name="selection" value=""');
  });

  test("an unknown view or workspace is not found", async () => {
    expect((await fetch(`${origin}/worktrees?view=nope&source=${parentId}`, authenticated())).status).toBe(404);
    expect((await fetch(`${origin}/worktrees?view=inventory&source=ghost`, authenticated())).status).toBe(404);
    // Views the dashboard owns are absent rather than rendered without an operation.
    expect((await fetch(`${origin}/worktrees?view=settings&source=${parentId}&id=${parentId}`, authenticated())).status).toBe(404);
    expect((await fetch(`${origin}/worktrees?view=rename&source=${parentId}&id=${parentId}`, authenticated())).status).toBe(404);
  });

  test("a message carried across a redirect is sanitized before it is rendered", async () => {
    const body = await (await fetch(
      `${origin}/worktrees?view=inventory&source=${parentId}&error=1&message=${encodeURIComponent("failed at /Users/reviewer/secret with token=abcdef123456")}`,
      authenticated(),
    )).text();
    expect(body).toContain("failed at [path]");
    expect(body).not.toContain("/Users/reviewer/secret");
    expect(body).not.toContain("abcdef123456");
  });
});

describe("operations", () => {
  test("creation answers with the approved redirect and completion", async () => {
    const response = await post("create", { source: parentId, mode: "new", branch: "feature/routes", selection: "local:release" }, authenticated());
    expect(response.status).toBe(200);
    const body = await response.json() as { redirect: string; completion?: { message: string; id: string; source: string } };
    expect(body.completion?.message).toBe("Created feature/routes");
    expect(body.completion?.source).toBe(parentId);
    expect(body.redirect).toContain("view=result");
    const child = registry.byId(body.completion!.id)!;
    expect(child.displayName).toBe("feature/routes");
    expect(child.worktree?.parentWorkspaceId).toBe(parentId);
    // Stopped by default: creation never starts a child.
    expect(started).toEqual([]);
  });

  test("the refreshed inventory lists the main checkout and its new child", async () => {
    const body = await (await fetch(`${origin}/worktrees?view=inventory&source=${parentId}&fragment=1`, authenticated())).text();
    expect(body).toContain("Main checkout");
    expect(body).toContain("Uatu-created");
    expect(body).toContain("feature/routes");
    // The child's own path is a predetermined sibling of the main checkout.
    expect(body).toContain("atlas.worktrees/feature-routes");
  });

  test("a refused creation round-trips the draft without a stale selection", async () => {
    const response = await post("create", { source: parentId, mode: "new", branch: "feature/routes", selection: "local:release", query: "release" }, authenticated());
    const body = await response.json() as { redirect: string; completion?: unknown };
    expect(body.completion).toBeUndefined();
    const redirect = new URL(body.redirect, origin);
    expect(redirect.searchParams.get("error")).toBe("1");
    expect(redirect.searchParams.get("branch")).toBe("feature/routes");
    expect(redirect.searchParams.get("query")).toBe("release");
    expect(redirect.searchParams.get("selection")).toBe("local:release");
    expect(redirect.searchParams.get("message")).toContain("already exists");
    // And the returned view keeps the draft rather than redefaulting to main.
    const view = await (await fetch(`${origin}${body.redirect}&fragment=1`, authenticated())).text();
    expect(view).toContain('name="selection" value="local:release"');
    expect(view).not.toContain('name="selection" value="local:main"');
  });

  test("an unparsable selection is refused without touching the repository", async () => {
    const before = await readdir(`${repository}.worktrees`);
    const body = await (await post("create", { source: parentId, mode: "new", branch: "feature/x", selection: "" }, authenticated())).json() as { redirect: string };
    expect(new URL(body.redirect, origin).searchParams.get("message")).toContain("Select an available branch");
    expect(await readdir(`${repository}.worktrees`)).toEqual(before);
  });

  test("an occupied branch offers its existing checkout instead of forcing", async () => {
    const body = await (await post("create", { source: parentId, mode: "existing", selection: "local:feature/routes" }, authenticated())).json() as { redirect: string };
    const redirect = new URL(body.redirect, origin);
    expect(redirect.searchParams.get("message")).toContain("already checked out");
    expect(redirect.searchParams.get("conflict")).toBeTruthy();
  });

  test("Open starts the workspace and navigates to its own session URL", async () => {
    const child = registry.list().find(entry => entry.displayName === "feature/routes")!;
    const body = await (await post("start", { source: parentId, id: child.id }, authenticated())).json() as { redirect: string };
    expect(body.redirect).toBe(`/s/${child.id}/`);
    expect(started).toEqual([child.id]);
  });

  test("Fetch refreshes the cached branch listing and preserves the draft", async () => {
    // A second temporary repository as "origin": a real fetch with no
    // network and no credential.
    const remote = path.join(root, "origin");
    await mkdir(remote);
    await git(remote, ["init", "--initial-branch=main"]);
    await writeFile(path.join(remote, "README.md"), "# Origin\n");
    await git(remote, ["add", "."]);
    await git(remote, ["commit", "-m", "initial"]);
    await git(remote, ["branch", "feature/search"]);
    await git(repository, ["remote", "add", "origin", remote]);

    const body = await (await post("fetch", { source: parentId, mode: "new", branch: "feature/fetched", query: "sea" }, authenticated())).json() as { redirect: string };
    const redirect = new URL(body.redirect, origin);
    expect(redirect.searchParams.get("error")).toBeNull();
    expect(redirect.searchParams.get("branch")).toBe("feature/fetched");
    expect(redirect.searchParams.get("query")).toBe("sea");
    const view = await (await fetch(`${origin}${body.redirect}&fragment=1`, authenticated())).text();
    expect(view).toContain('data-value="remote:origin/feature/search"');
    // Freshness is reported on the contract: a cached listing before the
    // fetch, a stamped one after it. (The approved compact dialog shows no
    // freshness readout, so this is asserted where it lives.)
    expect((await service.refs(parentId)).fetchedAt).toBeGreaterThan(0);
    // A submitted draft is never redefaulted back to main.
    expect(view).toContain('name="selection" value=""');
    expect(view).toContain('value="feature/fetched"');
  });

  test("an operation naming an unknown workspace is not found", async () => {
    expect((await post("start", { source: parentId, id: "ghost" }, authenticated())).status).toBe(404);
    expect((await post("refresh", { source: "ghost" }, authenticated())).status).toBe(404);
  });
});

describe("operations are scoped to the user who started them", () => {
  test("a pending operation is invisible to another user", async () => {
    const journal = new WorktreeJournal(path.join(root, "state", "pending-worktree-operation.json"));
    await journal.begin({
      operationId: "operation-scoped",
      kind: "create",
      phase: "verifying",
      user: "reviewer",
      repositoryId: "repository-atlas",
      sourceWorkspaceId: parentId,
      sourcePath: repository,
      destination: `${repository}.worktrees/feature-scoped`,
      mode: "new-branch",
      branch: "feature/scoped",
      base: { kind: "local", ref: "main" },
      checkoutId: "checkout-scoped",
    });
    try {
      const mine = await fetch(`${origin}/worktrees/operation`, authenticated());
      expect(mine.status).toBe(200);
      expect((await mine.json() as { operation: { operationId: string; phase: string } }).operation).toMatchObject({
        operationId: "operation-scoped",
        phase: "verifying",
      });

      const theirs = await fetch(`${origin}/worktrees/operation`, authenticated({}, otherCookie));
      expect(theirs.status).toBe(404);
      expect(await theirs.text()).not.toContain("feature/scoped");

      // Nor can they finish it.
      const stolen = await post("register", { source: parentId, id: "operation-scoped" }, authenticated({}, otherCookie));
      const body = await stolen.json() as { redirect: string };
      expect(new URL(body.redirect, origin).searchParams.get("message")).toContain("another user");
    } finally {
      await journal.clear();
    }
  });

  test("a second creation while one is pending is refused, not queued behind it", async () => {
    const journal = new WorktreeJournal(path.join(root, "state", "pending-worktree-operation.json"));
    await journal.begin({
      operationId: "operation-pending",
      kind: "create",
      phase: "creating",
      user: "reviewer",
      repositoryId: "repository-atlas",
      sourceWorkspaceId: parentId,
      sourcePath: repository,
      destination: `${repository}.worktrees/feature-pending`,
      mode: "new-branch",
      branch: "feature/pending",
      base: { kind: "local", ref: "main" },
    });
    try {
      const before = await readdir(`${repository}.worktrees`);
      const body = await (await post("create", { source: parentId, mode: "new", branch: "feature/second", selection: "local:main" }, authenticated())).json() as { redirect: string };
      const redirect = new URL(body.redirect, origin);
      expect(redirect.searchParams.get("error")).toBe("1");
      expect(redirect.searchParams.get("message")).toContain("still in progress");
      // The refusal happens before Git: no second tree, no second branch.
      expect(await readdir(`${repository}.worktrees`)).toEqual(before);
      expect(await git(repository, ["branch", "--list", "feature/second"])).toBe("");
    } finally {
      await journal.clear();
    }
  });

  test("with no pending operation, progress is absent for everyone", async () => {
    expect((await fetch(`${origin}/worktrees/operation`, authenticated())).status).toBe(404);
    expect((await fetch(`${origin}/worktrees/operation`, authenticated({}, otherCookie))).status).toBe(404);
  });
});

describe("partial outcomes are retained and recoverable through the same routes", () => {
  test("a failed registration offers retry-registration for the same checkout", async () => {
    const localRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "uatu-worktree-retained-")));
    temporaryDirectories.push(localRoot);
    const state = path.join(localRoot, "state");
    const localRepository = path.join(localRoot, "beacon");
    await Promise.all([mkdir(state), mkdir(localRepository)]);
    await git(localRepository, ["init", "--initial-branch=main"]);
    await writeFile(path.join(localRepository, "README.md"), "# Beacon\n");
    await git(localRepository, ["add", "."]);
    await git(localRepository, ["commit", "-m", "initial"]);

    const localRegistry = new WorkspaceRegistry(path.join(state, "registry.json"));
    const localPersonal = new PersonalWorkspaceStateStore(path.join(state, "personal-state.json"));
    const localCredentials = new CredentialMetadataStore(path.join(state, "credentials.json"));
    const localSessionStore = new HubSessionStore(path.join(state, "sessions.json"));
    await Promise.all([localRegistry.load(), localPersonal.load(), localCredentials.load(), localSessionStore.load()]);
    const localSessions = new SessionManager(localRegistry, { local: stubBackend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
    const localOnboarding = new WorkspaceOnboardingCoordinator({
      journalPath: path.join(state, "pending-onboarding.json"),
      registry: localRegistry,
      credentials: localCredentials,
      sessions: localSessions,
      reservations: new PathReservationCoordinator(),
      git: onboardingGit,
    });
    const localParent = await localOnboarding.configureExisting({
      path: localRepository, displayName: "Beacon", authentication: [], signing: null, init: false, start: false,
    });
    const real = createOnboardingWorktreeRegistrar({ onboarding: localOnboarding, registry: localRegistry });
    let failures = 1;
    const localService = new WorktreeService({
      registry: localRegistry,
      sessions: localSessions,
      journal: new WorktreeJournal(path.join(state, "pending-worktree-operation.json")),
      provenance: new WorktreeProvenanceStore(path.join(state, "worktree-provenance.json")),
      registrar: { register: input => (failures-- > 0 ? Promise.reject(new Error("registry persistence failed")) : real.register(input)) },
      git: { env: cleanEnvironment() },
    });
    const localServer = startHubServer({
      config: {
        port: 0, host: "127.0.0.1", tls: null,
        users: [{ name: "reviewer", passwordHash: await hashPassword("open sesame") }],
        stateDir: state,
      },
      registry: localRegistry,
      sessions: localSessions,
      sessionStore: localSessionStore,
      personalState: localPersonal,
      onboarding: localOnboarding,
      worktrees: localService,
    });
    try {
      const localOrigin = `http://127.0.0.1:${localServer.port}`;
      const localCookie = `${hubCookieName(new URL(localOrigin))}=${(await localSessionStore.issue("reviewer", "test")).id}`;
      const headers = { cookie: localCookie, origin: localOrigin };
      const form = new FormData();
      form.set("source", localParent.entry.id);
      form.set("mode", "new");
      form.set("branch", "feature/retained");
      form.set("selection", "local:main");
      const attempt = await (await fetch(`${localOrigin}/worktrees/create`, { method: "POST", body: form, headers })).json() as { redirect: string; completion?: unknown };
      expect(attempt.completion).toBeUndefined();
      const redirect = new URL(attempt.redirect, localOrigin);
      expect(redirect.searchParams.get("view")).toBe("configure");
      expect(redirect.searchParams.get("message")).toContain("retained");
      // Addressed by the retained checkout, not by a job number.
      expect(redirect.searchParams.get("id")).toMatch(/^[0-9a-f]{32}$/);
      // The checkout and its branch survive the failure.
      expect(await Bun.file(path.join(`${localRepository}.worktrees`, "feature-retained", "README.md")).exists()).toBe(true);
      expect(localRegistry.list().length).toBe(1);

      // The retained-operation view offers exactly one follow-up: retry.
      const view = await (await fetch(`${localOrigin}${attempt.redirect}&fragment=1`, { headers })).text();
      expect(view).toContain("Finish creating worktree");
      expect(view).toContain("Retry registration");

      const retry = new FormData();
      retry.set("source", localParent.entry.id);
      retry.set("id", redirect.searchParams.get("id")!);
      const completed = await (await fetch(`${localOrigin}/worktrees/register`, { method: "POST", body: retry, headers })).json() as { completion?: { message: string; id: string } };
      expect(completed.completion?.message).toBe("Created feature/retained");
      // One registration, one linked tree: the retry reused the checkout.
      expect(localRegistry.list().length).toBe(2);
      expect((await readdir(`${localRepository}.worktrees`)).length).toBe(1);
    } finally {
      localServer.stop(true);
    }
  });
});

describe("bounded subprocesses", () => {
  test("a timed-out Git probe leaves no orphaned process behind", async () => {
    const before = await runningGitProcesses();
    const run = createGitRunner({ env: cleanEnvironment(), timeoutMs: 150, gitCommand: () => "/bin/sh" });
    const result = await run(["-c", "sleep 30 & wait"], repository);
    expect(result.timedOut).toBe(true);
    // The runner kills the whole process group, so the sleep the shell
    // spawned is gone with it rather than outliving the operation.
    await Bun.sleep(150);
    const after = await runningGitProcesses();
    expect(after).toBe(before);
  });
});

async function runningGitProcesses(): Promise<number> {
  const child = Bun.spawn(["sh", "-c", "ps -o command= -ax | grep -c 'sleep 30' || true"], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(child.stdout).text();
  await child.exited;
  return Number(text.trim()) || 0;
}
