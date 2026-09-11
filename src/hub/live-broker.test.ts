import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { encodeReplayCursor } from "../chat/replay";
import { MetricsRegistry } from "../debug/metrics";
import { upstreamActiveGauge, upstreamCounter } from "../debug/stream-metrics";
import type { LiveEnvelope } from "../shared/live-protocol";
import {
  LiveBroker,
  setLiveUpstreamDiagnostics,
  type LiveSessionChange,
  type LiveUpstreamDiagnostic,
  type LiveUpstreamSource,
} from "./live-broker";

// A child stand-in: every upstream the broker opens is a controllable SSE
// response the test writes frames into and can end or refuse. Nothing
// crosses a socket, so timing is the broker's alone.
type FakeUpstream = {
  workspaceId: string;
  path: string;
  push(frame: string): void;
  end(): void;
  readonly cancelled: boolean;
};

function fakeSource(options: { running?: Set<string>; workspaces?: string[]; refuse?: (path: string) => Response | Error | null } = {}) {
  const running = options.running ?? new Set(["ws"]);
  const opened: FakeUpstream[] = [];
  const listeners = new Set<(change: LiveSessionChange) => void>();
  const encoder = new TextEncoder();
  const source: LiveUpstreamSource = {
    isRunning: id => running.has(id),
    workspaceIds: () => options.workspaces ?? [...running],
    async open({ workspaceId, path, signal }) {
      if (!running.has(workspaceId)) throw new Error("not running");
      const refusal = options.refuse?.(path);
      if (refusal instanceof Error) throw refusal;
      if (refusal) return refusal;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const upstream: FakeUpstream = {
        workspaceId,
        path,
        push(frame) {
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            // Already ended.
          }
        },
        end() {
          try {
            controller.close();
          } catch {
            // Already ended.
          }
        },
        cancelled: false,
      };
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
        cancel() {
          (upstream as { cancelled: boolean }).cancelled = true;
        },
      });
      signal.addEventListener("abort", () => {
        (upstream as { cancelled: boolean }).cancelled = true;
        try {
          controller.close();
        } catch {
          // Already ended.
        }
      }, { once: true });
      opened.push(upstream);
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
    onSessionChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    opened,
    running,
    setRunning(id: string, value: boolean) {
      if (value) running.add(id);
      else running.delete(id);
      for (const listener of listeners) listener({ workspaceId: id, running: value });
    },
    byPath: (fragment: string) => opened.filter(entry => entry.path.includes(fragment)),
  };
}

