import { expect, test } from "bun:test";
import { WorkerDismissalClient, visibleWorkers, workerExecutionIds } from "./worker-dismissal-client";
import { compactWorkers, type CompactWorker } from "./compact-work";
import type { BackgroundTaskItem } from "./types";
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

test("legacy bare marks cannot re-hide strong V2 after reconnect and reordered positive aliases", async () => {
  let consumer: LiveTopicConsumer = {};
  const bare = { executionId: "worker-dismissal:tool:call", dismissed: true, revision: 3 };
  const entries = [bare];
  const client = new WorkerDismissalClient({ changed: () => {}, channel: {
    subscribe: (_subscription, handlers) => { consumer = handlers; return { close: () => {}, resubscribe: () => {} }; },
  }, fetcher: async () => Response.json({ version: 1, conversationId: "opencode:parent", entries }) });
  const task: BackgroundTaskItem = { type: "background_task", id: "task:run", taskId: "run", toolUseId: "call", status: "running", createdAt: 10, description: "Review",
    activity: { kind: "unavailable", executionId: "v1:A", executionAliases: ["v1:A", "v1:B"] } };
  try {
    client.select("opencode:parent"); await flush();
    expect(client.dismissed.has(bare.executionId)).toBe(true);
    expect(visibleWorkers(compactWorkers([task]), client.dismissed)).toHaveLength(1);
    consumer.dropped!(1); consumer.ready!(2); await flush();
    const reordered = { ...task, activity: { ...task.activity!, executionId: "v1:B", executionAliases: ["v1:B", "v1:A"] } };
    client.observe(compactWorkers([reordered]));
    expect(visibleWorkers(compactWorkers([reordered]), client.dismissed)).toHaveLength(1);
    entries.push({ executionId: "v1:A", dismissed: true, revision: 0 });
    client.refresh(); await flush();
    expect(visibleWorkers(compactWorkers([reordered]), client.dismissed)).toHaveLength(0);
    expect(entries[0]).toEqual(bare);
  } finally { client.dispose(); }
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

for (const status of [409, 503]) test(`failed explicit dismissal (${status}) survives healthy personal reads and unrelated saves`, async () => {
  let consumer: LiveTopicConsumer = {};
  let fail = true;
  const posts: string[] = [];
  let reads = 0;
  const client = new WorkerDismissalClient({ changed: () => {}, channel: {
    subscribe: (_subscription, handlers) => { consumer = handlers; return { close: () => {}, resubscribe: () => {} }; },
  }, fetcher: async (_url, init) => {
    if (init?.method === "POST") {
      const mutation = JSON.parse(init.body as string); posts.push(mutation.executionId);
      if (fail && mutation.executionId === "exec:one") return new Response(null, { status });
      return Response.json(body(undefined, mutation.executionId === "exec:one", 3));
    }
    reads++; return Response.json(body(undefined, false, 3));
  } });
  try {
    client.select("opencode:parent"); await flush();
    expect(await client.dismiss("exec:one")).toBe(false); await flush();
    expect(reads).toBe(status === 409 ? 2 : 1);
    expect(client.error).toContain(status === 409 ? "retry" : "Could not save");
    expect(client.error).not.toContain("Refreshing");
    const failure = client.error;
    consumer.data!({ category: "worker-dismissals" }, "", 1); await flush();
    expect(client.error).toBe(failure);
    expect(await client.dismiss("exec:unrelated")).toBe(true);
    expect(client.error).toBe(failure);
    // Automatic retirement is coordinator health, not a retry of this action.
    client.refresh(); await flush();
    expect(client.error).toBe(failure);
    expect(posts).toEqual(["exec:one", "exec:unrelated"]);
    fail = false;
    expect(await client.dismiss("exec:alias", ["exec:one"])).toBe(true);
    expect(client.error).toBe("");
    expect(posts).toEqual(["exec:one", "exec:unrelated", "exec:alias"]);
  } finally { client.dispose(); }
});

test("automatic retirement and source-specific retries preserve other failed explicit actions until selection reset", async () => {
  const entries = new Map(["exec:one", "exec:two", "exec:retired"].map(executionId => [executionId, { executionId, revision: 1, dismissed: executionId === "exec:retired" }]));
  let fail = true;
  const operations: string[] = [];
  const client = new WorkerDismissalClient({ changed: () => {}, fetcher: async (_url, init) => {
    if (init?.method === "POST") {
      const mutation = JSON.parse(init.body as string); operations.push(mutation.operation);
      if (fail && mutation.operation === "dismiss") return new Response(null, { status: 503 });
      const entry = entries.get(mutation.executionId)!; entry.dismissed = mutation.operation === "dismiss"; entry.revision++;
    }
    return Response.json({ version: 1, conversationId: "opencode:parent", entries: [...entries.values()] });
  } });
  try {
    client.select("opencode:parent"); await flush();
    expect(await client.dismiss("exec:one")).toBe(false);
    expect(await client.dismiss("exec:two")).toBe(false);
    client.observe([worker("working", "exec:retired")]); await flush();
    expect(operations).toEqual(["dismiss", "dismiss", "retire"]);
    expect(client.error).toContain("Could not save");
    fail = false;
    expect(await client.dismiss("exec:one")).toBe(true);
    expect(client.error).toContain("Could not save");
    expect(await client.dismiss("exec:two")).toBe(true);
    expect(client.error).toBe("");
    fail = true; await client.dismiss("exec:one");
    client.select(null); expect(client.error).toBe("");
    client.select("opencode:parent"); await flush(); expect(client.error).toBe("");
    await client.dismiss("exec:one");
    client.select("opencode:other"); expect(client.error).toBe("");
  } finally { client.dispose(); }
});

for (const status of [409, 503]) test(`older successful dismissal cannot erase newer ${status} feedback, but a fresh proven-alias retry can`, async () => {
  const replies: Array<(response: Response) => void> = [];
  const client = new WorkerDismissalClient({ changed: () => {}, fetcher: async (_url, init) => init?.method === "POST"
    ? new Promise<Response>(resolve => replies.push(resolve)) : Response.json(body(undefined, false, 3)) });
  try {
    client.select("opencode:parent"); await flush();
    const older = client.dismiss("exec:one");
    const newer = client.dismiss("exec:one");
    replies[1]!(new Response(null, { status })); expect(await newer).toBe(false); await flush();
    const failure = client.error; expect(failure).toContain(status === 409 ? "Worker status changed" : "Could not save");
    replies[0]!(Response.json(body(undefined, true, 3))); expect(await older).toBe(true);
    expect(client.error).toBe(failure);
    // Reused row/child/UI references do not prove an execution alias.
    const reused = { ...worker("unavailable", "exec:other"), conversationId: "same-child", references: ["exec:one"] };
    client.observe([reused]);
    const unrelated = client.dismiss(workerExecutionIds(reused)[0], workerExecutionIds(reused));
    replies[2]!(Response.json(body(undefined, true, 3))); expect(await unrelated).toBe(true);
    expect(client.error).toBe(failure);
    const proven = { ...reused, activity: { ...reused.activity!, executionId: "exec:new-primary", executionAliases: ["exec:new-primary", "exec:one"] } };
    client.observe([proven]);
    const ids = workerExecutionIds(proven), retry = client.dismiss(ids[0], ids);
    replies[3]!(Response.json({ version: 1, conversationId: "opencode:parent", entries: ids.map(executionId => ({ executionId, revision: 4, dismissed: true })) }));
    expect(await retry).toBe(true); expect(client.error).toBe("");
  } finally { client.dispose(); }
});

test("a superseded in-flight failure cannot replace a newer successful proven-alias action", async () => {
  const replies: Array<(response: Response) => void> = [];
  const client = new WorkerDismissalClient({ changed: () => {}, fetcher: async (_url, init) => init?.method === "POST"
    ? new Promise<Response>(resolve => replies.push(resolve)) : Response.json(body(undefined, false, 3)) });
  try {
    client.select("opencode:parent"); await flush();
    const older = client.dismiss("exec:one");
    const newer = client.dismiss("exec:new-primary", ["exec:one"]);
    replies[1]!(Response.json(body(undefined, true, 3))); expect(await newer).toBe(true);
    replies[0]!(new Response(null, { status: 503 })); expect(await older).toBe(false);
    expect(client.error).toBe("");
  } finally { client.dispose(); }
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
