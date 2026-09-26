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
  const removals = new Set<(workspaceId: string) => void>();
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
    onWorkspaceRemoved(listener) {
      removals.add(listener);
      return () => removals.delete(listener);
    },
  };
  return {
    source,
    opened,
    running,
    // The registry lets go of a stopped workspace, as the hub's forget does.
    unregister(id: string) {
      const index = options.workspaces?.indexOf(id) ?? -1;
      if (index !== -1) options.workspaces!.splice(index, 1);
      for (const listener of removals) listener(id);
    },
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
    await waitFor(() => behind.envelopes.length === 2, "one tick + ready");
    expect(kinds(behind.envelopes)).toEqual(["data", "ready"]);
    expect(behind.envelopes[0]!.cursor).toBe(inventoryHead);

    // A first attach presents no cursor: it is owed the opening tick the
    // child gave this upstream's first subscriber long ago.
    const joiner = sink();
    live.subscribe(joiner, "ws", { topic: "inventory" });
    await waitFor(() => joiner.envelopes.length === 2, "opening tick + ready");
    expect(kinds(joiner.envelopes)).toEqual(["data", "ready"]);
    expect(joiner.envelopes[0]!.cursor).toBe(inventoryHead);

    const unplaceable = sink();
    live.subscribe(unplaceable, "ws", { topic: "document", key: "", cursor: "from-another-hub-life.9" });
    live.subscribe(unplaceable, "ws", { topic: "inventory", cursor: "from-another-hub-life.9" });
    await waitFor(() => unplaceable.envelopes.length === 4, "snapshot, tick, ready ×2");
    expect(unplaceable.envelopes.find(e => e.topic === "document")!.event).toEqual({ kind: "data", data: { generatedAt: 1 } });
    expect(unplaceable.envelopes.find(e => e.topic === "inventory")!.event).toEqual({ kind: "data", data: { type: "conversation.inventory" } });
  });

  test("inventory: a page attaching to a lingering upstream gets its own opening tick, a fresh upstream's first page only the child's", async () => {
    const child = fakeSource();
    const live = broker(child.source, { lingerMs: 500 });
    const before = sink();
    const first = live.subscribe(before, "ws", { topic: "inventory" });
    await waitFor(() => child.opened.length === 1, "one upstream");
    child.opened[0]!.push(": open\n\n");
    // The child's route opens every subscription with a reconcile tick.
    child.opened[0]!.push('event: inventory\ndata: {"type":"conversation.inventory"}\n\n');
    await waitFor(() => before.envelopes.length === 2, "ready + the child's opening tick");
    // Fresh upstream: the child's own tick is the only one — no duplicate.
    expect(kinds(before.envelopes)).toEqual(["ready", "data"]);

    // A reload: the page leaves, the upstream lingers, the reloaded page
    // read its baseline inventory and now attaches without a cursor. A
    // conversation created between that read and this attach is announced
    // by nothing else.
    first.detach();
    const reloaded = sink();
    live.subscribe(reloaded, "ws", { topic: "inventory" });
    await waitFor(() => reloaded.envelopes.length === 2, "opening tick + ready");
    expect(reloaded.envelopes.map(envelope => envelope.event)).toEqual([
      { kind: "data", data: { type: "conversation.inventory" } },
      { kind: "ready" },
    ]);
    expect(child.opened).toHaveLength(1);
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
    expect(latest.get("stopped")).toEqual({ running: false, working: false, awaiting: false, finished: false });
    expect(latest.get("broken")).toEqual({ running: false, working: false, awaiting: false, finished: false });
    expect(latest.get("alive")).toEqual({ running: true, working: true, awaiting: false, finished: false });
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
    expect(tab1.envelopes[1]!.event).toEqual({ kind: "data", data: { running: true, working: true, awaiting: true, finished: false } });
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
    expect(s.envelopes[0]!.event).toEqual({ kind: "data", data: { running: true, working: false, awaiting: false, finished: false } });
    child.setRunning("old", false);
    await waitFor(() => s.envelopes.length === 2, "stop reported");
    expect(s.envelopes[1]!.event).toEqual({ kind: "data", data: { running: false, working: false, awaiting: false, finished: false } });
  });

  test("two users share one upstream; it follows the workspace, not the feeds, and is released when it stops", async () => {
    const child = fakeSource({ running: new Set(["a"]), workspaces: ["a"] });
    const live = broker(child.source, { lingerMs: 30 });
    const one = live.subscribeActivity(sink(), "u1");
    const two = live.subscribeActivity(sink(), "u2");
    await waitFor(() => child.opened.length === 1, "one child upstream for two users");
    one.detach();
    two.detach();
    // Every feed is gone and the workspace still runs: the broker keeps
    // watching, which is what lets it see a finish nobody is there for.
    await Bun.sleep(60);
    expect(child.opened[0]!.cancelled).toBe(false);
    expect(live.upstreamCount("activity")).toBe(1);
    child.setRunning("a", false);
    await waitFor(() => child.opened[0]!.cancelled, "the stop cancels the child fetch");
    await waitFor(() => live.upstreamCount("activity") === 0, "released after the stop's linger");
  });
});

