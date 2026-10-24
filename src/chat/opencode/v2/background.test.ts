import { expect, spyOn, test } from "bun:test";
import { BackgroundWorkers } from "./background";
import fc from "fast-check";
import { compactWorkers } from "../../compact-work";
import type { ConversationItem } from "../../types";

const launch = (id: string, worker = id, command = "fixture") => ({ id, name: "shell", state: { status: "completed", input: { command }, metadata: { status: "running", shellID: worker } } });

test.each(["shell", "subagent"])("native %s results sort newest report first, not newest launch", kind => {
  const workers = new BackgroundWorkers();
  const items = new Map<string, ConversationItem>();
  const apply = (updates: ReturnType<BackgroundWorkers["launch"]> = []) => {
    for (const update of updates) {
      if (update.kind === "upsert") items.set(update.item.id, update.item);
      if (update.kind === "remove") items.delete(update.itemId);
    }
  };
  for (const [id, at] of [["long", 10], ["short", 20]] as const) {
    workers.verifyChild(id, "parent");
    const part = launch(id);
    apply(workers.launch("parent", kind === "shell" ? part : { ...part, name: kind, state: { ...part.state, input: { description: "fixture" }, metadata: { sessionID: id, status: "running" } } }, at));
  }
  const finish = (id: string, at: number) => apply(workers.notification("parent", `notice-${id}`, { text: "Result", metadata: { source: kind, ...(kind === "shell" ? { shellID: id, exit: 0 } : { childID: id }), state: "completed" } }, at));
  finish("short", 30);
  finish("long", 40);
  expect(compactWorkers([...items.values()]).map(({ name, settledAt }) => [name, settledAt])).toEqual([["fixture", 40], ["fixture", 30]]);
  expect([...items.values()].filter(item => item.type === "background_task").map(item => item.terminalReportedAt)).toEqual([40, 30]);
  expect([...items.values()].every(item => !("completedAt" in item) && !("usage" in item))).toBe(true);
  expect(workers.notification("parent", "notice-long", { text: "duplicate", metadata: { source: kind, shellID: "long", childID: "long", state: "completed" } }, 99)).toEqual([]);
});

test("a relaunched worker has no previous report clock and duplicate old notices cannot settle it", () => {
  const workers = new BackgroundWorkers();
  workers.launch("parent", launch("old", "reused"), 10);
  const payload = { text: "Done", metadata: { source: "shell", shellID: "reused", state: "completed", exit: 0 } };
  expect(workers.notification("parent", "old-result", payload, 20)?.[0]).toMatchObject({ item: { status: "completed", terminalReportedAt: 20 } });
  const next = workers.launch("parent", launch("new", "reused"), 30);
  expect(next[0]).toMatchObject({ item: { status: "running", createdAt: 30 } });
  if (next[0]?.kind !== "upsert") throw new Error("expected relaunched item");
  expect(next[0].item).not.toHaveProperty("terminalReportedAt");
  expect(workers.notification("parent", "old-result", payload, 40)).toEqual([]);
  expect(workers.launch("parent", launch("new", "reused"), 50)).toEqual(next);
});

// Inspect the budget invariant without exposing accounting as provider API.
function retained(workers: BackgroundWorkers) {
  return workers as unknown as {
    parents: Map<string, unknown>; tasks: Map<string, unknown>; notices: Set<string>;
    unmatched: Map<string, unknown>; ended: Map<string, unknown>; aliases: Map<string, unknown>;
    bytes: number; recoveryOnly: boolean; sizes: Map<object, unknown>; boundaries: number;
  };
}

function checkBytes(workers: BackgroundWorkers) {
  const state = retained(workers);
  const actual = JSON.stringify([state.parents, state.tasks, state.notices, state.unmatched, state.ended, state.aliases].map(values => [...values])).length * 2;
  expect(state.bytes).toBeGreaterThanOrEqual(actual);
  expect(state.bytes).toBeLessThanOrEqual(actual + 12);
}

