import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { encodeReplayCursor } from "../chat/replay";
import { MetricsRegistry } from "../debug/metrics";
import { upstreamActiveGauge, upstreamCounter } from "../debug/stream-metrics";
import { CHILD_CONVERSATION_REPLAY_RESYNC_HEADER, documentContextKey, type LiveEnvelope } from "../shared/live-protocol";
import type { DocumentSnapshot, DocumentPatch } from "../shared/document-updates";
import { BUILD_SUMMARY, createWatchSession } from "../server/watch-session";
import {
  createRepeatFoldingDiagnosticSink,
  LiveBroker,
  setLiveUpstreamDiagnostics,
  type LiveSessionChange,
  type LiveUpstreamDiagnostic,
  type LiveUpstreamSource,
} from "./live-broker";

test("personal subscriptions are refused before shared broker cache/fanout or diagnostics", () => {
  let opened = 0;
  const broker = new LiveBroker({ isRunning: () => true, workspaceIds: () => [], async open() { opened++; throw new Error("must not open"); } });
  try {
    expect(() => broker.subscribe({ write() { throw new Error("must not fan out"); } }, "ws", { topic: "personal" })).toThrow("personal topics belong to the authenticated endpoint");
    expect(opened).toBe(0);
    expect(broker.upstreamCount()).toBe(0);
  } finally { broker.dispose(); }
});

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

