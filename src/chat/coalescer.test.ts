import { describe, expect, test } from "bun:test";
import { ProviderUpdateCoalescer } from "./coalescer";
import { createProviderEventMemory, normalizeProviderEvent } from "./opencode/v1/normalization";
import { createClaudeEventMemory, normalizeClaudeMessage } from "./claude/normalization";
import type { NormalizedProviderUpdate } from "./provider";
import { ConversationProjection } from "./adapter";
import { ConversationReplay } from "./replay";
import { CHAT_TEXT_SEAL, CHAT_TURN, provisionalTurn, type ChatTextSeal, type ChatTurnIdentity } from "./turn-liveness";
import type { AssistantMessageItem } from "./types";

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

  // D1: the projection's "facts travel with whole items" rule applies after
  // coalescing. A seal on a later text update in the same window replaces the
  // buffered item, so it reaches the projection when the row is created; in a
  // later window it is ignored. Normalizers send seal changes as upserts.
  test("a text update's sealed item replaces the buffered one, so the seal counts only within one window", async () => {
    const text = (sealed: boolean): NormalizedProviderUpdate => ({ kind: "text", itemId: "reply", identity: "reply", mode: "cumulative", text: "![shot]",
      item: { id: "reply", type: "assistant_message", createdAt: 1, markdown: "", ...(sealed ? { [CHAT_TEXT_SEAL]: "ended" as const } : {}) } as AssistantMessageItem });
    const seal = (projection: ConversationProjection) => (projection.get("reply") as AssistantMessageItem & ChatTextSeal | undefined)?.[CHAT_TEXT_SEAL];
    const run = async (windows: NormalizedProviderUpdate[][]) => {
      const projection = new ConversationProjection(new ConversationReplay("g", "c", 10_000));
      // The timer never fires within the test: flushAll closes each window.
      const coalescer = new ProviderUpdateCoalescer({ windowMs: 60_000, onFlush: (_id, updates) => { for (const update of updates) projection.apply(update); } });
      for (const updates of windows) {
        coalescer.push("c", updates);
        coalescer.flushAll();
        await coalescer.settled();
      }
      coalescer.dispose();
      return seal(projection);
    };
    expect(await run([[text(false), text(true)]])).toBe("ended");
    expect(await run([[text(false)], [text(true)]])).toBeUndefined();
  });

  // A later text item in the same window that omits the facts the earlier one
  // created the row with keeps them, exactly as the projection's sparse merge
  // would across two windows.
  test("a later unannotated text item keeps the facts the buffered item created the row with, in one window as in two", async () => {
    const token = provisionalTurn();
    const text = (facts: object): NormalizedProviderUpdate => ({ kind: "text", itemId: "reply", identity: "reply", mode: "cumulative", text: "![shot]",
      item: { id: "reply", type: "assistant_message", createdAt: 1, markdown: "", ...facts } as AssistantMessageItem });
    const facts = (projection: ConversationProjection) => {
      const row = projection.get("reply") as AssistantMessageItem & ChatTextSeal & ChatTurnIdentity;
      return { seal: row[CHAT_TEXT_SEAL], completedAt: row.completedAt, turn: row[CHAT_TURN] && { ...row[CHAT_TURN] } };
    };
    const run = async (windows: NormalizedProviderUpdate[][]) => {
      const projection = new ConversationProjection(new ConversationReplay("g", "c", 10_000));
      const coalescer = new ProviderUpdateCoalescer({ windowMs: 60_000, onFlush: (_id, updates) => { for (const update of updates) projection.apply(update); } });
      for (const updates of windows) {
        coalescer.push("c", updates);
        coalescer.flushAll();
        await coalescer.settled();
      }
      coalescer.dispose();
      return facts(projection);
    };
    const created = text({ [CHAT_TEXT_SEAL]: "completion", completedAt: 5, [CHAT_TURN]: token });
    for (const later of [text({}), text({ [CHAT_TEXT_SEAL]: undefined, completedAt: undefined, [CHAT_TURN]: undefined })]) {
      const oneWindow = await run([[created, later]]);
      expect(oneWindow).toEqual(await run([[created], [later]]));
      expect(oneWindow).toEqual({ seal: "completion", completedAt: 5, turn: { completed: false, authority: "provisional" } });
    }
  });

  // An upsert for a row is a barrier for reply facts: a later text item's facts
  // never fold back into a text update buffered before the upsert, exactly as
  // separate windows would leave them.
  test("reply facts do not move backward across an intervening upsert, in one window as in two", async () => {
    const sealed = { [CHAT_TEXT_SEAL]: "ended" as const };
    const reply = (markdown: string, facts: object) => ({ id: "reply", type: "assistant_message", createdAt: 1, markdown, ...facts }) as AssistantMessageItem;
    const draft: NormalizedProviderUpdate = { kind: "text", itemId: "reply", identity: "reply", mode: "cumulative", text: "[shot]: old.png\n\n![shot]", item: reply("", {}) };
    const corrected: NormalizedProviderUpdate = { kind: "upsert", item: reply("![shot](new.png)", sealed) };
    const noOp: NormalizedProviderUpdate = { kind: "text", itemId: "reply", identity: "reply", mode: "incremental", text: "", item: reply("", sealed) };
    const run = async (windows: NormalizedProviderUpdate[][]) => {
      const projection = new ConversationProjection(new ConversationReplay("g", "c", 10_000));
      const published: Array<[string, unknown]> = [];
      const coalescer = new ProviderUpdateCoalescer({ windowMs: 60_000, onFlush: (_id, updates) => {
        for (const update of updates) {
          const event = projection.apply(update);
          if (event?.type === "item.upsert" && event.item.type === "assistant_message") published.push([event.item.markdown, (event.item as AssistantMessageItem & ChatTextSeal)[CHAT_TEXT_SEAL]]);
        }
      } });
      for (const updates of windows) {
        coalescer.push("c", updates);
        coalescer.flushAll();
        await coalescer.settled();
      }
      coalescer.dispose();
      return published;
    };
    const oneWindow = await run([[draft, corrected, noOp]]);
    expect(oneWindow).toEqual(await run([[draft], [corrected, noOp]]));
    // The draft is never published sealed, so its old.png reference is never captured.
    expect(oneWindow).toEqual([["[shot]: old.png\n\n![shot]", undefined], ["![shot](new.png)", "ended"]]);
  });

  // Characterization (base behaviour): OpenCode 1.x in one coalescer window. A
  // first delta with a fallback start (20), the classic text-end upsert with the
  // authoritative message start (10), then a trailing compatibility delta that
  // carries the corrected start: the first published reply frame is at 10.
  test("OpenCode 1.x: a trailing delta's corrected start reaches the first reply frame in one window", async () => {
    const memory = createProviderEventMemory();
    const projection = new ConversationProjection(new ConversationReplay("g", "s", 10_000));
    const published: Array<[string, number, string]> = [];
    const coalescer = new ProviderUpdateCoalescer({ windowMs: 60_000, onFlush: (_id, updates) => {
      for (const update of updates) {
        const event = projection.apply(update);
        if (event?.type === "item.upsert" && event.item.type === "assistant_message") published.push(["upsert", event.item.createdAt, event.item.markdown]);
        else if (event?.type === "item.text_delta") published.push(["delta", 0, event.delta]);
      }
    } });
    const events = [
      { type: "session.next.text.delta", properties: { sessionID: "s", textID: "p", assistantMessageID: "m", timestamp: 20, delta: "Hi" } },
      { type: "message.part.updated", properties: { sessionID: "s", timestamp: 30, message: { time: { created: 10 } }, part: { id: "p", messageID: "m", type: "text", text: "Hi", time: { end: 30 } } } },
      { type: "session.next.text.delta", properties: { sessionID: "s", textID: "p", assistantMessageID: "m", timestamp: 40, delta: "" } },
    ];
    coalescer.push("s", events.flatMap(event => normalizeProviderEvent(event, memory).updates));
    coalescer.flushAll();
    await coalescer.settled();
    coalescer.dispose();
    expect(published[0]).toEqual(["upsert", 10, "Hi"]);
    expect(projection.get("part:p")?.createdAt).toBe(10);
  });

  // The barrier holds even when the earlier entry carries no item: a later
  // item's reply facts never create or seal the row ahead of the upsert.
  test("a late seal cannot create a sealed row ahead of an intervening upsert when the first text update has no item", async () => {
    const reply = (facts: object) => ({ id: "reply", type: "assistant_message", createdAt: 1, markdown: "", ...facts }) as AssistantMessageItem;
    const itemless: NormalizedProviderUpdate = { kind: "text", itemId: "reply", identity: "reply", mode: "cumulative", text: "[shot]: old.png\n\n![shot]" };
    const unsealed: NormalizedProviderUpdate = { kind: "upsert", item: { ...reply({}), markdown: "[shot]: old.png\n\n![shot]" } };
    const lateSeal: NormalizedProviderUpdate = { kind: "text", itemId: "reply", identity: "reply", mode: "incremental", text: "", item: reply({ [CHAT_TEXT_SEAL]: "ended" }) };
    const run = async (windows: NormalizedProviderUpdate[][]) => {
      const projection = new ConversationProjection(new ConversationReplay("g", "c", 10_000));
      const seals: unknown[] = [];
      const coalescer = new ProviderUpdateCoalescer({ windowMs: 60_000, onFlush: (_id, updates) => {
        for (const update of updates) {
          const event = projection.apply(update);
          if (event?.type === "item.upsert") seals.push((event.item as AssistantMessageItem & ChatTextSeal)[CHAT_TEXT_SEAL]);
        }
      } });
      for (const updates of windows) {
        coalescer.push("c", updates);
        coalescer.flushAll();
        await coalescer.settled();
      }
      coalescer.dispose();
      return { seals: [...new Set(seals)], final: (projection.get("reply") as AssistantMessageItem & ChatTextSeal | undefined)?.[CHAT_TEXT_SEAL] };
    };
    const oneWindow = await run([[itemless, unsealed, lateSeal]]);
    expect(oneWindow).toEqual(await run([[itemless], [unsealed, lateSeal]]));
    expect(oneWindow).toEqual({ seals: [undefined], final: undefined });
  });

  // Characterization (inherited from base): consecutive upserts for a row in one
  // window fold together, so a text delta between them sees the later upsert's
  // facts. Claude Code's block start, a delta and the block stop in one window
  // publish the row already completed; in separate windows the delta comes first.
  test("Claude Code: a block stop in the same window folds into the block start ahead of the delta (inherited)", async () => {
    const run = async (split: boolean) => {
      const memory = createClaudeEventMemory();
      const projection = new ConversationProjection(new ConversationReplay("g", "c", 10_000));
      const frames: Array<[string, boolean]> = [];
      const coalescer = new ProviderUpdateCoalescer({ windowMs: 60_000, onFlush: (_id, updates) => {
        for (const update of updates) {
          const event = projection.apply(update);
          const row = projection.get("message:stream:api:0");
          if (event && row?.type === "assistant_message") frames.push([event.type, row.completedAt !== undefined]);
        }
      } });
      let uuid = 0;
      const frame = (event: Record<string, unknown>) => normalizeClaudeMessage({ type: "stream_event", uuid: `f-${++uuid}`, timestamp: uuid, event }, memory, "live").updates;
      const windows = [
        [...frame({ type: "message_start", message: { id: "api" } }), ...frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })],
        frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "[shot]: s.png\n\n![shot]" } }),
        frame({ type: "content_block_stop", index: 0 }),
      ];
      for (const updates of split ? windows : [windows.flat()]) {
        coalescer.push("c", updates);
        coalescer.flushAll();
        await coalescer.settled();
      }
      coalescer.dispose();
      return frames;
    };
    // One window: the row is created already completed, and the delta lands on it.
    expect(await run(false)).toEqual([["item.upsert", true], ["item.text_delta", true]]);
    // Separate windows: the delta lands on the open row, and the stop completes it.
    expect(await run(true)).toEqual([["item.upsert", false], ["item.text_delta", false], ["item.upsert", true]]);
  });
});