test("incremental byte ledger bounds the serialized oracle through replacements, aliases, results and deletions", () => {
  const workers = new BackgroundWorkers();
  const check = () => checkBytes(workers);
  const notice = (id: string, worker: string, at: number) => workers.notification("parent", id, { text: '\"\\\n\u0000\ud800𐀀', metadata: { source: "subagent", childID: worker, state: "completed" } }, at);
  for (let i = 0; i < 40; i++) {
    const child = `child${i}`;
    workers.verifyChild(child, "parent"); check();
    workers.verifyChild(child, "changed"); check();
    workers.verifyChild(child, "parent"); check();
    // Result before launch exercises unmatched removal and notice tombstones.
    notice(`early${i}`, child, 3); check();
    workers.launch("parent", { ...launch(`agent${i}`, child), name: "subagent", state: { ...launch(`agent${i}`, child).state, metadata: { sessionID: child, status: "running" } } }, 1); check();
    workers.launch("parent", launch(`shell${i}`, `worker${i}`, '\"\\\n\u0000\ud800𐀀'), 4); check();
    workers.launch("parent", launch(`alias${i}`, `worker${i}`), 5); check();
    workers.verifyChild(`worker${i}`, "parent");
    workers.executionEnded(`worker${i}`, 6); check();
    workers.executionEnded(`worker${i}`, 6); check();
    workers.executionEnded(`worker${i}`, 7); check();
    workers.launch("parent", launch(`next${i}`, `worker${i}`), 8); check();
    workers.notification("parent", `done${i}`, { text: "result", metadata: { source: "shell", shellID: `worker${i}`, state: "completed", exit: 0 } }, 9); check();
    notice(`ambiguous${i}`, `worker${i}`, 10); check();
  }
});

test("mixed occurrence updates keep the byte bound conservative against an independent full serialization", () => {
  fc.assert(fc.property(fc.array(fc.record({
    operation: fc.integer({ min: 0, max: 5 }),
    id: fc.integer({ min: 0, max: 8 }),
    body: fc.oneof(fc.string(), fc.constant('\"\\\n\u0000\ud800𐀀')),
  }), { minLength: 1, maxLength: 100 }), operations => {
    const workers = new BackgroundWorkers();
    operations.forEach(({ operation, id, body }, at) => {
      const child = `child${id}`;
      switch (operation) {
        case 0: workers.verifyChild(child, "parent"); break;
        case 1: workers.launch("parent", launch(`call${at}`, child, body), at); break;
        case 2: workers.executionEnded(child, at); break;
        case 3: workers.notification("parent", `notice${id}`, { text: body, metadata: { source: "subagent", childID: child, state: "completed" } }, at); break;
        case 4: workers.notification("parent", `shell${id}`, { text: body, metadata: { source: "shell", shellID: child, state: "completed", exit: 0 } }, at); break;
        case 5: workers.launch("parent", launch(`call${id}`, child, body), at); break;
      }
      checkBytes(workers);
    });
  }), { seed: 518, numRuns: 50 });
});

test("byte and entry saturation clear the complete ledger and never resume partial correlation", () => {
  for (const budget of [{ bytes: 900 }, { entries: 2 }]) {
    const workers = new BackgroundWorkers(budget);
    const state = retained(workers);
    for (let i = 0; i < 10; i++) workers.launch("parent", launch(`call${i}`), i);
    expect(state.recoveryOnly).toBe(true);
    expect([state.parents, state.tasks, state.notices, state.unmatched, state.ended, state.aliases].every(values => values.size === 0)).toBe(true);
    expect(state.sizes.size).toBe(0);
    expect(state.bytes).toBe(38);
    expect(state.boundaries).toBe(0);
    expect(workers.launch("parent", launch("later"), 20)).toEqual([]);
  }
});

test("live byte-budget serialization work grows with changed entries, not retained history", () => {
  const stringify = JSON.stringify;
  const work = (count: number) => {
    const workers = new BackgroundWorkers();
    let characters = 0;
    const spy = spyOn(JSON, "stringify").mockImplementation((value: unknown) => {
      const result = stringify(value);
      characters += result?.length ?? 0;
      return result;
    });
    try {
      for (let i = 0; i < count; i++) {
        workers.launch("parent", { id: `call${i}`, name: "shell", state: { status: "completed", input: { command: "echo fixture" }, metadata: { status: "running", shellID: `shell${i}` } } }, i);
      }
      const before = characters;
      for (let i = 0; i < count; i++) workers.launch("parent", { name: "irrelevant" }, i);
      expect(characters).toBe(before);
    } finally {
      spy.mockRestore();
    }
    return characters;
  };
  const small = work(128);
  expect(work(256)).toBeLessThan(small * 2.2);
});
