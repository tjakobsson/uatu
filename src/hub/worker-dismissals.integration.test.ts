import { afterEach, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BackgroundTaskItem } from "../chat/types";
import { HubSessionStore, hubCookieName } from "./auth";
import { EMPTY_CREDENTIAL_CONTEXT_RESOLVER } from "./credential-context";
import { PersonalWorkspaceStateStore } from "./personal-state";
import { WorkspaceRegistry } from "./registry";
import { SessionManager } from "./sessions";
import { startHubServer } from "./server";
import { WorkerDismissalsStore } from "./worker-dismissals";
import { createOpenCodeV2Provider } from "../chat/opencode/v2/provider";
import { compactWorkers } from "../chat/compact-work";
import { WorkerDismissalClient, visibleWorkers } from "../chat/worker-dismissal-client";
import { workerDismissalIdentities } from "../chat/worker-dismissal-identity";
import { workerDismissalEvidenceForItem } from "./worker-dismissals-observation";
import { compactWorkerEvidence } from "../chat/worker-dismissal-evidence";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// Reconstruct separate history reads, not two mutable rows in one runtime.
// The native fingerprint must distinguish contradictory immutable launches.
async function recoveredLaunch(ran = 10, message = "owner", prompt = "Review"): Promise<BackgroundTaskItem> {
  const launch = { id: message, type: "assistant", time: { created: 10 }, content: [{ id: "call", type: "tool", name: "subagent", time: { created: 10, ran, completed: 30 }, state: {
    status: "completed", input: { description: "Review", prompt }, metadata: { sessionID: "child", status: "running" },
  } }] };
  const provider = createOpenCodeV2Provider({ endpoint: "http://opencode.test", password: "fixture", directory: "/ws", fetch: (async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    expect(request.method).toBe("GET");
    if (/\/api\/session\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/").at(-1)!;
      return Response.json({ data: { id, projectID: "global", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 100, updated: 200 }, title: id, location: { directory: "/ws" }, ...(id === "child" ? { parentID: "parent" } : {}) } });
    }
    if (url.pathname.endsWith("/message")) return Response.json({ data: url.pathname.includes("/parent/") ? [launch] : [], cursor: {} });
    if (url.pathname.endsWith("/inbox")) return Response.json({ data: [] });
    if (url.pathname === "/api/session/active") return Response.json({});
    return Response.json({ _tag: "NotFoundError", message: url.pathname }, { status: 404 });
  }) as typeof fetch });
  try {
    const rows = (await provider.listMessages("parent", { limit: 100 })).items.filter((item): item is BackgroundTaskItem => item.type === "background_task");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.activity?.executionAliases).toHaveLength(1);
    return rows[0]!;
  } finally { await provider.dispose?.(); }
}

// Delivered synthetic messages retain their native inbox ID. These DTOs come
// from the public provider; tests never insert an activity identity envelope.
async function recoveredNotification(launch?: { owner: string; ran: number; prompt: string }): Promise<BackgroundTaskItem> {
  const result = { id: "native-inbox-result", type: "synthetic", time: { created: 40 }, text: "Done", metadata: { source: "subagent", childID: "child", state: "completed" } };
  const messages: unknown[] = [result];
  if (launch) messages.push({ id: launch.owner, type: "assistant", time: { created: 10 }, content: [{ id: "same-call", type: "tool", name: "subagent", time: { created: 10, ran: launch.ran, completed: 30 }, state: {
    status: "completed", input: { description: "Review", prompt: launch.prompt }, metadata: { sessionID: "child", status: "running" },
  } }] });
  const provider = createOpenCodeV2Provider({ endpoint: "http://opencode.test", password: "fixture", directory: "/ws", fetch: (async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    expect(request.method).toBe("GET");
    if (url.pathname === "/api/session/active") return Response.json({});
    if (/\/api\/session\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/").at(-1)!;
      return Response.json({ data: { id, projectID: "global", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 2 }, title: id, location: { directory: "/ws" }, ...(id === "child" ? { parentID: "parent" } : {}) } });
    }
    if (url.pathname.endsWith("/message")) return Response.json({ data: url.pathname.includes("/parent/") ? messages : [], cursor: {} });
    if (url.pathname.endsWith("/inbox")) return Response.json({ data: [] });
    return new Response(null, { status: 404 });
  }) as typeof fetch });
  try {
    const rows = (await provider.listMessages("parent", { limit: 100 })).items.filter((item): item is BackgroundTaskItem => item.type === "background_task");
    expect(rows).toHaveLength(1);
    return rows[0]!;
  } finally { await provider.dispose?.(); }
}

