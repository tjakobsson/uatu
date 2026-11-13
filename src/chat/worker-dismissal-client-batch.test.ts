import { expect, test } from "bun:test";
import { WorkerDismissalClient, visibleWorkers } from "./worker-dismissal-client";
import { compactWorkers } from "./compact-work";
import type { BackgroundTaskItem } from "./types";

const conversationId = "opencode:parent";
const items: BackgroundTaskItem[] = Array.from({ length: 290 }, (_, i) => ({ type: "background_task", id: `task:${i}`, taskId: String(i), description: "Fixture", createdAt: i + 1,
  status: i < 285 ? "completed" : "running", activity: { kind: i < 285 ? "ended" : "checking", executionId: `execution:${i}` } }));
const entries = () => items.map((_, i) => ({ executionId: `execution:${i}`, revision: 0, dismissed: false }));
const snapshot = (state = entries()) => Response.json({ version: 1, conversationId, entries: state });
const groups = Array.from({ length: 285 }, (_, i) => [`execution:${i}`]);

test("285 finished plus five unresolved produce one POST and one visibility transition", async () => {
  const ready = Promise.withResolvers<void>(), counts: number[] = [];
  let posts = 0;
  const workers = compactWorkers(items);
  const client = new WorkerDismissalClient({ changed: () => { counts.push(visibleWorkers(workers, client.dismissed).length); ready.resolve(); }, fetcher: async (_url, init) => {
    if (init?.method !== "POST") return snapshot();
    posts++;
    const request = JSON.parse(init.body as string);
    expect(request.targets).toHaveLength(285);
    return snapshot(entries().map((entry, i) => ({ ...entry, dismissed: i < 285 })));
  } });
  try {
    client.select(conversationId); await ready.promise; counts.length = 0;
    expect(await client.dismissMany(groups)).toBe(true);
    expect(posts).toBe(1); expect(counts).toEqual([5]); expect(client.error).toBe("");
  } finally { client.dispose(); }
});

for (const status of [409, 503]) test(`batch ${status} retains all rows and per-target failed-action feedback`, async () => {
  const ready = Promise.withResolvers<void>();
  let fail = true;
  const client = new WorkerDismissalClient({ changed: () => ready.resolve(), fetcher: async (_url, init) => {
    if (init?.method !== "POST") return snapshot();
    if (fail) return new Response(null, { status });
    const body = JSON.parse(init.body as string);
    return snapshot(entries().map(entry => ({ ...entry, dismissed: entry.executionId === body.executionId })));
  } });
  try {
    client.select(conversationId); await ready.promise;
    expect(await client.dismissMany(groups)).toBe(false);
    expect(client.dismissed.size).toBe(0); expect(client.error).not.toBe("");
    fail = false; expect(await client.dismiss("execution:0")).toBe(true);
    // A successful retry of one occurrence does not erase the other 284 errors.
    expect(client.error).not.toBe("");
  } finally { client.dispose(); }
});

test("activity during an atomic batch save keeps that worker visible and selection changes fence the response", async () => {
  for (const switchSelection of [false, true]) {
    const ready = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const client = new WorkerDismissalClient({ changed: () => ready.resolve(), fetcher: async (_url, init) => {
      if (init?.method !== "POST") return snapshot();
      entered.resolve(); await release.promise;
      return snapshot(entries().map((entry, i) => ({ ...entry, dismissed: i < 285 })));
    } });
    try {
      client.select(conversationId); await ready.promise;
      const pending = client.dismissMany(groups); await entered.promise;
      if (switchSelection) client.select("opencode:other");
      else client.observe(compactWorkers([{ ...items[0]!, status: "running", activity: { kind: "working", executionId: "execution:0" } }]));
      release.resolve(); expect(await pending).toBe(!switchSelection);
      expect(client.dismissed.has("execution:0")).toBe(false);
    } finally { release.resolve(); client.dispose(); }
  }
});

test("batch collection keeps the existing total identity budget, including aliases", async () => {
  let posts = 0;
  const client = new WorkerDismissalClient({ changed() {}, fetcher: async () => { posts++; return snapshot(); } });
  try {
    const aliases = Array.from({ length: 8193 }, (_, i) => `execution:${i}`);
    expect(await client.dismissMany([aliases])).toBe(false);
    expect(posts).toBe(0); expect(client.error).toContain("tracking is full");
  } finally { client.dispose(); }
});
