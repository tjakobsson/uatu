import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalProcessBackend } from "./backend";
import { HubSessionStore } from "./auth";
import { WorkspaceRegistry } from "./registry";
import { SessionManager } from "./sessions";
import { PersonalWorkspaceStateStore } from "./personal-state";
import { PersonalChatPreferencesStore } from "./personal-chat-preferences";
import { EMPTY_CREDENTIAL_CONTEXT_RESOLVER } from "./credential-context";
import { startHubServer } from "./server";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(trusted = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "uatu-personal-policy-"));
  const script = path.join(root, "child.ts");
  const bootstrapModule = new URL("./child-policy-bootstrap.ts", import.meta.url).pathname;
  await writeFile(script, `import {consumeChildPolicyDescriptor} from ${JSON.stringify(bootstrapModule)};
    const policy = ${trusted ? "await consumeChildPolicyDescriptor()" : "null"}; let n=0;
    const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
      const url=new URL(request.url); const text=await request.text();
      if(url.pathname.endsWith('/api/internal/hub-policy-proof'))return Response.json({proof:policy?.proof(JSON.parse(text).challenge)});
      const envelope=request.headers.get('x-uatu-hub-chat-policy');
      if(!policy && envelope)return new Response('unsigned identity must not cross', {status:403});
      const verified=policy?.verify({method:request.method,pathname:url.pathname,body:text},envelope??'');
      return Response.json({messageId:'fixture-'+(++n),pending:true,delivery:'steer',configuration:{},
        ...(verified?.unavailable?{automaticBackground:'unavailable'}:verified?.autoBackgroundOnSteer?{automaticBackground:'accepted'}:{})}, {status:202});
    }}); console.log('http://127.0.0.1:'+server.port+'/'); process.stdin.resume();process.on('SIGTERM',()=>process.exit(0));`);
  const registry = new WorkspaceRegistry(path.join(root, "registry.json"));
  await registry.load();
  const entry = await registry.register(root);
  const sessions = new SessionManager(registry, { local: new LocalProcessBackend({ uatuArgv: [process.execPath, script] }) }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
  const personalState = new PersonalWorkspaceStateStore(path.join(root, "personal.json"));
  const personalChatPreferences = new PersonalChatPreferencesStore(path.join(root, "chat.json"));
  const sessionStore = new HubSessionStore(path.join(root, "sessions.json"));
  await Promise.all([personalState.load(), personalChatPreferences.load(), sessionStore.load()]);
  const server = startHubServer({ config: { host: "127.0.0.1", port: 0, tls: null, users: ["alice", "bob"].map(name => ({ name, passwordHash: "unused" })) }, registry, sessions, sessionStore, personalState, personalChatPreferences });
  cleanups.push(async () => { await server.stop(true); await sessions.stopAll(); await rm(root, { recursive: true, force: true }); });
  await sessions.start(entry.id);
  const alice = await sessionStore.issue("alice", "A"), bob = await sessionStore.issue("bob", "B");
  const origin = `http://127.0.0.1:${server.port}`;
  const send = (id: string) => fetch(`${origin}/s/${entry.id}/api/chat/conversations/opencode:parent/prompts`, {
    method: "POST", headers: { authorization: `Bearer ${id}`, "content-type": "application/json", "x-uatu-hub-chat-policy": "forged", "x-uatu-hub-principal": "foreign" },
    body: JSON.stringify({ requestId: "same-client-id", text: "fixture only", delivery: "steer" }),
  });
  return { send, alice, bob, personalChatPreferences, root };
}

test("authenticated Hub resolves fresh personal policy per account and never forwards caller authority", async () => {
  const f = await fixture();
  await f.personalChatPreferences.update("bob", { version: 1, expectedRevision: 0, autoBackgroundOnSteer: false });
  const [on, off] = await Promise.all([f.send(f.alice.id), f.send(f.bob.id)]);
  expect(on.status).toBe(202); expect(off.status).toBe(202);
  const accepted = await on.json();
  expect(accepted).toMatchObject({ pending: true, automaticBackground: "accepted" });
  expect(await off.json()).not.toHaveProperty("automaticBackground");
  expect(JSON.stringify(accepted)).not.toMatch(/alice|principal|policy|secret/);
  await f.personalChatPreferences.update("alice", { version: 1, expectedRevision: 0, autoBackgroundOnSteer: false });
  expect(await (await f.send(f.alice.id)).json()).not.toHaveProperty("automaticBackground");
  await writeFile(path.join(f.root, "chat.json"), "corrupt persisted data");
  await f.personalChatPreferences.load();
  expect(await (await f.send(f.alice.id)).json()).toMatchObject({ pending: true, automaticBackground: "unavailable" });
}, 20_000);

test("missing child trust preserves primary acceptance with neutral unavailable feedback and no unsigned principal", async () => {
  const f = await fixture(false);
  const response = await f.send(f.alice.id);
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ pending: true, delivery: "steer", automaticBackground: "unavailable" });
}, 20_000);
