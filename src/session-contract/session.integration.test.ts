// The session contract, checked against a REAL workspace session. One
// session is started once, from source, through the Hub's own local backend
// (so the spawn shape, the fd-3 bootstrap and the readiness proof are the
// product's), with an in-process Hub in front of it. Every expectation the
// Hub has of a session is then checked: the ready line, policy trust, that
// each internal path exists, that each refused path is refused (410 for a
// per-stream source, 404 for an internal route) without reaching the
// session, that the Hub's own proof and account-change calls still reach it
// directly, that all of them stay out of the public contract, and that
// closing stdin ends the session.
//
// Waits are events only: the backend's start (ready line and proof), each
// HTTP answer, and the process exit.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readYaml } from "../../scripts/validate-api";
import { createAccountChangeNotifier } from "../hub/agent-account-propagation";
import { HubSessionStore } from "../hub/auth";
import { LocalProcessBackend, type RunningSession } from "../hub/backend";
import { EMPTY_CREDENTIAL_CONTEXT_RESOLVER } from "../hub/credential-context";
import { PersonalWorkspaceStateStore } from "../hub/personal-state";
import { WorkspaceRegistry } from "../hub/registry";
import { startHubServer } from "../hub/server";
import { SessionManager } from "../hub/sessions";
import { LIVE_STREAM_PATH } from "../shared/live-protocol";
import { createSessionLink } from "./link";
import {
  classifySessionPath,
  INTERNAL_SESSION_PATHS,
  SESSION_ACCOUNTS_CHANGED_PATH,
  SESSION_POLICY_PROOF_PATH,
  sessionBasePath,
  sessionConversationEventsPath,
  sessionPath,
  sessionWorkerEvidencePath,
} from "./paths";
import { formatReadyLine, parseReadyLine, sessionServeArgv } from "./spawn";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.ts");
const UATU_ARGV = ["bun", "run", CLI_PATH];
// A source-run session bundles the page before it is ready.
const START_BUDGET_MS = 90_000;

type Exclusion = { id: string; scope?: string; path?: string; pathPattern?: string; condition?: string; reason?: string };

let directory: string;
let workspaceId: string;
let basePath: string;
// The session as the backend started it: its link addresses the session's
// own listener.
let session: RunningSession;
let spawned: { argv: string[]; stdio: unknown; env: unknown; child: Bun.Subprocess<"pipe", "pipe", "pipe"> };
// Everything the backend read from the session's stdout while starting it:
// any startup progress, then the ready line.
let printed = "";
let sessions: SessionManager;
let hub: ReturnType<typeof startHubServer>;
let hubOrigin: string;
let bearer: string;
// A loopback forwarder between the Hub and the session. It records every
// request path the Hub sends, which is how "no request reaches the session"
// is observed.
let forwarder: ReturnType<typeof Bun.serve>;
const reached: string[] = [];

