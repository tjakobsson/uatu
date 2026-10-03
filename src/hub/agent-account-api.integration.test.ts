// The Agent accounts routes through the real Hub server: the authentication
// gate, the same-origin rule, the published contract, and that no submitted
// secret reaches a response or the Hub's log.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assertOpenApiResponse, loadContract } from "../../tests/contracts/contract-harness";
import { AccountOperationError, type AccountAdapter, type AccountAdapterStatus, type StartedLogin } from "./agent-account-adapter";
import { AgentAccountService } from "./agent-account-service";
import type { AccountAgentId } from "./agent-account-types";
import { hashPassword, HubSessionStore, hubCookieName } from "./auth";
import type { HubConfig } from "./config";
import { EMPTY_CREDENTIAL_CONTEXT_RESOLVER } from "./credential-context";
import { PersonalWorkspaceStateStore } from "./personal-state";
import { WorkspaceRegistry } from "./registry";
import { startHubServer } from "./server";
import { SessionManager } from "./sessions";

const KEY = "gsk-integration-secret-key";
const CODE = "pasted-authorization-code";

class RecordingAdapter implements AccountAdapter {
  capabilities = { login: true, logout: true, activate: false };
  keys: string[] = [];
  connected = false;

  async status(): Promise<AccountAdapterStatus> {
    return {
      targets: [
        {
          id: "groq",
          name: "Groq",
          connected: this.connected,
          credentials: this.connected ? [{ id: "groq", label: "Saved login", kind: "saved", active: true, removable: true }] : [],
          methods: [
            { id: "key", kind: "key", label: "API key", fields: [] },
            { id: "0", kind: "oauth", label: "Browser", fields: [], completion: "redirect" },
            { id: "1", kind: "oauth", label: "Code", fields: [] },
          ],
        },
      ],
      methods: [],
    };
  }

  async connectKey(_target: string, _method: string, key: string): Promise<void> {
    if (key.startsWith("bad")) throw new AccountOperationError(`The key ${key} was rejected by the provider.`, "key");
    this.keys.push(key);
    this.connected = true;
  }

  async startLogin(_target: string, methodId: string): Promise<StartedLogin> {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    done.catch(() => undefined);
    const redirect = methodId === "0";
    return {
      url: redirect ? "https://auth.example.test/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb" : "https://auth.example.test/code",
      instructions: redirect ? "Sign in in your browser." : "Paste the code.",
      completion: redirect ? "redirect" : "code",
      callback: redirect ? { protocol: "http:", hostname: "localhost", port: "1", pathname: "/cb" } : null,
      waitForCompletion: () => done,
      ...(redirect ? {} : {
        submitCode: async (code: string) => {
          if (code.startsWith("wrong")) throw new AccountOperationError(`Code ${code} is invalid.`, "code");
          this.connected = true;
          resolve();
        },
      }),
      cancel: async () => reject(new Error("cancelled")),
    };
  }

  async logout(): Promise<void> {
    this.connected = false;
  }

  async activate(): Promise<void> {}
  async dispose(): Promise<void> {}
}

