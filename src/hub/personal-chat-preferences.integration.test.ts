import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubSessionStore, hubCookieName } from "./auth";
import { PersonalChatPreferencesStore } from "./personal-chat-preferences";
import { PersonalWorkspaceStateStore } from "./personal-state";
import { WorkspaceRegistry } from "./registry";
import { SessionManager } from "./sessions";
import { EMPTY_CREDENTIAL_CONTEXT_RESOLVER } from "./credential-context";
import { startHubServer } from "./server";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "uatu-personal-chat-api-"));
  const registry = new WorkspaceRegistry(path.join(root, "registry.json"));
  const personalState = new PersonalWorkspaceStateStore(path.join(root, "personal.json"));
  const sessionStore = new HubSessionStore(path.join(root, "sessions.json"));
  const personalChatPreferences = new PersonalChatPreferencesStore(path.join(root, "chat.json"));
  await Promise.all([registry.load(), personalState.load(), sessionStore.load(), personalChatPreferences.load()]);
  const sessions = new SessionManager(registry, { local: { start: async () => { throw new Error("preferences must not start children"); } } }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
  const server = startHubServer({
    config: { host: "127.0.0.1", port: 0, tls: null, users: ["alice", "bob"].map(name => ({ name, passwordHash: "unused" })) },
    registry, personalState, sessionStore, sessions, personalChatPreferences,
  });
  cleanups.push(async () => { await server.stop(true); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.port}`;
  const alice = await sessionStore.issue("alice", "device A");
  const aliceOther = await sessionStore.issue("alice", "device B");
  const bob = await sessionStore.issue("bob", "device B");
  const cookie = (id: string) => `${hubCookieName(new URL(origin))}=${id}`;
  return { sessionStore, origin, alice, aliceOther, bob, cookie, url: `${origin}/api/hub/settings/chat-preferences` };
}

test("authenticated personal chat API isolates accounts, synchronizes devices, and rejects stale revisions", async () => {
  const f = await fixture();
  expect((await fetch(f.url)).status).toBe(401);
  const get = (id: string) => fetch(f.url, { headers: { authorization: `Bearer ${id}` } });
  const initial = await get(f.alice.id);
  expect(initial.status).toBe(200);
  expect(initial.headers.get("cache-control")).toBe("no-store");
  expect(await initial.json()).toEqual({ version: 1, revision: 0, autoBackgroundOnSteer: true });
  const put = (id: string, autoBackgroundOnSteer: boolean) => fetch(f.url, {
    method: "PUT", headers: { cookie: f.cookie(id), origin: f.origin, "content-type": "application/json" },
    body: JSON.stringify({ version: 1, expectedRevision: 0, autoBackgroundOnSteer }),
  });
  expect((await put(f.alice.id, false)).status).toBe(200);
  expect(await (await get(f.aliceOther.id)).json()).toEqual({ version: 1, revision: 1, autoBackgroundOnSteer: false });
  const conflict = await put(f.aliceOther.id, true);
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ current: { version: 1, revision: 1, autoBackgroundOnSteer: false } });
  expect(await (await get(f.bob.id)).json()).toEqual({ version: 1, revision: 0, autoBackgroundOnSteer: true });
  await f.sessionStore.revoke(f.alice.id);
  expect((await get(f.alice.id)).status).toBe(401);
  expect((await put(f.alice.id, true)).status).toBe(401);
});

test("personal chat API refuses foreign identity selectors, versions, cross-origin cookies and methods", async () => {
  const f = await fixture();
  const input = { version: 1, expectedRevision: 0, autoBackgroundOnSteer: false };
  const put = (body: unknown, origin = f.origin, extraHeaders = {}) => fetch(f.url, {
    method: "PUT", headers: { cookie: f.cookie(f.alice.id), origin, "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  expect((await put(input, "https://attacker.example")).status).toBe(403);
  for (const body of [{ ...input, user: "bob" }, { ...input, version: 2 }, { ...input, autoBackgroundOnSteer: "false" }, null]) {
    expect((await put(body)).status).toBe(400);
  }
  expect((await fetch(`${f.url}?user=bob`, { headers: { cookie: f.cookie(f.alice.id) } })).status).toBe(400);
  expect((await put(input, f.origin, { "x-hub-user": "bob" })).status).toBe(400);
  const method = await fetch(f.url, { method: "POST", headers: { cookie: f.cookie(f.alice.id), origin: f.origin } });
  expect(method.status).toBe(405);
  expect(method.headers.get("allow")).toBe("GET, PUT");
  const bearerSave = await fetch(f.url, { method: "PUT", headers: { authorization: `Bearer ${f.alice.id}`, "content-type": "application/json" }, body: JSON.stringify(input) });
  expect(bearerSave.status).toBe(200);
});
