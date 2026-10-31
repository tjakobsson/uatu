import { expect, test } from "bun:test";
import { WorkerDismissalClient, visibleWorkers } from "./worker-dismissal-client";
import type { CompactWorker } from "./compact-work";
import type { LiveTopicConsumer } from "../shell/live-channel";

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const body = (conversationId = "opencode:parent", dismissed = true, revision = 1) => ({ version: 1, conversationId, entries: [{ executionId: "exec:one", revision, dismissed }] });
const worker = (kind: "working" | "needs-answer" | "unavailable" | "ended", executionId = "exec:one"): CompactWorker => ({ id: "row", name: "Worker", kind: "agent", references: [], since: 1, settledAt: 1, state: kind === "working" || kind === "needs-answer" ? "working" : "unknown", activity: { kind, executionId } });

test("the default browser fetch is not invoked with the coordinator as its receiver", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  Reflect.set(globalThis, "fetch", async function (this: unknown, _url: string, init?: RequestInit) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    calls++;
    return Response.json(body(undefined, init?.method === "POST"));
  });
  const client = new WorkerDismissalClient({ changed: () => {} });
  try {
    client.select("opencode:parent"); await flush();
    expect(client.error).toBe("");
    await client.dismiss("exec:one");
    expect(client.dismissed.has("exec:one")).toBe(true); expect(calls).toBe(2);
  } finally { client.dispose(); Reflect.set(globalThis, "fetch", original); }
});

test("visibility uses exact execution and current activity always wins", () => {
  const marks = new Set(["exec:one"]);
  expect(visibleWorkers([worker("unavailable"), worker("ended")], marks)).toHaveLength(0);
  expect(visibleWorkers([worker("working"), worker("needs-answer"), worker("unavailable", "exec:two")], marks)).toHaveLength(3);
});

test("reversed proven aliases and alias expansion retain dismissal without matching reused child or UI aliases", () => {
  const marks = new Set(["exec:one"]);
  const original = worker("unavailable");
  const recovered = { ...worker("unavailable", "exec:two"), activity: { ...original.activity!, executionId: "exec:two", executionAliases: ["exec:two", "exec:one"] } };
  expect(visibleWorkers([recovered], marks)).toHaveLength(0);
  expect(visibleWorkers([{ ...recovered, activity: { ...recovered.activity, executionAliases: ["exec:one", "exec:two", "exec:three"] } }], marks)).toHaveLength(0);
  expect(visibleWorkers([{ ...worker("unavailable", "exec:new"), conversationId: "same-child", references: ["exec:one"] }], marks)).toHaveLength(1);
  expect(visibleWorkers([{ ...recovered, state: "working", activity: { ...recovered.activity, kind: "needs-answer" } }], marks)).toHaveLength(1);
});

test("selection fences late foreign responses; invalidations coalesce", async () => {
  const replies: Array<(response: Response) => void> = [];
  const client = new WorkerDismissalClient({ fetcher: () => new Promise(resolve => replies.push(resolve)), changed: () => {} });
  client.select("opencode:parent");
  client.refresh(); client.refresh();
  expect(replies).toHaveLength(1);
  client.select("opencode:other");
  expect(replies).toHaveLength(2);
  replies[0]!(Response.json(body())); await flush();
  expect(client.dismissed.size).toBe(0);
  replies[1]!(Response.json(body("opencode:other"))); await flush();
  expect(client.dismissed.has("exec:one")).toBe(true);
  client.dispose();
  expect(client.dismissed.size).toBe(0);
});

test("save is durable-only; conflicts refresh without resending a mutation", async () => {
  const calls: RequestInit[] = []; let fail = 503;
  const client = new WorkerDismissalClient({ changed: () => {}, fetcher: async (_url, init) => {
    calls.push(init!); return init?.method === "POST" ? new Response(null, { status: fail }) : Response.json(body(undefined, false, 3));
  } });
  client.select("opencode:parent"); await flush();
  await client.dismiss("exec:one");
  expect(client.dismissed.size).toBe(0); expect(client.error).toContain("save");
  fail = 409; await client.dismiss("exec:one"); await flush();
  expect(calls.filter(call => call.method === "POST")).toHaveLength(2);
  expect(calls.filter(call => call.method !== "POST")).toHaveLength(2);
  expect(JSON.parse(calls[1]!.body as string)).toEqual({ version: 1, conversationId: "opencode:parent", executionId: "exec:one", expectedRevision: 3, operation: "dismiss" });
  client.dispose();
});

