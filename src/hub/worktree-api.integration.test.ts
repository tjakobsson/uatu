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
import { WorktreeJournal, WorktreeProvenanceStore } from "./worktree-journal";
import { WorktreeOperationCoordinator } from "./worktree-coordinator";
import { createOnboardingWorktreeRegistrar } from "./worktree-registrar";
import { WorktreeService } from "./worktree-service";
import { createParentFetchPolicy } from "./worktree-fetch";
import { WORKTREE_API_PATH } from "./worktree-api";
import {
  parseWorktreeDeletionPreflight,
  parseWorktreeInventory,
  parseWorktreeOperationResult,
  parseWorktreeRefsResponse,
} from "../shared/worktree-contract";
import { parseLiveEnvelope, type LiveEnvelope } from "../shared/live-protocol";

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
let server: ReturnType<typeof startHubServer>;
let registry: WorkspaceRegistry;
let atlasId = "";

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
  await Promise.all([registry.load(), personalState.load(), credentials.load(), sessionStore.load()]);
  let service!: WorktreeService;
  const sessions = new SessionManager(
    registry,
    { local: backend },
    EMPTY_CREDENTIAL_CONTEXT_RESOLVER,
    workspaceId => service.assertStartable(workspaceId),
  );
  // One PathReservationCoordinator shared by onboarding and the worktree
  // coordinator, exactly like main.ts composes them. Separate coordinators
  // hid Bug 3 (a first-attempt worktree registration always failing in
  // production): the create's own path fence and the registration step it
  // triggers never actually contended for the same reservation coordinator.
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
  service = new WorktreeService({
    registry,
    sessions,
    journal: new WorktreeJournal(path.join(state, "pending-worktree-operation.json")),
    provenance: new WorktreeProvenanceStore(path.join(state, "worktree-provenance.json")),
    registrar: createOnboardingWorktreeRegistrar({ onboarding, registry }),
    coordinator: new WorktreeOperationCoordinator(reservations),
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
});

afterAll(async () => {
  server?.worktreeReconciler?.dispose();
  server?.live.endAll();
  server?.stop(true);
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function withSession(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), cookie } };
}

async function post(action: string, body: unknown, init: RequestInit = withSession()): Promise<Response> {
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

async function refsResult(response: Response) {
  expect(response.status).toBe(200);
  return parseWorktreeRefsResponse(await response.json());
}

async function preflight(response: Response) {
  expect(response.status).toBe(200);
  return parseWorktreeDeletionPreflight(await response.json());
}

// A live stream as a page holds it, trimmed to what these tests need:
// whether a committed operation publishes an invalidation on the
// `worktrees` topic. See worktree-lifecycle.integration.test.ts (5.2) for
// the fuller version this mirrors.
async function openLive(ws: string) {
  const controller = new AbortController();
  const params = new URLSearchParams({ ws, subs: JSON.stringify([{ topic: "worktrees" }]) });
  const response = await fetch(`${origin}/api/hub/live?${params}`, withSession({ signal: controller.signal }));
  expect(response.status).toBe(200);
  const envelopes: LiveEnvelope[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (!frame.startsWith("event: live")) continue;
          const envelope = parseLiveEnvelope(frame.split("\n").find(line => line.startsWith("data: "))!.slice(6));
          if (envelope) envelopes.push(envelope);
        }
      }
    } catch {
      // Aborted.
    }
  })();
  const worktrees = () => envelopes.filter(envelope => envelope.topic === "worktrees" && envelope.event.kind === "data");
  return {
    worktrees,
    async waitFor(predicate: () => boolean, what: string, timeoutMs = 4_000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(10);
      }
    },
    close: () => controller.abort(),
  };
}

async function inventory(init: RequestInit = withSession()) {
  const response = await fetch(`${origin}${WORKTREE_API_PATH}?source=${atlasId}`, init);
  expect(response.status).toBe(200);
  return parseWorktreeInventory((await response.json() as { inventory: unknown }).inventory);
}