test.each([
  ["ran", 11, "owner", "Review"], ["owner", 10, "new-owner", "Review"], ["input", 10, "owner", "Different review"],
] as const)("dismissal disk restart separates reused call with contradictory %s", async (_field, ran, owner, prompt) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "uatu-dismissal-identity-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const scope = { user: "alice", workspaceId: "project", conversationId: "opencode:parent" };
  const first = await recoveredLaunch(), next = await recoveredLaunch(ran, owner, prompt);
  expect(first.activity!.executionId).not.toBe(next.activity!.executionId);
  const file = path.join(root, "dismissals.json"), store = new WorkerDismissalsStore(file);
  await store.load();
  const key = workerDismissalIdentities(first)[0]!;
  await store.reconcile(scope, async () => workerDismissalEvidenceForItem(first), { executionId: key, expectedRevision: 0, operation: "dismiss" });
  const restart = new WorkerDismissalsStore(file); await restart.load();
  const ready = Promise.withResolvers<void>();
  const client = new WorkerDismissalClient({ changed: () => ready.resolve(), fetcher: async () => Response.json(await restart.reconcile(scope, async () => workerDismissalEvidenceForItem(next))) });
  try {
    client.select(scope.conversationId);
    await ready.promise;
    expect(client.error).toBe("");
    expect(client.dismissed.has(key)).toBe(true);
    expect(visibleWorkers(compactWorkers([first]), client.dismissed)).toHaveLength(0);
    expect(visibleWorkers(compactWorkers([next]), client.dismissed)).toHaveLength(1);
  } finally { client.dispose(); }
});

