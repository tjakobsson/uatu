import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assertOpenApiResponse, loadContract } from "../../tests/contracts/contract-harness";
import { hashPassword, HubSessionStore, HUB_COOKIE_NAME } from "./auth";
import type { HubConfig } from "./config";
import {
  EMPTY_RESOLVED_CREDENTIAL_CONTEXT,
  type ResolvedAuthenticationCredential,
  type ResolvedCredentialContext,
  type ResolvedSigningCredential,
} from "./credential-context";
import { CredentialMetadataStore, CredentialTokenStore, CredentialToolOverrideStore } from "./credential-store";
import { CredentialToolManager } from "./credential-tools";
import { CredentialApi, credentialApiError } from "./credential-api";
import { OpenPgpCredentialManager } from "./openpgp-credentials";
import { PersonalWorkspaceStateStore } from "./personal-state";
import { WorkspaceOnboardingCoordinator } from "./onboarding";
import { PathReservationCoordinator } from "./path-reservations";
import { WorkspaceRegistry } from "./registry";
import { startHubServer } from "./server";
import { SessionManager } from "./sessions";
import { TokenCredentialManager } from "./token-credentials";

const roots: string[] = [];
const servers: ReturnType<typeof startHubServer>[] = [];
const openApi = await loadContract(path.resolve(import.meta.dir, "..", "..", "api", "openapi.yaml"));
const coveredOperations = new Set<string>();