function fakeSource(options: { running?: Set<string>; workspaces?: string[]; refuse?: (path: string) => Response | Error | null; headers?: (path: string) => Record<string, string> } = {}) {
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
      return new Response(body, { headers: { "content-type": "text/event-stream", ...options.headers?.(path) } });
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

function trailerClock() {
  let nextId = 0;
  const timers = new Map<number, { run(): void; ms: number }>();
  return {
    timers,
    clock: {
      setTimer(run: () => void, ms: number) { const id = ++nextId; timers.set(id, { run, ms }); return id; },
      clearTimer(timer: unknown) { timers.delete(timer as number); },
    },
    fire() { const pending = [...timers.values()]; timers.clear(); for (const timer of pending) timer.run(); },
  };
}

const replayFrame = <T extends { generation: string; sequence: number }>(data: T, event = "chat") =>
  `id: ${cursorOf(data.generation, data.sequence)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

async function visualCatchUp(hintedCursor: string | null = cursorOf("g1", 5), reconnect = false) {
  const before = cursorOf("g1", 2), boundary = cursorOf("g1", 5);
  const replayPath = `?cursor=${encodeURIComponent(before)}`;
  const child = fakeSource({ headers: (pathname): Record<string, string> => pathname.includes(replayPath) && hintedCursor !== null
    ? { [CHILD_CONVERSATION_REPLAY_RESYNC_HEADER]: hintedCursor } : {} });
  const clock = trailerClock();
  const live = broker(child.source, { catchUpTrailerClock: clock.clock });
  const opener = sink();
  live.subscribe(opener, "ws", { topic: "conversation", key: "c" });
  await waitFor(() => child.opened.length === 1, "shared conversation upstream");
  const shared = child.opened[0]!;
  shared.push(`event: open\ndata: ${JSON.stringify({ cursor: boundary })}\n\n`);
  await waitFor(() => kinds(opener.envelopes).includes("ready"), "shared origin ready");
  const behind = sink();
  const attachment = live.subscribe(behind, "ws", { topic: "conversation", key: "c", cursor: before }, { reconnect });
  await waitFor(() => child.byPath(replayPath).length === 1, "private visual replay");
  const replay = child.byPath(replayPath)[0]!;
  const status = { type: "conversation.status", status: "failed", message: "Provider failed after generating the image", generation: "g1", sequence: 5, conversationId: "c" };
  const resync = { type: "resync", reason: "conversation-rewritten", generation: "g1", sequence: 5, conversationId: "c" };
  return { child, clock, live, opener, shared, behind, replay, attachment, before, boundary, status, resync };
}

// Failures are part of what these tests stage; the default sink's log line
// is not.
beforeEach(() => setLiveUpstreamDiagnostics(() => undefined));

afterEach(() => {
  for (const created of brokers.splice(0)) created.dispose();
  setLiveUpstreamDiagnostics(null);
});

describe("refcounted upstreams (2.1)", () => {
  test("document visibility is part of upstream identity and survives child requests", async () => {
    const child = fakeSource();
    const live = broker(child.source);
    const showing = documentContextKey(new URLSearchParams("compareTarget=base&scope=folder&showIgnored=1"));
    const hiding = documentContextKey(new URLSearchParams("compareTarget=base&scope=folder&showIgnored=0"));
    const a = live.subscribe(sink(), "ws", { topic: "document", key: showing });
    const b = live.subscribe(sink(), "ws", { topic: "document", key: hiding });
    const c = live.subscribe(sink(), "ws", { topic: "document", key: showing });
    await waitFor(() => child.opened.length === 2, "one upstream per visibility context");
    expect(child.opened.map(entry => new URL(entry.path, "http://child").searchParams.get("showIgnored")).sort()).toEqual(["0", "1"]);
    a.detach(); b.detach(); c.detach();
  });
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
  test("a browser recovery that creates a replacement shared stream flags only that child open", async () => {
    const child = fakeSource();
    const live = broker(child.source);
    const s = sink();
    const cursor = cursorOf("g1", 5);
    const resync = { type: "resync", reason: "conversation-rewritten", generation: "g1", sequence: 5, conversationId: "c" };
    live.subscribe(s, "ws", { topic: "conversation", key: "c", cursor }, { reconnect: true });
    await waitFor(() => child.opened.length === 1, "browser recovery's replacement child stream");
    const recovery = new URL(child.opened[0]!.path, "http://child");
    expect(recovery.searchParams.get("cursor")).toBe(cursor);
    expect(recovery.searchParams.get("reconnect")).toBe("1");
    child.opened[0]!.push(`event: open\ndata: ${JSON.stringify({ cursor })}\n\n${replayFrame(resync, "resync")}`);
    await waitFor(() => s.envelopes.some(envelope => envelope.event.kind === "resync"), "native same-cursor visual repair");
    expect(s.envelopes.at(-1)).toMatchObject({ cursor, event: { kind: "resync", data: resync } });
    expect(live.upstreamCount()).toBe(0);
    live.subscribe(s, "ws", { topic: "conversation", key: "c", cursor });
    await waitFor(() => child.opened.length === 2, "post-history fresh attachment");
    expect(new URL(child.opened[1]!.path, "http://child").searchParams.has("reconnect")).toBe(false);
    child.opened[1]!.push(`event: open\ndata: ${JSON.stringify({ cursor })}\n\n`);
    await waitFor(() => s.envelopes.at(-1)?.event.kind === "ready", "fresh attachment ready");
    expect(s.envelopes.filter(envelope => envelope.event.kind === "resync")).toHaveLength(1);
    live.dispose();
    expect(child.opened.every(upstream => upstream.cancelled)).toBe(true);
  });

  test("a recovering joiner cannot mutate a fresh shared child request that is already opening", async () => {
    const child = fakeSource();
    const live = broker(child.source);
    const cursor = cursorOf("g1", 5);
    const fresh = sink();
    live.subscribe(fresh, "ws", { topic: "conversation", key: "c", cursor });
    await waitFor(() => child.opened.length === 1, "fresh child opening");
    const recovering = sink();
    live.subscribe(recovering, "ws", { topic: "conversation", key: "c", cursor }, { reconnect: true });
    expect(recovering.envelopes).toEqual([]);
    expect(new URL(child.opened[0]!.path, "http://child").searchParams.has("reconnect")).toBe(false);
    child.opened[0]!.push(`event: open\ndata: ${JSON.stringify({ cursor })}\n\n`);
    await waitFor(() => fresh.envelopes.length === 1 && recovering.envelopes.length === 1, "independent attach outcomes");
    expect(kinds(fresh.envelopes)).toEqual(["ready"]);
    expect(kinds(recovering.envelopes)).toEqual(["ready"]);
    expect(child.opened).toHaveLength(1);
    expect(child.opened[0]!.cancelled).toBe(false);
  });

  test.each([5, 7])("a recovering browser at cursor %i needs no snapshot on a healthy stream with no remembered trailer", async sequence => {
    const child = fakeSource();
    const clock = trailerClock();
    const live = broker(child.source, { catchUpTrailerClock: clock.clock });
    const keeper = sink();
    const head = cursorOf("g1", 5);
    live.subscribe(keeper, "ws", { topic: "conversation", key: "c", cursor: head });
    await waitFor(() => child.opened.length === 1, "healthy shared child");
    child.opened[0]!.push(`event: open\ndata: ${JSON.stringify({ cursor: head })}\n\n`);
    await waitFor(() => kinds(keeper.envelopes).includes("ready"), "keeper ready");
    for (let round = 0; round < 2; round++) {
      const recovering = sink();
      const cancelled = live.subscribe(recovering, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", sequence) }, { reconnect: true });
      expect(kinds(recovering.envelopes)).toEqual(["ready"]);
      expect(recovering.envelopes[0]).toMatchObject({ ws: "ws", key: "c", event: { kind: "ready" } });
      expect(kinds(keeper.envelopes)).toEqual(["ready"]);
      expect(child.opened).toHaveLength(1);
      expect(clock.timers.size).toBe(0); // No additional replay lease.
      const fresh = live.subscribe(recovering, "ws", { topic: "conversation", key: "c", cursor: head });
      expect(kinds(recovering.envelopes)).toEqual(["ready", "ready"]);
      cancelled.detach(); fresh.detach();
    }
    // Recovery intent must not contaminate another freshly opened topic.
    live.subscribe(sink(), "ws", { topic: "conversation", key: "other", cursor: head });
    await waitFor(() => child.opened.length === 2, "unrelated fresh topic");
    expect(new URL(child.opened[1]!.path, "http://child").searchParams.has("reconnect")).toBe(false);
    child.running.add("other-workspace");
    live.subscribe(sink(), "other-workspace", { topic: "conversation", key: "c", cursor: head });
    await waitFor(() => child.opened.length === 3, "unrelated fresh workspace");
    expect(child.opened[2]!.workspaceId).toBe("other-workspace");
    expect(new URL(child.opened[2]!.path, "http://child").searchParams.has("reconnect")).toBe(false);
    live.dispose();
    expect(child.opened.every(upstream => upstream.cancelled)).toBe(true);
    expect(clock.timers.size).toBe(0);
  });

  test.each(["same chunk", "separate chunks"] as const)("a forwarded same-cursor trailer survives upstream drop/reopen and repairs only its full conversation key (%s)", async chunks => {
    const child = fakeSource({ running: new Set(["ws", "other-workspace"]) });
    const live = broker(child.source);
    const key = "opencode:c", head = cursorOf("g1", 5);
    const first = sink();
    live.subscribe(first, "ws", { topic: "conversation", key, cursor: cursorOf("g1", 4) });
    await waitFor(() => child.opened.length === 1, "initial upstream");
    const status = { type: "conversation.status", status: "completed", generation: "g1", sequence: 5, conversationId: key };
    const resync = { type: "resync", reason: "conversation-rewritten", generation: "g1", sequence: 5, conversationId: key };
    child.opened[0]!.push(`event: open\ndata: ${JSON.stringify({ cursor: cursorOf("g1", 4) })}\n\n`);
    await waitFor(() => kinds(first.envelopes).includes("ready"), "initial ready");
    if (chunks === "same chunk") child.opened[0]!.push(replayFrame(status) + replayFrame(resync, "resync"));
    else {
      child.opened[0]!.push(replayFrame(status));
      await waitFor(() => kinds(first.envelopes).includes("data"), "status acknowledged without trailer");
      child.opened[0]!.push(replayFrame(resync, "resync"));
    }
    await waitFor(() => live.upstreamCount() === 0, "trailer drops upstream");
    expect(kinds(first.envelopes)).toEqual(["ready", "data", "resync"]);
    const keeper = sink();
    live.subscribe(keeper, "ws", { topic: "conversation", key, cursor: head });
    await waitFor(() => child.opened.length === 2, "fresh post-history upstream");
    child.opened[1]!.push(`event: open\ndata: ${JSON.stringify({ cursor: head })}\n\n`);
    await waitFor(() => kinds(keeper.envelopes).includes("ready"), "fresh attachment never loops");
    for (let round = 0; round < 2; round++) {
      const recovering = sink();
      live.subscribe(recovering, "ws", { topic: "conversation", key, cursor: head }, { reconnect: true });
      expect(kinds(recovering.envelopes)).toEqual(["resync"]);
      expect(child.opened).toHaveLength(2);
      expect(kinds(keeper.envelopes)).toEqual(["ready"]);
    }
    for (const [workspace, otherKey] of [["ws", "claude:c"], ["other-workspace", key]] as const) {
      const unrelated = sink();
      live.subscribe(unrelated, workspace, { topic: "conversation", key: otherKey, cursor: head });
      await waitFor(() => child.opened.length === (workspace === "ws" ? 3 : 4), "unrelated scope opens");
      child.opened.at(-1)!.push(`event: open\ndata: ${JSON.stringify({ cursor: head })}\n\n`);
      await waitFor(() => kinds(unrelated.envelopes).includes("ready"), "unrelated scope ready");
      const resumed = sink();
      live.subscribe(resumed, workspace, { topic: "conversation", key: otherKey, cursor: head }, { reconnect: true });
      expect(kinds(resumed.envelopes)).toEqual(["ready"]);
    }
    // An earlier trailer does not poison later ordinary at-head resumes.
    child.opened[1]!.push(replayFrame({ ...status, sequence: 6 }));
    await waitFor(() => keeper.envelopes.some(envelope => envelope.cursor === cursorOf("g1", 6)), "new ordinary head");
    const later = sink();
    live.subscribe(later, "ws", { topic: "conversation", key, cursor: cursorOf("g1", 6) }, { reconnect: true });
    expect(kinds(later.envelopes)).toEqual(["ready"]);
    child.opened[1]!.push(replayFrame({ ...resync, sequence: 6 }, "resync"));
    await waitFor(() => kinds(keeper.envelopes).includes("resync"), "latest trailer supersedes previous cursor");
    const fresh = sink();
    live.subscribe(fresh, "ws", { topic: "conversation", key, cursor: cursorOf("g1", 6) });
    await waitFor(() => child.opened.length === 5, "newest fresh upstream");
    child.opened[4]!.push(`event: open\ndata: ${JSON.stringify({ cursor: cursorOf("g1", 6) })}\n\n`);
    await waitFor(() => kinds(fresh.envelopes).includes("ready"), "newest fresh ready");
    const newest = sink();
    live.subscribe(newest, "ws", { topic: "conversation", key, cursor: cursorOf("g1", 6) }, { reconnect: true });
    expect(kinds(newest.envelopes)).toEqual(["resync"]);
    const retained = (live as unknown as { conversationTrailers: Map<string, Map<string, string>> }).conversationTrailers;
    expect([...retained.get("ws")!.values()]).toEqual([cursorOf("g1", 6)]); // One latest cursor, not duplicate event history.
  });

  test.each(["linger", "stop", "forget", "dispose"] as const)("private hinted trailers survive upstream linger, but retire with their %s owner", async lifecycle => {
    const workspaces = ["ws"], head = cursorOf("g1", 5);
    const child = fakeSource({ workspaces, headers: () => ({ [CHILD_CONVERSATION_REPLAY_RESYNC_HEADER]: head }) });
    let live = broker(child.source, { lingerMs: 0 });
    const first = sink();
    live.subscribe(first, "ws", { topic: "conversation", key: "c", cursor: head }, { reconnect: true });
    await waitFor(() => child.opened.length === 1, "initial recovery child");
    child.opened[0]!.push(`event: open\ndata: ${JSON.stringify({ cursor: head })}\n\n${replayFrame({ type: "resync", reason: "conversation-rewritten", generation: "g1", sequence: 5, conversationId: "c" }, "resync")}`);
    await waitFor(() => live.upstreamCount() === 0, "hinted initial trailer consumed");
    const idle = sink();
    const attachment = live.subscribe(idle, "ws", { topic: "conversation", key: "c", cursor: head });
    await waitFor(() => child.opened.length === 2, "post-history child");
    child.opened[1]!.push(`event: open\ndata: ${JSON.stringify({ cursor: head })}\n\n`);
    await waitFor(() => kinds(idle.envelopes).includes("ready"), "post-history ready");
    attachment.detach();
    await waitFor(() => child.opened[1]!.cancelled, "linger releases child without forgetting trailer");
    if (lifecycle === "stop") { child.setRunning("ws", false); child.setRunning("ws", true); }
    else if (lifecycle === "forget") { child.unregister("ws"); workspaces.push("ws"); }
    else if (lifecycle === "dispose") { live.dispose(); live = broker(child.source); }
    const keeper = sink();
    live.subscribe(keeper, "ws", { topic: "conversation", key: "c", cursor: head });
    await waitFor(() => child.opened.length === 3, "replacement shared child");
    child.opened[2]!.push(`event: open\ndata: ${JSON.stringify({ cursor: head })}\n\n`);
    await waitFor(() => kinds(keeper.envelopes).includes("ready"), "replacement shared ready");
    const recovering = sink();
    live.subscribe(recovering, "ws", { topic: "conversation", key: "c", cursor: head }, { reconnect: true });
    expect(kinds(recovering.envelopes)).toEqual([lifecycle === "linger" ? "resync" : "ready"]);
    expect(child.opened).toHaveLength(3);
  });

  test.each(["retention-gap", "generation-changed", "invalid-cursor", "conversation-rewritten"] as const)("an unhinted opening %s resync is not evidence of a forwarded visual trailer", async reason => {
    const child = fakeSource(), live = broker(child.source), head = cursorOf("g1", 5);
    const first = sink();
    live.subscribe(first, "ws", { topic: "conversation", key: "c", cursor: head });
    await waitFor(() => child.opened.length === 1, "initial child");
    child.opened[0]!.push(`event: open\ndata: ${JSON.stringify({ cursor: head })}\n\n${replayFrame({ type: "resync", reason, generation: "g1", sequence: 5, conversationId: "c" }, "resync")}`);
    await waitFor(() => live.upstreamCount() === 0, "ordinary child invalidation");
    const keeper = sink();
    live.subscribe(keeper, "ws", { topic: "conversation", key: "c", cursor: head });
    await waitFor(() => child.opened.length === 2, "fresh child");
    child.opened[1]!.push(`event: open\ndata: ${JSON.stringify({ cursor: head })}\n\n`);
    await waitFor(() => kinds(keeper.envelopes).includes("ready"), "fresh child ready");
    const recovering = sink();
    live.subscribe(recovering, "ws", { topic: "conversation", key: "c", cursor: head }, { reconnect: true });
    expect(kinds(recovering.envelopes)).toEqual(["ready"]);
  });

  test("a browser recovering behind a shared origin retains native replay before its visual resync", async () => {
    const h = await visualCatchUp(cursorOf("g1", 5), true);
    expect(new URL(h.shared.path, "http://child").searchParams.has("reconnect")).toBe(false);
    expect(new URL(h.replay.path, "http://child").searchParams.get("reconnect")).toBe("1");
    const delta = { type: "item.text_delta", itemId: "answer", delta: "generated", conversationId: "c", generation: "g1", sequence: 3 };
    const continued = { ...delta, delta: " image", sequence: 4 };
    h.replay.push(replayFrame(delta) + replayFrame(continued) + replayFrame(h.status) + replayFrame(h.resync, "resync"));
    await waitFor(() => h.behind.envelopes.some(envelope => envelope.event.kind === "resync"), "replayed visual reconciliation");
    expect(h.behind.envelopes.map(envelope => envelope.event)).toEqual([
      { kind: "data", data: delta }, { kind: "data", data: continued }, { kind: "data", data: h.status }, { kind: "resync", data: h.resync },
    ]);
    expect(h.behind.envelopes.filter(envelope => envelope.event.kind === "data").map(envelope => envelope.cursor)).toEqual([3, 4, 5].map(sequence => cursorOf("g1", sequence)));
    expect(kinds(h.opener.envelopes)).toEqual(["ready"]);
    expect(h.child.opened).toHaveLength(2);
    expect(h.replay.cancelled).toBe(true);
    expect(h.clock.timers.size).toBe(0);
  });

  test.each(["same chunk", "separate chunks"] as const)("visual catch-up preserves status then its same-cursor resync across %s before fresh reattachment is ready", async chunks => {
    const h = await visualCatchUp();
    expect(h.clock.timers.size).toBe(0); // No deadline during fetch/early replay.
    h.replay.push(`event: open\ndata: ${JSON.stringify({ cursor: h.boundary })}\n\n`);
    const delta = { type: "item.text_delta", generation: "g1", sequence: 3, conversationId: "c", itemId: "answer", delta: " generated" };
    h.replay.push(replayFrame(delta));
    await waitFor(() => h.behind.envelopes.length === 1, "early native delta");
    expect(h.clock.timers.size).toBe(0);
    expect(h.behind.envelopes[0]!.event).toEqual({ kind: "data", data: delta });
    const secondDelta = { ...delta, sequence: 4, delta: " image" };
    h.replay.push(replayFrame(secondDelta));
    await waitFor(() => h.behind.envelopes.length === 2, "contiguous native replay");
    const ordinary = sink();
    h.live.subscribe(ordinary, "ws", { topic: "conversation", key: "c", cursor: h.boundary });
    expect(kinds(ordinary.envelopes)).toEqual(["ready"]);
    if (chunks === "same chunk") h.replay.push(replayFrame(h.status) + replayFrame(h.resync, "resync"));
    else {
      h.replay.push(replayFrame(h.status));
      await waitFor(() => h.behind.envelopes.length === 3, "terminal status without its trailer");
      expect(kinds(h.behind.envelopes)).toEqual(["data", "data", "data"]);
      expect(h.replay.cancelled).toBe(false);
      expect([...h.clock.timers.values()].map(timer => timer.ms)).toEqual([10_000]);
      const another = sink();
      h.live.subscribe(another, "ws", { topic: "conversation", key: "c", cursor: h.before });
      expect(kinds(another.envelopes)).toEqual(["resync"]);
      expect(h.child.opened).toHaveLength(2); // Still one private replay.
      h.replay.push(replayFrame(h.resync, "resync"));
    }
    await waitFor(() => kinds(h.behind.envelopes).includes("resync"), "visual reconciliation before any ready");
    expect(kinds(h.behind.envelopes)).toEqual(["data", "data", "data", "resync"]);
    expect(h.behind.envelopes[2]).toMatchObject({ cursor: h.boundary, event: { kind: "data", data: h.status } });
    expect(h.behind.envelopes[3]).toMatchObject({ cursor: h.boundary, event: { kind: "resync", data: h.resync } });
    expect(h.clock.timers.size).toBe(0);
    expect(h.replay.cancelled).toBe(true);
    expect(h.shared.cancelled).toBe(false);
    h.clock.fire();
    expect(h.behind.envelopes).toHaveLength(4);
    // The client has now read the enriched snapshot at this cursor. Only its
    // explicit fresh attachment may report ready; it must not resync-loop.
    const resumed = h.live.subscribe(h.behind, "ws", { topic: "conversation", key: "c", cursor: h.boundary });
    expect(kinds(h.behind.envelopes)).toEqual(["data", "data", "data", "resync", "ready"]);
    const recovering = sink();
    h.live.subscribe(recovering, "ws", { topic: "conversation", key: "c", cursor: h.boundary }, { reconnect: true });
    expect(kinds(recovering.envelopes)).toEqual(["resync"]); // The privately forwarded trailer also survives on the shared owner.
    const next = { ...delta, sequence: 6, delta: " next turn" };
    h.shared.push(replayFrame(next));
    await waitFor(() => h.behind.envelopes.length === 6 && ordinary.envelopes.length === 2, "normal shared delivery after recovery");
    expect(h.behind.envelopes.filter(envelope => envelope.event.kind === "data").map(envelope => envelope.cursor)).toEqual([3, 4, 5, 6].map(sequence => cursorOf("g1", sequence)));
    expect(h.behind.envelopes.at(-1)!.event).toEqual({ kind: "data", data: next });
    expect(h.child.opened).toHaveLength(2);
    resumed.detach(); h.attachment.detach(); h.live.dispose();
    expect(h.clock.timers.size).toBe(0);
    expect(h.live.upstreamCount()).toBe(0);
  });

  test.each([null, "not-a-cursor", cursorOf("foreign", 5), cursorOf("g1", 1), cursorOf("g1", 4)])("nonvisual or inapplicable visual hint %s retains immediate normal merge without a timer", async hint => {
    const h = await visualCatchUp(hint);
    h.replay.push(replayFrame(h.status));
    await waitFor(() => kinds(h.behind.envelopes).includes("ready"), "ordinary merge");
    expect(kinds(h.behind.envelopes)).toEqual(["data", "ready"]);
    expect(h.clock.timers.size).toBe(0);
    expect(h.replay.cancelled).toBe(true);
  });

  test("the trailer-only deadline releases the replay before one failure resync, never ready", async () => {
    const h = await visualCatchUp();
    h.replay.push(replayFrame(h.status));
    await waitFor(() => h.clock.timers.size === 1, "trailer watchdog armed at the origin");
    const overdue = [...h.clock.timers.values()][0]!;
    expect(overdue.ms).toBe(10_000);
    const write = h.behind.write;
    // This subscriber's sink also proves cancellation precedes recovery.
    h.behind.write = envelope => { if (envelope.event.kind === "resync") expect(h.replay.cancelled).toBe(true); write(envelope); };
    h.clock.fire();
    expect(h.replay.cancelled).toBe(true);
    expect(kinds(h.behind.envelopes)).toEqual(["data", "resync"]);
    expect(h.behind.envelopes[1]!.event).toEqual({ kind: "resync" });
    overdue.run(); // A stale callback cannot cause a second recovery.
    h.replay.push(replayFrame(h.resync, "resync"));
    expect(h.behind.envelopes).toHaveLength(2);
    h.live.subscribe(h.behind, "ws", { topic: "conversation", key: "c", cursor: h.boundary });
    expect(kinds(h.behind.envelopes)).toEqual(["data", "resync", "ready"]);
    const recovering = sink();
    h.live.subscribe(recovering, "ws", { topic: "conversation", key: "c", cursor: h.boundary }, { reconnect: true });
    expect(kinds(recovering.envelopes)).toEqual(["ready"]); // The Hub's watchdog resync was not a child trailer.
    expect(h.child.opened).toHaveLength(2);
    expect(h.clock.timers.size).toBe(0);
  });

  test("a later hinted boundary cannot extend the lease once replay reaches the shared origin", async () => {
    const h = await visualCatchUp(cursorOf("g1", 7));
    h.replay.push(`event: open\ndata: ${JSON.stringify({ cursor: cursorOf("g1", 7) })}\n\n`);
    h.replay.push(replayFrame(h.status));
    await waitFor(() => h.clock.timers.size === 1, "origin reached before the later hinted boundary");
    expect(kinds(h.behind.envelopes)).toEqual(["data"]);
    const deadline = [...h.clock.timers.keys()][0]!;
    h.replay.push(replayFrame({ ...h.status, sequence: 6 }));
    await waitFor(() => h.behind.envelopes.length === 2, "one later native event");
    expect([...h.clock.timers.keys()]).toEqual([deadline]); // Never re-arm on progress.
    h.clock.fire();
    expect(kinds(h.behind.envelopes)).toEqual(["data", "data", "resync"]);
    expect(h.replay.cancelled).toBe(true);
  });

  test.each(["source end", "wrong cursor", "wrong generation", "wrong conversation", "missing trailer", "generation changed"] as const)("a hinted replay's %s releases its watchdog and uses existing recovery", async failure => {
    const h = await visualCatchUp();
    h.replay.push(replayFrame(h.status));
    await waitFor(() => h.clock.timers.size === 1, "awaiting hinted trailer");
    if (failure === "source end") h.replay.end();
    else if (failure === "wrong cursor") h.replay.push(replayFrame({ ...h.resync, sequence: 6 }, "resync"));
    else if (failure === "wrong generation") h.replay.push(replayFrame({ ...h.resync, generation: "foreign" }, "resync"));
    else if (failure === "wrong conversation") h.replay.push(replayFrame({ ...h.resync, conversationId: "another" }, "resync"));
    else if (failure === "missing trailer") h.replay.push(": keepalive\n\n");
    else h.shared.push(replayFrame({ ...h.status, generation: "new-generation", sequence: 1 }));
    await waitFor(() => kinds(h.behind.envelopes).includes("resync"), "bounded topic recovery");
    expect(kinds(h.behind.envelopes)).toEqual(["data", "resync"]);
    expect(h.behind.envelopes.at(-1)!.event).toEqual({ kind: "resync" });
    expect(h.clock.timers.size).toBe(0);
    expect(h.replay.cancelled).toBe(true);
    h.clock.fire();
    expect(h.behind.envelopes).toHaveLength(2);
  });

  test.each(["detach", "dispose"] as const)("%s cancels a hinted trailer wait without late recovery or leaked timers", async action => {
    const h = await visualCatchUp();
    h.replay.push(replayFrame(h.status));
    await waitFor(() => h.clock.timers.size === 1, "waiting on the trailer");
    const stale = [...h.clock.timers.values()][0]!;
    if (action === "detach") h.attachment.detach(); else h.live.dispose();
    expect(h.clock.timers.size).toBe(0);
    expect(h.replay.cancelled).toBe(true);
    stale.run(); h.clock.fire();
    expect(kinds(h.behind.envelopes)).toEqual(["data"]);
    if (action === "dispose") expect(h.live.upstreamCount()).toBe(0);
  });
  for (const catchUp of [false, true]) {
    test(`disposing during a ${catchUp ? "private catch-up" : "shared live"} burst stops the remainder after its yield`, async () => {
      const child = fakeSource();
      const stopped = Promise.withResolvers<void>();
      const observed: unknown[] = [];
      let armed = false;
      let scheduled = false;
      let stoppedAt = 0;
      const live = broker(child.source, { observeConversation(_workspace, _conversation, data) {
        observed.push(data);
        if (!armed || scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
          stoppedAt = observed.length;
          live.dispose();
          stopped.resolve();
        });
      } });
      const first = sink();
      live.subscribe(first, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", catchUp ? 299 : 0) });
      await waitFor(() => child.opened.length === 1, "shared upstream");
      child.opened[0]!.push(": open\n\n");
      if (catchUp) {
        child.opened[0]!.push(chatFrame("g1", 300));
        await waitFor(() => first.envelopes.some(e => e.cursor === cursorOf("g1", 300)), "shared head");
        live.subscribe(sink(), "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 0) });
        await waitFor(() => child.opened.length === 2, "private replay");
      }
      const baseline = observed.length;
      armed = true;
      // Enough small frames for several pacing batches, but bounded below
      // the endpoint stress fixture's size. Disposal runs at the first yield.
      child.opened[catchUp ? 1 : 0]!.push(Array.from({ length: 300 }, (_, index) =>
        chatFrame("g1", index + 1, `,"message":"${"x".repeat(1024)}"`)).join(""));
      await stopped.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(observed.length).toBe(stoppedAt);
      expect(observed.length - baseline).toBeGreaterThan(0);
      expect(observed.length - baseline).toBeLessThan(300);
      expect(live.upstreamCount()).toBe(0);
    });
  }

  test("trusted observation precedes live and catch-up delivery and never interrupts canonical chat", async () => {
    const observed: unknown[] = [];
    const child = fakeSource({ refuse: path => {
      if (!path.includes(`?cursor=${encodeURIComponent(cursorOf("g1", 1))}`)) return null;
      const frames = [2, 3, 4, 5, 6].map(sequence => chatFrame("g1", sequence)).join("");
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frames)); } }), { headers: { "content-type": "text/event-stream" } });
    } });
    const live = broker(child.source, { replayBufferBytes: 260, observeConversation(workspace, parent, data) {
      expect(workspace).toBe("ws"); expect(parent).toBe("c"); observed.push(data);
      throw new Error("synthetic personal persistence failure");
    } });
    const first = sink(); live.subscribe(first, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 3) });
    await waitFor(() => child.opened.length === 1, "live upstream");
    child.opened[0]!.push(": open\n\n");
    for (const sequence of [4, 5, 6]) child.opened[0]!.push(chatFrame("g1", sequence));
    await waitFor(() => first.envelopes.length === 4, "live delivery despite observation failure");
    const behind = sink();
    live.subscribe({ write(envelope) {
      if (envelope.event.kind === "data") expect(observed).toContainEqual(envelope.event.data);
      behind.write(envelope);
    } }, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 1) });
    await waitFor(() => behind.envelopes.some(envelope => envelope.event.kind === "ready"), "replay merge");
    expect(behind.envelopes.filter(envelope => envelope.event.kind === "data").map(envelope => envelope.cursor)).toEqual([2, 3, 4, 5, 6].map(sequence => cursorOf("g1", sequence)));
    expect(observed.some(value => (value as { sequence: number }).sequence === 2)).toBe(true);
    expect(child.opened).toHaveLength(1); // No observation-owned upstream.
  });
  test("document joiners receive a materialized snapshot after live patches", async () => {
    const child = fakeSource();
    const live = broker(child.source);
    const first = sink();
    live.subscribe(first, "ws", { topic: "document", key: "" });
    await waitFor(() => child.opened.length === 1, "document upstream");
    const initial: DocumentSnapshot = {
      ...createWatchSession([], true).getStatePayload(), roots: [], kind: "snapshot", epoch: "child", revision: 0, build: BUILD_SUMMARY,
      discovery: { status: "ready", discovered: 0 }, repositoryState: { status: "ready", generation: 1 },
    };
    child.opened[0]!.push(`event: state\ndata: ${JSON.stringify(initial)}\n\n`);
    await waitFor(() => first.envelopes.length === 2, "initial snapshot and ready");
    const patch: DocumentPatch = {
      kind: "patch", epoch: "child", previousRevision: 0, revision: 1, generatedAt: Date.now() + 1,
      scope: { kind: "folder" }, compareTarget: "base", unscopedFingerprint: "1", changedId: "/docs/a.md",
      roots: [{ id: "/docs", path: "/docs", label: "docs", hiddenCount: 0 }], removals: [],
      upserts: [{ id: "/docs/a.md", rootId: "/docs", name: "a.md", relativePath: "a.md", mtimeMs: 1, revision: 1, kind: "markdown" }],
    };
    child.opened[0]!.push(`event: state\ndata: ${JSON.stringify(patch)}\n\n`);
    await waitFor(() => first.envelopes.length === 3, "live patch");
    expect(first.envelopes[2]!.event).toEqual({ kind: "data", data: patch });
    const second = sink();
    live.subscribe(second, "ws", { topic: "document", key: "" });
    await waitFor(() => second.envelopes.length === 2, "joined snapshot");
    expect(second.envelopes[0]!.event).toMatchObject({ kind: "data", data: { kind: "snapshot", revision: 1, roots: [{ docs: patch.upserts }] } });
    expect(second.envelopes[0]!.cursor).toBe(first.envelopes[2]!.cursor);
    const atHead = sink();
    live.subscribe(atHead, "ws", { topic: "document", key: "", cursor: first.envelopes[2]!.cursor });
    expect(atHead.envelopes.map(event => event.event.kind)).toEqual(["ready"]);
    child.opened[0]!.push(`event: state\ndata: ${JSON.stringify({ ...patch, previousRevision: 8, revision: 9 })}\n\n`);
    await waitFor(() => child.opened[0]!.cancelled, "gap recovery");
    expect(first.envelopes.at(-1)?.event.kind).toBe("unavailable");
  });
  test("document joiners receive Git-ignored folder entries and listing patches in the materialized snapshot", async () => {
    const child = fakeSource();
    const live = broker(child.source);
    const first = sink();
    live.subscribe(first, "ws", { topic: "document", key: "" });
    await waitFor(() => child.opened.length === 1, "document upstream");
    const root = { id: "/docs", path: "/docs", label: "docs", hiddenCount: 0 };
    const initial: DocumentSnapshot = {
      ...createWatchSession([], true).getStatePayload(), kind: "snapshot", epoch: "child", revision: 0, build: BUILD_SUMMARY,
      roots: [{ ...root, docs: [], folders: [{ id: "/docs/build", rootId: "/docs", relativePath: "build/", listed: false, revision: 0 }] }],
      discovery: { status: "ready", discovered: 0 }, repositoryState: { status: "ready", generation: 1 },
    };
    child.opened[0]!.push(`event: state\ndata: ${JSON.stringify(initial)}\n\n`);
    await waitFor(() => first.envelopes.length === 2, "initial snapshot and ready");
    const listing: DocumentPatch = {
      kind: "patch", epoch: "child", previousRevision: 0, revision: 1, generatedAt: Date.now() + 1,
      scope: { kind: "folder" }, compareTarget: "base", unscopedFingerprint: "1", changedId: null, removals: [],
      upserts: [{ id: "/docs/build/CMakeCache.txt", rootId: "/docs", name: "CMakeCache.txt", relativePath: "build/CMakeCache.txt", mtimeMs: 1, revision: 1, kind: "text", gitIgnoreStatus: "ignored" }],
      folderUpserts: [
        { id: "/docs/build", rootId: "/docs", relativePath: "build/", listed: true, revision: 1 },
        { id: "/docs/build/renders", rootId: "/docs", relativePath: "build/renders/", listed: false, revision: 1 },
      ],
    };
    child.opened[0]!.push(`event: state\ndata: ${JSON.stringify(listing)}\n\n`);
    await waitFor(() => first.envelopes.length === 3, "listing patch");
    expect(first.envelopes[2]!.event).toEqual({ kind: "data", data: listing });
    const removal: DocumentPatch = { ...listing, previousRevision: 1, revision: 2, generatedAt: listing.generatedAt + 1, upserts: [], folderUpserts: undefined,
      folderRemovals: [{ rootId: "/docs", id: "/docs/build/renders" }] };
    delete removal.folderUpserts;
    child.opened[0]!.push(`event: state\ndata: ${JSON.stringify(removal)}\n\n`);
    await waitFor(() => first.envelopes.length === 4, "folder removal");
    const joiner = sink();
    live.subscribe(joiner, "ws", { topic: "document", key: "" });
    await waitFor(() => joiner.envelopes.length === 2, "joined snapshot");
    expect(joiner.envelopes[0]!.event).toMatchObject({ kind: "data", data: { kind: "snapshot", revision: 2, roots: [{
      docs: listing.upserts, folders: [{ id: "/docs/build", relativePath: "build/", listed: true, revision: 1 }],
    }] } });
  });
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

  test("bulk recovery terminates only its topic, ignores a stale tail, and hands a fresh cursor to ordered native replay", async () => {
    const child = fakeSource();
    const live = broker(child.source);
    const page = sink();
    const old = live.subscribe(page, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 0) });
    live.subscribe(page, "ws", { topic: "inventory" });
    await waitFor(() => child.opened.length === 2, "both topics");
    const conversation = child.byPath("/conversations/c/events")[0]!;
    const inventory = child.byPath("/conversations/events")[0]!;
    conversation.push(`event: open\ndata: {"cursor":"${cursorOf("g1", 0)}"}\n\n`);
    inventory.push(': open\n\nevent: inventory\ndata: {"type":"conversation.inventory"}\n\n');
    await waitFor(() => page.envelopes.some(e => e.topic === "conversation" && e.event.kind === "ready"), "conversation ready");
    // Even a tail in the very same read cannot turn terminal resync into data
    // or an EOF outage. The snapshot boundary stays in this generation.
    conversation.push(`id: ${cursorOf("g1", 1)}\nevent: resync\ndata: {"type":"resync","generation":"g1","sequence":1,"conversationId":"c","reason":"conversation-rewritten"}\n\n${chatFrame("g1", 2)}`);
    await waitFor(() => page.envelopes.some(e => e.event.kind === "resync"), "snapshot recovery");
    expect(conversation.cancelled).toBe(true);
    const retired = page.envelopes.filter(e => e.topic === "conversation");
    expect(kinds(retired)).toEqual(["ready", "resync"]);
    // A resync is not acknowledged as applied data: the envelope retains the
    // last delivered cursor. Only the authoritative snapshot supplies the new
    // attachment boundary, not this invalidation's cursor.
    expect(retired[1]!.cursor).toBe(cursorOf("g1", 0));
    expect(retired[1]!.event).toMatchObject({ kind: "resync", data: { reason: "conversation-rewritten", sequence: 1 } });
    expect(live.upstreamCount("conversation")).toBe(0);
    const ticks = page.envelopes.filter(e => e.topic === "inventory" && e.event.kind === "data").length;
    inventory.push('event: inventory\ndata: {"type":"conversation.inventory"}\n\n');
    await waitFor(() => page.envelopes.filter(e => e.topic === "inventory" && e.event.kind === "data").length > ticks, "unrelated inventory continues");

    live.subscribe(page, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 1) });
    await waitFor(() => child.byPath("/conversations/c/events").length === 2, "fresh attach");
    const fresh = child.byPath("/conversations/c/events")[1]!;
    expect(fresh.path).toContain(`cursor=${encodeURIComponent(cursorOf("g1", 1))}`);
    old.detach(); // Obsolete ownership cannot detach the replacement.
    fresh.push(`event: open\ndata: {"cursor":"${cursorOf("g1", 1)}"}\n\n${chatFrame("g1", 2)}${chatFrame("g1", 3)}`);
    await waitFor(() => page.envelopes.some(e => e.cursor === cursorOf("g1", 3)), "native tail");
    expect(page.envelopes.filter(e => e.topic === "conversation" && e.event.kind === "data").map(e => e.cursor)).toEqual([2, 3].map(n => cursorOf("g1", n)));
    expect(page.envelopes.some(e => e.event.kind === "unavailable")).toBe(false);
    expect(fresh.cancelled).toBe(false);
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

    const firstInventory = { type: "conversation.inventory", catalogs: { claude: "g1:1", opencode: "g2:1" } };
    const latestInventory = { type: "conversation.inventory", catalogs: { claude: "g1:2", opencode: "g2:1" } };
    child.byPath("/conversations/events")[0]!.push(`event: inventory\ndata: ${JSON.stringify(firstInventory)}\n\n`);
    child.byPath("/conversations/events")[0]!.push(`event: inventory\ndata: ${JSON.stringify(latestInventory)}\n\n`);
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
    expect(behind.envelopes[0]!.event).toEqual({ kind: "data", data: latestInventory });

    // A first attach presents no cursor: it is owed the opening tick the
    // child gave this upstream's first subscriber long ago.
    const joiner = sink();
    live.subscribe(joiner, "ws", { topic: "inventory" });
    await waitFor(() => joiner.envelopes.length === 2, "opening tick + ready");
    expect(kinds(joiner.envelopes)).toEqual(["data", "ready"]);
    expect(joiner.envelopes[0]!.cursor).toBe(inventoryHead);
    expect(joiner.envelopes[0]!.event).toEqual({ kind: "data", data: latestInventory });

    const unplaceable = sink();
    live.subscribe(unplaceable, "ws", { topic: "document", key: "", cursor: "from-another-hub-life.9" });
    live.subscribe(unplaceable, "ws", { topic: "inventory", cursor: "from-another-hub-life.9" });
    await waitFor(() => unplaceable.envelopes.length === 4, "snapshot, tick, ready ×2");
    expect(unplaceable.envelopes.find(e => e.topic === "document")!.event).toEqual({ kind: "data", data: { generatedAt: 1 } });
    expect(unplaceable.envelopes.find(e => e.topic === "inventory")!.event).toEqual({ kind: "data", data: latestInventory });
  });

  test.each([false, true])("inventory: a lingering upstream retains its opening tick payload (catalogs: %s)", async withCatalogs => {
    const child = fakeSource();
    const live = broker(child.source, { lingerMs: 500 });
    const before = sink();
    const first = live.subscribe(before, "ws", { topic: "inventory" });
    await waitFor(() => child.opened.length === 1, "one upstream");
    child.opened[0]!.push(": open\n\n");
    // The child's route opens every subscription with a reconcile tick.
    const inventory = { type: "conversation.inventory", ...(withCatalogs ? { catalogs: { claude: "g1:2", opencode: "g2:1" } } : {}) };
    child.opened[0]!.push(`event: inventory\ndata: ${JSON.stringify(inventory)}\n\n`);
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
      { kind: "data", data: inventory },
      { kind: "ready" },
    ]);
    expect(child.opened).toHaveLength(1);
  });

  test("inventory: a reopened upstream forgets the previous child's catalog revisions", async () => {
    const child = fakeSource();
    const live = broker(child.source);
    const first = sink();
    live.subscribe(first, "ws", { topic: "inventory" });
    await waitFor(() => child.opened.length === 1, "first upstream");
    child.opened[0]!.push('event: inventory\ndata: {"type":"conversation.inventory","catalogs":{"claude":"old:7"}}\n\n');
    await waitFor(() => first.envelopes.some(envelope => envelope.event.kind === "data"), "first inventory payload");
    const oldCursor = first.envelopes.find(envelope => envelope.event.kind === "data")!.cursor;
    child.opened[0]!.end();
    await waitFor(() => child.opened.length === 2, "reopened upstream");
    child.opened[1]!.push(": open\n\n");
    const reconnected = sink();
    live.subscribe(reconnected, "ws", { topic: "inventory", cursor: oldCursor });
    await waitFor(() => reconnected.envelopes.some(envelope => envelope.event.kind === "ready"), "reconnected ready");
    expect(reconnected.envelopes[0]!.event).toEqual({ kind: "data", data: { type: "conversation.inventory" } });
    child.opened[1]!.push('event: inventory\ndata: {"type":"conversation.inventory","catalogs":{"claude":"new:1"}}\n\n');
    await waitFor(() => reconnected.envelopes.filter(envelope => envelope.event.kind === "data").length === 2, "new catalog revisions");
    const joiner = sink();
    live.subscribe(joiner, "ws", { topic: "inventory" });
    expect(joiner.envelopes[0]!.event).toEqual({ kind: "data", data: { type: "conversation.inventory", catalogs: { claude: "new:1" } } });
    expect(child.opened).toHaveLength(2);
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

describe("failure log repeat folding", () => {
  function folding(windowMs = 60_000) {
    const lines: string[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const log = createRepeatFoldingDiagnosticSink({
      log: line => lines.push(line),
      windowMs,
      setTimer: (fn, ms) => {
        const timer = { fn, ms };
        timers.push(timer);
        return timer;
      },
      clearTimer: timer => {
        const index = timers.indexOf(timer as (typeof timers)[number]);
        if (index >= 0) timers.splice(index, 1);
      },
    });
    const fire = () => {
      for (const timer of timers.splice(0)) timer.fn();
    };
    return { lines, timers, log, fire };
  }

  test("a replaced sink is retired: its pending summary timers are cleared and it never logs again", () => {
    const retired = folding();
    setLiveUpstreamDiagnostics(retired.log);
    retired.log({ topic: "document", status: "unreachable" });
    retired.log({ topic: "document", status: "unreachable" });
    expect(retired.lines).toHaveLength(1);
    expect(retired.timers).toHaveLength(1);
    const current = folding();
    setLiveUpstreamDiagnostics(current.log);
    // The open window's timer was cleared, not left to fire later.
    expect(retired.timers).toHaveLength(0);
    // Advancing past the window changes nothing for either sink: the retired
    // sink's pending count was dropped, not handed to its replacement.
    retired.fire();
    current.fire();
    expect(retired.lines).toHaveLength(1);
    expect(current.lines).toEqual([]);
    // A retired sink stays silent even if something still holds it.
    retired.log({ topic: "document", status: "unreachable" });
    expect(retired.lines).toHaveLength(1);
  });

  test("the first failure of a topic and status logs at once, exactly as before", () => {
    const { lines, log } = folding();
    log({ topic: "document", status: "unreachable" });
    expect(lines).toEqual(["uatu hub: live upstream document subscription failed (unreachable)"]);
  });

  test("repeats within the window are counted and summarized in one line when it closes", () => {
    const { lines, timers, log, fire } = folding();
    log({ topic: "document", status: "unreachable" });
    log({ topic: "document", status: "unreachable" });
    log({ topic: "document", status: "unreachable" });
    log({ topic: "document", status: "unreachable" });
    expect(lines).toHaveLength(1);
    expect(timers.map(t => t.ms)).toEqual([60_000]);
    fire();
    expect(lines).toEqual([
      "uatu hub: live upstream document subscription failed (unreachable)",
      "uatu hub: live upstream document subscription failed (unreachable) 3 more times in the last 60s",
    ]);
  });

  test("a window without repeats closes silently, and the next failure logs at once again", () => {
    const { lines, log, fire } = folding();
    log({ topic: "inventory", status: "unreachable" });
    fire();
    expect(lines).toHaveLength(1);
    log({ topic: "inventory", status: "unreachable" });
    expect(lines).toEqual([
      "uatu hub: live upstream inventory subscription failed (unreachable)",
      "uatu hub: live upstream inventory subscription failed (unreachable)",
    ]);
  });

  test("each topic and status pair folds on its own", () => {
    const { lines, log, fire } = folding();
    log({ topic: "document", status: "unreachable" });
    log({ topic: "conversation", status: "unreachable" });
    log({ topic: "document", status: "5xx" });
    log({ topic: "document", status: "unreachable" });
    expect(lines).toEqual([
      "uatu hub: live upstream document subscription failed (unreachable)",
      "uatu hub: live upstream conversation subscription failed (unreachable)",
      "uatu hub: live upstream document subscription failed (5xx)",
    ]);
    fire();
    expect(lines.slice(3)).toEqual([
      "uatu hub: live upstream document subscription failed (unreachable) 1 more time in the last 60s",
    ]);
  });

  test("folding the log leaves the broker reporting every failure episode to the sink", async () => {
    const child = fakeSource({ refuse: () => new Error("connection refused"), workspaces: ["a", "b"], running: new Set(["a", "b"]) });
    const records: LiveUpstreamDiagnostic[] = [];
    setLiveUpstreamDiagnostics(record => records.push(record));
    const live = broker(child.source, { retryMinMs: 5_000, retryMaxMs: 5_000 });
    const sinks = [sink(), sink()];
    live.subscribe(sinks[0]!, "a", { topic: "document", key: "" });
    live.subscribe(sinks[1]!, "b", { topic: "document", key: "" });
    await waitFor(() => sinks.every(s => s.envelopes.length === 1), "unavailable on each");
    expect(records).toEqual([
      { topic: "document", status: "unreachable" },
      { topic: "document", status: "unreachable" },
    ]);
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
    expect(new URL(child.opened[0]!.path, "http://child").searchParams.has("reconnect")).toBe(false);
    child.opened[0]!.push(": open\n\n");
    child.opened[0]!.push(chatFrame("g1", 1));
    await waitFor(() => s.envelopes.length === 2, "ready + data");
    child.opened[0]!.end();
    await waitFor(() => child.opened.length === 2, "reopen");
    expect(child.opened[1]!.path).toContain(`cursor=${encodeURIComponent(cursorOf("g1", 1))}`);
    expect(new URL(child.opened[1]!.path, "http://child").searchParams.get("reconnect")).toBe("1");
    child.opened[1]!.push(": open\n\n");
    child.opened[1]!.push(chatFrame("g1", 2));
    await waitFor(() => s.envelopes.length === 5, "unavailable, ready, data");
    expect(kinds(s.envelopes)).toEqual(["ready", "data", "unavailable", "ready", "data"]);
  });

  test.each(["stream end", "session restart"] as const)("%s after terminal status explicitly repairs the same-cursor visual resync without flagging fresh attachments", async failure => {
    const child = fakeSource();
    const clock = trailerClock();
    const live = broker(child.source, { retryMinMs: failure === "session restart" ? 5_000 : 20, retryMaxMs: 5_000, catchUpTrailerClock: clock.clock });
    const s = sink();
    const interrupt = (upstream: FakeUpstream) => {
      if (failure === "stream end") upstream.end();
      else { child.setRunning("ws", false); child.setRunning("ws", true); }
    };
    const initial = cursorOf("g1", 0), terminalCursor = cursorOf("g1", 1);
    const status = { type: "conversation.status", status: "failed", message: "Provider failed after image generation", generation: "g1", sequence: 1, conversationId: "c" };
    const resync = { type: "resync", reason: "conversation-rewritten", generation: "g1", sequence: 1, conversationId: "c" };
    live.subscribe(s, "ws", { topic: "conversation", key: "c", cursor: initial });
    await waitFor(() => child.opened.length === 1, "fresh conversation stream");
    expect(new URL(child.opened[0]!.path, "http://child").searchParams.has("reconnect")).toBe(false);
    child.opened[0]!.push(`event: open\ndata: ${JSON.stringify({ cursor: initial })}\n\n`);
    await waitFor(() => kinds(s.envelopes).includes("ready"), "initial ready");
    child.opened[0]!.push(replayFrame(status));
    await waitFor(() => s.envelopes.some(envelope => envelope.event.kind === "data"), "original native status received");
    expect(s.envelopes.at(-1)).toMatchObject({ cursor: terminalCursor, event: { kind: "data", data: status } });
    interrupt(child.opened[0]!);
    await waitFor(() => child.opened.length === 2, "transport recovery");
    const recovering = new URL(child.opened[1]!.path, "http://child");
    expect(recovering.searchParams.get("cursor")).toBe(terminalCursor);
    expect(recovering.searchParams.get("reconnect")).toBe("1");
    // The actual child uses this explicit flag to return its cached visual
    // resync even though no new native event or sequence is available.
    child.opened[1]!.push(`event: open\ndata: ${JSON.stringify({ cursor: terminalCursor })}\n\n${replayFrame(resync, "resync")}`);
    await waitFor(() => s.envelopes.some(envelope => envelope.event.kind === "resync"), "same-cursor visual repair");
    expect(s.envelopes.filter(envelope => envelope.event.kind === "data")).toEqual([
      expect.objectContaining({ cursor: terminalCursor, event: { kind: "data", data: status } }),
    ]);
    expect(s.envelopes.filter(envelope => envelope.event.kind === "resync")).toEqual([
      expect.objectContaining({ cursor: terminalCursor, event: { kind: "resync", data: resync } }),
    ]);
    expect(child.opened[1]!.cancelled).toBe(true);
    expect(live.upstreamCount("conversation")).toBe(0);

    for (let round = 0; round < 2; round++) {
      const freshIndex = child.opened.length;
      const readyCount = s.envelopes.filter(envelope => envelope.event.kind === "ready").length;
      live.subscribe(s, "ws", { topic: "conversation", key: "c", cursor: terminalCursor });
      await waitFor(() => child.opened.length === freshIndex + 1, "fresh post-history attachment");
      const fresh = child.opened[freshIndex]!;
      const path = new URL(fresh.path, "http://child");
      expect(path.searchParams.get("cursor")).toBe(terminalCursor);
      expect(path.searchParams.has("reconnect")).toBe(false);
      fresh.push(`event: open\ndata: ${JSON.stringify({ cursor: terminalCursor })}\n\n`);
      await waitFor(() => s.envelopes.filter(envelope => envelope.event.kind === "ready").length === readyCount + 1, "fresh ready without another message");
      expect(s.envelopes.filter(envelope => envelope.event.kind === "resync")).toHaveLength(round + 1);
      if (round === 0) {
        const unavailableCount = s.envelopes.filter(envelope => envelope.event.kind === "unavailable").length;
        // Repeat the selected failure mode. A session restart recovers on
        // its start event; an EOF alone correctly waits the 5-second retry
        // floor deliberately configured for that variant.
        interrupt(fresh);
        await waitFor(() => s.envelopes.filter(envelope => envelope.event.kind === "unavailable").length === unavailableCount + 1, "cached transport observed unavailable");
        await waitFor(() => child.opened.length === freshIndex + 2, "cached-cursor transport recovery");
        const cached = child.opened[freshIndex + 1]!;
        expect(new URL(cached.path, "http://child").searchParams.get("reconnect")).toBe("1");
        cached.push(`event: open\ndata: ${JSON.stringify({ cursor: terminalCursor })}\n\n${replayFrame(resync, "resync")}`);
        await waitFor(() => s.envelopes.filter(envelope => envelope.event.kind === "resync").length === 2, "second cached repair");
      }
    }
    expect(s.envelopes.filter(envelope => envelope.event.kind === "data")).toHaveLength(1);
    expect(clock.timers.size).toBe(0); // Shared recovery is not a private trailer lease.
    live.dispose();
    expect(child.opened.every(upstream => upstream.cancelled)).toBe(true);
    expect(live.upstreamCount()).toBe(0);
  });

  test("recovery retains the child's learned origin before any chat data has arrived", async () => {
    const child = fakeSource();
    const live = broker(child.source, { retryMinMs: 20, retryMaxMs: 40 });
    const s = sink();
    live.subscribe(s, "ws", { topic: "conversation", key: "c" });
    await waitFor(() => child.opened.length === 1, "unpositioned initial stream");
    expect(child.opened[0]!.path).toBe("/api/chat/conversations/c/events");
    const origin = cursorOf("g1", 7);
    child.opened[0]!.push(`event: open\ndata: ${JSON.stringify({ cursor: origin })}\n\n`);
    await waitFor(() => kinds(s.envelopes).includes("ready"), "origin learned");
    child.opened[0]!.end();
    await waitFor(() => child.opened.length === 2, "origin-only recovery");
    const recovered = new URL(child.opened[1]!.path, "http://child");
    expect(recovered.searchParams.get("cursor")).toBe(origin);
    expect(recovered.searchParams.get("reconnect")).toBe("1");
    const snapshotRecovery = { type: "resync", reason: "conversation-rewritten", generation: "g1", sequence: 7, conversationId: "c" };
    child.opened[1]!.push(replayFrame(snapshotRecovery, "resync"));
    await waitFor(() => kinds(s.envelopes).includes("resync"), "origin-only visual repair");
    expect(s.envelopes.filter(envelope => envelope.event.kind === "data")).toEqual([]);
  });

  test("a conversation's first child open after a stopped workspace starts is not transport recovery", async () => {
    const child = fakeSource({ running: new Set() });
    const live = broker(child.source, { retryMinMs: 5_000, retryMaxMs: 5_000 });
    const s = sink();
    live.subscribe(s, "ws", { topic: "conversation", key: "c", cursor: cursorOf("g1", 5) });
    expect(child.opened).toHaveLength(0);
    child.setRunning("ws", true);
    await waitFor(() => child.opened.length === 1, "first child transport");
    expect(new URL(child.opened[0]!.path, "http://child").searchParams.has("reconnect")).toBe(false);
    child.opened[0]!.push(": open\n\n");
    await waitFor(() => kinds(s.envelopes).includes("ready"), "fresh attachment ready");
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

  const working = { working: true, awaiting: false, unresolved: false };
  const unresolved = { working: false, awaiting: false, unresolved: true };
  const quiet = { working: false, awaiting: false, unresolved: false };
  const awaiting = { working: true, awaiting: true, unresolved: false };
  for (const scenario of [
    { name: "observed work finishes after unresolved clears without renewed Working", states: [working, unresolved, quiet, quiet], finished: [false, false, true, true], writes: 1 },
    { name: "recovered Working can subsequently finish", states: [working, unresolved, working, quiet], finished: [false, false, false, true], writes: 1 },
    { name: "first-seen unresolved does not invent prior work", states: [unresolved, quiet], finished: [false, false], writes: 0 },
    { name: "first-seen awaiting does not invent prior work", states: [awaiting, quiet], finished: [false, false], writes: 0 },
    { name: "awaiting still cancels completion eligibility", states: [working, awaiting, quiet], finished: [false, false, false], writes: 0 },
    { name: "awaiting cancels even a pending unresolved epoch", states: [working, { ...unresolved, awaiting: true }, unresolved, quiet], finished: [false, false, false, false], writes: 0 },
    { name: "new Working rearms after awaiting cancelled an unresolved epoch", states: [working, { ...unresolved, awaiting: true }, unresolved, working, quiet], finished: [false, false, false, false, true], writes: 1 },
  ]) test(scenario.name, async () => {
    const child = fakeSource({ running: new Set(["a"]), workspaces: ["a"] });
    let writes = 0, frames = 0;
    const live = broker(child.source, { marks: { read: () => ({ finishedAt: new Map(), viewedAt: new Map() }), write: () => { writes++; } } });
    // This public observer runs after activity fanout, providing a deterministic
    // ingestion barrier even when the public summary is unchanged.
    live.observeWorktrees({ attached() {}, interest() {}, activity(_workspace, activity) {
      expect(Object.keys(activity).sort()).toEqual(["awaiting", "finished", "running", "working"]);
      frames++;
    } });
    const alice = sink();
    live.subscribeActivity(alice, "alice");
    await waitFor(() => child.opened.length === 1, "activity watch");
    for (const [index, state] of scenario.states.entries()) {
      child.opened[0]!.push(`event: activity\ndata: ${JSON.stringify(state)}\n\n`);
      await waitFor(() => frames === index + 1, "activity evidence ingested");
      expect(latestFor(alice, "a")).toEqual({ running: true, working: state.working, awaiting: state.awaiting, finished: scenario.finished[index]! });
      expect(Object.keys(latestFor(alice, "a")).sort()).toEqual(["awaiting", "finished", "running", "working"]);
    }
    expect(writes).toBe(scenario.writes);
  });

  test("unresolved hides a retained old finish without stamping another epoch, including for new feeds", async () => {
    const child = fakeSource({ running: new Set(["a"]), workspaces: ["a"] });
    let frames = 0, writes = 0;
    const live = broker(child.source, { marks: { read: () => ({ finishedAt: new Map([["a", 1]]), viewedAt: new Map() }), write: () => { writes++; } } });
    live.observeWorktrees({ attached() {}, interest() {}, activity() { frames++; } });
    const alice = sink(); live.subscribeActivity(alice, "alice");
    await waitFor(() => child.opened.length === 1, "activity watch");
    child.opened[0]!.push(`event: activity\ndata: ${JSON.stringify(unresolved)}\n\n`);
    await waitFor(() => frames === 1, "unresolved ingested");
    expect(latestFor(alice, "a").finished).toBe(false);
    const bob = sink(); live.subscribeActivity(bob, "bob");
    expect(latestFor(bob, "a").finished).toBe(false);
    live.acknowledgeViewed("alice", "a");
    const writesAfterViewed = writes;
    child.opened[0]!.push(`event: activity\ndata: ${JSON.stringify(quiet)}\n\n`);
    await waitFor(() => frames === 2, "quiet ingested");
    expect(latestFor(alice, "a").finished).toBe(false);
    expect(latestFor(bob, "a").finished).toBe(true);
    expect(writes).toBe(writesAfterViewed);
  });

  for (const boundary of ["transport failure", "session stop", "workspace forget", "Hub restart"] as const) {
    test(`an unresolved completion epoch does not survive ${boundary}`, async () => {
      const child = fakeSource({ running: new Set(["a"]), workspaces: ["a"] });
      let live = broker(child.source, { retryMinMs: 1, retryMaxMs: 2 });
      let frames = 0;
      const observe = () => live.observeWorktrees({ attached() {}, interest() {}, activity() { frames++; } });
      observe();
      const alice = sink(); live.subscribeActivity(alice, "alice");
      await waitFor(() => child.opened.length === 1, "activity watch");
      for (const [index, state] of [working, unresolved].entries()) {
        child.opened[0]!.push(`event: activity\ndata: ${JSON.stringify(state)}\n\n`);
        await waitFor(() => frames === index + 1, "activity evidence ingested");
      }
      let next = 1;
      if (boundary === "transport failure") {
        child.opened[0]!.end();
        await waitFor(() => !latestFor(alice, "a").running, "transport failure observed");
      } else if (boundary === "session stop") {
        child.setRunning("a", false);
        expect(latestFor(alice, "a").running).toBe(false);
        child.setRunning("a", true);
      } else if (boundary === "workspace forget") {
        live.forgetWorkspace("a");
        live.subscribeActivity(sink(), "bob");
        // The lingering upstream can be reused, but its prior epoch cannot.
        next = 0;
      } else {
        live.dispose();
        live = broker(child.source);
        observe();
        live.subscribeActivity(alice, "alice");
      }
      await waitFor(() => child.opened[next] !== undefined, "new activity watch");
      const beforeQuiet = frames;
      child.opened[next]!.push(`event: activity\ndata: ${JSON.stringify(quiet)}\n\n`);
      await waitFor(() => frames > beforeQuiet, "quiet ingested after boundary");
      expect(latestFor(alice, "a")).toEqual({ running: true, working: false, awaiting: false, finished: false });
    });
  }

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