test("pre-fix version-one bare marks stay on disk but do not hide strong V2 after reload or reconnect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "uatu-dismissal-legacy-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const scope = { user: "alice", workspaceId: "project", conversationId: "opencode:parent" };
  const file = path.join(root, "dismissals.json"), task = await recoveredLaunch();
  const legacy = { ...scope, executionId: "worker-dismissal:tool:call", revision: 3, dismissed: true, signature: "pre-fix-signature" };
  await fs.writeFile(file, JSON.stringify({ version: 1, records: [legacy] }), { mode: 0o600 });
  const store = new WorkerDismissalsStore(file); await store.load();
  const read = () => Promise.resolve(workerDismissalEvidenceForItem(task));
  for (let i = 0; i < 2; i++) {
    const state = await store.reconcile(scope, read);
    const marks = new Set(state.entries.filter(entry => entry.dismissed).map(entry => entry.executionId));
    expect(state.entries).toContainEqual({ executionId: legacy.executionId, revision: 3, dismissed: true });
    expect(visibleWorkers(compactWorkers([task]), marks)).toHaveLength(1);
    await store.load();
  }
  const strong = workerDismissalIdentities(task)[0]!;
  const current = await store.reconcile(scope, read);
  const saved = await store.reconcile(scope, read, { executionId: strong, expectedRevision: current.entries.find(entry => entry.executionId === strong)!.revision, operation: "dismiss" });
  expect(visibleWorkers(compactWorkers([task]), new Set(saved.entries.filter(entry => entry.dismissed).map(entry => entry.executionId)))).toHaveLength(0);
  const persisted = JSON.parse(await fs.readFile(file, "utf8"));
  expect(persisted.version).toBe(1);
  expect(persisted.records.find((entry: { executionId: string }) => entry.executionId === legacy.executionId)).toEqual(legacy);
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "uatu-worker-dismissals-api-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const registry = new WorkspaceRegistry(path.join(root, "registry.json"));
  const personalState = new PersonalWorkspaceStateStore(path.join(root, "personal.json"));
  const sessionStore = new HubSessionStore(path.join(root, "sessions.json"));
  const workerDismissals = new WorkerDismissalsStore(path.join(root, "dismissals.json"));
  await Promise.all([registry.load(), personalState.load(), sessionStore.load(), workerDismissals.load()]);
  await registry.register(path.join(root, "project"));
  const items: BackgroundTaskItem[] = ["one", "two"].map(id => ({ type: "background_task", id, taskId: id, createdAt: 1, description: "Synthetic worker", status: "running", activity: { kind: "unavailable", executionId: id } }));
  const extraItems: unknown[] = [];
  let foreign = false; let nativeMutations = 0; let reads = 0;
  let nextRead: { entered(): void; waiting: Promise<void> } | undefined;
  const blockRead = () => {
    let entered!: () => void; let release!: () => void;
    const readEntered = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    nextRead = { entered, waiting };
    return { readEntered, release };
  };
  // The delayed-evidence regression exceeds Bun's default ten-second idle
  // timeout; leave the Hub's evidence deadline as the boundary under test.
  const child = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, async fetch(request) {
    if (request.method !== "GET") { nativeMutations++; return new Response(null, { status: 405 }); }
    const url = new URL(request.url); reads++;
    if (!["/s/project/api/chat/conversations/opencode%3Aparent", "/s/project/api/chat/conversations/opencode%3Aparent/worker-evidence"].includes(url.pathname) || url.searchParams.get("t") !== "synthetic-token") return new Response(null, { status: 404 });
    const response = url.pathname.endsWith("/worker-evidence")
      ? Response.json({ version: 1, conversationId: foreign ? "opencode:foreign" : "opencode:parent", complete: true, entries: compactWorkerEvidence(items) })
      : Response.json({ conversation: { id: foreign ? "opencode:foreign" : "opencode:parent", title: "Synthetic", createdAt: 1, updatedAt: 1, status: "idle", agent: { id: "opencode", name: "OpenCode" } }, configuration: {}, generation: "synthetic", cursor: "synthetic-cursor", items: [...items, ...extraItems] });
    const blocked = nextRead; nextRead = undefined;
    if (blocked) { blocked.entered(); await blocked.waiting; }
    return response;
  } });
  cleanups.push(async () => { await child.stop(true); });
  const sessions = new SessionManager(registry, { local: { start: async () => ({ workspaceId: "project", instanceId: "synthetic", policyTrust: "unavailable", basePath: "/s/project/", endpoint: { hostname: "127.0.0.1", port: child.port! }, token: "synthetic-token", exited: new Promise<number | null>(() => {}), stop: async () => {} }) } }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
  await sessions.start("project");
  const hub = startHubServer({ config: { host: "127.0.0.1", port: 0, tls: null, users: ["alice", "bob"].map(name => ({ name, passwordHash: "unused" })) }, registry, sessions, sessionStore, personalState, workerDismissals });
  cleanups.push(async () => { await hub.stop(true); });
  const origin = `http://127.0.0.1:${hub.port}`;
  const alice = await sessionStore.issue("alice", "device A"); const aliceOther = await sessionStore.issue("alice", "device B"); const bob = await sessionStore.issue("bob", "other account");
  const cookie = (id: string) => `${hubCookieName(new URL(origin))}=${id}`;
  const url = `${origin}/s/project/api/personal-worker-dismissals`;
  const get = (id = alice.id, extra = "") => fetch(`${url}?conversationId=opencode%3Aparent${extra}`, { headers: { authorization: `Bearer ${id}` } });
  const post = (executionId: string, expectedRevision = 0, id = alice.id, extra = {}, requestOrigin = origin) => fetch(url, { method: "POST", headers: { cookie: cookie(id), origin: requestOrigin }, body: JSON.stringify({ version: 1, conversationId: "opencode:parent", operation: "dismiss", executionId, expectedRevision, ...extra }) });
  return { get, post, url, origin, alice, aliceOther, bob, cookie, items, extraItems, workerDismissals, root, registry, personalState, sessions, blockRead, reads: () => reads, mutations: () => nativeMutations, foreign: () => { foreign = true; } };
}