beforeAll(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "uatu-session-contract-")));
  const workspace = path.join(directory, "project");
  await Bun.write(path.join(workspace, "README.md"), "# Session contract\n");
  // `uatu serve` refuses a folder outside a Git repository.
  execFileSync("git", ["init", "--quiet"], { cwd: workspace });

  const local = new LocalProcessBackend({
    uatuArgv: UATU_ARGV,
    spawn: ((argv: string[], options: { stdio: unknown; env: unknown }) => {
      const child = Bun.spawn(argv, options as never) as unknown as Bun.Subprocess<"pipe", "pipe", "pipe">;
      // Pass stdout through, keeping a copy of what the backend reads, so
      // the test sees the very ready line the backend parsed.
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      Object.defineProperty(child, "stdout", { value: new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { value, done } = await reader.read();
          if (done) { controller.close(); return; }
          printed += decoder.decode(value, { stream: true });
          controller.enqueue(value);
        },
        cancel: reason => reader.cancel(reason),
      }, { highWaterMark: 0 }) });
      spawned = { argv, stdio: options.stdio, env: options.env, child };
      return child;
    }) as unknown as typeof Bun.spawn,
  });

  const registry = new WorkspaceRegistry(path.join(directory, "registry.json"));
  await registry.load();
  workspaceId = (await registry.register(workspace)).id;
  basePath = sessionBasePath(workspaceId);

  sessions = new SessionManager(registry, { local: {
    start: async (entry, startBasePath, credentials) => {
      session = await local.start(entry, startBasePath, credentials);
      const direct = session.link;
      forwarder = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
        const url = new URL(request.url);
        reached.push(url.pathname);
        const headers = new Headers(request.headers);
        headers.set("host", `${direct.endpoint.hostname}:${direct.endpoint.port}`);
        headers.set("origin", direct.origin);
        return fetch(new URL(url.pathname + url.search, direct.origin), {
          method: request.method, headers, body: request.body, redirect: "manual", signal: request.signal,
        });
      } });
      // What the Hub holds: the same session, addressed through the forwarder.
      return {
        link: createSessionLink({
          workspaceId: direct.workspaceId,
          instanceId: direct.instanceId,
          basePath: direct.basePath,
          endpoint: { hostname: "127.0.0.1", port: forwarder.port! },
          token: direct.url("/").searchParams.get("t"),
        }),
        exited: session.exited,
        stop: session.stop,
      };
    },
  } }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
  await sessions.start(workspaceId);

  const sessionStore = new HubSessionStore(path.join(directory, "sessions.json"));
  bearer = (await sessionStore.issue("contract", "synthetic contract device")).id;
  const personalState = new PersonalWorkspaceStateStore(path.join(directory, "personal.json"));
  await personalState.load();
  hub = startHubServer({
    config: { host: "127.0.0.1", port: 0, tls: null, stateDir: directory, users: [{ name: "contract", passwordHash: "unused" }] },
    registry, sessions, sessionStore, personalState,
  });
  hubOrigin = `http://127.0.0.1:${hub.port}`;
}, START_BUDGET_MS);

afterAll(async () => {
  await hub?.stop(true);
  await sessions?.stopAll();
  await forwarder?.stop(true);
  if (directory) await rm(directory, { recursive: true, force: true });
}, 30_000);