async function assertContract(method: string, templatePath: string, response: Response): Promise<void> {
  await assertOpenApiResponse(openApi, { method, path: templatePath, response });
  const pathItem = (openApi.paths as Record<string, Record<string, { operationId?: string }>>)[templatePath];
  const operationId = pathItem?.[method.toLowerCase()]?.operationId;
  if (!operationId) throw new Error(`no documented operation for ${method} ${templatePath}`);
  coveredOperations.add(operationId);
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.cloneJobs.close();
    server.stop(true);
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(root: string) {
  const state = path.join(root, "state");
  await mkdir(state, { recursive: true });
  const registry = new WorkspaceRegistry(path.join(state, "registry.json"));
  await registry.load();
  const workspacePath = path.join(root, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const workspace = await registry.register(workspacePath);
  const sessionStore = new HubSessionStore(path.join(state, "sessions.json"));
  await sessionStore.load();
  const personalState = new PersonalWorkspaceStateStore(path.join(state, "personal.json"));
  await personalState.load();
  const metadata = new CredentialMetadataStore(path.join(state, "credentials.json"));
  const tokenStore = new CredentialTokenStore(path.join(state, "tokens.json"));
  const toolStore = new CredentialToolOverrideStore(path.join(state, "tools.json"));
  const tools = new CredentialToolManager(toolStore, "");
  await Promise.all([metadata.load(), tokenStore.load(), tools.load()]);
  const tokens = new TokenCredentialManager(metadata, tokenStore);
  const openpgp = new OpenPgpCredentialManager({
    gnupgHome: state,
    metadataStore: metadata,
    gpgPath: null,
    gpgconfPath: null,
  });
  const backendEvents = {
    starts: [] as string[],
    stops: [] as string[],
    stopFailures: new Set<string>(),
    runningProviderTokens: new Map<string, string[]>(),
  };
  // A minimal startable backend so tests can exercise running-session
  // gating (revocation vs a live child) without real processes.
  const backend = {
    start: async (entry: { id: string }, _basePath: string, credentials: ResolvedCredentialContext) => {
      backendEvents.starts.push(entry.id);
      const rawTokens = credentials.authentication.flatMap(item =>
        "token" in item
        && item.credential.capabilities.some(capability => capability === "github-cli" || capability === "gitlab-cli")
          ? [item.token]
          : []);
      backendEvents.runningProviderTokens.set(entry.id, rawTokens);
      return {
        workspaceId: entry.id,
        basePath: `/s/${entry.id}/`,
        endpoint: { hostname: "127.0.0.1", port: 1 },
        token: null,
        exited: new Promise<number | null>(() => undefined),
        stop: async () => {
          backendEvents.stops.push(entry.id);
          if (backendEvents.stopFailures.has(entry.id)) throw new Error(`${entry.id} refused stop`);
          backendEvents.runningProviderTokens.delete(entry.id);
        },
      };
    },
  };
  const sessions = new SessionManager(registry, { local: backend }, {
    revision: workspaceId => JSON.stringify(metadata.snapshot().assignments.filter(item => item.workspaceId === workspaceId)),
    runExclusive: operation => operation(),
    resolve: async entry => {
      const state = metadata.snapshot();
      const assignments = state.assignments.filter(item => item.workspaceId === entry.id);
      const authentication: ResolvedAuthenticationCredential[] = [];
      let signing: ResolvedSigningCredential | null = null;
      for (const assignment of assignments) {
        const credential = state.credentials.find(item => item.id === assignment.credentialId);
        if (!credential?.enabled) throw new Error(`credential is disabled: ${assignment.credentialId}`);
        if (assignment.role === "signing") {
          if (credential.type !== "token") signing = credential;
        } else if (credential.type === "token") {
          const token = tokenStore.get(credential.id);
          if (token === undefined) throw new Error(`credential token is unavailable: ${credential.id}`);
          authentication.push({ host: assignment.host, credential, token });
        } else if (credential.type === "ssh") {
          authentication.push({ host: assignment.host, credential });
        }
      }
      return {
        ...structuredClone(EMPTY_RESOLVED_CREDENTIAL_CONTEXT),
        revision: JSON.stringify(assignments),
        authentication,
        signing,
      };
    },
  });
  const config: HubConfig = {
    host: "127.0.0.1",
    port: 0,
    tls: null,
    stateDir: state,
    users: [
      { name: "alice", passwordHash: await hashPassword("alice password") },
      { name: "bob", passwordHash: await hashPassword("bob password") },
    ],
  };
  const onboardingJournal = path.join(state, "pending-onboarding.json");
  const onboarding = new WorkspaceOnboardingCoordinator({
    journalPath: onboardingJournal,
    registry,
    credentials: metadata,
    sessions,
    reservations: new PathReservationCoordinator(),
  });
  const server = startHubServer({
    config,
    registry,
    sessions,
    sessionStore,
    personalState,
    onboarding,
    credentialApi: {
      metadata,
      tools,
      ssh: null,
      openpgp,
      tokens,
      workspaceExists: id => registry.byId(id) !== undefined,
    },
  });
  servers.push(server);
  return { server, metadata, tokenStore, tokens, workspace, state, openpgp, registry, personalState, sessions, backendEvents, onboardingJournal };
}

async function login(origin: string, name: string, password: string): Promise<string> {
  const response = await fetch(`${origin}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, password }),
  });
  expect(response.status).toBe(200);
  const sessionId = ((await response.json()) as { sessionId: string }).sessionId;
  return `${HUB_COOKIE_NAME}=${sessionId}`;
}

function post(origin: string, cookie: string, endpoint: string, body: unknown, requestOrigin = origin) {
  return fetch(`${origin}${endpoint}`, {
    method: "POST",
    headers: { cookie, origin: requestOrigin, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("credential API integration", () => {
  test("maps an incorrect SSH passphrase to an actionable client error", () => {
    expect(credentialApiError(new Error("SSH credential could not be unlocked"))).toEqual({
      status: 400,
      message: "SSH credential could not be unlocked",
    });
  });

  test("serializes tool mutations through runtime refresh", async () => {
    let activePath = "";
    let releaseFirstRefresh!: () => void;
    let markFirstRefresh!: () => void;
    const firstRefresh = new Promise<void>(resolve => { markFirstRefresh = resolve; });
    const firstRefreshGate = new Promise<void>(resolve => { releaseFirstRefresh = resolve; });
    const published: string[] = [];
    const tools = {
      async setOverride(_tool: string, executablePath: string) {
        activePath = executablePath;
        return { tool: "git", path: executablePath, version: "test", results: [], guidance: null };
      },
      async clearOverride() { throw new Error("not used"); },
      async reprobeAll() {},
      list() { return [{ tool: "git", path: activePath, version: "test", results: [], guidance: null }]; },
    } as unknown as CredentialToolManager;
    const api = new CredentialApi({
      metadata: {} as CredentialMetadataStore,
      tools,
      ssh: null,
      openpgp: {} as OpenPgpCredentialManager,
      tokens: {} as TokenCredentialManager,
      workspaceExists: () => false,
      async toolsChanged() {
        const pathAtStart = activePath;
        if (pathAtStart === "/first") {
          markFirstRefresh();
          await firstRefreshGate;
        }
        published.push(pathAtStart);
      },
    });

    const first = api.setTool("git", { path: "/first" });
    await firstRefresh;
    const second = api.setTool("git", { path: "/second" });
    await Bun.sleep(1);
    expect(activePath).toBe("/first");
    releaseFirstRefresh();
    await Promise.all([first, second]);

    expect(published).toEqual(["/first", "/second"]);
    expect(activePath).toBe("/second");
  });

  test("reports deduplicated assigned credential names in populated Hub state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-credential-api-"));
    roots.push(root);
    const f = await fixture(root);
    const credential = await f.metadata.create({
      name: "Shared SSH",
      type: "ssh",
      enabled: false,
      capabilities: ["ssh-authentication", "ssh-signing"],
      metadata: { publicKey: "ssh-ed25519 AAAApublic", fingerprint: "SHA256:public" },
    });
    await f.metadata.assign({ workspaceId: f.workspace.id, credentialId: credential.id, role: "authentication", host: "github.com" });
    await f.metadata.assign({ workspaceId: f.workspace.id, credentialId: credential.id, role: "authentication", host: "gitlab.com" });
    await f.metadata.assign({ workspaceId: f.workspace.id, credentialId: credential.id, role: "signing" });
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");

    const response = await fetch(`${origin}/api/hub/state`, { headers: { cookie } });
    expect(response.status).toBe(200);
    await assertContract("GET", "/api/hub/state", response);
    expect(await response.json()).toMatchObject({
      workspaces: [{
        id: f.workspace.id,
        credentialAssignments: { authentication: ["Shared SSH"], signing: ["Shared SSH"] },
      }],
    });
  });

  test("reports missing tools and permits an authenticated readiness test", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-credential-api-"));
    roots.push(root);
    const f = await fixture(root);
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");

    const listed = await fetch(`${origin}/api/hub/credential-tools`, { headers: { cookie } });
    expect(listed.status).toBe(200);
    await assertContract("GET", "/api/hub/credential-tools", listed);
    const tools = (await listed.json()) as { tools: Array<{ tool: string; path: string | null; guidance: string | null }> };
    expect(tools.tools).toHaveLength(9);
    expect(tools.tools.every(tool => tool.path === null && tool.guidance !== null)).toBe(true);

    const tested = await post(origin, cookie, "/api/hub/credential-tools/gpg/test", {});
    expect(tested.status).toBe(200);
    await assertContract("POST", "/api/hub/credential-tools/{tool}/test", tested);
    expect(await tested.json()).toMatchObject({
      tool: {
        tool: "gpg",
        path: null,
        results: [{ layer: "binary", status: "unavailable" }],
      },
    });
  });

  test("shares Hub credentials across authenticated users without exposing secrets and persists restart state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-credential-api-"));
    roots.push(root);
    const first = await fixture(root);
    let origin = `http://127.0.0.1:${first.server.port}`;
    const alice = await login(origin, "alice", "alice password");
    const secret = "api-token-sentinel-value";

    const created = await post(origin, alice, "/api/hub/credentials/token", {
      name: "GitHub token",
      host: "github.com",
      username: "git",
      token: secret,
      capabilities: ["https-git", "github-cli"],
    });
    expect(created.status).toBe(200);
    await assertContract("POST", "/api/hub/credentials/token", created);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const createdText = await created.text();
    expect(createdText).not.toContain(secret);
    expect(createdText).not.toContain("token-sentinel");
    const credentialId = (JSON.parse(createdText) as { credential: { id: string } }).credential.id;

    const sshPublic = await first.metadata.create({
      name: "Public SSH key",
      type: "ssh",
      enabled: true,
      capabilities: ["ssh-signing"],
      metadata: { publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest public", fingerprint: "SHA256:public" },
    });
    const exported = await fetch(`${origin}/api/hub/credentials/${sshPublic.id}/public-key`, { headers: { cookie: alice } });
    expect(exported.status).toBe(200);
    await assertContract("GET", "/api/hub/credentials/{credentialId}/public-key", exported);
    expect(await exported.json()).toEqual({
      id: sshPublic.id,
      type: "ssh",
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest public",
      fingerprint: "SHA256:public",
    });

    const bob = await login(origin, "bob", "bob password");
    const shared = await fetch(`${origin}/api/hub/credentials`, { headers: { cookie: bob } });
    await assertContract("GET", "/api/hub/credentials", shared);
    const sharedText = await shared.text();
    expect(shared.status).toBe(200);
    expect(sharedText).toContain(credentialId);
    expect(sharedText).not.toContain(secret);
    expect(sharedText).not.toContain("privateKey");

    first.server.stop(true);
    servers.splice(servers.indexOf(first.server), 1);
    const restarted = await fixture(root);
    origin = `http://127.0.0.1:${restarted.server.port}`;
    const restartedAlice = await login(origin, "alice", "alice password");
    const afterRestart = await fetch(`${origin}/api/hub/credentials`, { headers: { cookie: restartedAlice } });
    const restartText = await afterRestart.text();
    expect(restartText).toContain(credentialId);
    expect(restartText).not.toContain(secret);
    expect(restarted.tokenStore.get(credentialId)).toBe(secret);
  }, 30_000);

  test("assignment mutations freeze while an onboarding journal is pending", async () => {
    // Onboarding recovery compares the workspace's current assignments
    // against the journaled pre-commit set; a mutation while the journal
    // lingers would make a deliberate revocation back to that set
    // indistinguishable from an unfinished commit.
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-credential-api-"));
    roots.push(root);
    const f = await fixture(root);
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");
    const create = await post(origin, cookie, "/api/hub/credentials/token", {
      name: "Fence token",
      host: "github.com",
      token: "fence-secret",
      capabilities: ["https-git"],
    });
    const credentialId = ((await create.json()) as { credential: { id: string } }).credential.id;

    const { writeFile, unlink } = await import("node:fs/promises");
    await writeFile(f.onboardingJournal, "{}\n", { mode: 0o600 });
    const fencedAssign = await post(origin, cookie, `/api/hub/credentials/${credentialId}/assign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "github.com",
    });
    expect(fencedAssign.status).toBe(409);
    expect(((await fencedAssign.json()) as { error: string }).error).toContain("pending onboarding");
    const fencedUnassign = await post(origin, cookie, `/api/hub/credentials/${credentialId}/unassign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "github.com",
    });
    expect(fencedUnassign.status).toBe(409);
    const fencedDelete = await post(origin, cookie, `/api/hub/credentials/${credentialId}/delete`, { confirm: true, unassign: true });
    expect(fencedDelete.status).toBe(409);
    expect(f.metadata.snapshot().assignments).toEqual([]);
    expect(f.metadata.snapshot().credentials.some(item => item.id === credentialId)).toBe(true);

    await unlink(f.onboardingJournal);
    const assigned = await post(origin, cookie, `/api/hub/credentials/${credentialId}/assign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "github.com",
    });
    expect(assigned.status).toBe(200);
  });

  test("assignment mutations refuse a journal that lands while they wait for the workspace queue", async () => {
    // The admission check above is only a fast-fail: onboarding publishes
    // its journal from inside runExclusive on the workspace id it planned,
    // so a request that reads a clear journal can then queue behind that
    // very commit and mutate assignments once it releases the queue. An
    // unassignment returning the set to its recorded pre-commit value would
    // then be reinstated by recovery, which reads that set as an unfinished
    // commit. The authoritative check therefore runs under the queue.
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-credential-api-"));
    roots.push(root);
    const f = await fixture(root);
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");
    const create = await post(origin, cookie, "/api/hub/credentials/token", {
      name: "Queue fence token",
      host: "github.com",
      token: "queue-fence-secret",
      capabilities: ["https-git"],
    });
    const credentialId = ((await create.json()) as { credential: { id: string } }).credential.id;
    const assigned = await post(origin, cookie, `/api/hub/credentials/${credentialId}/assign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "github.com",
    });
    expect(assigned.status).toBe(200);
    const committed = f.metadata.snapshot().assignments;
    expect(committed).toHaveLength(1);

    const { writeFile, unlink } = await import("node:fs/promises");
    // Occupy the workspace's lifecycle queue the way an onboarding commit
    // does, and journal only after each request is past the route's outer
    // checks: the check that fences them must be the one they make under
    // the queue, not one they made before asking for it.
    const raceUnderHeldQueue = async (send: () => Promise<Response>): Promise<Response> => {
      let releaseQueue!: () => void;
      const held = new Promise<void>(resolve => { releaseQueue = resolve; });
      const holding = f.sessions.runExclusive(f.workspace.id, () => held);
      const request = send();
      try {
        // Ample time for an in-process request to reach the route and queue
        // behind the hold. A slower machine only weakens the proof — a
        // journal that lands before the route runs is refused either way —
        // so this can never make the test red.
        await Bun.sleep(250);
        await writeFile(f.onboardingJournal, "{}\n", { mode: 0o600 });
        releaseQueue();
        await holding;
        return await request;
      } finally {
        releaseQueue();
        await holding.catch(() => undefined);
        await request.catch(() => undefined);
        await unlink(f.onboardingJournal).catch(() => undefined);
      }
    };

    const unassigned = await raceUnderHeldQueue(() => post(origin, cookie, `/api/hub/credentials/${credentialId}/unassign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "github.com",
    }));
    expect(unassigned.status).toBe(409);
    await assertContract("POST", "/api/hub/credentials/{credentialId}/unassign", unassigned);
    expect(await unassigned.json()).toEqual({
      error: "a pending onboarding requires Hub recovery before credential assignment changes",
    });
    expect(f.metadata.snapshot().assignments).toEqual(committed);

    // The workspace-scoped assignment API takes the same queue and answers
    // the same refusal.
    const replaced = await raceUnderHeldQueue(() => post(origin, cookie, `/api/hub/workspaces/${f.workspace.id}/credential-assignments`, {
      authentication: { credentialId, host: "gitlab.com" },
    }));
    expect(replaced.status).toBe(409);
    await assertContract("POST", "/api/hub/workspaces/{workspaceId}/credential-assignments", replaced);
    expect(await replaced.json()).toEqual({
      error: "a pending onboarding requires Hub recovery before credential assignment changes",
    });
    expect(f.metadata.snapshot().assignments).toEqual(committed);

    // With no journal on disk the same request commits, so the refusals
    // above were the fence and not an unrelated failure.
    const unfenced = await post(origin, cookie, `/api/hub/credentials/${credentialId}/unassign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "github.com",
    });
    expect(unfenced.status).toBe(200);
    expect(f.metadata.snapshot().assignments).toEqual([]);
  }, 30_000);

  test("enforces same-origin, strict bodies, references, and confirmed delete-and-unassign", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-credential-api-"));
    roots.push(root);
    const f = await fixture(root);
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");
    const secret = "delete-transaction-secret";
    const create = await post(origin, cookie, "/api/hub/credentials/token", {
      name: "Git token",
      host: "github.com",
      token: secret,
      capabilities: ["https-git"],
    });
    const credentialId = ((await create.json()) as { credential: { id: string } }).credential.id;

    const crossOrigin = await post(origin, cookie, `/api/hub/credentials/${credentialId}/disable`, {}, "https://attacker.example");
    expect(crossOrigin.status).toBe(403);
    await assertContract("POST", "/api/hub/credentials/{credentialId}/disable", crossOrigin);
    expect(f.metadata.snapshot().credentials.find(item => item.id === credentialId)?.enabled).toBe(true);

    const malformed = await post(origin, cookie, `/api/hub/credentials/${credentialId}/disable`, "{secret request garbage");
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).toBe('{"error":"invalid JSON body"}');
    const unknownField = await post(origin, cookie, `/api/hub/credentials/${credentialId}/disable`, { token: secret });
    expect(unknownField.status).toBe(400);
    expect(await unknownField.text()).not.toContain(secret);

    const unknownWorkspace = await post(origin, cookie, `/api/hub/credentials/${credentialId}/assign`, {
      workspaceId: "missing",
      role: "authentication",
      host: "github.com",
    });
    expect(unknownWorkspace.status).toBe(404);
    const assigned = await post(origin, cookie, `/api/hub/credentials/${credentialId}/assign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "github.com",
    });
    expect(assigned.status).toBe(200);
    await assertContract("POST", "/api/hub/credentials/{credentialId}/assign", assigned);

    const unconfirmed = await post(origin, cookie, `/api/hub/credentials/${credentialId}/delete`, { confirm: false, unassign: true });
    expect(unconfirmed.status).toBe(400);
    const referenced = await post(origin, cookie, `/api/hub/credentials/${credentialId}/delete`, { confirm: true });
    expect(referenced.status).toBe(409);
    expect(f.metadata.snapshot().assignments).toHaveLength(1);
    expect(f.tokenStore.get(credentialId)).toBe(secret);

    const deleted = await post(origin, cookie, `/api/hub/credentials/${credentialId}/delete`, { confirm: true, unassign: true });
    expect(deleted.status).toBe(200);
    await assertContract("POST", "/api/hub/credentials/{credentialId}/delete", deleted);
    expect(await deleted.json()).toEqual({ deleted: true });
    expect(f.metadata.snapshot().credentials.some(item => item.id === credentialId)).toBe(false);
    expect(f.metadata.snapshot().assignments).toEqual([]);
    expect(f.tokenStore.get(credentialId)).toBeUndefined();
  }, 30_000);

  test("removes credential assignments when a workspace is forgotten", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-credential-api-"));
    roots.push(root);
    const f = await fixture(root);
    const credential = await f.metadata.create({
      name: "Forgotten token",
      type: "token",
      enabled: true,
      capabilities: ["https-git"],
      metadata: { host: "github.com" },
    });
    await f.metadata.assign({ workspaceId: f.workspace.id, credentialId: credential.id, role: "authentication", host: "github.com" });
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");

    const response = await post(origin, cookie, `/api/hub/workspaces/${f.workspace.id}/forget`, {});
    expect(response.status).toBe(200);
    expect(f.metadata.snapshot().assignments).toEqual([]);
  });

  test("keeps credential assignments when registry removal fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-credential-api-"));
    roots.push(root);
    const f = await fixture(root);
    const credential = await f.metadata.create({
      name: "Retained token",
      type: "token",
      enabled: true,
      capabilities: ["https-git"],
      metadata: { host: "github.com" },
    });
    await f.metadata.assign({ workspaceId: f.workspace.id, credentialId: credential.id, role: "authentication", host: "github.com" });
    await f.personalState.patch("alice", f.workspace.id, { follow: false });
    f.registry.remove = async () => { throw new Error("registry disk full"); };
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");

    const response = await post(origin, cookie, `/api/hub/workspaces/${f.workspace.id}/forget`, {});
    expect(response.status).toBe(500);
    expect(f.registry.byId(f.workspace.id)).not.toBeUndefined();
    expect(f.personalState.get("alice", f.workspace.id)).toEqual({ version: 1, follow: false });
    expect(f.metadata.snapshot().assignments).toHaveLength(1);
  });

  test("serializes assignment with workspace forget", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-credential-api-"));
    roots.push(root);
    const f = await fixture(root);
    const credential = await f.metadata.create({
      name: "Racing token",
      type: "token",
      enabled: true,
      capabilities: ["https-git"],
      metadata: { host: "github.com" },
    });
    const originalAssign = f.metadata.assign.bind(f.metadata);
    let markAssignReached!: () => void;
    let releaseAssign!: () => void;
    const assignReached = new Promise<void>(resolve => { markAssignReached = resolve; });
    const assignGate = new Promise<void>(resolve => { releaseAssign = resolve; });
    f.metadata.assign = async (...args) => {
      markAssignReached();
      await assignGate;
      return originalAssign(...args);
    };
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");
    const assigning = post(origin, cookie, `/api/hub/credentials/${credential.id}/assign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "github.com",
    });
    await assignReached;
    let forgetSettled = false;
    const forgetting = post(origin, cookie, `/api/hub/workspaces/${f.workspace.id}/forget`, {})
      .finally(() => { forgetSettled = true; });
    await Bun.sleep(5);
    expect(forgetSettled).toBe(false);

    releaseAssign();
    expect((await assigning).status).toBe(200);
    expect((await forgetting).status).toBe(200);
    expect(f.registry.byId(f.workspace.id)).toBeUndefined();
    expect(f.metadata.snapshot().assignments).toEqual([]);
  });

  test("assigns provider-only tokens and removes only the selected authentication host", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-credential-api-"));
    roots.push(root);
    const f = await fixture(root);
    const ssh = await f.metadata.create({
      name: "Shared SSH key",
      type: "ssh",
      enabled: true,
      capabilities: ["ssh-authentication"],
      metadata: { publicKey: "ssh-ed25519 AAAATEST uatu", fingerprint: "SHA256:test" },
    });
    await f.metadata.assign({ workspaceId: f.workspace.id, credentialId: ssh.id, role: "authentication", host: "one.example.com" });
    await f.metadata.assign({ workspaceId: f.workspace.id, credentialId: ssh.id, role: "authentication", host: "two.example.com" });
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");
    const provider = await post(origin, cookie, "/api/hub/credentials/token", {
      name: "GitHub CLI",
      host: "github.example.com",
      token: "provider-only-secret",
      capabilities: ["github-cli"],
    });
    const providerId = ((await provider.json()) as { credential: { id: string } }).credential.id;

    expect((await post(origin, cookie, `/api/hub/credentials/${providerId}/assign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "github.example.com",
    })).status).toBe(200);
    const removed = await post(origin, cookie, `/api/hub/credentials/${ssh.id}/unassign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "one.example.com",
    });
    expect(removed.status).toBe(200);
    expect(f.metadata.snapshot().assignments).toContainEqual({
      workspaceId: f.workspace.id,
      credentialId: ssh.id,
      role: "authentication",
      host: "two.example.com",
    });
    expect(f.metadata.snapshot().assignments.some(assignment => assignment.credentialId === ssh.id && assignment.role === "authentication" && assignment.host === "one.example.com")).toBe(false);
  });

  test("disable and delete wait for the assigned workspace's lifecycle queue", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-credential-api-"));
    roots.push(root);
    const f = await fixture(root);
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");
    const created = await post(origin, cookie, "/api/hub/credentials/token", {
      name: "Revocable token",
      host: "github.com",
      token: "revocable-secret",
      capabilities: ["https-git"],
    });
    const credentialId = ((await created.json()) as { credential: { id: string } }).credential.id;
    expect((await post(origin, cookie, `/api/hub/credentials/${credentialId}/assign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "github.com",
    })).status).toBe(200);

    // Simulate a session start holding the workspace's lifecycle queue: the
    // revocation must queue behind it, not commit while the start could
    // still capture the credential.
    let releaseStart!: () => void;
    const startHeld = new Promise<void>(resolve => { releaseStart = resolve; });
    const start = f.sessions.runExclusive(f.workspace.id, () => startHeld);
    const disable = post(origin, cookie, `/api/hub/credentials/${credentialId}/disable`, {});
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(f.metadata.snapshot().credentials.find(item => item.id === credentialId)?.enabled).toBe(true);

    releaseStart();
    await start;
    expect((await disable).status).toBe(200);
    expect(f.metadata.snapshot().credentials.find(item => item.id === credentialId)?.enabled).toBe(false);

    const deletion = await post(origin, cookie, `/api/hub/credentials/${credentialId}/delete`, { confirm: true, unassign: true });
    expect(deletion.status).toBe(200);
    expect(f.metadata.snapshot().credentials).toEqual([]);
  });

  test("stops provider-token sessions before disable and confirmed delete without stopping HTTPS-only or unrelated sessions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-provider-revocation-"));
    roots.push(root);
    const f = await fixture(root);
    const unrelatedPath = path.join(root, "unrelated");
    await mkdir(unrelatedPath);
    const unrelated = await f.registry.register(unrelatedPath);
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");
    const providerSecret = "raw-provider-environment-token";
    const providerResponse = await post(origin, cookie, "/api/hub/credentials/token", {
      name: "Provider token",
      host: "github.com",
      token: providerSecret,
      capabilities: ["https-git", "github-cli"],
    });
    const providerId = ((await providerResponse.json()) as { credential: { id: string } }).credential.id;
    const httpsResponse = await post(origin, cookie, "/api/hub/credentials/token", {
      name: "HTTPS token",
      host: "gitlab.com",
      token: "live-helper-token",
      capabilities: ["https-git"],
    });
    const httpsId = ((await httpsResponse.json()) as { credential: { id: string } }).credential.id;
    expect((await post(origin, cookie, `/api/hub/credentials/${providerId}/assign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "github.com",
    })).status).toBe(200);
    expect((await post(origin, cookie, `/api/hub/credentials/${httpsId}/assign`, {
      workspaceId: unrelated.id,
      role: "authentication",
      host: "gitlab.com",
    })).status).toBe(200);
    await Promise.all([f.sessions.start(f.workspace.id), f.sessions.start(unrelated.id)]);
    expect(f.backendEvents.runningProviderTokens.get(f.workspace.id)).toEqual([providerSecret]);

    const unconfirmedDelete = await post(origin, cookie, `/api/hub/credentials/${providerId}/delete`, { confirm: false, unassign: true });
    expect(unconfirmedDelete.status).toBe(400);
    const rejectedDelete = await post(origin, cookie, `/api/hub/credentials/${providerId}/delete`, { confirm: true });
    expect(rejectedDelete.status).toBe(409);
    const enable = await post(origin, cookie, `/api/hub/credentials/${providerId}/enable`, {});
    expect(enable.status).toBe(200);
    const httpsDisable = await post(origin, cookie, `/api/hub/credentials/${httpsId}/disable`, {});
    expect(httpsDisable.status).toBe(200);
    expect(f.backendEvents.stops).toEqual([]);
    expect(f.sessions.isRunning(f.workspace.id)).toBe(true);
    expect(f.sessions.isRunning(unrelated.id)).toBe(true);

    const originalSetEnabled = f.tokens.setEnabled.bind(f.tokens);
    f.tokens.setEnabled = async (credentialId, enabled) => {
      if (credentialId === providerId && !enabled) {
        expect(f.backendEvents.stops).toContain(f.workspace.id);
        expect(f.sessions.isRunning(f.workspace.id)).toBe(false);
      }
      return originalSetEnabled(credentialId, enabled);
    };
    const disabled = await post(origin, cookie, `/api/hub/credentials/${providerId}/disable`, {});
    expect(disabled.status).toBe(200);
    expect(f.backendEvents.runningProviderTokens.has(f.workspace.id)).toBe(false);
    expect(f.sessions.isRunning(unrelated.id)).toBe(true);

    expect((await post(origin, cookie, `/api/hub/credentials/${providerId}/enable`, {})).status).toBe(200);
    await f.sessions.start(f.workspace.id);
    const originalDelete = f.tokens.delete.bind(f.tokens);
    f.tokens.delete = async (credentialId, unassign) => {
      if (credentialId === providerId) {
        expect(f.sessions.isRunning(f.workspace.id)).toBe(false);
        expect(f.backendEvents.runningProviderTokens.has(f.workspace.id)).toBe(false);
      }
      return originalDelete(credentialId, unassign);
    };
    const deleted = await post(origin, cookie, `/api/hub/credentials/${providerId}/delete`, { confirm: true, unassign: true });
    expect(deleted.status).toBe(200);
    expect(f.tokenStore.get(providerId)).toBeUndefined();
    expect(f.metadata.snapshot().assignments.some(item => item.credentialId === providerId)).toBe(false);
    expect(f.sessions.isRunning(unrelated.id)).toBe(true);
  }, 30_000);

  test("revokes stale provider projections but does not stop a session that never projected a later assignment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-stale-provider-projection-"));
    roots.push(root);
    const f = await fixture(root);
    const deletePath = path.join(root, "delete-stale");
    const addedPath = path.join(root, "assigned-after-start");
    await Promise.all([mkdir(deletePath), mkdir(addedPath)]);
    const deleteWorkspace = await f.registry.register(deletePath);
    const addedWorkspace = await f.registry.register(addedPath);
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");
    const createProvider = async (name: string, token: string): Promise<string> => {
      const response = await post(origin, cookie, "/api/hub/credentials/token", {
        name,
        host: "github.com",
        token,
        capabilities: ["github-cli"],
      });
      return ((await response.json()) as { credential: { id: string } }).credential.id;
    };
    const assign = (credentialId: string, workspaceId: string, replace = false) => post(
      origin,
      cookie,
      `/api/hub/credentials/${credentialId}/assign`,
      { workspaceId, role: "authentication", host: "github.com", replace },
    );
    const disableA = await createProvider("Disable A", "disable-a-secret");
    const disableB = await createProvider("Disable B", "disable-b-secret");
    const deleteA = await createProvider("Delete A", "delete-a-secret");
    const deleteB = await createProvider("Delete B", "delete-b-secret");
    const addedLater = await createProvider("Added later", "added-later-secret");

    expect((await assign(disableA, f.workspace.id)).status).toBe(200);
    await f.sessions.start(f.workspace.id);
    expect((await assign(disableB, f.workspace.id, true)).status).toBe(200);
    expect(f.sessions.runningWorkspaceIdsUsingCredential(disableA)).toEqual([f.workspace.id]);
    expect(f.metadata.snapshot().assignments.some(item => item.credentialId === disableA)).toBe(false);
    expect((await post(origin, cookie, `/api/hub/credentials/${disableA}/disable`, {})).status).toBe(200);
    expect(f.sessions.isRunning(f.workspace.id)).toBe(false);

    expect((await assign(deleteA, deleteWorkspace.id)).status).toBe(200);
    await f.sessions.start(deleteWorkspace.id);
    expect((await assign(deleteB, deleteWorkspace.id, true)).status).toBe(200);
    expect(f.sessions.runningWorkspaceIdsUsingCredential(deleteA)).toEqual([deleteWorkspace.id]);
    const deleted = await post(origin, cookie, `/api/hub/credentials/${deleteA}/delete`, { confirm: true });
    expect(deleted.status).toBe(200);
    expect(f.sessions.isRunning(deleteWorkspace.id)).toBe(false);
    expect(f.metadata.snapshot().credentials.some(item => item.id === deleteA)).toBe(false);

    await f.sessions.start(addedWorkspace.id);
    expect((await assign(addedLater, addedWorkspace.id)).status).toBe(200);
    expect(f.sessions.runningWorkspaceIdsUsingCredential(addedLater)).toEqual([]);
    expect((await post(origin, cookie, `/api/hub/credentials/${addedLater}/disable`, {})).status).toBe(200);
    expect(f.sessions.isRunning(addedWorkspace.id)).toBe(true);
    expect(f.backendEvents.stops).not.toContain(addedWorkspace.id);
  }, 30_000);

  test("attempts every provider-token stop and leaves the catalog intact when any stop fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-provider-stop-failure-"));
    roots.push(root);
    const f = await fixture(root);
    const secondPath = path.join(root, "second");
    await mkdir(secondPath);
    const second = await f.registry.register(secondPath);
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");
    const secret = "provider-stop-failure-secret";
    const created = await post(origin, cookie, "/api/hub/credentials/token", {
      name: "Shared provider token",
      host: "github.com",
      token: secret,
      capabilities: ["github-cli"],
    });
    const credentialId = ((await created.json()) as { credential: { id: string } }).credential.id;
    for (const workspaceId of [f.workspace.id, second.id]) {
      expect((await post(origin, cookie, `/api/hub/credentials/${credentialId}/assign`, {
        workspaceId,
        role: "authentication",
        host: "github.com",
      })).status).toBe(200);
      await f.sessions.start(workspaceId);
    }
    f.backendEvents.stopFailures.add(f.workspace.id);

    const failed = await post(origin, cookie, `/api/hub/credentials/${credentialId}/disable`, {});
    expect(failed.status).toBe(500);
    expect(new Set(f.backendEvents.stops)).toEqual(new Set([f.workspace.id, second.id]));
    expect(f.sessions.isRunning(f.workspace.id)).toBe(true);
    expect(f.sessions.isRunning(second.id)).toBe(false);
    expect(f.metadata.snapshot().credentials.find(item => item.id === credentialId)?.enabled).toBe(true);
    expect(f.metadata.snapshot().assignments.filter(item => item.credentialId === credentialId)).toHaveLength(2);
    expect(f.tokenStore.get(credentialId)).toBe(secret);

    f.backendEvents.stopFailures.clear();
    // A retry must still retire a survivor if the catalog already says the
    // credential is disabled, as can happen after recovery from older state.
    await f.metadata.setEnabled(credentialId, false);
    const retried = await post(origin, cookie, `/api/hub/credentials/${credentialId}/disable`, {});
    expect(retried.status).toBe(200);
    expect(f.sessions.isRunning(f.workspace.id)).toBe(false);
    expect(f.metadata.snapshot().credentials.find(item => item.id === credentialId)?.enabled).toBe(false);
  }, 30_000);

  test("confirmed provider-token delete preserves catalog and failed running projections when any stop fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-provider-delete-stop-failure-"));
    roots.push(root);
    const f = await fixture(root);
    const secondPath = path.join(root, "delete-second");
    await mkdir(secondPath);
    const second = await f.registry.register(secondPath);
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");
    const secret = "provider-delete-stop-failure-secret";
    const created = await post(origin, cookie, "/api/hub/credentials/token", {
      name: "Delete stop failure",
      host: "github.com",
      token: secret,
      capabilities: ["github-cli"],
    });
    const credentialId = ((await created.json()) as { credential: { id: string } }).credential.id;
    for (const workspaceId of [f.workspace.id, second.id]) {
      expect((await post(origin, cookie, `/api/hub/credentials/${credentialId}/assign`, {
        workspaceId,
        role: "authentication",
        host: "github.com",
      })).status).toBe(200);
      await f.sessions.start(workspaceId);
    }
    const assignments = f.metadata.snapshot().assignments;
    f.backendEvents.stopFailures.add(f.workspace.id);

    const failed = await post(origin, cookie, `/api/hub/credentials/${credentialId}/delete`, {
      confirm: true,
      unassign: true,
    });
    expect(failed.status).toBe(500);
    expect(new Set(f.backendEvents.stops)).toEqual(new Set([f.workspace.id, second.id]));
    expect(f.metadata.snapshot().credentials.find(item => item.id === credentialId)).toMatchObject({ enabled: true });
    expect(f.metadata.snapshot().assignments).toEqual(assignments);
    expect(f.tokenStore.get(credentialId)).toBe(secret);
    expect(f.tokens.resolve(credentialId)).toMatchObject({ token: secret });
    expect(f.sessions.isRunning(f.workspace.id)).toBe(true);
    expect(f.sessions.runningWorkspaceIdsUsingCredential(credentialId)).toEqual([f.workspace.id]);
    expect(f.sessions.isRunning(second.id)).toBe(false);
  }, 30_000);

  test("keeps provider sessions stopped when catalog mutation fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-provider-mutation-failure-"));
    roots.push(root);
    const f = await fixture(root);
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");
    const secret = "provider-mutation-failure-secret";
    const created = await post(origin, cookie, "/api/hub/credentials/token", {
      name: "Provider mutation failure",
      host: "gitlab.com",
      token: secret,
      capabilities: ["gitlab-cli"],
    });
    const credentialId = ((await created.json()) as { credential: { id: string } }).credential.id;
    expect((await post(origin, cookie, `/api/hub/credentials/${credentialId}/assign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "gitlab.com",
    })).status).toBe(200);
    await f.sessions.start(f.workspace.id);
    f.tokens.setEnabled = async () => { throw new Error("catalog write failed"); };

    const response = await post(origin, cookie, `/api/hub/credentials/${credentialId}/disable`, {});
    expect(response.status).toBe(500);
    expect(f.sessions.isRunning(f.workspace.id)).toBe(false);
    expect(f.backendEvents.runningProviderTokens.has(f.workspace.id)).toBe(false);
    expect(f.metadata.snapshot().credentials.find(item => item.id === credentialId)?.enabled).toBe(true);
    expect(f.metadata.snapshot().assignments.filter(item => item.credentialId === credentialId)).toHaveLength(1);
    expect(f.tokenStore.get(credentialId)).toBe(secret);
  }, 30_000);

  test("holds provider workspace queues through catalog mutation so a concurrent start cannot capture the token", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-provider-start-race-"));
    roots.push(root);
    const f = await fixture(root);
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");
    const created = await post(origin, cookie, "/api/hub/credentials/token", {
      name: "Racing provider token",
      host: "github.com",
      token: "provider-race-secret",
      capabilities: ["github-cli"],
    });
    const credentialId = ((await created.json()) as { credential: { id: string } }).credential.id;
    expect((await post(origin, cookie, `/api/hub/credentials/${credentialId}/assign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "github.com",
    })).status).toBe(200);
    await f.sessions.start(f.workspace.id);

    const originalSetEnabled = f.tokens.setEnabled.bind(f.tokens);
    let mutationReached!: () => void;
    let releaseMutation!: () => void;
    const atMutation = new Promise<void>(resolve => { mutationReached = resolve; });
    const mutationGate = new Promise<void>(resolve => { releaseMutation = resolve; });
    f.tokens.setEnabled = async (id, enabled) => {
      if (id === credentialId && !enabled) {
        mutationReached();
        await mutationGate;
      }
      return originalSetEnabled(id, enabled);
    };
    const disabling = post(origin, cookie, `/api/hub/credentials/${credentialId}/disable`, {});
    await atMutation;
    expect(f.sessions.isRunning(f.workspace.id)).toBe(false);
    const startOutcome = f.sessions.start(f.workspace.id).then(
      () => null,
      error => error,
    );
    await Bun.sleep(10);
    expect(f.backendEvents.starts).toEqual([f.workspace.id]);

    releaseMutation();
    expect((await disabling).status).toBe(200);
    expect(await startOutcome).toMatchObject({ message: expect.stringContaining("credential is disabled") });
    expect(f.backendEvents.runningProviderTokens.has(f.workspace.id)).toBe(false);
  }, 30_000);

  test("widens revocation queues for an assignment that commits after the initial snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-provider-revocation-widening-"));
    roots.push(root);
    const f = await fixture(root);
    const widenedPath = path.join(root, "z-widened");
    await mkdir(widenedPath);
    const widened = await f.registry.register(widenedPath);
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");
    const created = await post(origin, cookie, "/api/hub/credentials/token", {
      name: "Widened revocation token",
      host: "github.com",
      token: "widened-revocation-secret",
      capabilities: ["github-cli"],
    });
    const credentialId = ((await created.json()) as { credential: { id: string } }).credential.id;
    expect((await post(origin, cookie, `/api/hub/credentials/${credentialId}/assign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "github.com",
    })).status).toBe(200);
    await f.sessions.start(f.workspace.id);

    const originalAssign = f.metadata.assign.bind(f.metadata);
    let markAssignmentEntered!: () => void;
    let releaseAssignment!: () => void;
    const assignmentEntered = new Promise<void>(resolve => { markAssignmentEntered = resolve; });
    const assignmentGate = new Promise<void>(resolve => { releaseAssignment = resolve; });
    let assignmentCommitted = false;
    f.metadata.assign = async (...args) => {
      markAssignmentEntered();
      await assignmentGate;
      const result = await originalAssign(...args);
      assignmentCommitted = true;
      return result;
    };
    const assigning = post(origin, cookie, `/api/hub/credentials/${credentialId}/assign`, {
      workspaceId: widened.id,
      role: "authentication",
      host: "github.com",
    });
    await assignmentEntered;

    const originalRunExclusive = f.sessions.runExclusive.bind(f.sessions);
    let initialQueueObserved = false;
    let markInitialQueueEntered!: () => void;
    let markWidenedQueueEntered!: () => void;
    let releaseWidenedQueue!: () => void;
    const initialQueueEntered = new Promise<void>(resolve => { markInitialQueueEntered = resolve; });
    const widenedQueueEntered = new Promise<void>(resolve => { markWidenedQueueEntered = resolve; });
    const widenedQueueGate = new Promise<void>(resolve => { releaseWidenedQueue = resolve; });
    f.sessions.runExclusive = <T>(workspaceId: string, operation: () => Promise<T>) =>
      originalRunExclusive(workspaceId, async () => {
        if (workspaceId === f.workspace.id && !initialQueueObserved) {
          initialQueueObserved = true;
          markInitialQueueEntered();
        }
        if (workspaceId === widened.id) {
          markWidenedQueueEntered();
          await widenedQueueGate;
        }
        return operation();
      });
    const originalSetEnabled = f.tokens.setEnabled.bind(f.tokens);
    f.tokens.setEnabled = async (...args) => {
      expect(assignmentCommitted).toBe(true);
      return originalSetEnabled(...args);
    };

    const disabling = post(origin, cookie, `/api/hub/credentials/${credentialId}/disable`, {});
    await initialQueueEntered;
    expect(assignmentCommitted).toBe(false);
    expect(f.metadata.snapshot().credentials.find(item => item.id === credentialId)?.enabled).toBe(true);
    releaseAssignment();
    expect((await assigning).status).toBe(200);
    await widenedQueueEntered;
    expect(assignmentCommitted).toBe(true);
    expect(f.metadata.snapshot().credentials.find(item => item.id === credentialId)?.enabled).toBe(true);

    const startOutcome = f.sessions.start(widened.id).then(
      () => null,
      error => error,
    );
    expect(f.sessions.isStarting(widened.id)).toBe(true);
    expect(f.backendEvents.starts).toEqual([f.workspace.id]);
    releaseWidenedQueue();

    expect((await disabling).status).toBe(200);
    expect(await startOutcome).toMatchObject({ message: expect.stringContaining("credential is disabled") });
    expect(f.backendEvents.starts).toEqual([f.workspace.id]);
    expect(f.metadata.snapshot().assignments.some(item =>
      item.workspaceId === widened.id && item.credentialId === credentialId)).toBe(true);
  }, 30_000);

  test("assignments commit under the credential lock revocations hold", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-credential-api-"));
    roots.push(root);
    const f = await fixture(root);
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");
    const created = await post(origin, cookie, "/api/hub/credentials/token", {
      name: "Locked-out token",
      host: "github.com",
      token: "assignment-lock-secret",
      capabilities: ["https-git"],
    });
    const credentialId = ((await created.json()) as { credential: { id: string } }).credential.id;

    // A revocation holding the credential lock keeps a concurrent
    // assignment from committing until the lock is released.
    let releaseRevocation!: () => void;
    const revocationHeld = new Promise<void>(resolve => { releaseRevocation = resolve; });
    const revocation = f.metadata.runExclusiveCredential(credentialId, () => revocationHeld);
    const assignment = post(origin, cookie, `/api/hub/credentials/${credentialId}/assign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "github.com",
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(f.metadata.snapshot().assignments).toEqual([]);

    releaseRevocation();
    await revocation;
    expect((await assignment).status).toBe(200);
    expect(f.metadata.snapshot().assignments).toHaveLength(1);
  });

  test("atomically assigns authentication and signing under both credential locks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-credential-api-"));
    roots.push(root);
    const f = await fixture(root);
    const authentication = await f.metadata.create({
      name: "Authentication key",
      type: "ssh",
      enabled: false,
      capabilities: ["ssh-authentication"],
      metadata: { publicKey: "ssh-ed25519 AAAAauth", fingerprint: "SHA256:auth" },
    }, () => "auth-key");
    const signing = await f.metadata.create({
      name: "Signing key",
      type: "ssh",
      enabled: false,
      capabilities: ["ssh-signing"],
      metadata: { publicKey: "ssh-ed25519 AAAAsign", fingerprint: "SHA256:sign" },
    }, () => "sign-key");
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");

    const originalRunExclusiveCredential = f.metadata.runExclusiveCredential.bind(f.metadata);
    const enteredCredentialIds = new Set<string>();
    let markAuthenticationLockEntered!: () => void;
    let markSigningLockEntered!: () => void;
    let releaseTransaction!: () => void;
    const authenticationLockEntered = new Promise<void>(resolve => { markAuthenticationLockEntered = resolve; });
    const signingLockEntered = new Promise<void>(resolve => { markSigningLockEntered = resolve; });
    const transactionGate = new Promise<void>(resolve => { releaseTransaction = resolve; });
    f.metadata.runExclusiveCredential = <T>(credentialId: string, operation: () => Promise<T>) =>
      originalRunExclusiveCredential(credentialId, async () => {
        enteredCredentialIds.add(credentialId);
        if (credentialId === authentication.id) markAuthenticationLockEntered();
        if (credentialId === signing.id) {
          markSigningLockEntered();
          await transactionGate;
        }
        return operation();
      });
    const assigning = post(origin, cookie, `/api/hub/workspaces/${f.workspace.id}/credential-assignments`, {
      authentication: { credentialId: authentication.id, host: "github.com" },
      signing: { credentialId: signing.id },
    });
    await Promise.all([authenticationLockEntered, signingLockEntered]);
    expect(enteredCredentialIds).toEqual(new Set([authentication.id, signing.id]));
    expect(f.metadata.snapshot().assignments).toEqual([]);

    releaseTransaction();
    const response = await assigning;
    expect(response.status).toBe(200);
    await assertContract("POST", "/api/hub/workspaces/{workspaceId}/credential-assignments", response);
    expect((await response.json()) as unknown).toEqual({ assignments: [
      { workspaceId: f.workspace.id, credentialId: authentication.id, role: "authentication", host: "github.com" },
      { workspaceId: f.workspace.id, credentialId: signing.id, role: "signing" },
    ] });
    expect(f.metadata.snapshot().assignments).toHaveLength(2);
  });

  test("degrades one failed readiness probe without failing credential inventory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-credential-api-"));
    roots.push(root);
    const f = await fixture(root);
    await f.metadata.create({
      name: "Unavailable signing key",
      type: "openpgp",
      enabled: true,
      capabilities: ["openpgp-signing"],
      metadata: { publicKey: "public", fingerprint: "C".repeat(40) },
    }, () => "broken-readiness");
    await f.metadata.create({
      name: "Disabled token",
      type: "token",
      enabled: false,
      capabilities: ["https-git"],
      metadata: { host: "github.com" },
    }, () => "healthy-item");
    f.openpgp.readiness = async () => { throw new Error("gpg probe crashed"); };
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");

    const response = await fetch(`${origin}/api/hub/credentials`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { credentials: Array<{ id: string; readiness: Array<{ layer: string; status: string; message: string }> }> };
    expect(payload.credentials.find(item => item.id === "broken-readiness")?.readiness).toEqual([{
      layer: "runtime",
      status: "unavailable",
      message: "Credential readiness could not be determined.",
    }]);
    expect(payload.credentials.find(item => item.id === "healthy-item")?.readiness[0]?.message).toBe("The credential is disabled.");
  });

  test("refuses to unassign a running workspace without stop", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-credential-api-"));
    roots.push(root);
    const f = await fixture(root);
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");
    const created = await post(origin, cookie, "/api/hub/credentials/token", {
      name: "Live token",
      host: "github.com",
      token: "live-revocation-secret",
      capabilities: ["https-git"],
    });
    const credentialId = ((await created.json()) as { credential: { id: string } }).credential.id;
    expect((await post(origin, cookie, `/api/hub/credentials/${credentialId}/assign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "github.com",
    })).status).toBe(200);
    await f.sessions.start(f.workspace.id);

    // The running child keeps its projected configuration and the Hub-side
    // helper serves tokens by id, so a catalog-only removal would report a
    // revocation that is not in effect.
    const refused = await post(origin, cookie, `/api/hub/credentials/${credentialId}/unassign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "github.com",
    });
    expect(refused.status).toBe(409);
    expect(f.metadata.snapshot().assignments).toHaveLength(1);

    const stopped = await post(origin, cookie, `/api/hub/credentials/${credentialId}/unassign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "github.com",
      stop: true,
    });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ removed: true });
    expect(f.sessions.isRunning(f.workspace.id)).toBe(false);
    expect(f.metadata.snapshot().assignments).toEqual([]);
  });

  test("unassigns inside the stop lifecycle when stop is requested", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-credential-api-"));
    roots.push(root);
    const f = await fixture(root);
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");
    const created = await post(origin, cookie, "/api/hub/credentials/token", {
      name: "Stop token",
      host: "github.com",
      token: "stop-unassign-secret",
      capabilities: ["https-git"],
    });
    const credentialId = ((await created.json()) as { credential: { id: string } }).credential.id;
    expect((await post(origin, cookie, `/api/hub/credentials/${credentialId}/assign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "github.com",
    })).status).toBe(200);

    const invalid = await post(origin, cookie, `/api/hub/credentials/${credentialId}/unassign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "github.com",
      stop: "yes",
    });
    expect(invalid.status).toBe(400);

    const removed = await post(origin, cookie, `/api/hub/credentials/${credentialId}/unassign`, {
      workspaceId: f.workspace.id,
      role: "authentication",
      host: "github.com",
      stop: true,
    });
    expect(removed.status).toBe(200);
    await assertContract("POST", "/api/hub/credentials/{credentialId}/unassign", removed);
    expect(await removed.json()).toEqual({ removed: true });
    expect(f.metadata.snapshot().assignments).toEqual([]);
  });

  test("permits an empty unlock passphrase for SSH credentials only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-credential-api-"));
    roots.push(root);
    const f = await fixture(root);
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");
    await f.metadata.create({
      name: "Unencrypted key",
      type: "ssh",
      enabled: true,
      capabilities: ["ssh-authentication"],
      metadata: { publicKey: "ssh-ed25519 AAAA uatu", fingerprint: "SHA256:empty" },
    }, () => "ssh-empty");
    await f.metadata.create({
      name: "Signing key",
      type: "openpgp",
      enabled: true,
      capabilities: ["openpgp-signing"],
      metadata: { publicKey: "public", fingerprint: "B".repeat(40) },
    }, () => "pgp-empty");

    // Empty is a valid SSH unlock (an explicitly locked unencrypted key);
    // validation passes and the request reaches the absent SSH service.
    const ssh = await post(origin, cookie, "/api/hub/credentials/ssh-empty/unlock", { passphrase: "" });
    expect(ssh.status).toBe(503);
    // OpenPGP unlock keeps requiring a nonempty passphrase.
    const openpgp = await post(origin, cookie, "/api/hub/credentials/pgp-empty/unlock", { passphrase: "" });
    expect(openpgp.status).toBe(400);
  });

  test("returns an error when OpenPGP unlock does not make the key ready", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-credential-api-"));
    roots.push(root);
    const f = await fixture(root);
    const credential = await f.metadata.create({
      name: "Signing key",
      type: "openpgp",
      enabled: true,
      capabilities: ["openpgp-signing"],
      metadata: { publicKey: "public", fingerprint: "A".repeat(40) },
    });
    f.openpgp.unlock = async () => [{ layer: "runtime", status: "unavailable", message: "OpenPGP unlock failed." }];
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");

    const response = await post(origin, cookie, `/api/hub/credentials/${credential.id}/unlock`, { passphrase: "wrong" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "OpenPGP unlock failed." });
  });

  test("every credential mutation route conforms to its public contract", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "uatu-credential-api-"));
    roots.push(root);
    const f = await fixture(root);
    const origin = `http://127.0.0.1:${f.server.port}`;
    const cookie = await login(origin, "alice", "alice password");

    const cases: Array<[string, unknown, number, string]> = [
      ["/api/hub/credentials/ssh/generate", { name: "SSH", capabilities: ["ssh-authentication"], passphrase: "secret" }, 503, "/api/hub/credentials/ssh/generate"],
      ["/api/hub/credentials/ssh/import", { name: "SSH", capabilities: ["ssh-authentication"], privateKey: "private", passphrase: "secret" }, 503, "/api/hub/credentials/ssh/import"],
      ["/api/hub/credentials/openpgp/generate", { name: "PGP", userId: "User <user@example.test>", passphrase: "secret" }, 503, "/api/hub/credentials/openpgp/generate"],
      ["/api/hub/credentials/openpgp/import", { name: "PGP", privateKey: "private" }, 503, "/api/hub/credentials/openpgp/import"],
      ["/api/hub/credential-tools/gpg", { path: "/definitely/missing/gpg" }, 400, "/api/hub/credential-tools/{tool}"],
    ];
    for (const [endpoint, body, expectedStatus, contractPath] of cases) {
      const response = await post(origin, cookie, endpoint, body);
      expect(response.status).toBe(expectedStatus);
      await assertContract("POST", contractPath, response);
    }

    const created = await post(origin, cookie, "/api/hub/credentials/token", {
      name: "Lifecycle token",
      host: "github.com",
      token: "lifecycle-secret",
      capabilities: ["https-git"],
    });
    const credentialId = ((await created.json()) as { credential: { id: string } }).credential.id;
    const actions: Array<[string, unknown, string, number]> = [
      ["unlock", { passphrase: "secret" }, "unlock", 400],
      ["lock", {}, "lock", 400],
      ["enable", {}, "enable", 200],
      ["assign", { workspaceId: f.workspace.id, role: "authentication", host: "github.com" }, "assign", 200],
      ["unassign", { workspaceId: f.workspace.id, role: "authentication", host: "github.com" }, "unassign", 200],
      ["test", {}, "test", 200],
      ["delete", { confirm: true }, "delete", 200],
    ];
    for (const [action, body, contractAction, expectedStatus] of actions) {
      const response = await post(origin, cookie, `/api/hub/credentials/${credentialId}/${action}`, body);
      expect(response.status).toBe(expectedStatus);
      await assertContract("POST", `/api/hub/credentials/{credentialId}/${contractAction}`, response);
    }
  }, 30_000);

  test("every documented credential operation was black-box validated", () => {
    const documented = new Set<string>();
    for (const pathItem of Object.values(openApi.paths as Record<string, Record<string, unknown>>)) {
      for (const candidate of Object.values(pathItem)) {
        const operation = candidate as { operationId?: unknown; tags?: unknown } | null;
        if (typeof operation?.operationId === "string" && Array.isArray(operation.tags) && operation.tags.includes("Hub credentials")) {
          documented.add(operation.operationId);
        }
      }
    }
    expect(documented.size).toBe(19);
    expect([...documented].filter(id => !coveredOperations.has(id))).toEqual([]);
  });
});
