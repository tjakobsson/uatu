import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assertOpenApiResponse, loadContract } from "../../tests/contracts/contract-harness";
import { hashPassword, HubSessionStore, HUB_COOKIE_NAME } from "./auth";
import type { HubConfig } from "./config";
import { EMPTY_CREDENTIAL_CONTEXT_RESOLVER } from "./credential-context";
import { CredentialMetadataStore, CredentialTokenStore, CredentialToolOverrideStore } from "./credential-store";
import { CredentialToolManager } from "./credential-tools";
import { CredentialApi, credentialApiError } from "./credential-api";
import { OpenPgpCredentialManager } from "./openpgp-credentials";
import { PersonalWorkspaceStateStore } from "./personal-state";
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
  const sessions = new SessionManager(registry, {} as never, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
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
  const server = startHubServer({
    config,
    registry,
    sessions,
    sessionStore,
    personalState,
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
  return { server, metadata, tokenStore, workspace, state, openpgp, registry, personalState };
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
    expect(tools.tools).toHaveLength(8);
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
    expect(documented.size).toBe(18);
    expect([...documented].filter(id => !coveredOperations.has(id))).toEqual([]);
  });
});