function throughHub(suffix: string, method = "GET"): Promise<Response> {
  return fetch(`${hubOrigin}${sessionPath(basePath, suffix)}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: "{}" }),
  });
}

// Requests an internal path on the session's own listener, the way the Hub
// does. A stream answers with headers and stays open, so only the status and
// content type are read and the body is released.
async function direct(item: { path: string; method: string }): Promise<{ status: number; contentType: string }> {
  const abort = new AbortController();
  const headers = session.link.requestHeaders(item.method === "GET" ? undefined : "application/json");
  if (item.method !== "GET") headers.set("content-type", "application/json");
  try {
    const response = await fetch(session.link.url(item.path), {
      method: item.method, headers, signal: abort.signal, redirect: "manual",
      ...(item.method === "GET" ? {} : { body: "{}" }),
    });
    return { status: response.status, contentType: response.headers.get("content-type") ?? "" };
  } finally {
    abort.abort();
  }
}

// The two conversation-scoped internal paths, as the contract samples them.
const CONVERSATION_SCOPED: ReadonlySet<string> = new Set([sessionConversationEventsPath("sample"), sessionWorkerEvidencePath("sample")]);

// A GET on the session's own listener with the Hub's headers, for an answer
// that is JSON.
async function directJson(target: string): Promise<{ status: number; contentType: string; body: unknown }> {
  const response = await fetch(session.link.url(target), { headers: session.link.requestHeaders("application/json"), redirect: "manual" });
  return {
    status: response.status,
    contentType: (response.headers.get("content-type") ?? "").split(";")[0]!,
    body: await response.json(),
  };
}

describe("session contract against a real workspace session", () => {
  test("the Hub spawns the contract's argv with piped stdio, a private descriptor and an explicit environment", () => {
    expect(spawned.argv).toEqual(sessionServeArgv(UATU_ARGV, path.join(directory, "project"), basePath));
    expect(spawned.stdio).toEqual(["pipe", "pipe", "pipe", "socket-fd"]);
    expect(spawned.env).toBeObject();
  });

  test("the session prints a ready line the contract parser accepts", () => {
    const ready = parseReadyLine(printed.slice(0, printed.lastIndexOf("\n") + 1));
    expect(ready).not.toBeNull();
    expect(ready!.endpoint).toEqual(session.link.endpoint);
    expect(ready!.endpoint.hostname).toBe("127.0.0.1");
    expect(ready!.url.pathname).toBe(basePath);
    expect(ready!.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Byte for byte what the contract's formatter prints.
    expect(ready!.text).toBe(formatReadyLine(ready!.endpoint.port, basePath, ready!.token!));
    expect(session.link.url("/").searchParams.get("t")).toBe(ready!.token);
  });

  test("policy trust is ready through the fd-3 bootstrap and the readiness proof", () => {
    expect(session.link.policyTrust).toBe("ready");
    expect(session.link.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    const pathname = sessionPath(basePath, "/api/chat/conversations/opencode%3Aparent/prompts");
    expect(session.link.sign({ method: "POST", pathname, body: "{}" }, { principal: "alice", revision: 0, autoBackgroundOnSteer: false })).toBeString();
  });

  test("every internal path the Hub calls exists on the session's own listener", async () => {
    // The control: a path no route serves gets the listener's plain-text
    // 404, which is how a missing route is told apart from a route's own
    // answer.
    const unrouted = (answer: { status: number; contentType: string }) =>
      answer.status === 404 && !answer.contentType.includes("application/json");
    expect(unrouted(await direct({ path: "/api/internal/not-a-session-route", method: "POST" }))).toBe(true);
    // The conversation-scoped routes are proved by their handlers' own
    // answers in the next test: for the sample conversation, a JSON 404 is
    // the agent resolver's answer and says nothing about the route.
    const missing: string[] = [];
    for (const item of INTERNAL_SESSION_PATHS.filter(entry => !CONVERSATION_SCOPED.has(entry.path))) {
      if (unrouted(await direct(item))) missing.push(`${item.method} ${item.path}`);
    }
    expect(missing).toEqual([]);
    // The streams the Hub subscribes to open on the session's own listener.
    for (const item of INTERNAL_SESSION_PATHS.filter(entry => classifySessionPath(entry.method, entry.path) === "refused-stream" && !CONVERSATION_SCOPED.has(entry.path))) {
      const answer = await direct(item);
      expect(answer.status).toBe(200);
      expect(answer.contentType).toContain("text/event-stream");
    }
  }, 30_000);

  test("the conversation stream and worker evidence answer from their own handlers for the ids the Hub sends", async () => {
    // A conversation exists only behind a running agent runtime (an OpenCode
    // server, a Claude Code SDK session), which this session would have to
    // start and the test machine need not have. So the routes are proved by
    // the answers their handlers give before any agent is asked: each runs
    // after the session accepted the link's token and the agent-qualified id
    // the Hub sends, and neither is the resolver's 404 nor the fallback's.
    const id = "opencode:sample";
    // The live broker's catch-up names its cursor in the query; an empty one
    // is the stream handler's own refusal.
    expect(await directJson(`${sessionConversationEventsPath(id)}?cursor=`)).toEqual({
      status: 400, contentType: "application/json", body: { error: "invalid cursor" },
    });
    // Worker evidence takes no query beyond the token.
    expect(await directJson(`${sessionWorkerEvidencePath(id)}?unexpected=1`)).toEqual({
      status: 400, contentType: "application/json", body: { error: "unexpected query parameter" },
    });
  });

  test("a forwarded path reaches the session through the Hub", async () => {
    const response = await throughHub("/api/state");
    expect(response.status).toBe(200);
    expect(Array.isArray(((await response.json()) as { roots: unknown[] }).roots)).toBe(true);
    expect(reached).toContain(sessionPath(basePath, "/api/state"));
  });

  test("every per-stream path answers 410 through the Hub and never reaches the session", async () => {
    const refused = INTERNAL_SESSION_PATHS.filter(item => classifySessionPath(item.method, item.path) === "refused-stream");
    expect(refused.map(item => item.path)).toContain("/api/chat/notifications/events");
    expect(refused).toHaveLength(5);
    for (const item of refused) {
      const before = reached.length;
      const response = await throughHub(item.path);
      expect(response.status).toBe(410);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(((await response.json()) as { replacement: string }).replacement).toBe(LIVE_STREAM_PATH);
      expect(reached.slice(before)).toEqual([]);
    }
  });

  test("every internal route answers a non-cached 404 through the Hub, on any method, and never reaches the session", async () => {
    const refused = INTERNAL_SESSION_PATHS.filter(item => classifySessionPath(item.method, item.path) === "refused-internal");
    expect(refused.map(item => item.path).sort()).toEqual(["/api/chat/accounts-changed", "/api/internal/hub-policy-proof"]);
    for (const item of refused) {
      for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
        const before = reached.length;
        const response = await throughHub(item.path, method);
        expect(response.status).toBe(404);
        expect(response.headers.get("cache-control")).toBe("no-store");
        await response.body?.cancel();
        expect(reached.slice(before)).toEqual([]);
      }
    }
  });

  test("the Hub's own readiness proof still reaches the session directly", async () => {
    // The backend proved readiness against the session's own listener before
    // the Hub held the link: trust is ready only for a proof the policy
    // authority verified.
    expect(session.link.policyTrust).toBe("ready");
    // The same route, called the way the backend calls it, answers a proof.
    const before = reached.length;
    const response = await fetch(new URL(sessionPath(basePath, SESSION_POLICY_PROOF_PATH), session.link.origin), {
      method: "POST",
      headers: { "content-type": "application/json", origin: session.link.origin },
      body: JSON.stringify({ challenge: "contract-challenge" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(((await response.json()) as { proof: unknown }).proof).toBeString();
    expect(reached.slice(before)).toEqual([]);
  });

  test("the Hub's account-change notification still reaches the session directly", async () => {
    // The production notifier, aimed at the session's own listener; only the
    // answer is recorded on its way back.
    const answers: { pathname: string; status: number; body: unknown }[] = [];
    const notify = createAccountChangeNotifier({
      sessions: { runningIds: () => [workspaceId], get: id => (id === workspaceId ? session : undefined) },
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        answers.push({ pathname: input.pathname, status: response.status, body: await response.clone().json() });
        return response;
      },
    });
    const before = reached.length;
    await notify("opencode", { kind: "added" });
    expect(answers).toEqual([{ pathname: sessionPath(basePath, SESSION_ACCOUNTS_CHANGED_PATH), status: 200, body: { ok: true } }]);
    expect(reached.slice(before)).toEqual([]);
  });

  test("every internal path is an explicit exclusion, never a public operation", async () => {
    const [excluded, inventory, openapi] = await Promise.all([
      readYaml<{ exclusions: Exclusion[] }>("api/exclusions.yaml"),
      readYaml<{ operations: { path: string }[] }>("api/operations.yaml"),
      readYaml<{ paths: Record<string, unknown> }>("api/openapi.yaml"),
    ]);
    // Named by path, or by a prefix pattern covering it. Conditional entries
    // and the method catch-all describe fallbacks and classify nothing.
    const excludes = (exclusion: Exclusion, target: string) => {
      if (exclusion.condition !== undefined || exclusion.scope === "hub" || exclusion.pathPattern === "*") return false;
      if (exclusion.path === target) return true;
      return exclusion.pathPattern?.endsWith("*") === true && target.startsWith(exclusion.pathPattern.slice(0, -1));
    };
    const published = new Set([...inventory.operations.map(item => item.path), ...Object.keys(openapi.paths)]
      .map(item => item.replace(/\{[^}]+\}/g, "sample")));
    for (const item of INTERNAL_SESSION_PATHS) {
      const throughHubPath = `/s/{workspaceId}${item.path}`;
      expect(excluded.exclusions.some(exclusion => excludes(exclusion, throughHubPath))).toBe(true);
      expect(excluded.exclusions.some(exclusion => excludes(exclusion, item.path))).toBe(true);
      expect(published.has(`/s/sample${item.path}`)).toBe(false);
      expect(published.has(item.path)).toBe(false);
    }
    // Every path the Hub refuses, per-stream source or internal route, is
    // named by its own entry, which states the refusal, rather than only
    // falling under the session API's prefix pattern.
    const template = (suffix: string) => `/s/{workspaceId}${suffix.replace("/sample/", "/{conversationId}/")}`;
    const refused = INTERNAL_SESSION_PATHS.filter(item => classifySessionPath(item.method, item.path).startsWith("refused-"));
    expect(refused).toHaveLength(7);
    const unnamed = refused
      .filter(item => !excluded.exclusions.some(exclusion => exclusion.path === template(item.path) && /^not proxied\./.test(exclusion.reason ?? "")));
    expect(unnamed.map(item => item.path)).toEqual([]);
  });

  // Last: it ends the session the tests above share.
  test("closing stdin makes the session exit", async () => {
    spawned.child.stdin.end();
    expect(await session.exited).toBe(0);
  }, 30_000);
});