test("read failure restores rows, success commits, and recovery retires once without blocking activity", async () => {
  let response = body(); let failRead = false; let failSave = false; let posts = 0;
  const client = new WorkerDismissalClient({ changed: () => {}, fetcher: async (_url, init) => {
    if (init?.method === "POST") { posts++; return failSave ? new Response(null, { status: 503 }) : Response.json(response); }
    return failRead ? new Response(null, { status: 503 }) : Response.json(response);
  } });
  client.select("opencode:parent"); await flush(); expect(client.dismissed.size).toBe(1);
  failRead = true; client.refresh(); await flush();
  expect(client.dismissed.size).toBe(0); expect(client.error).toContain("read");
  failRead = false; response = body(undefined, false); client.refresh(); await flush();
  response = body(); await client.dismiss("exec:one"); expect(client.dismissed.size).toBe(1);
  failSave = true; client.observe([worker("working")]); await flush();
  expect(client.dismissed.size).toBe(0); expect(client.error).toContain("save");
  client.observe([worker("unavailable")]); client.observe([worker("working")]); await flush();
  expect(posts).toBe(2); expect(client.dismissed.size).toBe(0);
  client.dispose();
});

test("reconnect invalidates in-flight reads and sign-out detaches the only personal subscription", async () => {
  let consumer: LiveTopicConsumer = {}; let closed = 0;
  const replies: Array<(response: Response) => void> = [];
  const client = new WorkerDismissalClient({ changed: () => {}, fetcher: () => new Promise(resolve => replies.push(resolve)), channel: {
    subscribe: (subscription, handlers) => {
      expect(subscription).toEqual({ topic: "personal" }); consumer = handlers;
      return { close: () => { closed++; }, resubscribe: () => {} };
    },
  } });
  client.select("opencode:parent");
  consumer.ready!(1); expect(replies).toHaveLength(2);
  consumer.dropped!(1); consumer.ready!(2); expect(replies).toHaveLength(3);
  replies[0]!(Response.json(body())); replies[1]!(Response.json(body())); await flush();
  expect(client.dismissed.size).toBe(0);
  replies[2]!(Response.json(body(undefined, false))); await flush();
  expect(client.dismissed.size).toBe(0);
  consumer.unavailable!(2);
  expect(client.error).toContain("storage is unavailable"); expect(client.dismissed.size).toBe(0);
  consumer.ready!(2); replies[3]!(Response.json(body(undefined, false))); await flush();
  expect(client.error).toBe("");
  client.dispose(); expect(closed).toBe(1);
});

test("two clients converge through account-private invalidations, with no second account mutation", async () => {
  const marks = new Map<string, boolean>(); const listeners = new Map<string, Set<LiveTopicConsumer>>();
  const make = (account: string) => new WorkerDismissalClient({ changed: () => {}, channel: {
    subscribe: (_subscription, consumer) => {
      const set = listeners.get(account) ?? new Set(); set.add(consumer); listeners.set(account, set);
      return { close: () => { set.delete(consumer); }, resubscribe: () => {} };
    },
  }, fetcher: async (_url, init) => {
    if (init?.method === "POST") {
      marks.set(account, JSON.parse(init.body as string).operation === "dismiss");
      for (const consumer of listeners.get(account) ?? []) consumer.data?.({ category: "worker-dismissals" }, "", 1);
    }
    return Response.json(body(undefined, marks.get(account) ?? false));
  } });
  const a = make("a"), secondA = make("a"), b = make("b");
  for (const client of [a, secondA, b]) client.select("opencode:parent");
  await flush(); await a.dismiss("exec:one"); await flush();
  expect(a.dismissed.size).toBe(1); expect(secondA.dismissed.size).toBe(1); expect(b.dismissed.size).toBe(0);
  secondA.observe([worker("needs-answer")]); await flush();
  expect(a.dismissed.size).toBe(0); expect(secondA.dismissed.size).toBe(0); expect(b.dismissed.size).toBe(0);
  for (const client of [a, secondA, b]) client.dispose();
});