describe("finished (fix-workspace-activity-states D2/D3)", () => {
  const facts = (envelope: LiveEnvelope) => (envelope.event as { data: { running: boolean; working: boolean; awaiting: boolean; finished: boolean } }).data;
  const latestFor = (s: ReturnType<typeof sink>, ws: string) => facts(s.envelopes.filter(e => e.ws === ws).at(-1)!);
  const push = (child: ReturnType<typeof fakeSource>, working: boolean, awaiting: boolean) =>
    child.opened[0]!.push(`event: activity\ndata: {"working":${working},"awaiting":${awaiting}}\n\n`);

  // Two users with feeds, the child open and confirmed working.
  async function workingWorkspace() {
    const child = fakeSource({ running: new Set(["a"]), workspaces: ["a"] });
    const live = broker(child.source);
    const alice = sink();
    const bob = sink();
    const attachments = { alice: live.subscribeActivity(alice, "alice"), bob: live.subscribeActivity(bob, "bob") };
    await waitFor(() => child.opened.length === 1, "one shared activity upstream");
    child.opened[0]!.push(": open\n\n");
    push(child, true, false);
    await waitFor(() => latestFor(alice, "a").working && latestFor(bob, "a").working, "both see working");
    return { child, live, alice, bob, attachments };
  }

  test("working → quiet marks the workspace finished for every user holding a feed", async () => {
    const { child, alice, bob } = await workingWorkspace();
    push(child, false, false);
    await waitFor(() => latestFor(alice, "a").finished && latestFor(bob, "a").finished, "both see finished");
    expect(latestFor(alice, "a")).toEqual({ running: true, working: false, awaiting: false, finished: true });
    // Unchanged facts re-sent by the child are not a second emit.
    const count = alice.envelopes.length;
    push(child, false, false);
    await Bun.sleep(30);
    expect(alice.envelopes).toHaveLength(count);
  });

  test("a workspace first seen quiet is not finished: unknown → idle invents nothing", async () => {
    const child = fakeSource({ running: new Set(["a"]), workspaces: ["a"] });
    const live = broker(child.source);
    const alice = sink();
    live.subscribeActivity(alice, "alice");
    await waitFor(() => child.opened.length === 1, "upstream");
    child.opened[0]!.push(": open\n\n");
    push(child, false, false);
    await Bun.sleep(30);
    expect(latestFor(alice, "a")).toEqual({ running: true, working: false, awaiting: false, finished: false });
    // Nor does a hub-invented unknown (an old child without the route).
    const old = fakeSource({ running: new Set(["o"]), workspaces: ["o"], refuse: path => (path === "/api/activity" ? new Response("not found", { status: 404 }) : null) });
    const oldLive = broker(old.source);
    const carol = sink();
    oldLive.subscribeActivity(carol, "carol");
    await Bun.sleep(40);
    expect(carol.envelopes.map(facts).every(value => !value.finished)).toBe(true);
  });

  test("working → awaiting is not a finish, and neither is awaiting → idle without working in between", async () => {
    const { child, alice } = await workingWorkspace();
    push(child, true, true);
    await waitFor(() => latestFor(alice, "a").awaiting, "awaiting");
    expect(latestFor(alice, "a").finished).toBe(false);
    push(child, false, false);
    await Bun.sleep(30);
    expect(latestFor(alice, "a")).toEqual({ running: true, working: false, awaiting: false, finished: false });
    // Answered, the agent works on, then finishes: that finish counts.
    push(child, true, false);
    await waitFor(() => latestFor(alice, "a").working, "working again");
    push(child, false, false);
    await waitFor(() => latestFor(alice, "a").finished, "finished after the answer's work");
  });

  test("acknowledging clears finished for that user only, emitting exactly once, and is idempotent", async () => {
    const { child, live, alice, bob } = await workingWorkspace();
    push(child, false, false);
    await waitFor(() => latestFor(alice, "a").finished && latestFor(bob, "a").finished, "both finished");
    const aliceCount = alice.envelopes.length;
    const bobCount = bob.envelopes.length;
    live.acknowledgeViewed("alice", "a");
    expect(alice.envelopes).toHaveLength(aliceCount + 1);
    expect(latestFor(alice, "a")).toEqual({ running: true, working: false, awaiting: false, finished: false });
    expect(bob.envelopes).toHaveLength(bobCount);
    expect(latestFor(bob, "a").finished).toBe(true);
    live.acknowledgeViewed("alice", "a");
    live.acknowledgeViewed("alice", "unknown-workspace");
    expect(alice.envelopes).toHaveLength(aliceCount + 1);
    // A later finish outranks the earlier view.
    push(child, true, false);
    await waitFor(() => latestFor(alice, "a").working, "working again");
    push(child, false, false);
    await waitFor(() => latestFor(alice, "a").finished, "finished again for alice");
  });

  test("a stop clears finished; so does work starting again", async () => {
    const { child, live, alice } = await workingWorkspace();
    push(child, false, false);
    await waitFor(() => latestFor(alice, "a").finished, "finished");
    push(child, true, false);
    await waitFor(() => latestFor(alice, "a").working, "working");
    expect(latestFor(alice, "a").finished).toBe(false);
    push(child, false, false);
    await waitFor(() => latestFor(alice, "a").finished, "finished once more");
    child.setRunning("a", false);
    await waitFor(() => !latestFor(alice, "a").running, "stopped");
    expect(latestFor(alice, "a")).toEqual({ running: false, working: false, awaiting: false, finished: false });
    // Restarted: the child is seen fresh, nothing finished carries over.
    child.setRunning("a", true);
    await waitFor(() => child.opened.length === 2, "reopened");
    child.opened[1]!.push(": open\n\nevent: activity\ndata: {\"working\":false,\"awaiting\":false}\n\n");
    await Bun.sleep(30);
    expect(latestFor(alice, "a")).toEqual({ running: true, working: false, awaiting: false, finished: false });
    void live;
  });

  test("a user whose feed was dropped and re-created still sees finished; the shared upstream's replay is not a transition", async () => {
    const { child, live, alice, bob, attachments } = await workingWorkspace();
    push(child, false, false);
    await waitFor(() => latestFor(alice, "a").finished && latestFor(bob, "a").finished, "both finished");
    // Alice closes her last page: her feed goes; bob's keeps the upstream.
    attachments.alice.detach();
    // A frame arrives meanwhile — still quiet — and bob is unchanged.
    push(child, false, false);
    await Bun.sleep(20);
    const again = sink();
    live.subscribeActivity(again, "alice");
    expect(latestFor(again, "a")).toEqual({ running: true, working: false, awaiting: false, finished: true });
    expect(latestFor(bob, "a").finished).toBe(true);
    // Bob acknowledged nothing, alice's new feed did not invent a second
    // finish from the replayed frame either: acknowledging clears it for
    // good until real work happens again.
    live.acknowledgeViewed("alice", "a");
    expect(latestFor(again, "a").finished).toBe(false);
    push(child, false, false);
    await Bun.sleep(20);
    expect(latestFor(again, "a").finished).toBe(false);
  });

  test("work finishing with no feed open at all is reported to the first feed that appears afterwards (D11)", async () => {
    const { child, live, attachments } = await workingWorkspace();
    // Both users close their last page. The broker's own watch stays.
    attachments.alice.detach();
    attachments.bob.detach();
    await Bun.sleep(40);
    expect(child.opened[0]!.cancelled).toBe(false);
    // The agent finishes with nobody watching.
    push(child, false, false);
    await Bun.sleep(30);
    const later = sink();
    live.subscribeActivity(later, "alice");
    expect(latestFor(later, "a")).toEqual({ running: true, working: false, awaiting: false, finished: true });
    // Still one upstream: the page that returned did not open a second.
    expect(child.opened).toHaveLength(1);
  });

  test("a stop with no feed open releases the watch and clears the marks", async () => {
    const { child, live, attachments } = await workingWorkspace();
    push(child, false, false);
    await Bun.sleep(30);
    attachments.alice.detach();
    attachments.bob.detach();
    child.setRunning("a", false);
    await waitFor(() => child.opened[0]!.cancelled, "watch released by the stop");
    const later = sink();
    live.subscribeActivity(later, "alice");
    expect(latestFor(later, "a")).toEqual({ running: false, working: false, awaiting: false, finished: false });
    // Restarted and quiet from the first frame: nothing carries over.
    child.setRunning("a", true);
    await waitFor(() => child.opened.length === 2, "reopened");
    child.opened[1]!.push(": open\n\nevent: activity\ndata: {\"working\":false,\"awaiting\":false}\n\n");
    await Bun.sleep(30);
    expect(latestFor(later, "a")).toEqual({ running: true, working: false, awaiting: false, finished: false });
  });

  // The marks as the broker last handed them to its store.
  function recordingMarks(restored: { finishedAt?: [string, number][]; viewedAt?: [string, [string, number][]][] } = {}) {
    const writes: { finishedAt: Map<string, number>; viewedAt: Map<string, Map<string, number>> }[] = [];
    return {
      writes,
      last: () => writes.at(-1),
      sink: {
        read: () => ({
          finishedAt: new Map(restored.finishedAt ?? []),
          viewedAt: new Map((restored.viewedAt ?? []).map(([user, entries]) => [user, new Map(entries)])),
        }),
        write: (marks: { finishedAt: Map<string, number>; viewedAt: Map<string, Map<string, number>> }) => {
          const viewedAt = new Map<string, Map<string, number>>();
          for (const [user, workspaces] of marks.viewedAt) viewedAt.set(user, new Map(workspaces));
          writes.push({ finishedAt: new Map(marks.finishedAt), viewedAt });
        },
      },
    };
  }

  test("a finish survives a single upstream stream end and its retry, and stays persisted", async () => {
    const child = fakeSource({ running: new Set(["a"]), workspaces: ["a"] });
    const marks = recordingMarks();
    const live = broker(child.source, { marks: marks.sink });
    const alice = sink();
    live.subscribeActivity(alice, "alice");
    await waitFor(() => child.opened.length === 1, "the watch");
    child.opened[0]!.push(": open\n\n");
    push(child, true, false);
    await waitFor(() => latestFor(alice, "a").working, "working");
    push(child, false, false);
    await waitFor(() => latestFor(alice, "a").finished, "finished");
    // bob viewed an earlier finish; that view is not the drop's to erase.
    live.acknowledgeViewed("bob", "a");
    // One transient end of the child's stream: the upstream signals
    // unavailable on this first failure of the episode.
    child.opened[0]!.end();
    await waitFor(() => !latestFor(alice, "a").running, "unreachable reads as not running");
    expect(latestFor(alice, "a").finished).toBe(false);
    expect(marks.last()!.finishedAt.has("a")).toBe(true);
    expect(marks.last()!.viewedAt.get("bob")?.has("a")).toBe(true);
    // The retry reaches the child, which is still quiet: the unviewed
    // finish shows again.
    await waitFor(() => child.opened.length === 2, "the retry");
    child.opened[1]!.push(": open\n\nevent: activity\ndata: {\"working\":false,\"awaiting\":false}\n\n");
    await waitFor(() => latestFor(alice, "a").running, "reachable again");
    expect(latestFor(alice, "a")).toEqual({ running: true, working: false, awaiting: false, finished: true });
    expect(marks.last()!.finishedAt.has("a")).toBe(true);
  });

  test("an unreachable child stays not running for a new page and another workspace's change; recovery restores the real value without inventing a finish", async () => {
    const child = fakeSource({ running: new Set(["a", "b"]), workspaces: ["a", "b"] });
    let refusing = false;
    const source: LiveUpstreamSource = {
      ...child.source,
      open: request => refusing && request.workspaceId === "a" ? Promise.reject(new Error("refused")) : child.source.open(request),
    };
    const live = broker(source);
    const alice = sink();
    live.subscribeActivity(alice, "alice");
    const watchOf = () => child.opened.filter(entry => entry.workspaceId === "a");
    await waitFor(() => watchOf().length === 1, "the watch on a");
    watchOf()[0]!.push(": open\n\n");
    watchOf()[0]!.push('event: activity\ndata: {"working":true,"awaiting":false}\n\n');
    await waitFor(() => latestFor(alice, "a").working, "working");
    // The child goes away mid-run and every retry is refused.
    refusing = true;
    watchOf()[0]!.end();
    await waitFor(() => !latestFor(alice, "a").running, "unreachable");
    // A second page opens: the seed must not resurrect it as running.
    const again = sink();
    live.subscribeActivity(again, "alice");
    expect(latestFor(again, "a").running).toBe(false);
    expect(latestFor(alice, "a").running).toBe(false);
    // Another workspace's session change refreshes every feed: same answer.
    child.setRunning("b", false);
    await waitFor(() => !latestFor(alice, "b").running, "b stopped");
    await Bun.sleep(150);
    expect(latestFor(alice, "a").running).toBe(false);
    expect(latestFor(again, "a").running).toBe(false);
    // The child answers again, quiet. Its last reading before the drop was
    // working, but the drop is not a finish: nothing was seen to end.
    refusing = false;
    await waitFor(() => watchOf().length === 2, "the recovered watch");
    watchOf()[1]!.push(": open\n\n");
    watchOf()[1]!.push('event: activity\ndata: {"working":false,"awaiting":false}\n\n');
    await waitFor(() => latestFor(alice, "a").running && latestFor(again, "a").running, "recovered");
    expect(latestFor(alice, "a")).toEqual({ running: true, working: false, awaiting: false, finished: false });
    expect(latestFor(again, "a")).toEqual({ running: true, working: false, awaiting: false, finished: false });
    watchOf()[1]!.push('event: activity\ndata: {"working":true,"awaiting":false}\n\n');
    await waitFor(() => latestFor(alice, "a").working, "working after recovery");
    expect(latestFor(alice, "a")).toEqual({ running: true, working: true, awaiting: false, finished: false });
  });

  test("a workspace that leaves the registry takes its marks with it; a new one under the freed slug is not finished", async () => {
    const workspaces = ["a", "other"];
    const child = fakeSource({ running: new Set(), workspaces });
    // What the previous hub left: an unviewed finish in "a", stopped by the
    // restart, and a view of it by bob.
    const marks = recordingMarks({ finishedAt: [["a", 5]], viewedAt: [["bob", [["a", 3]]]] });
    const live = broker(child.source, { marks: marks.sink });
    const alice = sink();
    live.subscribeActivity(alice, "alice");
    // Forgotten while stopped: no session change announces it.
    child.unregister("a");
    expect(marks.last()!.finishedAt.has("a")).toBe(false);
    expect(marks.last()!.viewedAt.has("bob")).toBe(false);
    // A different folder is registered and takes the freed slug.
    workspaces.push("a");
    child.setRunning("a", true);
    await waitFor(() => child.opened.length === 1, "the new workspace's watch");
    child.opened[0]!.push(": open\n\nevent: activity\ndata: {\"working\":false,\"awaiting\":false}\n\n");
    await Bun.sleep(30);
    expect(latestFor(alice, "a")).toEqual({ running: true, working: false, awaiting: false, finished: false });
  });

  test("restored marks for a workspace the registry no longer names are dropped at load, before any page asks", () => {
    const child = fakeSource({ running: new Set(), workspaces: ["kept"] });
    const marks = recordingMarks({
      finishedAt: [["kept", 4], ["gone", 6]],
      viewedAt: [["alice", [["kept", 2], ["gone", 7]]], ["bob", [["gone", 8]]]],
    });
    const live = broker(child.source, { marks: marks.sink });
    expect(marks.writes).toHaveLength(1);
    expect([...marks.last()!.finishedAt]).toEqual([["kept", 4]]);
    expect([...marks.last()!.viewedAt.keys()]).toEqual(["alice"]);
    expect([...marks.last()!.viewedAt.get("alice")!]).toEqual([["kept", 2]]);
    // The counter still resumes above every stamp read back.
    live.acknowledgeViewed("alice", "kept");
    expect(marks.last()!.viewedAt.get("alice")!.get("kept")).toBe(9);
  });

  test("an acknowledgement with nothing to clear stamps and persists nothing; one that clears a finish does", async () => {
    const child = fakeSource({ running: new Set(["a"]), workspaces: ["a"] });
    const marks = recordingMarks();
    const live = broker(child.source, { marks: marks.sink });
    const alice = sink();
    live.subscribeActivity(alice, "alice");
    await waitFor(() => child.opened.length === 1, "the watch");
    child.opened[0]!.push(": open\n\n");
    push(child, true, false);
    await waitFor(() => latestFor(alice, "a").working, "working");
    // Nothing has finished: a page (or any client) posting now changes
    // nothing and costs no write.
    const before = marks.writes.length;
    const emitted = alice.envelopes.length;
    live.acknowledgeViewed("alice", "a");
    live.acknowledgeViewed("alice", "unknown-workspace");
    expect(marks.writes).toHaveLength(before);
    expect(alice.envelopes).toHaveLength(emitted);
    push(child, false, false);
    await waitFor(() => latestFor(alice, "a").finished, "finished");
    // Clearing a finish is stamped and persisted.
    const finishedWrites = marks.writes.length;
    live.acknowledgeViewed("alice", "a");
    expect(marks.writes).toHaveLength(finishedWrites + 1);
    expect(latestFor(alice, "a").finished).toBe(false);
    const viewed = marks.last()!.viewedAt.get("alice")!.get("a")!;
    // The same finish acknowledged again — another page of hers, say — is
    // already seen: no new stamp, no write.
    live.acknowledgeViewed("alice", "a");
    expect(marks.writes).toHaveLength(finishedWrites + 1);
    // Bob has not seen it, so his acknowledgement still counts.
    live.acknowledgeViewed("bob", "a");
    expect(marks.writes).toHaveLength(finishedWrites + 2);
    // A later finish outranks alice's view and is hers to clear again.
    push(child, true, false);
    await waitFor(() => latestFor(alice, "a").working, "working again");
    push(child, false, false);
    await waitFor(() => latestFor(alice, "a").finished, "finished again");
    live.acknowledgeViewed("alice", "a");
    expect(marks.last()!.viewedAt.get("alice")!.get("a")!).toBeGreaterThan(viewed);
    expect(latestFor(alice, "a").finished).toBe(false);
  });

  test("every activity payload carries exactly the four facts", async () => {
    const { child, alice } = await workingWorkspace();
    push(child, false, false);
    await waitFor(() => latestFor(alice, "a").finished, "finished");
    for (const envelope of alice.envelopes) {
      expect(Object.keys(facts(envelope)).sort()).toEqual(["awaiting", "finished", "running", "working"]);
    }
  });
});