describe("worktree API authorization", () => {
  test("an anonymous JSON request never reaches the service", async () => {
    const response = await fetch(`${origin}${WORKTREE_API_PATH}?source=${atlasId}`);
    expect(response.status).toBe(401);
  });

  test("a Hub session reaches its workspaces, with the same-origin rule on mutations", async () => {
    const listed = await fetch(`${origin}${WORKTREE_API_PATH}?source=${atlasId}`, withSession());
    expect(listed.status).toBe(200);
    expect((await inventory()).sourceWorkspaceId).toBe(atlasId);
    const crossSite = await post("create", { sourceWorkspaceId: atlasId, mode: "existing-local", base: { kind: "local", ref: "release" } }, {
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toEqual({ error: "cross-origin request rejected" });
    expect(existsSync(path.join(root, "atlas.worktrees"))).toBe(false);
  });

  test("an unknown operation or method is refused rather than guessed", async () => {
    expect((await post("rename", { sourceWorkspaceId: atlasId })).status).toBe(404);
    expect((await post("configure", { sourceWorkspaceId: atlasId })).status).toBe(404);
    expect((await fetch(`${origin}${WORKTREE_API_PATH}`, withSession({ method: "POST" }))).status).toBe(405);
    expect((await fetch(`${origin}${WORKTREE_API_PATH}/create`, withSession())).status).toBe(405);
    expect((await fetch(`${origin}${WORKTREE_API_PATH}/fetch`, withSession())).status).toBe(405);
    expect((await fetch(`${origin}${WORKTREE_API_PATH}/preflight-delete`, withSession())).status).toBe(405);
    expect((await fetch(`${origin}${WORKTREE_API_PATH}/register`, withSession())).status).toBe(405);
    expect((await fetch(`${origin}${WORKTREE_API_PATH}/forget`, withSession())).status).toBe(405);
  });

  test("an invalid JSON body is refused as a transport problem, not a refusal", async () => {
    for (const action of ["fetch", "preflight-delete", "register", "forget"]) {
      const response = await fetch(`${origin}${WORKTREE_API_PATH}/${action}`, withSession({ method: "POST", headers: { "content-type": "application/json" }, body: "not json" }));
      expect(response.status).toBe(400);
    }
  });

  test("unauthenticated and cross-origin-cookie requests reach none of the new operations", async () => {
    for (const action of ["fetch", "preflight-delete", "register", "forget"]) {
      const anonymous = await fetch(`${origin}${WORKTREE_API_PATH}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceWorkspaceId: atlasId, reference: atlasId }),
      });
      expect(anonymous.status).toBe(401);
      const crossOrigin = await post(action, { sourceWorkspaceId: atlasId, reference: atlasId }, {
        headers: { cookie, origin: "https://evil.example" },
      });
      expect(crossOrigin.status).toBe(403);
    }
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
    // Ported from the retired `/worktrees` flow (section 9): the refusal
    // NAMES the occupying checkout, which is what lets the dialog offer its
    // Open/Start instead of a force option.
    expect(refused.error.conflictCheckoutId).toBeTruthy();
    const occupied = (await inventory()).checkouts.find(checkout =>
      checkout.checkoutId === refused.error.conflictCheckoutId
      || checkout.workspaceId === refused.error.conflictCheckoutId
      || checkout.path === refused.error.conflictCheckoutId);
    expect(occupied?.branch).toBe("feature/login");
  });

  // Ported from the retired `/worktrees` flow (section 9): the journal's
  // one-operation guard must surface over the wire as an ordinary refusal
  // that mutated nothing, not as a transport failure.
  test("a second creation while one is pending is refused before Git, not queued behind it", async () => {
    const atlas = registry.byId(atlasId)!.path;
    const journal = new WorktreeJournal(path.join(root, "state", "pending-worktree-operation.json"));
    await journal.begin({
      operationId: "operation-pending",
      kind: "create",
      phase: "creating",
      user: "reviewer",
      repositoryId: "repository-atlas",
      sourceWorkspaceId: atlasId,
      sourcePath: atlas,
      destination: `${atlas}.worktrees/feature-pending`,
      mode: "new-branch",
      branch: "feature/pending",
      base: { kind: "local", ref: "main" },
    });
    try {
      const refused = await result(await post("create", {
        sourceWorkspaceId: atlasId, mode: "new-branch", branch: "feature/second", baseRef: "main",
      }));
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.error.message).toContain("still in progress");
      expect(await git(atlas, ["branch", "--list", "feature/second"])).toBe("");
      expect(existsSync(`${atlas}.worktrees/feature-second`)).toBe(false);
    } finally {
      await journal.clear();
    }
  });

  test("an option-shaped branch cannot reach Git through the API either", async () => {
    const refused = await result(await post("create", {
      sourceWorkspaceId: atlasId, mode: "new-branch", branch: "--force", baseRef: "main",
    }));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("invalid-input");
  });

  // W2: a 65-character branch would otherwise let Git create the worktree
  // and branch, then fail registration forever (the registry's display-name
  // ceiling is 64). It must never reach Git at all.
  test("a branch name over 64 characters is refused before Git runs anything", async () => {
    const longBranch = `feature/${"x".repeat(60)}`;
    expect(longBranch.length).toBe(68);
    const refused = await result(await post("create", {
      sourceWorkspaceId: atlasId, mode: "new-branch", branch: longBranch, baseRef: "main",
    }));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("invalid-input");
    expect(refused.error.message).toBe("Branch names are limited to 64 characters in Uatu.");
    expect(await git(path.join(root, "atlas"), ["branch", "--list", longBranch])).toBe("");
    expect(existsSync(path.join(root, "atlas.worktrees", `feature-${"x".repeat(60)}`))).toBe(false);
    expect((await inventory()).checkouts.some(checkout => checkout.branch === longBranch)).toBe(false);
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

  test("a creation is in the authoritative listing immediately, and the retired HTML flow is gone", async () => {
    const created = await result(await post("create", {
      sourceWorkspaceId: atlasId, mode: "existing-local", base: { kind: "local", ref: "release" },
    }));
    expect(created.ok).toBe(true);
    // One family backs every surface: the dialog's own next read shows it,
    // with no second registration path.
    expect((await inventory()).checkouts.some(checkout => checkout.branch === "release")).toBe(true);
    // The server-rendered fragment flow the dialog replaced is unmounted.
    for (const retired of ["/worktrees", "/worktrees/create", "/worktrees/operation"]) {
      expect((await fetch(`${origin}${retired}`, { headers: { cookie, origin } })).status).toBe(404);
    }
  });
});

describe("fetch, preflight-delete, register and forget over JSON (8.1)", () => {
  test("fetch reports refs even when it is refused, and validates its own body", async () => {
    // This fixture configures no fetch policy, so a fetch is refused before
    // touching Git — and still reports the cached listing rather than
    // looking like an empty repository.
    const outcome = await refsResult(await post("fetch", { sourceWorkspaceId: atlasId }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("fetch-authentication");
    expect(outcome.refs?.local).toContain("release");

    const invalid = await refsResult(await post("fetch", { sourceWorkspaceId: atlasId, bogus: true }));
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error.code).toBe("invalid-input");
    expect(invalid.refs).toBeUndefined();
  });

  test("preflight-delete is read-only: it reports the checkout and requiresStop without removing anything", async () => {
    const created = await result(await post("create", {
      sourceWorkspaceId: atlasId, mode: "new-branch", branch: "feature/preflight", base: { kind: "local", ref: "main" },
    }));
    expect(created.ok).toBe(true);
    const checked = await preflight(await post("preflight-delete", { sourceWorkspaceId: atlasId, reference: "feature/preflight" }));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.requiresStop).toBe(false);
    expect(checked.checkout.branch).toBe("feature/preflight");
    // Read-only: nothing was removed or unregistered.
    expect(existsSync(path.join(root, "atlas.worktrees", "feature-preflight"))).toBe(true);
    expect(registry.byId(checked.checkout.workspaceId!)).toBeDefined();
  });

  test("preflight-delete never offers the main checkout, and refuses a reference that does not exist", async () => {
    const mainCheckout = await preflight(await post("preflight-delete", { sourceWorkspaceId: atlasId, reference: atlasId }));
    expect(mainCheckout.ok).toBe(false);
    if (mainCheckout.ok) return;
    expect(mainCheckout.error.code).toBe("ownership-required");

    const unknown = await preflight(await post("preflight-delete", { sourceWorkspaceId: atlasId, reference: "not-a-checkout" }));
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.code).toBe("not-found");
  });

  test("register brings an externally created tree under Uatu, invalidating the family; re-registering it is refused", async () => {
    await git(path.join(root, "atlas"), ["worktree", "add", path.join(root, "atlas.worktrees", "external"), "-b", "feature/external"]);
    const page = await openLive(atlasId);
    await page.waitFor(() => page.worktrees().length === 1, "fresh invalidation on subscribe");

    const registered = await result(await post("register", { sourceWorkspaceId: atlasId, reference: "feature/external" }));
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(registered.checkout!.ownership).toBe("external");
    expect(registered.registered).toBe(true);
    expect(registered.started).toBe(false);
    await page.waitFor(() => page.worktrees().length >= 2, "invalidation after registration");
    page.close();

    const again = await result(await post("register", { sourceWorkspaceId: atlasId, reference: "feature/external" }));
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe("conflict");
  });

  test("forget releases a running workspace stopped — there is no stop:false variant — keeping checkout, branch and files, and invalidates with the vacated reference", async () => {
    const created = await result(await post("create", {
      sourceWorkspaceId: atlasId, mode: "new-branch", branch: "feature/forget", base: { kind: "local", ref: "main" }, start: true,
    }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const workspaceId = created.checkout!.workspaceId!;
    expect(created.started).toBe(true);

    const page = await openLive(atlasId);
    await page.waitFor(() => page.worktrees().length === 1, "fresh invalidation on subscribe");

    const forgotten = await result(await post("forget", { sourceWorkspaceId: atlasId, reference: workspaceId }));
    expect(forgotten.ok).toBe(true);
    expect(registry.byId(workspaceId)).toBeUndefined();
    expect(existsSync(path.join(root, "atlas.worktrees", "feature-forget"))).toBe(true);
    expect(await git(path.join(root, "atlas"), ["branch", "--list", "feature/forget"])).toContain("feature/forget");
    await page.waitFor(() => page.worktrees().length >= 2, "invalidation after forget, carrying the vacated reference");
    page.close();
  });

  test("forget refuses a reference that is not a registered workspace", async () => {
    const refused = await result(await post("forget", { sourceWorkspaceId: atlasId, reference: "not-a-workspace" }));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("not-found");
  });
});

describe("register recovers a retained checkout over the wire (8.1)", () => {
  // A dedicated Hub, service and registrar: the first registration attempt
  // must fail AFTER Git succeeds, which the shared fixture's real registrar
  // cannot simulate. Git succeeding and registration failing is exactly what
  // leaves a checkout "retained" for the wire's /register to recover.
  let retryRoot = "";
  let retryOrigin = "";
  let retryCookie = "";
  let retryAtlasId = "";
  let retryServer: ReturnType<typeof startHubServer> | undefined;
  let retryRegistry: WorkspaceRegistry | undefined;
  let failNextRegistration = true;

  beforeAll(async () => {
    retryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "uatu-worktree-api-retry-")));
    temporaryDirectories.push(retryRoot);
    const retryHome = path.join(retryRoot, "home");
    await mkdir(retryHome);
    const state = path.join(retryRoot, "state");
    await mkdir(state);
    const env = { ...cleanEnvironment(), HOME: retryHome };
    const atlas = path.join(retryRoot, "atlas");
    await mkdir(atlas);
    await Bun.spawn(["git", "init", "--initial-branch=main"], { cwd: atlas, env, stdout: "ignore", stderr: "ignore" }).exited;
    await writeFile(path.join(atlas, "README.md"), "# atlas\n");
    await Bun.spawn(["git", "add", "."], { cwd: atlas, env, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["git", "-c", "commit.gpgsign=false", "commit", "-m", "initial"], { cwd: atlas, env, stdout: "ignore", stderr: "ignore" }).exited;

    const config: HubConfig = {
      port: 0, host: "127.0.0.1", tls: null,
      users: [{ name: "reviewer", passwordHash: await hashPassword("open sesame") }],
      stateDir: state,
    };
    retryRegistry = new WorkspaceRegistry(path.join(state, "registry.json"));
    const personalState = new PersonalWorkspaceStateStore(path.join(state, "personal-state.json"));
    const credentials = new CredentialMetadataStore(path.join(state, "credentials.json"));
    const sessionStore = new HubSessionStore(path.join(state, "sessions.json"));
    await Promise.all([retryRegistry.load(), personalState.load(), credentials.load(), sessionStore.load()]);
    let service!: WorktreeService;
    const sessions = new SessionManager(
      retryRegistry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER,
      workspaceId => service.assertStartable(workspaceId),
    );
    // One PathReservationCoordinator shared by onboarding and the worktree
    // coordinator, exactly like main.ts composes them — see the comment on
    // the other beforeAll's `reservations` above.
    const retryReservations = new PathReservationCoordinator();
    const onboarding = new WorkspaceOnboardingCoordinator({
      journalPath: path.join(state, "pending-onboarding.json"),
      registry: retryRegistry, credentials, sessions,
      reservations: retryReservations,
      git: onboardingGit,
    });
    retryAtlasId = (await onboarding.configureExisting({
      path: atlas, displayName: "Atlas", authentication: [], signing: null, init: false, start: false,
    })).entry.id;
    const realRegistrar = createOnboardingWorktreeRegistrar({ onboarding, registry: retryRegistry });
    service = new WorktreeService({
      registry: retryRegistry,
      sessions,
      journal: new WorktreeJournal(path.join(state, "pending-worktree-operation.json")),
      provenance: new WorktreeProvenanceStore(path.join(state, "worktree-provenance.json")),
      coordinator: new WorktreeOperationCoordinator(retryReservations),
      // Fails exactly the first registration, so create() reports a retained
      // checkout; every later call (the retry included) goes to the real one.
      registrar: {
        register: input => {
          if (failNextRegistration) {
            failNextRegistration = false;
            return Promise.reject(new Error("registry persistence failed"));
          }
          return realRegistrar.register(input);
        },
      },
      git: { env },
      fetchEnv: env,
      // No credential is assigned to the parent, and this repository has no
      // remote, so a fetch's own remote enumeration never calls `resolve` —
      // the policy exists only to prove a configured fetch actually runs.
      fetchPolicy: createParentFetchPolicy({
        assignments: () => credentials.snapshot().assignments,
        resolve: async () => { throw new Error("no credential is selected on the parent"); },
      }),
      unregister: async workspaceId => {
        await personalState.forgetWorkspace(workspaceId, () => retryRegistry!.remove(workspaceId), async () => {
          await credentials.removeWorkspaceAssignments(workspaceId);
        });
      },
    });
    retryServer = startHubServer({
      config, registry: retryRegistry, sessions, sessionStore, personalState, onboarding,
      worktrees: service,
      credentialApi: {
        metadata: credentials,
        tools: { list: () => [], async set() { throw new Error("unused"); } } as never,
        ssh: null, openpgp: null as never, tokens: null as never,
        workspaceExists: workspaceId => retryRegistry!.byId(workspaceId) !== undefined,
      },
    });
    retryOrigin = `http://127.0.0.1:${retryServer.port}`;
    retryCookie = `${hubCookieName(new URL(retryOrigin))}=${(await sessionStore.issue("reviewer", "test")).id}`;
  });

  afterAll(async () => {
    retryServer?.worktreeReconciler?.dispose();
    retryServer?.live.endAll();
    retryServer?.stop(true);
  });

  test("fetch succeeds and stamps freshness when a policy is configured", async () => {
    const response = await fetch(`${retryOrigin}${WORKTREE_API_PATH}/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: retryCookie },
      body: JSON.stringify({ sourceWorkspaceId: retryAtlasId }),
    });
    expect(response.status).toBe(200);
    const outcome = parseWorktreeRefsResponse(await response.json());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refs.fetchedAt).toBeGreaterThan(0);
  });

  test("register retries a retained checkout instead of creating a second one", async () => {
    const createResponse = await fetch(`${retryOrigin}${WORKTREE_API_PATH}/create`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: retryCookie },
      body: JSON.stringify({
        sourceWorkspaceId: retryAtlasId, mode: "new-branch", branch: "feature/retained", base: { kind: "local", ref: "main" },
      }),
    });
    const createdResult = parseWorktreeOperationResult(await createResponse.json());
    expect(createdResult.ok).toBe(false);
    if (createdResult.ok) return;
    expect(createdResult.error.code).toBe("registration-failed");
    expect(createdResult.error.retry).toBe("retry-registration");
    const retainedId = createdResult.retainedCheckout!.checkoutId;
    // Git succeeded: the branch and the tree are already there.
    expect(existsSync(path.join(retryRoot, "atlas.worktrees", "feature-retained"))).toBe(true);

    const registerResponse = await fetch(`${retryOrigin}${WORKTREE_API_PATH}/register`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: retryCookie },
      body: JSON.stringify({ sourceWorkspaceId: retryAtlasId, reference: retainedId }),
    });
    const registerResult = parseWorktreeOperationResult(await registerResponse.json());
    expect(registerResult.ok).toBe(true);
    if (!registerResult.ok) return;
    expect(registerResult.checkout?.checkoutId).toBe(retainedId);
    expect(registerResult.checkout?.ownership).toBe("uatu");
    expect(registerResult.registered).toBe(true);
    // Exactly one registration exists for it — the retry, not a second tree.
    expect(retryRegistry!.list().filter(entry => entry.worktree?.checkoutId === retainedId)).toHaveLength(1);
  });
});