function sink() {
  const envelopes: LiveEnvelope[] = [];
  return { envelopes, write: (envelope: LiveEnvelope) => { envelopes.push(envelope); } };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const kinds = (envelopes: LiveEnvelope[]) => envelopes.map(envelope => envelope.event.kind);
const cursorOf = (generation: string, sequence: number) => encodeReplayCursor({ generation, sequence });
const chatFrame = (generation: string, sequence: number, extra = "") =>
  `id: ${cursorOf(generation, sequence)}\nevent: chat\ndata: {"type":"conversation.status","generation":"${generation}","sequence":${sequence}${extra}}\n\n`;

const brokers: LiveBroker[] = [];
function broker(source: LiveUpstreamSource, options: ConstructorParameters<typeof LiveBroker>[1] = {}) {
  const created = new LiveBroker(source, { lingerMs: 60, retryMinMs: 30, retryMaxMs: 120, inventoryOpenGraceMs: 20, ...options });
  brokers.push(created);
  return created;
}

// Failures are part of what these tests stage; the default sink's log line
// is not.
beforeEach(() => setLiveUpstreamDiagnostics(() => undefined));

afterEach(() => {
  for (const created of brokers.splice(0)) created.dispose();
  setLiveUpstreamDiagnostics(null);
});

describe("refcounted upstreams (2.1)", () => {
  test("four subscribers to one conversation share one upstream and each receives every event", async () => {
    const child = fakeSource();
    const live = broker(child.source);
    const sinks = [sink(), sink(), sink(), sink()];
    const cursor = cursorOf("g1", 0);
    const attachments = sinks.map(s => live.subscribe(s, "ws", { topic: "conversation", key: "opencode:abc", cursor }));
    await waitFor(() => child.opened.length === 1, "one upstream");
    expect(child.opened[0]!.path).toBe(`/api/chat/conversations/opencode%3Aabc/events?cursor=${encodeURIComponent(cursor)}`);
    child.opened[0]!.push(": open\n\n");
    await waitFor(() => sinks.every(s => s.envelopes.length === 1), "ready on every sink");
    for (const s of sinks) expect(s.envelopes[0]!.event).toEqual({ kind: "ready" });

    child.opened[0]!.push(chatFrame("g1", 1));
    child.opened[0]!.push(chatFrame("g1", 2));
    await waitFor(() => sinks.every(s => s.envelopes.length === 3), "two data envelopes on every sink");
    for (const s of sinks) {
      expect(kinds(s.envelopes)).toEqual(["ready", "data", "data"]);
      expect(s.envelopes[2]!.cursor).toBe(cursorOf("g1", 2));
      expect(s.envelopes[2]!).toMatchObject({ ws: "ws", topic: "conversation", key: "opencode:abc" });
    }
    expect(child.opened).toHaveLength(1);
    expect(live.upstreamCount("conversation")).toBe(1);
    for (const attachment of attachments) attachment.detach();
  });

  test("the upstream is aborted after the linger once the last subscriber leaves", async () => {
    const child = fakeSource();
    const live = broker(child.source, { lingerMs: 40 });
    const a = live.subscribe(sink(), "ws", { topic: "document", key: "" });
    const b = live.subscribe(sink(), "ws", { topic: "document", key: "" });
    await waitFor(() => child.opened.length === 1, "one upstream");
    child.opened[0]!.push('event: state\ndata: {"generatedAt":1}\n\n');
    a.detach();
    await Bun.sleep(60);
    expect(child.opened[0]!.cancelled).toBe(false);
    b.detach();
    expect(child.opened[0]!.cancelled).toBe(false);
    await waitFor(() => child.opened[0]!.cancelled, "the upstream to be aborted after linger");
    expect(live.upstreamCount()).toBe(0);
  });

  test("a quick unsubscribe and resubscribe within the linger reuses the upstream", async () => {
    const child = fakeSource();
    const live = broker(child.source, { lingerMs: 200 });
    const first = sink();
    const a = live.subscribe(first, "ws", { topic: "document", key: "" });
    await waitFor(() => child.opened.length === 1, "one upstream");
    child.opened[0]!.push('event: state\ndata: {"generatedAt":1}\n\n');
    await waitFor(() => first.envelopes.length === 2, "snapshot + ready");
    a.detach();
    await Bun.sleep(30);
    const second = sink();
    const b = live.subscribe(second, "ws", { topic: "document", key: "" });
    await waitFor(() => second.envelopes.length === 2, "snapshot + ready for the resubscriber");
    expect(child.opened).toHaveLength(1);
    expect(child.opened[0]!.cancelled).toBe(false);
    expect(second.envelopes[0]!.event).toEqual({ kind: "data", data: { generatedAt: 1 } });
    await Bun.sleep(250);
    expect(child.opened[0]!.cancelled).toBe(false);
    b.detach();
  });

  test("different keys are different upstreams; the document key is appended verbatim", async () => {
    const child = fakeSource();
    const live = broker(child.source);
    live.subscribe(sink(), "ws", { topic: "document", key: "compareTarget=main&scope=docs" });
    live.subscribe(sink(), "ws", { topic: "document", key: "" });
    live.subscribe(sink(), "ws", { topic: "inventory" });
    await waitFor(() => child.opened.length === 3, "three upstreams");
    expect(child.opened.map(entry => entry.path).sort()).toEqual([
      "/api/chat/conversations/events",
      "/api/events",
      "/api/events?compareTarget=main&scope=docs",
    ]);
  });
});

describe("cursors, replay, and topic-scoped resync (2.2)", () => {
  test("a stale conversation cursor resyncs the conversation topic while the document topic replays", async () => {
    const child = fakeSource({
      refuse: path => {
        // The child cannot replay a cursor from a retired generation: it
        // answers with its resync and ends the stream.
        if (path.includes("/events?cursor=") && path.includes(encodeURIComponent(cursorOf("g0", 3)))) {
          return new Response(`id: ${cursorOf("g1", 5)}\nevent: resync\ndata: {"type":"resync","reason":"generation-changed"}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return null;
      },
    });
    const live = broker(child.source);

    // An established page: document and conversation both live.
    const first = sink();
    live.subscribe(first, "ws", { topic: "document", key: "" });
    live.subscribe(first, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 5) });
    await waitFor(() => child.opened.length === 2, "two upstreams");
    child.byPath("/api/events")[0]!.push('event: state\ndata: {"generatedAt":1}\n\n');
    child.byPath("/conversations/c/")[0]!.push(": open\n\n");
    await waitFor(() => first.envelopes.filter(e => e.event.kind === "ready").length === 2, "both ready");
    const documentCursor = first.envelopes.find(e => e.topic === "document" && e.event.kind === "data")!.cursor;
    child.byPath("/api/events")[0]!.push('event: state\ndata: {"generatedAt":2}\n\n');
    await waitFor(() => first.envelopes.filter(e => e.topic === "document" && e.event.kind === "data").length === 2, "second snapshot");

    // A reconnecting tab: its document cursor is one behind; its conversation
    // cursor is from a generation the child no longer holds.
    const reconnecting = sink();
    live.subscribe(reconnecting, "ws", { topic: "document", key: "", cursor: documentCursor });
    live.subscribe(reconnecting, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g0", 3) });
    await waitFor(() => reconnecting.envelopes.filter(e => e.topic === "conversation").length === 1, "conversation verdict");
    await waitFor(() => reconnecting.envelopes.filter(e => e.topic === "document").length === 2, "document replay");

    const document = reconnecting.envelopes.filter(e => e.topic === "document");
    expect(kinds(document)).toEqual(["data", "ready"]);
    expect(document[0]!.event).toEqual({ kind: "data", data: { generatedAt: 2 } });
    const conversation = reconnecting.envelopes.filter(e => e.topic === "conversation");
    expect(conversation[0]!.event).toMatchObject({ kind: "resync", data: { type: "resync", reason: "generation-changed" } });
    // The shared conversation upstream is untouched by one client's stale cursor.
    expect(child.byPath("/conversations/c/")[0]!.cancelled).toBe(false);
    expect(first.envelopes.filter(e => e.event.kind === "resync")).toHaveLength(0);
  });

  test("a conversation cursor inside the buffer replays later events in order before ready, then live events continue", async () => {
    const child = fakeSource();
    const live = broker(child.source);
    const watcher = sink();
    live.subscribe(watcher, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 0) });
    await waitFor(() => child.opened.length === 1, "upstream");
    const upstream = child.opened[0]!;
    upstream.push(": open\n\n");
    for (let sequence = 1; sequence <= 4; sequence += 1) upstream.push(chatFrame("g1", sequence));
    await waitFor(() => watcher.envelopes.length === 5, "watcher caught up");

    const joiner = sink();
    live.subscribe(joiner, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 2) });
    await waitFor(() => joiner.envelopes.length === 3, "replay of 3 and 4 then ready");
    expect(kinds(joiner.envelopes)).toEqual(["data", "data", "ready"]);
    expect(joiner.envelopes.map(e => e.cursor)).toEqual([cursorOf("g1", 3), cursorOf("g1", 4), cursorOf("g1", 4)]);

    upstream.push(chatFrame("g1", 5));
    await waitFor(() => joiner.envelopes.length === 4 && watcher.envelopes.length === 6, "live event to both");
    expect(joiner.envelopes[3]!.cursor).toBe(cursorOf("g1", 5));
    expect(child.opened).toHaveLength(1);
  });

  test("a conversation cursor ahead of the upstream head skips until the upstream passes it", async () => {
    const child = fakeSource();
    const live = broker(child.source);
    const watcher = sink();
    live.subscribe(watcher, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 1) });
    await waitFor(() => child.opened.length === 1, "upstream");
    const upstream = child.opened[0]!;
    upstream.push(": open\n\n");
    upstream.push(chatFrame("g1", 2));
    await waitFor(() => watcher.envelopes.length === 2, "watcher has 2");

    // Its snapshot was taken after event 4 was published, before the
    // upstream read it.
    const ahead = sink();
    live.subscribe(ahead, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 4) });
    await waitFor(() => ahead.envelopes.length === 1, "ready");
    upstream.push(chatFrame("g1", 3));
    upstream.push(chatFrame("g1", 4));
    upstream.push(chatFrame("g1", 5));
    await waitFor(() => watcher.envelopes.length === 5, "watcher has all");
    expect(ahead.envelopes.map(e => e.cursor)).toEqual([cursorOf("g1", 2), cursorOf("g1", 5)]);
    expect(kinds(ahead.envelopes)).toEqual(["ready", "data"]);
  });

  test("a conversation cursor behind the buffer is caught up from the child's own replay and merged into the shared upstream", async () => {
    const child = fakeSource({
      refuse: path => {
        if (!path.includes(`?cursor=${encodeURIComponent(cursorOf("g1", 1))}`)) return null;
        // The child replays 2..6 for that cursor, then would stay open.
        let frames = "";
        for (let sequence = 2; sequence <= 6; sequence += 1) frames += chatFrame("g1", sequence);
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frames)); } }), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const live = broker(child.source, { replayBufferBytes: 260 });
    const watcher = sink();
    live.subscribe(watcher, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 3) });
    await waitFor(() => child.opened.length === 1, "shared upstream");
    const upstream = child.opened[0]!;
    upstream.push(": open\n\n");
    for (let sequence = 4; sequence <= 6; sequence += 1) upstream.push(chatFrame("g1", sequence));
    await waitFor(() => watcher.envelopes.length === 4, "watcher caught up");

    const behind = sink();
    live.subscribe(behind, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 1) });
    await waitFor(() => behind.envelopes.some(e => e.event.kind === "ready"), "merged and ready");
    const delivered = behind.envelopes.filter(e => e.event.kind === "data").map(e => e.cursor);
    expect(delivered).toEqual([2, 3, 4, 5, 6].map(sequence => cursorOf("g1", sequence)));
    expect(kinds(behind.envelopes).at(-1)).toBe("ready");

    upstream.push(chatFrame("g1", 7));
    await waitFor(() => behind.envelopes.length === delivered.length + 2, "live after merge");
    expect(behind.envelopes.at(-1)!.cursor).toBe(cursorOf("g1", 7));
    // No duplicates: every sequence once.
    expect(new Set(behind.envelopes.filter(e => e.event.kind === "data").map(e => e.cursor)).size).toBe(6);
  });

  test("a joiner with an older cursor on a stream opened without one is caught up to where the stream began", async () => {
    const child = fakeSource();
    const live = broker(child.source);
    const opener = sink();
    live.subscribe(opener, "ws", { topic: "conversation", key: "c" });
    await waitFor(() => child.opened.length === 1, "shared upstream");
    const shared = child.opened[0]!;
    expect(shared.path).not.toContain("cursor=");
    // The child names where its stream begins.
    shared.push(`event: open\ndata: ${JSON.stringify({ cursor: cursorOf("g1", 5) })}\n\n`);
    await waitFor(() => kinds(opener.envelopes).includes("ready"), "opener ready");

    // A tab restored with an older cursor joins before any event arrives.
    const joiner = sink();
    live.subscribe(joiner, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 2) });
    const replayPath = `?cursor=${encodeURIComponent(cursorOf("g1", 2))}`;
    await waitFor(() => child.byPath(replayPath).length === 1, "replay from the joiner's cursor");
    const replay = child.byPath(replayPath)[0]!;
    for (let sequence = 3; sequence <= 5; sequence += 1) replay.push(chatFrame("g1", sequence));
    await waitFor(() => kinds(joiner.envelopes).includes("ready"), "merged at the stream's start");

    shared.push(chatFrame("g1", 6));
    await waitFor(() => joiner.envelopes.filter(e => e.event.kind === "data").length === 4, "live after merge");
    expect(joiner.envelopes.filter(e => e.event.kind === "data").map(e => e.cursor)).toEqual([3, 4, 5, 6].map(sequence => cursorOf("g1", sequence)));
    expect(replay.cancelled).toBe(true);
  });

  test("with no starting cursor from the child, a joiner is caught up rather than skipped past the gap", async () => {
    const child = fakeSource();
    const live = broker(child.source);
    live.subscribe(sink(), "ws", { topic: "conversation", key: "c" });
    await waitFor(() => child.opened.length === 1, "shared upstream");
    child.opened[0]!.push(": open\n\n");
    const joiner = sink();
    live.subscribe(joiner, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 2) });
    const replayPath = `?cursor=${encodeURIComponent(cursorOf("g1", 2))}`;
    await waitFor(() => child.byPath(replayPath).length === 1, "replay opened");
    expect(kinds(joiner.envelopes)).not.toContain("ready");
    child.byPath(replayPath)[0]!.push(chatFrame("g1", 3));
    await waitFor(() => joiner.envelopes.length === 1, "replayed event");
    expect(joiner.envelopes[0]!.cursor).toBe(cursorOf("g1", 3));
  });

  test("a second subscriber behind the buffer while a child replay runs takes a resync instead of its own replay", async () => {
    let replays = 0;
    const child = fakeSource({
      refuse: path => {
        const behind = [1, 2].some(sequence => path.includes(`?cursor=${encodeURIComponent(cursorOf("g1", sequence))}`));
        if (!behind) return null;
        replays += 1;
        // A replay that stays open without reaching the shared head: in flight.
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(chatFrame("g1", 3))); } }), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const live = broker(child.source, { replayBufferBytes: 260 });
    const watcher = sink();
    live.subscribe(watcher, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 3) });
    await waitFor(() => child.opened.length === 1, "shared upstream");
    const upstream = child.opened[0]!;
    upstream.push(": open\n\n");
    for (let sequence = 4; sequence <= 8; sequence += 1) upstream.push(chatFrame("g1", sequence));
    await waitFor(() => watcher.envelopes.filter(e => e.event.kind === "data").length === 5, "watcher live");

    const first = sink();
    live.subscribe(first, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 1) });
    await waitFor(() => replays === 1, "one replay in flight");
    const second = sink();
    live.subscribe(second, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 2) });
    await waitFor(() => second.envelopes.length === 1, "second resynced");
    expect(second.envelopes[0]!.event.kind).toBe("resync");
    // Still one child replay, and the first lagging subscriber keeps it.
    expect(replays).toBe(1);
    expect(kinds(first.envelopes)).not.toContain("resync");
  });

  test("a child resync ends the upstream: every subscriber gets resync, is detached, and a fresh add reopens", async () => {
    const child = fakeSource();
    const live = broker(child.source);
    const a = sink();
    const b = sink();
    live.subscribe(a, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 0) });
    live.subscribe(b, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 0) });
    await waitFor(() => child.opened.length === 1, "upstream");
    child.opened[0]!.push(": open\n\n");
    await waitFor(() => a.envelopes.length === 1 && b.envelopes.length === 1, "ready");
    child.opened[0]!.push(`id: ${cursorOf("g2", 0)}\nevent: resync\ndata: {"type":"resync","reason":"conversation-rewritten"}\n\n`);
    child.opened[0]!.end();
    await waitFor(() => a.envelopes.length === 2 && b.envelopes.length === 2, "resync on both");
    expect(a.envelopes[1]!.event).toMatchObject({ kind: "resync", data: { reason: "conversation-rewritten" } });
    expect(live.upstreamCount("conversation")).toBe(0);

    const again = sink();
    live.subscribe(again, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g2", 0) });
    await waitFor(() => child.opened.length === 2, "reopened");
    expect(child.opened[1]!.path).toContain(encodeURIComponent(cursorOf("g2", 0)));
  });

  test("document: no cursor gets the retained snapshot; the head cursor gets nothing; inventory replays as one tick", async () => {
    const child = fakeSource();
    const live = broker(child.source);
    const first = sink();
    live.subscribe(first, "ws", { topic: "document", key: "" });
    live.subscribe(first, "ws", { topic: "inventory" });
    await waitFor(() => child.opened.length === 2, "upstreams");
    child.byPath("/api/events")[0]!.push('event: state\ndata: {"generatedAt":1}\n\n');
    await waitFor(() => first.envelopes.filter(e => e.event.kind === "ready").length === 2, "ready twice");
    expect(kinds(first.envelopes.filter(e => e.topic === "inventory"))).toEqual(["ready"]);
    const documentHead = first.envelopes.find(e => e.topic === "document" && e.event.kind === "data")!.cursor;

    child.byPath("/conversations/events")[0]!.push('event: inventory\ndata: {"type":"conversation.inventory"}\n\n');
    child.byPath("/conversations/events")[0]!.push('event: inventory\ndata: {"type":"conversation.inventory"}\n\n');
    await waitFor(() => first.envelopes.filter(e => e.topic === "inventory" && e.event.kind === "data").length === 2, "two ticks");
    const inventoryTicks = first.envelopes.filter(e => e.topic === "inventory" && e.event.kind === "data");
    const inventoryHead = inventoryTicks[1]!.cursor;
    expect(inventoryTicks[0]!.cursor).not.toBe(inventoryHead);

    const atHead = sink();
    live.subscribe(atHead, "ws", { topic: "document", key: "", cursor: documentHead });
    live.subscribe(atHead, "ws", { topic: "inventory", cursor: inventoryHead });
    await waitFor(() => atHead.envelopes.length === 2, "ready only");
    expect(kinds(atHead.envelopes)).toEqual(["ready", "ready"]);

    const behind = sink();
    live.subscribe(behind, "ws", { topic: "inventory", cursor: inventoryTicks[0]!.cursor });
    live.subscribe(behind, "ws", { topic: "inventory" });
    await waitFor(() => behind.envelopes.length === 3, "one tick + two ready");
    expect(behind.envelopes.filter(e => e.event.kind === "data")).toHaveLength(1);
    expect(behind.envelopes.find(e => e.event.kind === "data")!.cursor).toBe(inventoryHead);

    const unplaceable = sink();
    live.subscribe(unplaceable, "ws", { topic: "document", key: "", cursor: "from-another-hub-life.9" });
    live.subscribe(unplaceable, "ws", { topic: "inventory", cursor: "from-another-hub-life.9" });
    await waitFor(() => unplaceable.envelopes.length === 4, "snapshot, tick, ready ×2");
    expect(unplaceable.envelopes.find(e => e.topic === "document")!.event).toEqual({ kind: "data", data: { generatedAt: 1 } });
    expect(unplaceable.envelopes.find(e => e.topic === "inventory")!.event).toEqual({ kind: "data", data: { type: "conversation.inventory" } });
  });

  test("the conversation buffer is byte-bounded", async () => {
    const child = fakeSource();
    const live = broker(child.source, { replayBufferBytes: 300 });
    const watcher = sink();
    live.subscribe(watcher, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 0) });
    await waitFor(() => child.opened.length === 1, "upstream");
    child.opened[0]!.push(": open\n\n");
    for (let sequence = 1; sequence <= 20; sequence += 1) child.opened[0]!.push(chatFrame("g1", sequence));
    await waitFor(() => watcher.envelopes.length === 21, "all delivered");
    // A cursor evicted from the buffer is not replayable from the hub: the
    // broker turns to the child (which here refuses with an error → resync).
    const late = sink();
    live.subscribe(late, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 1) });
    await waitFor(() => child.opened.length === 2, "catch-up fetch");
    child.opened[1]!.end();
    await waitFor(() => late.envelopes.some(e => e.event.kind === "resync"), "resync from a failed catch-up");
  });
});

describe("failure and child exit (2.3)", () => {
  test("a rejecting child fetch delivers one unavailability envelope per subscribed client and closes nothing", async () => {
    const child = fakeSource({ refuse: () => new Error("connection refused") });
    const records: LiveUpstreamDiagnostic[] = [];
    setLiveUpstreamDiagnostics(record => records.push(record));
    const live = broker(child.source, { retryMinMs: 20, retryMaxMs: 40 });
    const sinks = [sink(), sink(), sink()];
    for (const s of sinks) live.subscribe(s, "ws", { topic: "document", key: "" });
    await waitFor(() => sinks.every(s => s.envelopes.length === 1), "unavailable on each");
    for (const s of sinks) expect(s.envelopes[0]!.event).toEqual({ kind: "unavailable" });
    // Retries keep failing; no further envelopes pile up.
    await Bun.sleep(150);
    for (const s of sinks) expect(s.envelopes).toHaveLength(1);
    expect(records).toEqual([{ topic: "document", status: "unreachable" }]);
    expect(live.upstreamCount("document")).toBe(1);
  });

  test("an unexpected upstream end is unavailable, then recovery sends a fresh snapshot and ready", async () => {
    const child = fakeSource();
    const live = broker(child.source, { retryMinMs: 20, retryMaxMs: 40 });
    const s = sink();
    live.subscribe(s, "ws", { topic: "document", key: "" });
    await waitFor(() => child.opened.length === 1, "upstream");
    child.opened[0]!.push('event: state\ndata: {"generatedAt":1}\n\n');
    await waitFor(() => s.envelopes.length === 2, "snapshot + ready");
    child.opened[0]!.end();
    await waitFor(() => s.envelopes.length === 3, "unavailable");
    expect(s.envelopes[2]!.event).toEqual({ kind: "unavailable" });
    await waitFor(() => child.opened.length === 2, "retry");
    child.opened[1]!.push('event: state\ndata: {"generatedAt":2}\n\n');
    await waitFor(() => s.envelopes.length === 5, "snapshot + ready after recovery");
    expect(kinds(s.envelopes)).toEqual(["data", "ready", "unavailable", "data", "ready"]);
    expect(s.envelopes[3]!.event).toEqual({ kind: "data", data: { generatedAt: 2 } });
  });

  test("a conversation upstream resumes from its last cursor on recovery", async () => {
    const child = fakeSource();
    const live = broker(child.source, { retryMinMs: 20, retryMaxMs: 40 });
    const s = sink();
    live.subscribe(s, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 0) });
    await waitFor(() => child.opened.length === 1, "upstream");
    child.opened[0]!.push(": open\n\n");
    child.opened[0]!.push(chatFrame("g1", 1));
    await waitFor(() => s.envelopes.length === 2, "ready + data");
    child.opened[0]!.end();
    await waitFor(() => child.opened.length === 2, "reopen");
    expect(child.opened[1]!.path).toContain(`cursor=${encodeURIComponent(cursorOf("g1", 1))}`);
    child.opened[1]!.push(": open\n\n");
    child.opened[1]!.push(chatFrame("g1", 2));
    await waitFor(() => s.envelopes.length === 5, "unavailable, ready, data");
    expect(kinds(s.envelopes)).toEqual(["ready", "data", "unavailable", "ready", "data"]);
  });

  test("a stopped workspace is unavailable at once and a session start recovers it promptly", async () => {
    const child = fakeSource({ running: new Set() });
    const live = broker(child.source, { retryMinMs: 5_000, retryMaxMs: 5_000 });
    const s = sink();
    live.subscribe(s, "ws", { topic: "document", key: "" });
    await waitFor(() => s.envelopes.length === 1, "unavailable");
    expect(s.envelopes[0]!.event).toEqual({ kind: "unavailable" });
    child.setRunning("ws", true);
    await waitFor(() => child.opened.length === 1, "reopened on session start, not on the backoff tick");
    child.opened[0]!.push('event: state\ndata: {"generatedAt":3}\n\n');
    await waitFor(() => s.envelopes.length === 3, "snapshot + ready");
    // A stop notification fails it at once and aborts the child fetch.
    child.setRunning("ws", false);
    await waitFor(() => s.envelopes.length === 4, "unavailable after stop");
    expect(child.opened[0]!.cancelled).toBe(true);
  });

  test("tabs joining a failed upstream share the attempt that failed and bring one retry forward to the floor", async () => {
    let attempts = 0;
    const child = fakeSource({ refuse: () => { attempts += 1; return new Error("refused"); } });
    const live = broker(child.source, { retryMinMs: 200, retryMaxMs: 5_000 });
    const first = sink();
    live.subscribe(first, "ws", { topic: "inventory" });
    await waitFor(() => first.envelopes.length === 1, "unavailable");
    expect(attempts).toBe(1);
    // Three more tabs join within the floor: each is told at once, none
    // restarts the upstream.
    const joiners = [sink(), sink(), sink()];
    for (const joiner of joiners) live.subscribe(joiner, "ws", { topic: "inventory" });
    for (const joiner of joiners) expect(kinds(joiner.envelopes)).toEqual(["unavailable"]);
    await Bun.sleep(30);
    expect(attempts).toBe(1);
    // One retry at the floor for all four.
    await waitFor(() => attempts === 2, "one retry", 1_000);
    await Bun.sleep(40);
    expect(attempts).toBe(2);
  });

  test("a subscriber joining a failed upstream is told unavailable immediately", async () => {
    const child = fakeSource({ refuse: () => new Error("refused") });
    const live = broker(child.source, { retryMinMs: 5_000, retryMaxMs: 5_000 });
    const first = sink();
    live.subscribe(first, "ws", { topic: "inventory" });
    await waitFor(() => first.envelopes.length === 1, "unavailable");
    const second = sink();
    live.subscribe(second, "ws", { topic: "inventory" });
    expect(second.envelopes).toEqual([expect.objectContaining({ event: { kind: "unavailable" } })]);
  });
});

describe("a shared upstream failing during a conversation catch-up", () => {
  // A shared conversation upstream at head 6 with a live watcher, and a
  // second subscriber behind the buffer whose child replay has delivered
  // event 2 when the shared upstream ends: both are told `unavailable`, the
  // replay stays readable. Each test stages what happens next. The retry
  // reopens from the head; the test decides when that reopen goes live.
  async function failDuringCatchUp() {
    const child = fakeSource();
    const live = broker(child.source, { retryMinMs: 20, retryMaxMs: 40 });
    const watcher = sink();
    live.subscribe(watcher, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 3) });
    await waitFor(() => child.opened.length === 1, "shared upstream");
    const shared = child.opened[0]!;
    shared.push(": open\n\n");
    for (let sequence = 4; sequence <= 6; sequence += 1) shared.push(chatFrame("g1", sequence));
    await waitFor(() => watcher.envelopes.length === 4, "watcher live at 6");

    const behind = sink();
    live.subscribe(behind, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 1) });
    const replayPath = `?cursor=${encodeURIComponent(cursorOf("g1", 1))}`;
    await waitFor(() => child.byPath(replayPath).length === 1, "child replay for the lagging subscriber");
    const replay = child.byPath(replayPath)[0]!;
    replay.push(chatFrame("g1", 2));
    await waitFor(() => behind.envelopes.length === 1, "first caught-up event");

    shared.end();
    await waitFor(() => kinds(behind.envelopes).includes("unavailable") && kinds(watcher.envelopes).includes("unavailable"), "unavailable on both");
    expect(replay.cancelled).toBe(false);
    const reopened = () => child.byPath(`?cursor=${encodeURIComponent(cursorOf("g1", 6))}`)[0];
    const dataCursors = (envelopes: LiveEnvelope[]) => envelopes.filter(e => e.event.kind === "data").map(e => e.cursor);
    return { child, live, watcher, behind, replay, reopened, dataCursors };
  }

  test("a catch-up reaching the shared upstream while it is down ends without ready, and the subscriber is not live", async () => {
    const { behind, replay, reopened, dataCursors } = await failDuringCatchUp();
    replay.push(chatFrame("g1", 3) + chatFrame("g1", 4));
    await waitFor(() => replay.cancelled, "catch-up merged and released");
    // Past the retry: it reopens from the head but nothing has made it live.
    await waitFor(() => reopened() !== undefined, "retry from the head");
    await Bun.sleep(30);
    expect(kinds(behind.envelopes)).toEqual(["data", "unavailable", "data", "data"]);
    expect(dataCursors(behind.envelopes)).toEqual([2, 3, 4].map(sequence => cursorOf("g1", sequence)));
  });

  test("recovery attaches that subscriber: the owed events in order, ready once, then live", async () => {
    const { behind, watcher, replay, reopened, dataCursors } = await failDuringCatchUp();
    replay.push(chatFrame("g1", 3) + chatFrame("g1", 4));
    await waitFor(() => replay.cancelled, "catch-up merged and released");
    await waitFor(() => reopened() !== undefined, "retry from the head");
    expect(kinds(behind.envelopes)).not.toContain("ready");

    reopened()!.push(": open\n\n");
    await waitFor(() => kinds(behind.envelopes).includes("ready"), "ready on recovery");
    reopened()!.push(chatFrame("g1", 7));
    await waitFor(() => behind.envelopes.at(-1)?.cursor === cursorOf("g1", 7), "live after recovery");
    expect(kinds(behind.envelopes)).toEqual(["data", "unavailable", "data", "data", "data", "data", "ready", "data"]);
    expect(dataCursors(behind.envelopes)).toEqual([2, 3, 4, 5, 6, 7].map(sequence => cursorOf("g1", sequence)));
    expect(kinds(watcher.envelopes)).toEqual(["ready", "data", "data", "data", "unavailable", "ready", "data"]);
  });

  test("a catch-up that dies while the shared upstream is down keeps the subscriber pending; recovery resumes it from its progress", async () => {
    const { child, behind, replay, reopened, dataCursors } = await failDuringCatchUp();
    // The child's replay ends with the same outage. Not a resync: the page
    // was told the stream is unavailable and waits for its recovery.
    replay.end();
    await waitFor(() => reopened() !== undefined, "retry from the head");
    await Bun.sleep(30);
    expect(kinds(behind.envelopes)).toEqual(["data", "unavailable"]);

    reopened()!.push(": open\n\n");
    const resumedPath = `?cursor=${encodeURIComponent(cursorOf("g1", 2))}`;
    await waitFor(() => child.byPath(resumedPath).length === 1, "catch-up resumed from the last caught-up cursor");
    expect(kinds(behind.envelopes)).not.toContain("ready");
    child.byPath(resumedPath)[0]!.push(chatFrame("g1", 3) + chatFrame("g1", 4));
    await waitFor(() => kinds(behind.envelopes).includes("ready"), "merged and ready");
    reopened()!.push(chatFrame("g1", 7));
    await waitFor(() => behind.envelopes.at(-1)?.cursor === cursorOf("g1", 7), "live after recovery");
    expect(kinds(behind.envelopes)).toEqual(["data", "unavailable", "data", "data", "data", "data", "ready", "data"]);
    expect(dataCursors(behind.envelopes)).toEqual([2, 3, 4, 5, 6, 7].map(sequence => cursorOf("g1", sequence)));
    expect(kinds(behind.envelopes)).not.toContain("resync");
  });

  test("a catch-up that merges after the upstream recovered goes live once, and a later failure is signalled again", async () => {
    const { behind, replay, reopened, dataCursors } = await failDuringCatchUp();
    await waitFor(() => reopened() !== undefined, "retry from the head");
    reopened()!.push(": open\n\n");
    await Bun.sleep(30);
    // Recovery leaves the catch-up to finish; the subscriber is not ready yet.
    expect(kinds(behind.envelopes)).toEqual(["data", "unavailable"]);

    replay.push(chatFrame("g1", 3) + chatFrame("g1", 4));
    await waitFor(() => kinds(behind.envelopes).includes("ready"), "merged and ready");
    expect(kinds(behind.envelopes)).toEqual(["data", "unavailable", "data", "data", "data", "data", "ready"]);
    expect(dataCursors(behind.envelopes)).toEqual([2, 3, 4, 5, 6].map(sequence => cursorOf("g1", sequence)));

    reopened()!.end();
    await waitFor(() => kinds(behind.envelopes).at(-1) === "unavailable", "second outage signalled");
    expect(kinds(behind.envelopes).filter(kind => kind === "ready")).toHaveLength(1);
    expect(kinds(behind.envelopes).filter(kind => kind === "unavailable")).toHaveLength(2);
  });
});

describe("activity (2.4)", () => {
  test("a stopped workspace reports not running, an unreachable child not running, and extra fields are dropped", async () => {
    const child = fakeSource({
      running: new Set(["alive", "broken"]),
      workspaces: ["alive", "broken", "stopped"],
      refuse: path => (path === "/api/activity" ? null : null),
    });
    // The broken workspace's child refuses every connection.
    const source: LiveUpstreamSource = {
      ...child.source,
      open: request => request.workspaceId === "broken" ? Promise.reject(new Error("refused")) : child.source.open(request),
    };
    const live = broker(source, { retryMinMs: 5_000, retryMaxMs: 5_000 });
    const s = sink();
    live.subscribeActivity(s, "tobias");
    await waitFor(() => child.opened.length === 1, "one activity upstream for the reachable child");
    expect(child.opened[0]!.path).toBe("/api/activity");
    child.opened[0]!.push(": open\n\n");
    child.opened[0]!.push('event: activity\ndata: {"working":true,"awaiting":false,"title":"secret plans","conversationId":"x"}\n\n');
    await waitFor(() => s.envelopes.some(e => e.ws === "broken" && (e.event as { data: { running: boolean } }).data.running === false), "broken reported not running");
    await waitFor(() => s.envelopes.some(e => e.ws === "alive" && (e.event as { data: { working: boolean } }).data.working), "alive reported working");
    const latest = new Map<string, unknown>();
    for (const envelope of s.envelopes) {
      expect(envelope.topic).toBe("activity");
      expect(envelope.event.kind).toBe("data");
      latest.set(envelope.ws, (envelope.event as { data: unknown }).data);
    }
    expect(latest.get("stopped")).toEqual({ running: false, working: false, awaiting: false });
    expect(latest.get("broken")).toEqual({ running: false, working: false, awaiting: false });
    expect(latest.get("alive")).toEqual({ running: true, working: true, awaiting: false });
    expect(JSON.stringify(s.envelopes)).not.toContain("secret plans");
  });

  test("emits only on change, and a change in another workspace reaches every stream of the user", async () => {
    const child = fakeSource({ running: new Set(["a"]), workspaces: ["a"] });
    const live = broker(child.source);
    const tab1 = sink();
    const tab2 = sink();
    live.subscribeActivity(tab1, "u");
    live.subscribeActivity(tab2, "u");
    await waitFor(() => child.opened.length === 1, "one activity upstream for both tabs");
    child.opened[0]!.push(": open\n\n");
    child.opened[0]!.push('event: activity\ndata: {"working":false,"awaiting":false}\n\n');
    await Bun.sleep(30);
    // The open snapshot said running + unknown, and the child confirmed the
    // same booleans: no second envelope.
    expect(tab1.envelopes).toHaveLength(1);
    expect(tab2.envelopes).toHaveLength(1);
    child.opened[0]!.push('event: activity\ndata: {"working":true,"awaiting":true}\n\n');
    await waitFor(() => tab1.envelopes.length === 2 && tab2.envelopes.length === 2, "change on both");
    expect(tab1.envelopes[1]!.event).toEqual({ kind: "data", data: { running: true, working: true, awaiting: true } });
    child.opened[0]!.push('event: activity\ndata: {"working":true,"awaiting":true}\n\n');
    await Bun.sleep(30);
    expect(tab1.envelopes).toHaveLength(2);
  });

  test("an old child answering 404 is running with unknown activity; a session stop flips it to not running", async () => {
    const child = fakeSource({
      running: new Set(["old"]),
      workspaces: ["old"],
      refuse: path => (path === "/api/activity" ? new Response("not found", { status: 404 }) : null),
    });
    const live = broker(child.source);
    const s = sink();
    live.subscribeActivity(s, "u");
    await Bun.sleep(40);
    expect(s.envelopes).toHaveLength(1);
    expect(s.envelopes[0]!.event).toEqual({ kind: "data", data: { running: true, working: false, awaiting: false } });
    child.setRunning("old", false);
    await waitFor(() => s.envelopes.length === 2, "stop reported");
    expect(s.envelopes[1]!.event).toEqual({ kind: "data", data: { running: false, working: false, awaiting: false } });
  });

  test("the activity upstream is refcounted per user and released after the last feed leaves", async () => {
    const child = fakeSource({ running: new Set(["a"]), workspaces: ["a"] });
    const live = broker(child.source, { lingerMs: 30 });
    const one = live.subscribeActivity(sink(), "u1");
    const two = live.subscribeActivity(sink(), "u2");
    await waitFor(() => child.opened.length === 1, "one child upstream for two users");
    one.detach();
    await Bun.sleep(60);
    expect(child.opened[0]!.cancelled).toBe(false);
    two.detach();
    await waitFor(() => child.opened[0]!.cancelled, "released after linger");
  });
});

describe("diagnostics (3.3)", () => {
  test("a retried upstream is one active upstream, and its release returns the gauge to zero", async () => {
    const registry = new MetricsRegistry();
    const child = fakeSource();
    const live = broker(child.source, { metrics: registry, lingerMs: 10, retryMinMs: 20, retryMaxMs: 40 });
    const attachment = live.subscribe(sink(), "ws", { topic: "document", key: "" });
    await waitFor(() => child.opened.length === 1, "upstream");
    child.opened[0]!.push('event: state\ndata: {"generatedAt":1}\n\n');
    child.opened[0]!.end();
    await waitFor(() => child.opened.length === 2, "retry");
    expect(registry.get(upstreamCounter("document", "opened"))).toBe(2);
    expect(registry.get(upstreamActiveGauge("document"))).toBe(1);
    attachment.detach();
    await waitFor(() => registry.get(upstreamCounter("document", "released")) === 1, "released");
    expect(registry.get(upstreamActiveGauge("document"))).toBe(0);
  });

  test("upstream counters are fixed classes only", async () => {
    const registry = new MetricsRegistry();
    const child = fakeSource();
    const live = broker(child.source, { metrics: registry, lingerMs: 10 });
    const attachment = live.subscribe(sink(), "ws", { topic: "conversation", key: "opencode:secret-conversation", cursor: cursorOf("g1", 0) });
    await waitFor(() => child.opened.length === 1, "upstream");
    child.opened[0]!.push(": open\n\n");
    expect(registry.get(upstreamCounter("conversation", "opened"))).toBe(1);
    expect(registry.get(upstreamActiveGauge("conversation"))).toBe(1);
    attachment.detach();
    await waitFor(() => registry.get(upstreamCounter("conversation", "released")) === 1, "released");
    expect(registry.get(upstreamActiveGauge("conversation"))).toBe(0);
    const names = Object.keys(registry.snapshot().counters).join("\n");
    expect(names).not.toContain("secret-conversation");
    expect(names).not.toContain("ws");
    expect(names).not.toContain(cursorOf("g1", 0));
  });
});