describe("watching activity from the start (fix-workspace-activity-states D11)", () => {
  const facts = (envelope: LiveEnvelope) => (envelope.event as { data: { running: boolean; working: boolean; awaiting: boolean; finished: boolean } }).data;
  const latestFor = (s: ReturnType<typeof sink>, ws: string) => facts(s.envelopes.filter(e => e.ws === ws).at(-1)!);
  const activityFrame = (working: boolean) => `event: activity\ndata: {"working":${working},"awaiting":false}\n\n`;

  test("a session driven without any page records its finish, which the first later feed sees", async () => {
    const child = fakeSource({ running: new Set(["a"]), workspaces: ["a"] });
    const live = broker(child.source, { watchActivityFromStart: true });
    // No feed has ever been asked for: the broker opened the watch itself.
    await waitFor(() => child.opened.length === 1, "the watch opened at construction");
    expect(child.opened[0]!.path).toContain("/api/activity");
    // An API client drives a turn through the proxy; it runs and finishes.
    child.opened[0]!.push(": open\n\n" + activityFrame(true));
    await Bun.sleep(20);
    child.opened[0]!.push(activityFrame(false));
    await Bun.sleep(20);
    const later = sink();
    live.subscribeActivity(later, "alice");
    expect(latestFor(later, "a")).toEqual({ running: true, working: false, awaiting: false, finished: true });
    expect(child.opened).toHaveLength(1);
  });

  test("a session started later with no page open is watched from its start", async () => {
    const child = fakeSource({ running: new Set(), workspaces: ["a"] });
    const live = broker(child.source, { watchActivityFromStart: true });
    await Bun.sleep(20);
    expect(child.opened).toHaveLength(0);
    child.setRunning("a", true);
    await waitFor(() => child.opened.length === 1, "the watch opened by the start");
    child.opened[0]!.push(": open\n\n" + activityFrame(true));
    await Bun.sleep(20);
    child.opened[0]!.push(activityFrame(false));
    await Bun.sleep(20);
    const later = sink();
    live.subscribeActivity(later, "alice");
    expect(latestFor(later, "a").finished).toBe(true);
  });

  test("the marks are restored before the watches opened at construction can compose against them", async () => {
    const child = fakeSource({ running: new Set(["a"]), workspaces: ["a"] });
    // What the previous hub left: an unviewed finish in "a" and nothing
    // else. The watch's first frame has no predecessor, so it must neither
    // invent a finish nor lose the restored one.
    const restored = { finishedAt: new Map([["a", 5]]), viewedAt: new Map<string, Map<string, number>>() };
    const live = broker(child.source, { watchActivityFromStart: true, marks: { read: () => restored, write: () => undefined } });
    await waitFor(() => child.opened.length === 1, "the watch opened at construction");
    child.opened[0]!.push(": open\n\n" + activityFrame(false));
    await Bun.sleep(20);
    const later = sink();
    live.subscribeActivity(later, "alice");
    expect(latestFor(later, "a")).toEqual({ running: true, working: false, awaiting: false, finished: true });
  });

  test("by default the broker stays lazy: nothing is watched until the first activity feed", async () => {
    const child = fakeSource({ running: new Set(["a"]), workspaces: ["a"] });
    const live = broker(child.source);
    await Bun.sleep(30);
    expect(child.opened).toHaveLength(0);
    live.subscribeActivity(sink(), "alice");
    await waitFor(() => child.opened.length === 1, "the watch opened by the first feed");
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

describe("worktrees topic (worktree 5.2)", () => {
  test("attaching sends one fresh invalidation and ready, opens no child upstream, and needs no running child", () => {
    const fake = fakeSource({ running: new Set() });
    const live = broker(fake.source);
    const client = sink();
    live.subscribe(client, "ws", { topic: "worktrees" });
    expect(client.envelopes).toEqual([
      { ws: "ws", topic: "worktrees", cursor: "", event: { kind: "data", data: { type: "worktree.inventory" } } },
      { ws: "ws", topic: "worktrees", cursor: "", event: { kind: "ready" } },
    ]);
    expect(fake.opened).toHaveLength(0);
  });

  test("a reconnect presenting any cursor still receives a fresh invalidation", () => {
    const live = broker(fakeSource().source);
    const first = sink();
    live.subscribe(first, "ws", { topic: "worktrees" }).detach();
    const second = sink();
    live.subscribe(second, "ws", { topic: "worktrees", cursor: "stale" });
    expect(kinds(second.envelopes)).toEqual(["data", "ready"]);
  });

  test("publish invalidates only subscribers of the named workspaces, immediately, with a content-free payload", () => {
    const live = broker(fakeSource({ running: new Set(["a", "b"]) }).source);
    const a = sink();
    const b = sink();
    const c = sink();
    live.subscribe(a, "a", { topic: "worktrees" });
    live.subscribe(b, "b", { topic: "worktrees" });
    live.subscribe(c, "c", { topic: "worktrees" });
    for (const client of [a, b, c]) client.envelopes.length = 0;
    live.publishWorktrees(["a", "b", "a"]);
    expect(a.envelopes).toEqual([{ ws: "a", topic: "worktrees", cursor: "", event: { kind: "data", data: { type: "worktree.inventory" } } }]);
    expect(b.envelopes).toHaveLength(1);
    expect(c.envelopes).toHaveLength(0);
    expect(JSON.stringify(a.envelopes)).not.toMatch(/path|branch|checkout/);
  });

  test("a session stop leaves the topic live; a detached subscriber receives nothing", () => {
    const fake = fakeSource({ running: new Set(["ws"]) });
    const live = broker(fake.source);
    const client = sink();
    const attachment = live.subscribe(client, "ws", { topic: "worktrees" });
    client.envelopes.length = 0;
    fake.setRunning("ws", false);
    live.publishWorktrees(["ws"]);
    expect(kinds(client.envelopes)).toEqual(["data"]);
    attachment.detach();
    live.publishWorktrees(["ws"]);
    expect(client.envelopes).toHaveLength(1);
  });

  test("the activity payload is unchanged by the new topic", async () => {
    const fake = fakeSource({ running: new Set(["ws"]) });
    const live = broker(fake.source);
    const client = sink();
    live.subscribeActivity(client, "user");
    live.subscribe(sink(), "ws", { topic: "worktrees" });
    live.publishWorktrees(["ws"]);
    expect(client.envelopes.every(envelope => envelope.topic === "activity")).toBe(true);
    for (const envelope of client.envelopes) {
      if (envelope.event.kind === "data") expect(Object.keys(envelope.event.data as object).sort()).toEqual(["awaiting", "finished", "running", "working"]);
    }
  });

  test("the observer hears attach, interest while held, and observed activity", async () => {
    const fake = fakeSource({ running: new Set(["ws"]) });
    const live = broker(fake.source, { lingerMs: 20 });
    const events: string[] = [];
    live.observeWorktrees({
      attached: ws => events.push(`attached:${ws}`),
      interest: (ws, interested) => events.push(`interest:${ws}:${interested}`),
      activity: (ws, activity) => events.push(`activity:${ws}:${activity.working}`),
    });
    const first = live.subscribe(sink(), "ws", { topic: "worktrees" });
    const second = live.subscribe(sink(), "ws", { topic: "worktrees" });
    expect(events).toEqual(["interest:ws:true", "attached:ws", "attached:ws"]);
    first.detach();
    second.detach();
    await waitFor(() => events.includes("interest:ws:false"), "interest released after linger");
    live.subscribeActivity(sink(), "user");
    await waitFor(() => fake.byPath("/api/activity").length === 1, "activity upstream");
    fake.byPath("/api/activity")[0]!.push(`event: activity\ndata: {"working":true,"awaiting":false}\n\n`);
    await waitFor(() => events.includes("activity:ws:true"), "activity observed");
  });
});

describe("presence", () => {
  function clocked(options: ConstructorParameters<typeof LiveBroker>[1] = {}) {
    const clock = { now: 1_000_000 };
    const child = fakeSource({ workspaces: [] });
    const live = broker(child.source, { presenceGraceMs: 30_000, now: () => clock.now, ...options });
    return { clock, live };
  }

  test("a never-seen user is recent for one grace period after the broker starts, then away", () => {
    const { clock, live } = clocked();
    expect(live.presence("u")).toBe("recent");
    clock.now += 29_999;
    expect(live.presence("u")).toBe("recent");
    clock.now += 1;
    expect(live.presence("u")).toBe("away");
  });

  test("one visible page makes the user present; its departure is recent, then away after the grace", () => {
    const { clock, live } = clocked();
    clock.now += 60_000;
    const page = live.subscribeActivity(sink(), "u");
    expect(live.presence("u")).toBe("present");
    page.detach();
    expect(live.presence("u")).toBe("recent");
    clock.now += 29_999;
    expect(live.presence("u")).toBe("recent");
    clock.now += 1;
    expect(live.presence("u")).toBe("away");
  });

  test("a second page keeps the user present until both go", () => {
    const { clock, live } = clocked();
    clock.now += 60_000;
    const desktop = live.subscribeActivity(sink(), "u");
    const phone = live.subscribeActivity(sink(), "u");
    desktop.detach();
    expect(live.presence("u")).toBe("present");
    phone.detach();
    expect(live.presence("u")).toBe("recent");
    // A repeated detach is not a second departure.
    clock.now += 20_000;
    phone.detach();
    clock.now += 10_000;
    expect(live.presence("u")).toBe("away");
  });

  test("one user's presence does not affect another's", () => {
    const { clock, live } = clocked();
    clock.now += 60_000;
    live.subscribeActivity(sink(), "a");
    expect(live.presence("a")).toBe("present");
    expect(live.presence("b")).toBe("away");
  });

  test("listeners hear arrival, departure, and the end of the grace period", async () => {
    const live = broker(fakeSource({ workspaces: [] }).source, { presenceGraceMs: 40 });
    const heard: Array<[string, string]> = [];
    live.onPresenceChange(user => heard.push([user, live.presence(user)]));
    await Bun.sleep(45);
    const page = live.subscribeActivity(sink(), "u");
    page.detach();
    await waitFor(() => heard.length === 3, "grace end announced");
    expect(heard).toEqual([["u", "present"], ["u", "recent"], ["u", "away"]]);
  });

  test("returning inside the grace cancels the pending away announcement", async () => {
    const live = broker(fakeSource({ workspaces: [] }).source, { presenceGraceMs: 40 });
    const heard: string[] = [];
    live.onPresenceChange(user => heard.push(live.presence(user)));
    live.subscribeActivity(sink(), "u").detach();
    live.subscribeActivity(sink(), "u");
    await Bun.sleep(80);
    expect(heard).toEqual(["present", "recent", "present"]);
  });
});