test("personal dismissal GET accepts complete evidence that arrives within the child history budget", async () => {
  const f = await fixture();
  const blocked = f.blockRead();
  const pending = f.get();
  await blocked.readEntered;
  // Deliberately exceed the former 10-second Hub deadline while staying well
  // within the child's 25-second covered-history budget. This delay is the
  // fault under test, not a wait for unrelated state to settle.
  const timer = setTimeout(blocked.release, 10_200);
  try {
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 1, conversationId: "opencode:parent", entries: [
      { executionId: "one", revision: 0, dismissed: false },
      { executionId: "two", revision: 0, dismissed: false },
    ] });
    expect(f.mutations()).toBe(0);
  } finally { clearTimeout(timer); blocked.release(); }
}, 20_000);

test("notification-only public DTO dismisses through the real Hub and disk reload without hiding an unproven late launch", async () => {
  const f = await fixture(), provisional = await recoveredNotification();
  f.items.splice(0, f.items.length, provisional);
  const id = provisional.activity?.executionId;
  expect(id).toMatch(/^v1:notification:[a-f0-9]{64}$/);
  const connect = async () => {
    const ready = Promise.withResolvers<void>();
    let posts = 0;
    const client = new WorkerDismissalClient({ changed: () => ready.resolve(), fetcher: async (_url, init) => {
      if (init?.method === "POST") posts++;
      const headers = new Headers(init?.headers);
      headers.set("cookie", f.cookie(f.alice.id)); headers.set("origin", f.origin);
      return fetch(`${f.url}${init?.method === "POST" ? "" : "?conversationId=opencode%3Aparent"}`, { ...init, headers });
    } });
    client.select("opencode:parent"); await ready.promise;
    expect(client.error).toBe("");
    return { client, posts: () => posts };
  };
  const first = await connect();
  try {
    await first.client.dismiss(id);
    expect(first.client.error).toBe("");
    expect(first.posts()).toBe(1);
    expect(visibleWorkers(compactWorkers([provisional]), first.client.dismissed)).toHaveLength(0);
  } finally { first.client.dispose(); }
  await f.workerDismissals.load();
  const persisted = JSON.parse(await fs.readFile(path.join(f.root, "dismissals.json"), "utf8"));
  expect(persisted.version).toBe(1);
  expect(persisted.records).toContainEqual(expect.objectContaining({ executionId: id, dismissed: true }));
  f.items.splice(0, f.items.length, await recoveredNotification());
  const reopened = await connect();
  try {
    expect(visibleWorkers(compactWorkers(f.items), reopened.client.dismissed)).toHaveLength(0);
    // Every launch is recovered independently. A weak result fold (even a
    // terminal one) supplies no positive notification-to-launch alias proof.
    for (const facts of [{ owner: "owner", ran: 11, prompt: "Review" }, { owner: "other-owner", ran: 12, prompt: "Different review" }]) {
      const exact = await recoveredNotification(facts);
      expect(exact.status).toBe("completed");
      expect(exact.activity?.executionId).toMatch(/^v1:[a-f0-9]{64}$/);
      expect(workerDismissalIdentities(exact)).not.toContain(id!);
      f.items.splice(0, f.items.length, exact);
      expect((await f.get()).status).toBe(200);
      expect(visibleWorkers(compactWorkers(f.items), reopened.client.dismissed)).toHaveLength(1);
    }
    expect(reopened.posts()).toBe(0);
    expect(f.mutations()).toBe(0);
  } finally { reopened.client.dispose(); }
});

