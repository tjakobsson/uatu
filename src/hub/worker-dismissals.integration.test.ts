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

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
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
  const child = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "GET") { nativeMutations++; return new Response(null, { status: 405 }); }
    const url = new URL(request.url); reads++;
    if (url.pathname !== "/s/project/api/chat/conversations/opencode%3Aparent" || url.searchParams.get("t") !== "synthetic-token") return new Response(null, { status: 404 });
    const response = Response.json({ conversation: { id: foreign ? "opencode:foreign" : "opencode:parent", title: "Synthetic", createdAt: 1, updatedAt: 1, status: "idle", agent: { id: "opencode", name: "OpenCode" } }, configuration: {}, generation: "synthetic", cursor: "synthetic-cursor", items: [...items, ...extraItems] });
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
  // Reconciliation also exposes unused immutable task aliases. Assert the
  // two explicit concurrent marks, not that every possible anchor was saved.
  expect(sameAccount.entries.filter((entry: { dismissed: boolean }) => entry.dismissed)
    .map((entry: { executionId: string }) => entry.executionId).sort()).toEqual(["one", "two"]);
  expect(sameAccount.entries).toEqual(expect.arrayContaining([
    { executionId: "worker-dismissal:task:one", revision: 0, dismissed: false },
    { executionId: "worker-dismissal:task:two", revision: 0, dismissed: false },
  ]));
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
  expect((await fetch(`${f.url}?conversationId=opencode:parent`)).status).toBe(401);
  const before = f.reads();
  for (const extra of [{ user: "bob" }, { activity: { kind: "working" } }, { version: 2 }, { expectedRevision: -1 }]) expect((await f.post("one", 0, f.alice.id, extra)).status).toBe(400);
  expect((await f.post("one", 0, f.alice.id, {}, "https://attacker.example")).status).toBe(403);
  expect((await f.get(f.alice.id, "&user=bob")).status).toBe(400);
  expect((await f.post("x".repeat(5000))).status).toBe(413);
  expect(f.reads()).toBe(before);
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
    for (const id of ["A", "B"]) expect(retired.entries.find((entry: { executionId: string }) => entry.executionId === id)).toMatchObject({ dismissed: false, revision: 2 });
    expect((await f.post("B", 0)).status).toBe(409);
    f.items[0]!.activity = { kind: "unavailable", executionId: "C" };
    const fresh = await (await f.get()).json();
    expect(fresh.entries.find((entry: { executionId: string }) => entry.executionId === "C")).toMatchObject({ dismissed: false, revision: 0 });
  } finally { detach(); }
});
