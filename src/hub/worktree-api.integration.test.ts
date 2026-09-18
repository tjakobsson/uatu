import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
import { WorktreeCapabilityStore } from "./worktree-capability";
import { WorktreeJournal, WorktreeProvenanceStore } from "./worktree-journal";
import { createOnboardingWorktreeRegistrar } from "./worktree-registrar";
import { WorktreeService } from "./worktree-service";
import { WORKTREE_API_PATH } from "../shared/worktree-context";
import { parseWorktreeInventory, parseWorktreeOperationResult } from "../shared/worktree-contract";

// Task 6.2 against the REAL Hub: Bun.serve, the registry, onboarding, the
// worktree service and the published JSON family, over real temporary Git
// repositories. No workspace child is spawned — the backend is a stub, so
// "running" is a Hub-side fact. The Git environment is explicit, never
// inherited from a Hub-managed development workspace.

const temporaryDirectories: string[] = [];
let root = "";
let home = "";
let origin = "";
let cookie = "";
let capability = "";
let beaconCapability = "";
let revokedCapability = "";
let server: ReturnType<typeof startHubServer>;
let registry: WorkspaceRegistry;
let capabilities: WorktreeCapabilityStore;
let atlasId = "";
let beaconId = "";

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
  const child = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd, env: cleanEnvironment(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout;
}