test("POST queued behind the first GET is fenced before the workspace lifecycle wait", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const exclusive = f.sessions.runExclusive.bind(f.sessions);
  let calls = 0;
  const queued = spyOn(f.sessions, "runExclusive").mockImplementation((id, operation) => {
    if (++calls === 2) entered.resolve();
    return exclusive(id, operation);
  });
  const blocked = f.blockRead(); const get = f.get();
  await blocked.readEntered;
  const post = f.post("one");
  try {
    await entered.promise;
    f.items[0]!.activity!.kind = "working";
    const history = await fetch(`${f.origin}/s/project/api/chat/conversations/opencode%3Aparent`, { headers: { authorization: `Bearer ${f.alice.id}` } });
    expect(history.status).toBe(200); await history.json();
    f.items[0]!.activity!.kind = "unavailable";
    blocked.release(); expect((await get).status).toBe(200);
    expect((await post).status).toBe(409);
    // Drain the durable retirement before simulating process recovery.
    expect((await f.get()).status).toBe(200);
    await f.workerDismissals.load();
    const state = await (await f.get()).json();
    const entry = state.entries.find((entry: { executionId: string }) => entry.executionId === "one");
    expect(entry.dismissed).toBe(false);
    // A genuinely new explicit action after activity and a fresh unavailable
    // read remains admissible; the fence is not a permanent denial.
    expect((await f.post("one", entry.revision)).status).toBe(200);
    expect(f.mutations()).toBe(0);
  } finally { blocked.release(); await Promise.all([get, post]); queued.mockRestore(); }
});

test.each(["restart", "reused registration", "lifecycle failure"] as const)("admitted POST cannot cross %s while waiting for the real lifecycle mutex", async kind => {
  const f = await fixture();
  const blocked = Promise.withResolvers<void>();
  const held = f.sessions.runExclusive("project", () => blocked.promise);
  const queued = Promise.withResolvers<void>();
  const exclusive = f.sessions.runExclusive.bind(f.sessions);
  const changed = kind === "restart" ? (async () => { await f.sessions.stop("project"); await f.sessions.start("project"); })()
    : kind === "reused registration" ? exclusive("project", async () => {
      await f.registry.remove("project");
      await f.workerDismissals.forgetWorkspace("project");
      await f.registry.register(path.join(f.root, "new-location", "project"));
    }) : Promise.resolve();
  const lock = spyOn(f.sessions, "runExclusive").mockImplementation((id, operation) => {
    queued.resolve();
    return exclusive(id, async () => {
      if (kind === "lifecycle failure") throw new Error("synthetic lifecycle failure");
      return operation();
    });
  });
  const post = f.post("one");
  try {
    await queued.promise; blocked.resolve(); await held; await changed;
    expect((await post).status).toBe(503);
    expect(f.reads()).toBe(0);
    lock.mockRestore();
    expect((await f.post("one")).status).toBe(200);
    expect(f.mutations()).toBe(0);
  } finally { blocked.resolve(); await Promise.all([held, changed, post]); lock.mockRestore(); }
});

test("first personal POST before any GET conflicts with positive proxied history during its older read and stays visible after reload", async () => {
  const f = await fixture();
  const blocked = f.blockRead(); const first = f.post("one");
  await blocked.readEntered;
  try {
    f.items[0]!.activity!.kind = "working";
    const history = await fetch(`${f.origin}/s/project/api/chat/conversations/opencode%3Aparent`, { headers: { authorization: `Bearer ${f.alice.id}` } });
    expect(history.status).toBe(200);
    expect((await history.json()).items[0].activity.kind).toBe("working");
    f.items[0]!.activity!.kind = "unavailable";
    blocked.release(); expect((await first).status).toBe(409);
    expect((await f.post("one")).status).toBe(409);
    expect((await f.get()).status).toBe(200);
    await f.workerDismissals.load();
    expect((await f.post("one")).status).toBe(409);
    const state = await (await f.get()).json();
    expect(state.entries.find((entry: { executionId: string }) => entry.executionId === "one")).toMatchObject({ dismissed: false, revision: 2 });
    expect(f.mutations()).toBe(0);
  } finally { blocked.release(); await first; }
});

