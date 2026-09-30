import { describe, expect, test } from "bun:test";
import { ProviderUpdateCoalescer } from "./coalescer";
import type { NormalizedProviderUpdate } from "./provider";

function textUpdate(itemId: string, text: string, mode: "cumulative" | "incremental" = "incremental"): NormalizedProviderUpdate {
  return { kind: "text", itemId, identity: itemId.replace(/^part:/, ""), mode, text };
}

function collect() {
  const flushes: Array<{ conversationId: string; updates: NormalizedProviderUpdate[] }> = [];
  return {
    flushes,
    onFlush: (conversationId: string, updates: NormalizedProviderUpdate[]) => { flushes.push({ conversationId, updates }); },
  };
}

describe("ProviderUpdateCoalescer", () => {
  test("merges consecutive incremental deltas for the same item into one update", async () => {
    const sink = collect();
    const coalescer = new ProviderUpdateCoalescer({ windowMs: 5, onFlush: sink.onFlush });
    coalescer.push("c1", [textUpdate("part:a", "Hel")]);
    coalescer.push("c1", [textUpdate("part:a", "lo")]);
    coalescer.push("c1", [textUpdate("part:a", " world")]);
    await new Promise(resolve => setTimeout(resolve, 20));
    await coalescer.settled();
    expect(sink.flushes).toHaveLength(1);
    expect(sink.flushes[0]!.updates).toEqual([textUpdate("part:a", "Hello world")]);
  });

  test("a cumulative snapshot supersedes buffered deltas", async () => {
    const sink = collect();
    const coalescer = new ProviderUpdateCoalescer({ windowMs: 5, onFlush: sink.onFlush });
    coalescer.push("c1", [textUpdate("part:a", "partial")]);
    coalescer.push("c1", [textUpdate("part:a", "full text", "cumulative")]);
    await new Promise(resolve => setTimeout(resolve, 20));
    await coalescer.settled();
    expect(sink.flushes[0]!.updates).toEqual([textUpdate("part:a", "full text", "cumulative")]);
  });

  test("replaces repeated upserts for the same item in place", async () => {
    const sink = collect();
    const coalescer = new ProviderUpdateCoalescer({ windowMs: 5, onFlush: sink.onFlush });
    const running: NormalizedProviderUpdate = { kind: "upsert", item: { id: "tool:1", type: "tool", createdAt: 1, name: "read", status: "running" } };
    const progressed: NormalizedProviderUpdate = { kind: "upsert", item: { id: "tool:1", type: "tool", createdAt: 1, name: "read", status: "running", output: "…" } };
    coalescer.push("c1", [running]);
    coalescer.push("c1", [progressed]);
    await new Promise(resolve => setTimeout(resolve, 20));
    await coalescer.settled();
    expect(sink.flushes).toHaveLength(1);
    expect(sink.flushes[0]!.updates).toEqual([progressed]);
  });

  // What the adapter's projection would have done had the two frames been
  // applied one after the other: OpenCode 2.x follows a `session.tool.called`
  // (input) with a `session.tool.progress` (no input) inside one window, and
  // a plain replacement leaves the row without its input for good.
  test("folds a sparse later upsert into the buffered one when given a merge", async () => {
    const sink = collect();
    const coalescer = new ProviderUpdateCoalescer({
      windowMs: 5,
      onFlush: sink.onFlush,
      mergeUpsert: (current, incoming) => current.type === "tool" && incoming.type === "tool" ? { ...current, ...incoming, input: incoming.input ?? current.input } : incoming,
    });
    const called: NormalizedProviderUpdate = { kind: "upsert", item: { id: "tool:1", type: "tool", createdAt: 1, name: "execute", status: "running", input: "{\"code\":\"tools.tracker.create_issue()\"}" } };
    const progressed: NormalizedProviderUpdate = { kind: "upsert", item: { id: "tool:1", type: "tool", createdAt: 1, name: "execute", status: "running", output: "…" } };
    coalescer.push("c1", [called]);
    coalescer.push("c1", [progressed]);
    await new Promise(resolve => setTimeout(resolve, 20));
    await coalescer.settled();
    expect(sink.flushes).toHaveLength(1);
    expect(sink.flushes[0]!.updates).toEqual([{ kind: "upsert", item: { id: "tool:1", type: "tool", createdAt: 1, name: "execute", status: "running", input: "{\"code\":\"tools.tracker.create_issue()\"}", output: "…" } }]);
  });

  test("status updates and terminal tool states flush immediately", async () => {
    const sink = collect();
    const coalescer = new ProviderUpdateCoalescer({ windowMs: 5_000, onFlush: sink.onFlush });
    coalescer.push("c1", [textUpdate("part:a", "x")]);
    coalescer.push("c1", [{ kind: "status", status: "completed" }]);
    await coalescer.settled();
    expect(sink.flushes).toHaveLength(1);
    expect(sink.flushes[0]!.updates.map(update => update.kind)).toEqual(["text", "status"]);

    coalescer.push("c1", [{ kind: "upsert", item: { id: "tool:1", type: "tool", createdAt: 1, name: "read", status: "completed" } }]);
    await coalescer.settled();
    expect(sink.flushes).toHaveLength(2);
    coalescer.dispose();
  });


  test("deltas landing after a cumulative snapshot extend it instead of vanishing", async () => {
    // The live opening of every assistant message: text.started arrives as a
    // cumulative empty snapshot, deltas follow inside the same window. The
    // buffered entry stays cumulative and accumulates the deltas.
    const sink = collect();
    const coalescer = new ProviderUpdateCoalescer({ windowMs: 5, onFlush: sink.onFlush });
    coalescer.push("c1", [textUpdate("part:a", "", "cumulative")]);
    coalescer.push("c1", [textUpdate("part:a", "Hel")]);
    coalescer.push("c1", [textUpdate("part:a", "lo")]);
    await new Promise(resolve => setTimeout(resolve, 20));
    await coalescer.settled();
    expect(sink.flushes).toHaveLength(1);
    expect(sink.flushes[0]!.updates).toEqual([textUpdate("part:a", "Hello", "cumulative")]);
  });

  test("keeps conversations independent and preserves order across flushes", async () => {
    const sink = collect();
    const coalescer = new ProviderUpdateCoalescer({ windowMs: 5, onFlush: sink.onFlush });
    coalescer.push("c1", [textUpdate("part:a", "one")]);
    coalescer.push("c2", [textUpdate("part:b", "two")]);
    coalescer.flushAll();
    await coalescer.settled();
    expect(sink.flushes.map(flush => flush.conversationId).sort()).toEqual(["c1", "c2"]);
  });

  test("discard invalidates buffered and already-queued flushes without dropping later updates", async () => {
    const sink = collect();
    const coalescer = new ProviderUpdateCoalescer({ windowMs: 5_000, onFlush: sink.onFlush });
    coalescer.push("c1", [textUpdate("part:stale", "old"), { kind: "status", status: "completed" }]);
    // The urgent status queued a flush on the promise tail, but it has not run
    // yet. A rewrite must invalidate that work as well as the visible buffer.
    coalescer.discard("c1");
    coalescer.push("c1", [textUpdate("part:fresh", "new")]);
    coalescer.flushAll();
    await coalescer.settled();

    expect(sink.flushes).toEqual([{
      conversationId: "c1",
      updates: [textUpdate("part:fresh", "new")],
    }]);
  });

  test("flushAll drains pending work and dispose stops accepting more", async () => {
    const sink = collect();
    const coalescer = new ProviderUpdateCoalescer({ windowMs: 5_000, onFlush: sink.onFlush });
    coalescer.push("c1", [textUpdate("part:a", "tail")]);
    coalescer.dispose();
    await coalescer.settled();
    expect(sink.flushes).toHaveLength(1);
    coalescer.push("c1", [textUpdate("part:a", "ignored")]);
    await coalescer.settled();
    expect(sink.flushes).toHaveLength(1);
  });
});