let tempRoot = "";
let hub: ReturnType<typeof startHubServer> | null = null;
let origin = "";
let cookie = "";
let adapter: RecordingAdapter;
let service: AgentAccountService;
const changed: AccountAgentId[] = [];
const fetched: string[] = [];
const openApi = await loadContract(path.resolve(import.meta.dir, "..", "..", "api", "openapi.yaml"));

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "uatu-agent-accounts-"));
  const registry = new WorkspaceRegistry(path.join(tempRoot, "registry.json"));
  await registry.load();
  const personalState = new PersonalWorkspaceStateStore(path.join(tempRoot, "personal-state.json"));
  await personalState.load();
  const sessions = new SessionManager(registry, { local: { start: async () => { throw new Error("no sessions here"); } } }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
  const config: HubConfig = {
    port: 0 as number,
    host: "127.0.0.1",
    tls: null,
    users: [{ name: "alice", passwordHash: await hashPassword("pw") }],
    stateDir: path.join(tempRoot, "state"),
  };
  const sessionStore = new HubSessionStore(path.join(tempRoot, "sessions.json"));
  await sessionStore.load();
  adapter = new RecordingAdapter();
  service = new AgentAccountService({
    runtimes: agent => ({
      start: async () => agent === "opencode"
        ? { state: "ready", version: "1.18.34", generation: 1, adapter }
        : { state: "not-installed", message: "Claude Code is not installed or is not on the Hub's PATH." },
      stop: async () => undefined,
    }),
    onChanged: agent => { changed.push(agent); },
    fetch: async input => {
      fetched.push(input);
      return new Response("ok");
    },
    settleWaitMs: 50,
  });
  hub = startHubServer({ config, registry, sessions, sessionStore, personalState, agentAccounts: service });
  origin = `http://127.0.0.1:${hub.port}`;
  const login = await fetch(`${origin}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "alice", password: "pw" }) });
  cookie = `${hubCookieName(new URL(origin))}=${((await login.json()) as { sessionId: string }).sessionId}`;
});

afterAll(async () => {
  await service?.dispose();
  hub?.stop(true);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

afterEach(() => {
  changed.length = 0;
  fetched.length = 0;
});

function post(endpoint: string, body: unknown, requestOrigin = origin) {
  return fetch(`${origin}${endpoint}`, {
    method: "POST",
    headers: { cookie, origin: requestOrigin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const coveredOperations = new Set<string>();

async function contract(method: string, template: string, response: Response): Promise<void> {
  await assertOpenApiResponse(openApi, { method, path: template, response: response.clone() });
  const operationId = (openApi.paths as Record<string, Record<string, { operationId?: string }>>)[template]?.[method.toLowerCase()]?.operationId;
  if (!operationId) throw new Error(`no documented operation for ${method} ${template}`);
  coveredOperations.add(operationId);
}

describe("agent accounts API", () => {
  test("reads require a Hub session", async () => {
    const response = await fetch(`${origin}/api/hub/agent-accounts`);
    expect(response.status).toBe(401);
  });

  test("the read lists both agents per the contract, a missing agent with its diagnostic", async () => {
    const response = await fetch(`${origin}/api/hub/agent-accounts`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await contract("GET", "/api/hub/agent-accounts", response);
    const body = await response.json() as { agents: Array<{ agent: string; state: string; message?: string }> };
    expect(body.agents.map(agent => [agent.agent, agent.state])).toEqual([["opencode", "ready"], ["claude", "not-installed"]]);
    expect(body.agents[1]?.message).toContain("not installed");
  });

  test("a key login reaches the agent and is never echoed or logged", async () => {
    const logs: string[] = [];
    const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
    try {
      const response = await post("/api/hub/agent-accounts/key", { agent: "opencode", target: "groq", method: "key", key: KEY });
      expect(response.status).toBe(200);
      await contract("POST", "/api/hub/agent-accounts/key", response);
      const text = await response.text();
      expect(text).not.toContain(KEY);
      expect(adapter.keys).toContain(KEY);
      expect(changed).toEqual(["opencode"]);
      const rejected = await post("/api/hub/agent-accounts/key", { agent: "opencode", target: "groq", method: "key", key: `bad-${KEY}` });
      expect(rejected.status).toBe(400);
      await contract("POST", "/api/hub/agent-accounts/key", rejected);
      const rejectedBody = await rejected.json() as { error: string; field?: string };
      expect(rejectedBody.field).toBe("key");
      expect(rejectedBody.error).not.toContain(KEY);
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
    expect(logs.join("\n")).not.toContain(KEY);
  });

  test("no file in the Hub's state directory holds a submitted key", async () => {
    await post("/api/hub/agent-accounts/key", { agent: "opencode", target: "groq", method: "key", key: KEY });
    const files: string[] = [];
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory).catch(() => [] as string[])) {
        const full = path.join(directory, entry);
        if ((await stat(full)).isDirectory()) await walk(full);
        else files.push(full);
      }
    };
    await walk(tempRoot);
    for (const file of files) expect(await readFile(file, "utf8")).not.toContain(KEY);
  });

  test("a cross-origin cookie mutation is refused and the agent is unchanged", async () => {
    const before = adapter.keys.length;
    const response = await post("/api/hub/agent-accounts/key", { agent: "opencode", target: "groq", method: "key", key: "cross-origin-key" }, "https://evil.example.test");
    expect(response.status).toBe(403);
    const login = await post("/api/hub/agent-accounts/login", { agent: "opencode", target: "groq", method: "1" }, "https://evil.example.test");
    expect(login.status).toBe(403);
    expect(adapter.keys.length).toBe(before);
    const reads = await (await fetch(`${origin}/api/hub/agent-accounts`, { headers: { cookie } })).json() as { attempts: unknown[] };
    expect(reads.attempts.filter(attempt => (attempt as { state: string }).state === "pending")).toEqual([]);
  });

  test("a code login completes with the pasted code, which never reaches a response or the log", async () => {
    const logs: string[] = [];
    const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
    try {
      const started = await post("/api/hub/agent-accounts/login", { agent: "opencode", target: "groq", method: "1" });
      expect(started.status).toBe(200);
      await contract("POST", "/api/hub/agent-accounts/login", started);
      const attempt = ((await started.json()) as { attempts: Array<{ id: string; state: string; completion: string }> }).attempts.find(item => item.state === "pending")!;
      expect(attempt.completion).toBe("code");
      const wrong = await post(`/api/hub/agent-accounts/attempts/${attempt.id}/code`, { code: `wrong-${CODE}` });
      expect(wrong.status).toBe(400);
      expect(await wrong.text()).not.toContain(CODE);
      const right = await post(`/api/hub/agent-accounts/attempts/${attempt.id}/code`, { code: CODE });
      expect(right.status).toBe(200);
      await contract("POST", "/api/hub/agent-accounts/attempts/{attemptId}/code", right);
      const text = await right.text();
      expect(text).not.toContain(CODE);
      expect(JSON.parse(text).attempts.find((item: { id: string }) => item.id === attempt.id).state).toBe("complete");
    } finally {
      error.mockRestore();
    }
    expect(logs.join("\n")).not.toContain(CODE);
  });

  test("a redirect address for another host is refused with no request; the attempt's own callback is delivered", async () => {
    const started = await post("/api/hub/agent-accounts/login", { agent: "opencode", target: "groq", method: "0" });
    const attempt = ((await started.json()) as { attempts: Array<{ id: string; state: string }> }).attempts.find(item => item.state === "pending")!;
    const refused = await post(`/api/hub/agent-accounts/attempts/${attempt.id}/redirect`, { address: "http://evil.example.test:1/cb?code=secret-redirect-code" });
    expect(refused.status).toBe(400);
    await contract("POST", "/api/hub/agent-accounts/attempts/{attemptId}/redirect", refused);
    const refusedBody = await refused.json() as { error: string; field?: string };
    expect(refusedBody.field).toBe("address");
    expect(refusedBody.error).not.toContain("secret-redirect-code");
    expect(fetched).toEqual([]);
    const delivered = await post(`/api/hub/agent-accounts/attempts/${attempt.id}/redirect`, { address: "http://localhost:1/cb?code=good" });
    expect(delivered.status).toBe(200);
    expect(fetched).toEqual(["http://localhost:1/cb?code=good"]);
    const cancelled = await post(`/api/hub/agent-accounts/attempts/${attempt.id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    await contract("POST", "/api/hub/agent-accounts/attempts/{attemptId}/cancel", cancelled);
  });

  test("an unknown attempt is 404; an agent that is not installed is 409; malformed bodies are 400", async () => {
    const missing = await post("/api/hub/agent-accounts/attempts/nope/cancel", {});
    expect(missing.status).toBe(404);
    await contract("POST", "/api/hub/agent-accounts/attempts/{attemptId}/cancel", missing);
    const notInstalled = await post("/api/hub/agent-accounts/login", { agent: "claude", target: "claude", method: "claudeai" });
    expect(notInstalled.status).toBe(409);
    await contract("POST", "/api/hub/agent-accounts/login", notInstalled);
    expect((await post("/api/hub/agent-accounts/key", { agent: "nobody", target: "x", method: "y", key: "z" })).status).toBe(400);
    expect((await post("/api/hub/agent-accounts/key", { agent: "opencode", target: "x", method: "y", key: "z", extra: 1 })).status).toBe(400);
  });

  test("switching a credential reaches the agent and announces the change", async () => {
    const response = await post("/api/hub/agent-accounts/activate", { agent: "opencode", credential: "cred_b" });
    expect(response.status).toBe(200);
    await contract("POST", "/api/hub/agent-accounts/activate", response);
    expect(changed).toEqual(["opencode"]);
  });

  test("logout reaches the agent and announces the change", async () => {
    const response = await post("/api/hub/agent-accounts/logout", { agent: "opencode", target: "groq", credential: "groq" });
    expect(response.status).toBe(200);
    await contract("POST", "/api/hub/agent-accounts/logout", response);
    expect(adapter.connected).toBe(false);
    expect(changed).toEqual(["opencode"]);
  });

  test("every documented agent accounts operation was black-box validated", () => {
    const documented = new Set<string>();
    for (const pathItem of Object.values(openApi.paths as Record<string, Record<string, unknown>>)) {
      for (const candidate of Object.values(pathItem)) {
        const operation = candidate as { operationId?: unknown; tags?: unknown } | null;
        if (typeof operation?.operationId === "string" && Array.isArray(operation.tags) && operation.tags.includes("Hub agent accounts")) documented.add(operation.operationId);
      }
    }
    expect(documented.size).toBe(8);
    expect([...documented].filter(id => !coveredOperations.has(id))).toEqual([]);
  });
});