test("positive proxied history during an older personal read durably retires all accounts despite its later evidence commit", async () => {
  const f = await fixture();
  for (const id of [f.alice.id, f.bob.id]) expect((await f.post("one", 0, id)).status).toBe(200);
  f.items[0]!.activity!.generation = 2;
  const blocked = f.blockRead();
  const older = f.get();
  await blocked.readEntered;
  try {
    f.items[0]!.activity!.kind = "working";
    const response = await fetch(`${f.origin}/s/project/api/chat/conversations/opencode%3Aparent`, { headers: { authorization: `Bearer ${f.alice.id}` } });
    expect(response.status).toBe(200);
    expect((await response.json()).items[0].activity.kind).toBe("working");
    f.items[0]!.activity!.kind = "unavailable";
    blocked.release(); expect((await older).status).toBe(200);
    // Drain retirement through the API, then load only durable state.
    expect((await f.get()).status).toBe(200);
    await f.workerDismissals.load();
    for (const id of [f.alice.id, f.bob.id]) {
      expect((await f.post("one", 0, id)).status).toBe(409);
      const state = await (await f.get(id)).json();
      expect(state.entries.find((entry: { executionId: string }) => entry.executionId === "one")).toMatchObject({ dismissed: false, revision: 3 });
    }
    expect(f.mutations()).toBe(0);
  } finally { blocked.release(); await older; }
});

test("workspace-prefixed personal dismissal API merges devices, isolates accounts and durably fences active retirement", async () => {
  const f = await fixture();
  const initial = await f.get(); expect(initial.status).toBe(200); expect(initial.headers.get("cache-control")).toBe("no-store");
  expect((await Promise.all([f.post("one"), f.post("two", 0, f.aliceOther.id)])).map(response => response.status)).toEqual([200, 200]);
  const sameAccount = await (await f.get(f.aliceOther.id)).json();
  // Strong identities must not acquire unqualified native task aliases.
  expect(sameAccount.entries.filter((entry: { dismissed: boolean }) => entry.dismissed)
    .map((entry: { executionId: string }) => entry.executionId).sort()).toEqual(["one", "two"]);
  expect(sameAccount.entries).toHaveLength(2);
  expect((await (await f.get(f.bob.id)).json()).entries.some((entry: { dismissed: boolean }) => entry.dismissed)).toBe(false);
  f.items[0]!.activity!.kind = "working";
  expect((await f.get()).status).toBe(200);
  f.items[0]!.activity!.kind = "unavailable";
  expect((await f.post("one")).status).toBe(409);
  const fresh = await (await f.get()).json(); expect(fresh.entries.find((entry: { executionId: string }) => entry.executionId === "one")).toMatchObject({ dismissed: false, revision: 2 });
  expect((await f.post("one", 2)).status).toBe(200);
  expect(f.mutations()).toBe(0);
});

test("personal dismissal API rejects identity/origin/body/foreign execution claims before mutating", async () => {
  const f = await fixture();
  const admissions = spyOn(f.workerDismissals, "withAdmission");
  cleanups.push(async () => { admissions.mockRestore(); });
  expect((await fetch(`${f.url}?conversationId=opencode:parent`)).status).toBe(401);
  const before = f.reads();
  for (const extra of [{ user: "bob" }, { activity: { kind: "working" } }, { version: 2 }, { expectedRevision: -1 }]) expect((await f.post("one", 0, f.alice.id, extra)).status).toBe(400);
  expect((await f.post("one", 0, f.alice.id, {}, "https://attacker.example")).status).toBe(403);
  expect((await f.get(f.alice.id, "&user=bob")).status).toBe(400);
  expect((await f.post("x".repeat(5000))).status).toBe(413);
  expect(f.reads()).toBe(before);
  expect(admissions).not.toHaveBeenCalled();
  const foreignExecution = await f.post("foreign"); expect(foreignExecution.status).toBe(404); expect(foreignExecution.headers.get("cache-control")).toBe("no-store");
  f.foreign(); expect((await f.get()).status).toBe(503);
  expect(f.mutations()).toBe(0);
});