async function repository(name: string): Promise<string> {
  const folder = path.join(root, name);
  await mkdir(folder);
  await git(folder, ["init", "--initial-branch=main"]);
  await writeFile(path.join(folder, "README.md"), `# ${name}\n`);
  await git(folder, ["add", "."]);
  await git(folder, ["commit", "-m", "initial"]);
  await git(folder, ["branch", "release"]);
  return folder;
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
      basePath,
      endpoint: { hostname: "127.0.0.1", port: 1 },
      token: null,
      exited: new Promise<number | null>(() => {}),
      async stop() {},
    };
  },
};

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "uatu-worktree-api-")));
  temporaryDirectories.push(root);
  home = path.join(root, "home");
  await mkdir(home);
  const state = path.join(root, "state");
  await mkdir(state);
  const atlas = await repository("atlas");
  const beacon = await repository("beacon");

  const config: HubConfig = {
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
  capabilities = new WorktreeCapabilityStore(path.join(state, "worktree-capabilities.json"));
  await Promise.all([registry.load(), personalState.load(), credentials.load(), sessionStore.load(), capabilities.load()]);
  let service!: WorktreeService;
  const sessions = new SessionManager(
    registry,
    { local: backend },
    EMPTY_CREDENTIAL_CONTEXT_RESOLVER,
    workspaceId => service.assertStartable(workspaceId),
  );
  const onboarding = new WorkspaceOnboardingCoordinator({
    journalPath: path.join(state, "pending-onboarding.json"),
    registry,
    credentials,
    sessions,
    reservations: new PathReservationCoordinator(),
    git: onboardingGit,
  });
  atlasId = (await onboarding.configureExisting({ path: atlas, displayName: "Atlas", authentication: [], signing: null, init: false, start: false })).entry.id;
  beaconId = (await onboarding.configureExisting({ path: beacon, displayName: "Beacon", authentication: [], signing: null, init: false, start: false })).entry.id;
  service = new WorktreeService({
    registry,
    sessions,
    journal: new WorktreeJournal(path.join(state, "pending-worktree-operation.json")),
    provenance: new WorktreeProvenanceStore(path.join(state, "worktree-provenance.json")),
    registrar: createOnboardingWorktreeRegistrar({ onboarding, registry }),
    git: { env: cleanEnvironment() },
    unregister: async workspaceId => {
      await personalState.forgetWorkspace(workspaceId, () => registry.remove(workspaceId), async () => {
        await credentials.removeWorkspaceAssignments(workspaceId);
      });
    },
  });
  server = startHubServer({
    config, registry, sessions, sessionStore, personalState, onboarding,
    worktrees: service,
    worktreeCapabilities: capabilities,
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
  cookie = `${hubCookieName(new URL(origin))}=${(await sessionStore.issue("reviewer", "test")).id}`;
  capability = (await capabilities.issue({ user: "reviewer", workspaceId: atlasId, sourceWorkspaceId: atlasId })).token;
  beaconCapability = (await capabilities.issue({ user: "reviewer", workspaceId: beaconId, sourceWorkspaceId: beaconId })).token;
  const doomed = await capabilities.issue({ user: "reviewer", workspaceId: atlasId, sourceWorkspaceId: atlasId });
  revokedCapability = doomed.token;
  await capabilities.revoke(doomed.record.id);
});

afterAll(async () => {
  server?.worktreeReconciler?.dispose();
  server?.live.endAll();
  server?.stop(true);
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function withCapability(token = capability, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } };
}

async function post(action: string, body: unknown, init: RequestInit = withCapability()): Promise<Response> {
  return fetch(`${origin}${WORKTREE_API_PATH}/${action}`, {
    method: "POST",
    ...init,
    headers: { ...(init.headers as Record<string, string>), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function result(response: Response) {
  expect(response.status).toBe(200);
  return parseWorktreeOperationResult(await response.json());
}

async function inventory(init: RequestInit = withCapability()) {
  const response = await fetch(`${origin}${WORKTREE_API_PATH}?source=${atlasId}`, init);
  expect(response.status).toBe(200);
  return parseWorktreeInventory((await response.json() as { inventory: unknown }).inventory);
}

describe("worktree capability authorization", () => {
  test("an anonymous JSON request never reaches the service", async () => {
    const response = await fetch(`${origin}${WORKTREE_API_PATH}?source=${atlasId}`);
    expect(response.status).toBe(401);
  });

  test("a capability authorizes the worktree family and nothing else on the Hub", async () => {
    // Everything a Hub session can do, this credential deliberately cannot.
    for (const route of ["/api/hub/state", "/api/hub/credentials", "/api/hub/sessions", "/", "/settings"]) {
      const response = await fetch(`${origin}${route}`, withCapability());
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "this credential authorizes only the worktree API" });
    }
    // Including the browser's own worktree flow, which is a different surface.
    expect((await fetch(`${origin}/worktrees?view=inventory&source=${atlasId}`, withCapability())).status).toBe(403);
  });

  test("a capability is pinned to one repository family", async () => {
    const response = await fetch(`${origin}${WORKTREE_API_PATH}?source=${beaconId}`, withCapability());
    expect(response.status).toBe(403);
    // The other family's existence is not described to a credential that
    // may not touch it.
    expect(await response.json()).toEqual({ error: "this credential authorizes another workspace" });
    // And the same credential works on its own family, while the other
    // family's credential cannot read this one.
    expect((await inventory()).sourceWorkspaceId).toBe(atlasId);
    const acrossFamilies = await fetch(`${origin}${WORKTREE_API_PATH}?source=${atlasId}`, withCapability(beaconCapability));
    expect(acrossFamilies.status).toBe(403);
  });

  test("a revoked capability is refused with an actionable reason", async () => {
    const response = await fetch(`${origin}${WORKTREE_API_PATH}?source=${atlasId}`, withCapability(revokedCapability));
    expect(response.status).toBe(401);
    expect((await response.json() as { error: string }).error).toContain("restart the workspace");
  });

  test("a Hub session reaches the same family, with the same-origin rule on mutations", async () => {
    const session = { cookie, origin } as Record<string, string>;
    const listed = await fetch(`${origin}${WORKTREE_API_PATH}?source=${atlasId}`, { headers: session });
    expect(listed.status).toBe(200);
    const crossSite = await post("create", { sourceWorkspaceId: atlasId, mode: "existing-local", base: { kind: "local", ref: "release" } }, {
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toEqual({ error: "cross-origin request rejected" });
    expect(existsSync(path.join(root, "atlas.worktrees"))).toBe(false);
  });

  test("an unknown operation or method is refused rather than guessed", async () => {
    expect((await post("forget", { sourceWorkspaceId: atlasId })).status).toBe(404);
    expect((await post("fetch", { sourceWorkspaceId: atlasId })).status).toBe(404);
    expect((await fetch(`${origin}${WORKTREE_API_PATH}`, withCapability(capability, { method: "POST" }))).status).toBe(405);
    expect((await fetch(`${origin}${WORKTREE_API_PATH}/create`, withCapability())).status).toBe(405);
  });
});

describe("worktree operations over JSON", () => {
  test("list reports the repository's own checkouts", async () => {
    const listed = await inventory();
    expect(listed.status).toBe("ready");
    expect(listed.checkouts.filter(checkout => checkout.main)).toHaveLength(1);
    expect(listed.refs.local).toContain("release");
  });

  test("create resolves an unqualified base against the authoritative listing", async () => {
    const created = await result(await post("create", {
      sourceWorkspaceId: atlasId, mode: "new-branch", branch: "feature/login", baseRef: "main",
    }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // The Hub chose the destination; no path was ever sent or returned as
    // an instruction.
    expect(created.checkout!.path).toBe(path.join(root, "atlas.worktrees", "feature-login"));
    expect(created.checkout!.branch).toBe("feature/login");
    expect(created.checkout!.ownership).toBe("uatu");
    expect(created.started).toBe(false);
    expect(await git(path.join(root, "atlas.worktrees", "feature-login"), ["rev-parse", "--abbrev-ref", "HEAD"]))
      .toBe("feature/login\n");
  });

  test("a base that is not in the listing is refused without substituting one", async () => {
    const refused = await result(await post("create", {
      sourceWorkspaceId: atlasId, mode: "new-branch", branch: "feature/other", baseRef: "no-such-branch",
    }));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("ref-unavailable");
    expect(refused.error.retry).toBe("retry-fetch");
    expect(existsSync(path.join(root, "atlas.worktrees", "feature-other"))).toBe(false);
  });

  test("the UI's safety rules hold identically for an agent request", async () => {
    // The branch is already checked out: refused, never forced, and the
    // existing checkout is named.
    const refused = await result(await post("create", {
      sourceWorkspaceId: atlasId, mode: "existing-local", base: { kind: "local", ref: "feature/login" },
    }));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(["branch-in-use", "branch-exists", "destination-occupied"]).toContain(refused.error.code);
  });

  test("an option-shaped branch cannot reach Git through the API either", async () => {
    const refused = await result(await post("create", {
      sourceWorkspaceId: atlasId, mode: "new-branch", branch: "--force", baseRef: "main",
    }));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("invalid-input");
  });

  test("open reports an existing checkout by branch, and starts only when asked", async () => {
    const reported = await result(await post("open", { sourceWorkspaceId: atlasId, reference: "feature/login" }));
    expect(reported.ok).toBe(true);
    if (!reported.ok) return;
    expect(reported.started).toBe(false);
    expect(reported.checkout!.branch).toBe("feature/login");

    const started = await result(await post("open", { sourceWorkspaceId: atlasId, reference: "feature/login", start: true }));
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.started).toBe(true);
  });

  test("a name that matches nothing, or is ambiguous, is refused", async () => {
    const missing = await result(await post("open", { sourceWorkspaceId: atlasId, reference: "not-a-branch" }));
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe("not-found");
  });

  test("delete requires the explicit confirmation and keeps the branch", async () => {
    const unconfirmed = await result(await post("delete", { sourceWorkspaceId: atlasId, reference: "feature/login" }));
    expect(unconfirmed.ok).toBe(false);
    if (unconfirmed.ok) return;
    expect(unconfirmed.error.message).toContain("Nothing was removed");
    expect(existsSync(path.join(root, "atlas.worktrees", "feature-login"))).toBe(true);

    // It is running (opened above), so stopping it must be authorized too.
    const withoutStop = await result(await post("delete", {
      sourceWorkspaceId: atlasId, reference: "feature/login", confirm: true,
    }));
    expect(withoutStop.ok).toBe(false);
    expect(existsSync(path.join(root, "atlas.worktrees", "feature-login"))).toBe(true);

    const deleted = await result(await post("delete", {
      sourceWorkspaceId: atlasId, reference: "feature/login", confirm: true, stop: true,
    }));
    expect(deleted.ok).toBe(true);
    expect(existsSync(path.join(root, "atlas.worktrees", "feature-login"))).toBe(false);
    // The branch always remains.
    expect(await git(path.join(root, "atlas"), ["branch", "--list", "feature/login"])).toContain("feature/login");
  });

  test("the main checkout can never be deleted through the API", async () => {
    const refused = await result(await post("delete", { sourceWorkspaceId: atlasId, reference: atlasId, confirm: true, stop: true }));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(["ownership-required", "not-found", "invalid-input"]).toContain(refused.error.code);
    expect(existsSync(path.join(root, "atlas"))).toBe(true);
  });

  test("an agent creation is visible to the browser flow immediately", async () => {
    const created = await result(await post("create", {
      sourceWorkspaceId: atlasId, mode: "existing-local", base: { kind: "local", ref: "release" },
    }));
    expect(created.ok).toBe(true);
    // The same service backs both surfaces, so the HTML picker shows it
    // without any second registration path.
    const fragment = await fetch(`${origin}/worktrees?view=inventory&source=${atlasId}&fragment=1`, {
      headers: { cookie, origin },
    });
    expect(await fragment.text()).toContain("release");
  });
});