test("all positively proven aliases retire serially, and expanded aliases cannot resurrect an old mark", async () => {
  const entries = ["exec:one", "exec:two"].map(executionId => ({ executionId, revision: 1, dismissed: true }));
  const writes: string[] = [];
  const client = new WorkerDismissalClient({ changed: () => {}, fetcher: async (_url, init) => {
    if (init?.method === "POST") {
      const mutation = JSON.parse(init.body as string); writes.push(mutation.executionId);
      entries.find(entry => entry.executionId === mutation.executionId)!.dismissed = false;
    }
    return Response.json({ version: 1, conversationId: "opencode:parent", entries });
  } });
  client.select("opencode:parent"); await flush();
  client.observe([{ ...worker("working"), activity: { kind: "working", executionId: "exec:two", executionAliases: ["exec:two", "exec:one"] } }]);
  await flush(); await flush();
  expect(writes).toEqual(["exec:two", "exec:one"]); expect(client.dismissed.size).toBe(0);
  client.dispose();
});

test("a late dismissal cannot re-hide recovered work, and a failed fresh dismissal preserves its row", async () => {
  let reply: ((response: Response) => void) | undefined;
  const client = new WorkerDismissalClient({ changed: () => {}, fetcher: async (_url, init) => {
    if (init?.method === "POST") {
      if (JSON.parse(init.body as string).operation === "retire") return new Response(null, { status: 503 });
      return new Promise<Response>(resolve => { reply = resolve; });
    }
    return Response.json(body());
  } });
  client.select("opencode:parent"); await flush();
  client.observe([worker("working")]); await flush();
  client.observe([worker("unavailable")]);
  const failed = client.dismiss("exec:one");
  expect(client.dismissed.size).toBe(0); // No optimistic hiding of the old mark.
  reply!(new Response(null, { status: 503 })); await failed;
  expect(client.dismissed.size).toBe(0);
  const stale = client.dismiss("exec:one");
  client.observe([worker("working")]); client.observe([worker("unavailable")]);
  reply!(Response.json(body())); await stale;
  expect(client.dismissed.size).toBe(0);
  client.dispose();
});

test("a newer explicit dismissal on another device supersedes retired alias fences after activity ends", async () => {
  let state = body(undefined, true, 0);
  const client = new WorkerDismissalClient({ changed: () => {}, fetcher: async () => Response.json(state) });
  const activity = { ...worker("working"), activity: { kind: "working" as const, executionId: "exec:two", executionAliases: ["exec:two", "exec:one"] } };
  client.select("opencode:parent"); await flush();
  state = body(undefined, false, 1);
  client.observe([activity]); await flush(); client.refresh(); await flush();
  expect(client.dismissed.size).toBe(0);
  client.observe([{ ...activity, state: "unknown", activity: { ...activity.activity, kind: "unavailable" } }]);
  // A 409 refresh can publish the new unavailable evidence revision before
  // the other device's later explicit action saves at that same revision.
  state = body(undefined, false, 2); client.refresh(); await flush();
  state = body(undefined, true, 2); client.refresh(); await flush();
  expect(client.dismissed.has("exec:one")).toBe(true);
  client.dispose();
});

test("a personal read begun before recovery cannot supersede its visibility fence with a late higher revision", async () => {
  let reply: ((response: Response) => void) | undefined;
  const client = new WorkerDismissalClient({ changed: () => {}, fetcher: () => new Promise(resolve => { reply = resolve; }) });
  client.select("opencode:parent");
  client.observe([worker("working")]); client.observe([worker("unavailable")]);
  reply!(Response.json(body(undefined, true, 9))); await flush();
  expect(client.dismissed.size).toBe(0);
  expect(client.error).toContain("retirement");
  client.dispose();
});