test("authenticated workspace forget clears all accounts' dismissals without touching another workspace", async () => {
  const f = await fixture();
  expect((await f.post("one")).status).toBe(200);
  expect((await f.post("one", 0, f.bob.id)).status).toBe(200);
  await f.registry.register(path.join(f.root, "other"));
  await f.personalState.patch("alice", "other", { documentPath: "keep.md" });
  const other = { user: "alice", workspaceId: "other", conversationId: "opencode:parent" };
  const evidence = async () => [{ executionId: "one", signature: "fixture", active: false, dismissible: true }];
  await f.workerDismissals.reconcile(other, evidence, { executionId: "one", expectedRevision: 0, operation: "dismiss" });
  await f.sessions.stop("project");
  const forgotten = await fetch(`${f.origin}/api/hub/workspaces/project/forget`, { method: "POST", headers: { cookie: f.cookie(f.alice.id), origin: f.origin } });
  expect(forgotten.status).toBe(200);
  expect(f.registry.byId("project")).toBeUndefined();
  await f.workerDismissals.load();
  for (const user of ["alice", "bob"]) {
    expect((await f.workerDismissals.reconcile({ user, workspaceId: "project", conversationId: "opencode:parent" }, async () => [])).entries).toEqual([]);
  }
  expect((await f.workerDismissals.reconcile(other, evidence)).entries).toContainEqual(expect.objectContaining({ executionId: "one", dismissed: true }));
  expect(f.personalState.get("alice", "other").documentPath).toBe("keep.md");
  expect(f.registry.byId("other")).toBeDefined();
  expect(f.mutations()).toBe(0);
});

test("failed dismissal cleanup leaves a durable forget journal that restart can finish", async () => {
  const f = await fixture();
  expect((await f.post("one")).status).toBe(200);
  expect((await f.post("one", 0, f.bob.id)).status).toBe(200);
  await f.sessions.stop("project");
  const cleanup = spyOn(f.workerDismissals, "forgetWorkspace").mockRejectedValueOnce(new Error("synthetic cleanup failure"));
  try {
    const forgotten = await fetch(`${f.origin}/api/hub/workspaces/project/forget`, { method: "POST", headers: { cookie: f.cookie(f.alice.id), origin: f.origin } });
    expect(forgotten.status).toBe(500);
    expect(f.registry.byId("project")).toBeUndefined();
  } finally { cleanup.mockRestore(); }
  const personal = new PersonalWorkspaceStateStore(path.join(f.root, "personal.json"));
  const dismissals = new WorkerDismissalsStore(path.join(f.root, "dismissals.json"));
  await Promise.all([personal.load(), dismissals.load()]);
  expect((JSON.parse(await fs.readFile(path.join(f.root, "personal.json"), "utf8"))).pendingForgets).toHaveProperty("project");
  await personal.recoverPendingForgets(id => f.registry.byId(id) !== undefined, id => dismissals.forgetWorkspace(id));
  for (const user of ["alice", "bob"]) {
    expect((await dismissals.reconcile({ user, workspaceId: "project", conversationId: "opencode:parent" }, async () => [])).entries).toEqual([]);
  }
  expect((JSON.parse(await fs.readFile(path.join(f.root, "personal.json"), "utf8"))).pendingForgets).toEqual({});
  expect(f.mutations()).toBe(0);
});

test("committed dismissal invalidates only same-account personal streams over the existing channel", async () => {
  const f = await fixture();
  await f.get(); await f.get(f.bob.id);
  const open = async (id: string) => {
    const response = await fetch(`${f.origin}/api/hub/live?ws=project&subs=${encodeURIComponent('[{"topic":"personal"}]')}`, { headers: { authorization: `Bearer ${id}` } });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes('"category":"worker-dismissals"')) text += new TextDecoder().decode((await reader.read()).value);
    return reader;
  };
  const a = await open(f.alice.id); const a2 = await open(f.aliceOther.id); const b = await open(f.bob.id);
  try {
    const nextA = a.read(); const nextA2 = a2.read(); const nextB = b.read();
    expect((await f.post("one")).status).toBe(200);
    for (const frame of await Promise.all([nextA, nextA2])) expect(new TextDecoder().decode(frame.value)).toContain('"category":"worker-dismissals"');
    await b.cancel(); expect((await nextB).done).toBe(true);
    const committed = await (await f.get()).json(); expect(committed.entries.find((entry: { executionId: string }) => entry.executionId === "one").dismissed).toBe(true);
  } finally { await Promise.all([a.cancel(), a2.cancel(), b.cancel()]); }
});

test("trusted proxied history retires a mark even if activity disappears before the next personal read", async () => {
  const f = await fixture();
  expect((await f.post("one")).status).toBe(200);
  f.items[0]!.activity!.kind = "needs-answer";
  let committed!: () => void; const saved = new Promise<void>(resolve => { committed = resolve; });
  const detach = f.workerDismissals.subscribe(committed);
  try {
    const history = await fetch(`${f.origin}/s/project/api/chat/conversations/opencode%3Aparent`, { headers: { authorization: `Bearer ${f.alice.id}` } });
    const snapshot = await history.json();
    expect(snapshot.items[0].activity.kind).toBe("needs-answer");
    await saved;
    f.items[0]!.activity!.kind = "unavailable";
    await f.workerDismissals.load(); // Simulate persisted state recovery, no provider read.
    expect((await f.post("one")).status).toBe(409);
    expect((await (await f.get()).json()).entries.find((entry: { executionId: string }) => entry.executionId === "one").dismissed).toBe(false);
    expect(f.mutations()).toBe(0);
  } finally { detach(); }
});

test("failed retirement leaves active history and canonical pending question available and reports private read failure", async () => {
  const f = await fixture();
  await f.post("one");
  f.items[0]!.activity = { kind: "needs-answer", executionId: "one", request: { kind: "question", id: "canonical" } };
  const question = { type: "question", id: "canonical", requestId: "native-question", createdAt: 1, status: "pending", questions: [{ prompt: "Continue?", header: "Choice", options: [{ label: "Yes", description: "Continue" }], multiple: false, allowFreeForm: true }] };
  f.extraItems.push(question);
  let failed!: () => void; const warning = new Promise<void>(resolve => { failed = resolve; });
  const detach = f.workerDismissals.subscribe(failed);
  const rename = spyOn(fs, "rename").mockRejectedValue(new Error("synthetic private-store outage"));
  try {
    const response = await fetch(`${f.origin}/s/project/api/chat/conversations/opencode%3Aparent`, { headers: { authorization: `Bearer ${f.alice.id}` } });
    expect(response.status).toBe(200);
    const history = await response.json();
    expect(history.items[0].activity.kind).toBe("needs-answer");
    expect(history.items.at(-1)).toEqual(question);
    await warning;
    const personal = await f.get(); expect(personal.status).toBe(503);
    expect((await personal.json()).error).toContain("chat remains available");
    expect(f.mutations()).toBe(0);
  } finally { detach(); rename.mockRestore(); }
});

test("proven aliases retain an old primary dismissal, retire together, and never hide a disjoint execution", async () => {
  const f = await fixture();
  f.items[0]!.activity = { kind: "unavailable", executionId: "B" };
  expect((await f.post("B")).status).toBe(200);
  f.items[0]!.activity = { kind: "unavailable", executionId: "A", executionAliases: ["A", "B"] };
  const unavailable = await (await f.get()).json();
  expect(unavailable.entries.find((entry: { executionId: string }) => entry.executionId === "B").dismissed).toBe(true);
  f.items[0]!.activity.kind = "working";
  let saved!: () => void; const committed = new Promise<void>(resolve => { saved = resolve; });
  const detach = f.workerDismissals.subscribe(saved);
  try {
    await (await fetch(`${f.origin}/s/project/api/chat/conversations/opencode%3Aparent`, { headers: { authorization: `Bearer ${f.alice.id}` } })).json();
    await committed;
    await f.workerDismissals.load();
    f.items[0]!.activity.kind = "unavailable";
    const retired = await (await f.get()).json();
    // B also crossed a causal signature change when its alias set expanded.
    for (const [executionId, revision] of [["A", 2], ["B", 3]]) expect(retired.entries.find((entry: { executionId: string }) => entry.executionId === executionId)).toMatchObject({ dismissed: false, revision });
    expect((await f.post("B", 0)).status).toBe(409);
    f.items[0]!.activity = { kind: "unavailable", executionId: "C" };
    const fresh = await (await f.get()).json();
    expect(fresh.entries.find((entry: { executionId: string }) => entry.executionId === "C")).toMatchObject({ dismissed: false, revision: 0 });
  } finally { detach(); }
});
