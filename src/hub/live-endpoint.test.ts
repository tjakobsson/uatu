import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { encodeReplayCursor } from "../chat/replay";
import { MetricsRegistry } from "../debug/metrics";
import { allStreamCounterNames } from "../debug/stream-metrics";
import {
  LIVE_STREAM_PATH,
  liveSubscriptionsPath,
  parseLiveEnvelope,
  parseLiveHello,
  type LiveEnvelope,
  type LiveSubscription,
} from "../shared/live-protocol";
import type { RunningSession, SessionBackend } from "./backend";
import { hashPassword, HubSessionStore } from "./auth";
import type { HubConfig } from "./config";
import { EMPTY_CREDENTIAL_CONTEXT_RESOLVER } from "./credential-context";
import { LiveBroker, setLiveUpstreamDiagnostics, type LiveUpstreamDiagnostic, type LiveUpstreamSource } from "./live-broker";
import { LiveEndpoint } from "./live-endpoint";
import { SseFrameParser } from "./live-sse";
import { PersonalWorkspaceStateStore } from "./personal-state";
import { WorkspaceRegistry } from "./registry";
import { startHubServer } from "./server";
import { SessionManager } from "./sessions";

// ---------------------------------------------------------------------------
// Shared: a live-stream reader over any Response body.

type LiveReading = {
  hello: string | null;
  envelopes: LiveEnvelope[];
  comments: number;
  openedAtMs: number;
  firstBytesAtMs: number | null;
  ended: boolean;
  status: number;
  headers: Headers;
  waitFor(predicate: (reading: LiveReading) => boolean, what: string, timeoutMs?: number): Promise<void>;
  cancel(): Promise<void>;
  abort(): void;
};

async function readLive(open: (signal: AbortSignal) => Promise<Response>): Promise<LiveReading> {
  const controller = new AbortController();
  const openedAtMs = Date.now();
  const response = await open(controller.signal);
  const reading: LiveReading = {
    hello: null,
    envelopes: [],
    comments: 0,
    openedAtMs,
    firstBytesAtMs: null,
    ended: false,
    status: response.status,
    headers: response.headers,
    async waitFor(predicate, what, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(reading)) return;
        await Bun.sleep(5);
      }
      throw new Error(`timed out waiting for ${what}`);
    },
    async cancel() {
      await reader?.cancel().catch(() => undefined);
    },
    abort() {
      controller.abort();
    },
  };
  if (response.status !== 200 || !response.body) {
    reading.ended = true;
    return reading;
  }
  const reader = response.body.getReader();
  const parser = new SseFrameParser();
  void (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        reading.firstBytesAtMs ??= Date.now();
        for (const frame of parser.push(next.value)) {
          if ("comment" in frame) {
            reading.comments += 1;
            continue;
          }
          if (frame.event === "hello") reading.hello = parseLiveHello(frame.data)?.streamId ?? null;
          if (frame.event === "live") {
            const envelope = parseLiveEnvelope(frame.data);
            if (envelope) reading.envelopes.push(envelope);
          }
        }
      }
    } catch {
      // Aborted by the test.
    }
    reading.ended = true;
  })();
  return reading;
}

const cursorOf = (generation: string, sequence: number) => encodeReplayCursor({ generation, sequence });
const dataOf = (envelope: LiveEnvelope) => (envelope.event as { data: unknown }).data;

// ---------------------------------------------------------------------------
// In-process: the endpoint over a broker with a controllable source.

type FakeUpstream = { path: string; push(frame: string): void; end(): void; cancelled: boolean };

function fakeSource() {
  const opened: FakeUpstream[] = [];
  const encoder = new TextEncoder();
  const source: LiveUpstreamSource = {
    isRunning: () => true,
    workspaceIds: () => ["ws"],
    async open({ path, signal }) {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const upstream: FakeUpstream = {
        path,
        push: frame => {
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            // Ended.
          }
        },
        end: () => {
          try {
            controller.close();
          } catch {
            // Ended.
          }
        },
        cancelled: false,
      };
      const body = new ReadableStream<Uint8Array>({
        start: c => {
          controller = c;
        },
        cancel: () => {
          upstream.cancelled = true;
        },
      });
      signal.addEventListener("abort", () => {
        upstream.cancelled = true;
        upstream.end();
      }, { once: true });
      opened.push(upstream);
      return new Response(body);
    },
  };
  return { source, opened, byPath: (fragment: string) => opened.filter(entry => entry.path.includes(fragment)) };
}

describe("LiveEndpoint (in-process)", () => {
  const principal = { user: "u", sessionId: "session-A" };
  let child: ReturnType<typeof fakeSource>;
  let broker: LiveBroker;
  let endpoint: LiveEndpoint;
  let registry: MetricsRegistry;

  beforeEach(() => {
    setLiveUpstreamDiagnostics(() => undefined);
    child = fakeSource();
    registry = new MetricsRegistry();
    broker = new LiveBroker(child.source, { lingerMs: 30, retryMinMs: 20, retryMaxMs: 40, inventoryOpenGraceMs: 10, metrics: registry });
    endpoint = new LiveEndpoint({
      broker,
      resolveWorkspace: requested => (requested === "ws" ? "ws" : null),
      keepaliveMs: 40,
      maxQueuedBytes: 4_096,
      metrics: registry,
    });
  });

  afterEach(() => {
    endpoint.endAll();
    broker.dispose();
    setLiveUpstreamDiagnostics(null);
  });

  const openStream = (query: string, who = principal) =>
    readLive(async signal => endpoint.openStream(new Request(`http://hub.test${LIVE_STREAM_PATH}?${query}`, { signal }), who));

  const change = (streamId: string, body: unknown, who = principal) =>
    endpoint.changeSubscriptions(
      new Request(`http://hub.test${liveSubscriptionsPath(streamId)}`, { method: "POST", body: JSON.stringify(body) }),
      streamId,
      who,
    );

  test("opens with the comment frame and hello before any upstream answers, with stream headers", async () => {
    const stream = await openStream(`ws=ws&subs=${encodeURIComponent(JSON.stringify([{ topic: "document", key: "" }]))}`);
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(stream.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(stream.headers.get("x-accel-buffering")).toBe("no");
    await stream.waitFor(r => r.hello !== null, "hello", 1_000);
    expect(stream.firstBytesAtMs! - stream.openedAtMs).toBeLessThan(100);
    expect(stream.comments).toBeGreaterThanOrEqual(1);
    expect(stream.hello!.length).toBeGreaterThanOrEqual(32);
    expect(stream.envelopes).toHaveLength(0);
    // Keepalives are comments and move no cursor.
    await stream.waitFor(r => r.comments >= 3, "keepalives", 1_000);
    expect(stream.envelopes).toHaveLength(0);
    await stream.cancel();
  });

  test("refuses an unknown workspace, a malformed query, and too many subscriptions", async () => {
    expect((await openStream("ws=nope")).status).toBe(404);
    expect((await openStream("ws=ws&subs=%5B%7B%22topic%22%3A%22nope%22%7D%5D")).status).toBe(400);
    const many = Array.from({ length: 17 }, (_, index) => ({ topic: "conversation", key: `c${index}` }));
    expect((await openStream(`ws=ws&subs=${encodeURIComponent(JSON.stringify(many))}`)).status).toBe(400);
    expect(endpoint.streamCount()).toBe(0);
  });

  test("adding a conversation starts its events on the open stream and removing stops them", async () => {
    const stream = await openStream("ws=ws");
    await stream.waitFor(r => r.hello !== null, "hello");
    const subscription: LiveSubscription = { topic: "conversation", key: "opencode:c1", cursor: cursorOf("g", 0) };
    expect((await change(stream.hello!, { add: [subscription] })).status).toBe(200);
    await stream.waitFor(() => child.byPath("/conversations/opencode%3Ac1/").length === 1, "upstream opened");
    const upstream = child.byPath("/conversations/opencode%3Ac1/")[0]!;
    upstream.push(": open\n\n");
    upstream.push(`id: ${cursorOf("g", 1)}\nevent: chat\ndata: {"type":"conversation.status"}\n\n`);
    await stream.waitFor(r => r.envelopes.length === 2, "ready + data");
    expect(stream.envelopes[0]).toMatchObject({ ws: "ws", topic: "conversation", key: "opencode:c1", event: { kind: "ready" } });
    expect(stream.envelopes[1]).toMatchObject({ cursor: cursorOf("g", 1), event: { kind: "data", data: { type: "conversation.status" } } });

    expect((await change(stream.hello!, { remove: [{ topic: "conversation", key: "opencode:c1" }] })).status).toBe(200);
    upstream.push(`id: ${cursorOf("g", 2)}\nevent: chat\ndata: {"type":"conversation.status"}\n\n`);
    await Bun.sleep(40);
    expect(stream.envelopes).toHaveLength(2);
    await stream.waitFor(() => upstream.cancelled, "child subscription released after linger");
    await stream.cancel();
  });

  test("add of a subscribed key replaces it from the new cursor; removals apply before adds", async () => {
    const stream = await openStream(`ws=ws&subs=${encodeURIComponent(JSON.stringify([{ topic: "conversation", key: "c", cursor: cursorOf("g", 0) }]))}`);
    await stream.waitFor(() => child.opened.length === 1, "upstream");
    child.opened[0]!.push(": open\n\n");
    child.opened[0]!.push(`id: ${cursorOf("g", 1)}\nevent: chat\ndata: {"n":1}\n\n`);
    child.opened[0]!.push(`id: ${cursorOf("g", 2)}\nevent: chat\ndata: {"n":2}\n\n`);
    await stream.waitFor(r => r.envelopes.length === 3, "ready + 2");
    // Re-add from cursor 1 in the same request that removes it: one
    // subscription remains, and the replay from 1 arrives (event 2), then ready.
    const response = await change(stream.hello!, {
      remove: [{ topic: "conversation", key: "c" }],
      add: [{ topic: "conversation", key: "c", cursor: cursorOf("g", 1) }],
    });
    expect(response.status).toBe(200);
    await stream.waitFor(r => r.envelopes.length === 5, "replay + ready");
    expect(stream.envelopes.slice(3).map(e => e.event.kind)).toEqual(["data", "ready"]);
    expect(stream.envelopes[3]!.cursor).toBe(cursorOf("g", 2));
    expect(child.opened).toHaveLength(1);
    await stream.cancel();
  });

  test("subscription control is bound to the stream: another session is refused, an unknown stream is 404, a bad body 400", async () => {
    const stream = await openStream("ws=ws");
    await stream.waitFor(r => r.hello !== null, "hello");
    const other = { user: "u", sessionId: "session-B" };
    expect((await change(stream.hello!, { add: [{ topic: "inventory" }] }, other)).status).toBe(403);
    expect((await change("no-such-stream", { add: [{ topic: "inventory" }] })).status).toBe(404);
    expect((await change(stream.hello!, { add: [{ topic: "inventory" }], extra: 1 })).status).toBe(400);
    const notJson = await endpoint.changeSubscriptions(
      new Request(`http://hub.test${liveSubscriptionsPath(stream.hello!)}`, { method: "POST", body: "{" }),
      stream.hello!,
      principal,
    );
    expect(notJson.status).toBe(400);
    // The stream was unaffected: nothing subscribed, nothing written.
    await Bun.sleep(20);
    expect(child.opened).toHaveLength(0);
    expect(stream.envelopes).toHaveLength(0);
    await stream.cancel();
    await stream.waitFor(r => r.ended, "ended");
    expect((await change(stream.hello!, { add: [{ topic: "inventory" }] })).status).toBe(404);
  });

  test("a resync detaches the subscription so a later remove is a no-op and add re-attaches", async () => {
    const stream = await openStream(`ws=ws&subs=${encodeURIComponent(JSON.stringify([{ topic: "conversation", key: "c", cursor: cursorOf("g", 0) }]))}`);
    await stream.waitFor(() => child.opened.length === 1, "upstream");
    child.opened[0]!.push(": open\n\n");
    child.opened[0]!.push(`id: ${cursorOf("h", 0)}\nevent: resync\ndata: {"type":"resync","reason":"generation-changed"}\n\n`);
    child.opened[0]!.end();
    await stream.waitFor(r => r.envelopes.some(e => e.event.kind === "resync"), "resync");
    expect((await change(stream.hello!, { remove: [{ topic: "conversation", key: "c" }] })).status).toBe(200);
    expect((await change(stream.hello!, { add: [{ topic: "conversation", key: "c", cursor: cursorOf("h", 0) }] })).status).toBe(200);
    await stream.waitFor(() => child.opened.length === 2, "reopened from the fresh cursor");
    expect(child.opened[1]!.path).toContain(encodeURIComponent(cursorOf("h", 0)));
    await stream.cancel();
  });

  test("the activity topic delivers one envelope per workspace on open and rides the same stream", async () => {
    const stream = await openStream("ws=ws&activity=1");
    await stream.waitFor(r => r.envelopes.length === 1, "activity snapshot");
    expect(stream.envelopes[0]).toMatchObject({ ws: "ws", topic: "activity", event: { kind: "data", data: { running: true, working: false, awaiting: false } } });
    await stream.waitFor(() => child.byPath("/api/activity").length === 1, "activity upstream");
    child.byPath("/api/activity")[0]!.push(": open\n\nevent: activity\ndata: {\"working\":true,\"awaiting\":false}\n\n");
    await stream.waitFor(r => r.envelopes.length === 2, "activity change");
    expect(dataOf(stream.envelopes[1]!)).toEqual({ running: true, working: true, awaiting: false });
    await stream.cancel();
  });

  // A stream whose client has read the opening frames and then stopped
  // pulling: what the endpoint queues for it is what these tests probe.
  async function stalledStream(query: string) {
    const response = endpoint.openStream(new Request(`http://hub.test${LIVE_STREAM_PATH}?${query}`), principal);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read(); // open + hello; then the reader never pulls again
    await new Promise(resolve => setTimeout(resolve, 20));
    const parser = new SseFrameParser();
    return {
      reader,
      // Resumes reading until `predicate` holds over everything received.
      async resume(predicate: (envelopes: LiveEnvelope[]) => boolean, timeoutMs = 2_000): Promise<LiveEnvelope[]> {
        const envelopes: LiveEnvelope[] = [];
        const deadline = Date.now() + timeoutMs;
        while (!predicate(envelopes)) {
          if (Date.now() > deadline) throw new Error("timed out resuming the stalled stream");
          const next = await reader.read();
          if (next.done) break;
          for (const frame of parser.push(next.value)) {
            if ("comment" in frame || frame.event !== "live") continue;
            const envelope = parseLiveEnvelope(frame.data);
            if (envelope) envelopes.push(envelope);
          }
        }
        return envelopes;
      },
    };
  }

  const documentSubs = encodeURIComponent(JSON.stringify([{ topic: "document", key: "" }]));

  test("a document snapshot larger than the queue cap reaches a reading client intact", async () => {
    // The cap is 4 KiB here; a real workspace snapshot runs to megabytes. A
    // single frame is always admitted — the cap bounds what is queued
    // behind unread data, never the frame itself — so a reader that keeps
    // up gets the whole snapshot instead of an ended stream.
    const stream = await openStream(`ws=ws&subs=${documentSubs}`);
    await stream.waitFor(() => child.byPath("/api/events").length === 1, "upstream");
    const filler = "x".repeat(8_000);
    child.byPath("/api/events")[0]!.push(`event: state\ndata: ${JSON.stringify({ generatedAt: 1, filler })}\n\n`);
    await stream.waitFor(r => r.envelopes.length === 2, "snapshot + ready");
    expect(dataOf(stream.envelopes[0]!)).toEqual({ generatedAt: 1, filler });
    expect(stream.envelopes[1]!.event.kind).toBe("ready");
    expect(stream.ended).toBe(false);
    expect(endpoint.streamCount()).toBe(1);
    expect(registry.get("stream.hub-live.closed_total.failed")).toBe(0);
    await stream.cancel();
  });

  test("a stalled client holds only the newest document snapshot and stays open", async () => {
    // Every document frame is a full snapshot, so an unread one is
    // superseded by the next: the queue keeps one per subscription, in the
    // slot of the oldest undelivered, ahead of the signals that followed it.
    const stalled = await stalledStream(`ws=ws&subs=${documentSubs}`);
    const upstream = child.byPath("/api/events")[0]!;
    for (let index = 0; index < 20; index += 1) {
      upstream.push(`event: state\ndata: ${JSON.stringify({ generatedAt: index, filler: "x".repeat(500) })}\n\n`);
      await Bun.sleep(1);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(endpoint.streamCount()).toBe(1);
    const received = await stalled.resume(envelopes => envelopes.some(e => e.event.kind === "ready"));
    expect(received.map(e => e.event.kind)).toEqual(["data", "ready"]);
    expect(dataOf(received[0]!)).toMatchObject({ generatedAt: 19 });
    expect(endpoint.streamCount()).toBe(1);
    await stalled.reader.cancel().catch(() => undefined);
  });

  test("a stalled client flooded with conversation frames beyond the cap is ended instead of growing hub memory", async () => {
    const subs = encodeURIComponent(JSON.stringify([{ topic: "conversation", key: "c", cursor: cursorOf("g", 0) }]));
    const stalled = await stalledStream(`ws=ws&subs=${subs}`);
    const upstream = child.byPath("/conversations/c/")[0]!;
    upstream.push(": open\n\n");
    for (let index = 1; index <= 20; index += 1) {
      upstream.push(`id: ${cursorOf("g", index)}\nevent: chat\ndata: ${JSON.stringify({ n: index, filler: "x".repeat(400) })}\n\n`);
      await Bun.sleep(1);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(endpoint.streamCount()).toBe(0);
    expect(registry.get("stream.hub-live.closed_total.failed")).toBe(1);
    await stalled.reader.cancel().catch(() => undefined);
  });

  test("subscriptions attached while the stream ended are released, not stored on a dead stream", async () => {
    // A broker subscribe writes synchronously (the latest document
    // snapshot, its `ready`, an activity snapshot). When such a write
    // overflows the queue the stream ends inside the subscribe call; the
    // attachment it returns must then be detached at once, or its upstream
    // never lingers out and pins a child fetch forever.
    const warm = await openStream(`ws=ws&subs=${documentSubs}`);
    await warm.waitFor(() => child.byPath("/api/events").length === 1, "upstream");
    child.byPath("/api/events")[0]!.push(`event: state\ndata: ${JSON.stringify({ generatedAt: 1, filler: "x".repeat(500) })}\n\n`);
    await warm.waitFor(r => r.envelopes.length === 2, "snapshot + ready");

    // A cap the warm snapshot exceeds: the document `ready` queued behind
    // it ends the stream during the first attach.
    const tiny = new LiveEndpoint({ broker, resolveWorkspace: () => "ws", maxQueuedBytes: 64, metrics: registry });
    const subs = encodeURIComponent(JSON.stringify([{ topic: "document", key: "" }, { topic: "inventory" }]));
    const doomed = await readLive(async signal => tiny.openStream(new Request(`http://hub.test${LIVE_STREAM_PATH}?ws=ws&subs=${subs}&activity=1`, { signal }), principal));
    await doomed.waitFor(r => r.ended, "ended by the overflow");
    expect(tiny.streamCount()).toBe(0);
    expect(registry.get("stream.hub-live.closed_total.failed")).toBe(1);

    await warm.cancel();
    await warm.waitFor(r => r.ended, "warm stream ended");
    await Bun.sleep(100); // past the 30 ms linger
    expect(broker.upstreamCount("document")).toBe(0);
    expect(broker.upstreamCount("inventory")).toBe(0);
    expect(broker.upstreamCount("activity")).toBe(0);
    expect(broker.upstreamCount()).toBe(0);
    tiny.endAll();
  });

  test("ending a session's streams closes them and releases their subscriptions", async () => {
    const a = await openStream(`ws=ws&subs=${encodeURIComponent(JSON.stringify([{ topic: "document", key: "" }]))}`);
    const b = await openStream("ws=ws", { user: "v", sessionId: "session-B" });
    await a.waitFor(r => r.hello !== null && b.hello !== null, "both hellos");
    endpoint.endStreamsForSession("session-A");
    await a.waitFor(r => r.ended, "A ended");
    expect(b.ended).toBe(false);
    await b.waitFor(() => child.opened[0]!.cancelled, "A's upstream released");
    await b.cancel();
  });

  test("an expired principal is ended at the next keepalive", async () => {
    let valid = true;
    const checked = new LiveEndpoint({ broker, resolveWorkspace: () => "ws", keepaliveMs: 20, principalStillValid: () => valid });
    const stream = await readLive(async signal => checked.openStream(new Request(`http://hub.test${LIVE_STREAM_PATH}?ws=ws`, { signal }), principal));
    await stream.waitFor(r => r.comments >= 2, "keepalive");
    valid = false;
    await stream.waitFor(r => r.ended, "ended after revocation");
    checked.endAll();
  });

  test("diagnostics name classes only: no workspace, conversation, cursor, payload, cookie, or token", async () => {
    const records: LiveUpstreamDiagnostic[] = [];
    setLiveUpstreamDiagnostics(record => records.push(record));
    const failing = new LiveBroker({
      ...child.source,
      open: () => Promise.reject(new Error("refused: token=child-secret cookie=uatu_hub=abc")),
    }, { retryMinMs: 5_000, retryMaxMs: 5_000, metrics: registry });
    const failingEndpoint = new LiveEndpoint({ broker: failing, resolveWorkspace: () => "secret-workspace", metrics: registry });
    const subs = [{ topic: "conversation", key: "opencode:secret-conversation", cursor: cursorOf("secret-generation", 7) }];
    const stream = await readLive(async signal => failingEndpoint.openStream(
      new Request(`http://hub.test${LIVE_STREAM_PATH}?ws=secret-workspace&reconnect=1&subs=${encodeURIComponent(JSON.stringify(subs))}`, {
        signal,
        headers: { cookie: "uatu_hub=session-cookie", authorization: "Bearer user-token" },
      }),
      { user: "secret-user", sessionId: "secret-session" },
    ));
    await stream.waitFor(r => r.envelopes.length === 1, "unavailable");
    await stream.cancel();
    await stream.waitFor(r => r.ended, "ended");
    failingEndpoint.endAll();
    failing.dispose();

    expect(records).toEqual([{ topic: "conversation", status: "unreachable" }]);
    const serialized = JSON.stringify({ records, counters: registry.snapshot().counters });
    for (const forbidden of [
      "secret-workspace", "secret-conversation", "secret-generation", cursorOf("secret-generation", 7),
      "session-cookie", "user-token", "child-secret", "uatu_hub", "secret-user", "secret-session", "conversation.status",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    const permitted = new Set(allStreamCounterNames());
    for (const name of Object.keys(registry.snapshot().counters)) expect(permitted.has(name)).toBe(true);
    expect(registry.get("stream.hub-live.opened_total")).toBeGreaterThanOrEqual(1);
    expect(registry.get("stream.hub-live.reconnected_total")).toBe(1);
    expect(registry.get("stream.hub-live.closed_total.cancelled")).toBeGreaterThanOrEqual(1);
    expect(registry.get("upstream.conversation.failed_total")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Through the real hub: the gate, CSRF, the refusal, sign-out.

describe("hub live routes", () => {
  const encoder = new TextEncoder();
  const childRequests: string[] = [];
  let tempRoot = "";
  let child: ReturnType<typeof Bun.serve> | null = null;
  let hub: ReturnType<typeof startHubServer> | null = null;
  let sessionStore: HubSessionStore;
  let origin = "";
  let cookie = "";
  let sessionId = "";
  let documentDelayMs = 0;

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-live-routes-"));
    child = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch(request) {
        const url = new URL(request.url);
        childRequests.push(url.pathname);
        if (url.pathname.endsWith("/api/events")) {
          const delay = documentDelayMs;
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              setTimeout(() => {
                try {
                  controller.enqueue(encoder.encode('event: state\ndata: {"generatedAt":1}\n\n'));
                } catch {
                  // Gone.
                }
              }, delay);
            },
          }), { headers: { "content-type": "text/event-stream" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const registry = new WorkspaceRegistry(path.join(tempRoot, "registry.json"));
    await registry.load();
    const personalState = new PersonalWorkspaceStateStore(path.join(tempRoot, "personal-state.json"));
    await personalState.load();
    await registry.register(path.join(tempRoot, "workspaces", "project"));
    const backend: SessionBackend = {
      start: async (workspace): Promise<RunningSession> => ({
        workspaceId: workspace.id,
        basePath: `/s/${workspace.id}/`,
        endpoint: { hostname: "127.0.0.1", port: child!.port! },
        token: "child-secret",
        exited: new Promise<number | null>(() => undefined),
        stop: async () => undefined,
      }),
    };
    const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
    await sessions.start("project");
    const config: HubConfig = {
      port: 0 as number,
      host: "127.0.0.1",
      tls: null,
      users: [{ name: "t", passwordHash: await hashPassword("x") }],
      stateDir: path.join(tempRoot, "state"),
    };
    sessionStore = new HubSessionStore(path.join(tempRoot, "sessions.json"));
    await sessionStore.load();
    hub = startHubServer({ config, registry, sessions, sessionStore, personalState });
    origin = `http://127.0.0.1:${hub.port}`;
    sessionId = (await sessionStore.issue("t", "test")).id;
    cookie = `uatu_hub=${sessionId}`;
  });

  afterAll(async () => {
    hub?.live.endAll();
    hub?.liveBroker.dispose();
    hub?.stop(true);
    child?.stop(true);
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  const openStream = (query: string, headers: Record<string, string> = { cookie }) =>
    readLive(signal => fetch(`${origin}${LIVE_STREAM_PATH}?${query}`, { headers, signal }));

  test("headers and the first frame arrive within 100 ms for an idle workspace", async () => {
    documentDelayMs = 400;
    try {
      const subs = encodeURIComponent(JSON.stringify([{ topic: "document", key: "" }]));
      const stream = await openStream(`ws=project&subs=${subs}`);
      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      expect(stream.headers.get("cache-control")).toBe("no-store, no-transform");
      await stream.waitFor(r => r.hello !== null, "hello");
      expect(stream.firstBytesAtMs! - stream.openedAtMs).toBeLessThan(100);
      // The document snapshot follows once the child answers.
      await stream.waitFor(r => r.envelopes.length === 2, "snapshot + ready");
      expect(stream.envelopes[0]).toMatchObject({ ws: "project", topic: "document", event: { kind: "data", data: { generatedAt: 1 } } });
      // The child's document route was reached with the brokered token and a
      // loopback origin; the token never appears on the hub side.
      expect(childRequests.some(pathname => pathname === "/s/project/api/events")).toBe(true);
      await stream.cancel();
    } finally {
      documentDelayMs = 0;
    }
  });

  test("the stream is gated like every hub route and a workspace outside the registry is refused", async () => {
    expect((await openStream("ws=project", {})).status).toBe(401);
    expect((await openStream("ws=project", { authorization: "Bearer not-a-session" })).status).toBe(401);
    const unknown = await openStream("ws=elsewhere");
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("cache-control")).toBe("no-store");
  });

  test("an absent ws is 400, distinct from an unknown workspace", async () => {
    const absent = await fetch(`${origin}${LIVE_STREAM_PATH}`, { headers: { cookie } });
    expect(absent.status).toBe(400);
    expect(absent.headers.get("cache-control")).toBe("no-store");
    expect(await absent.json()).toEqual({ error: "workspace id required" });
    expect(hub!.live.streamCount()).toBe(0);
  });

  test("the stream is same-origin checked for cookie sessions: a foreign Origin is refused before anything is subscribed", async () => {
    // SameSite=Lax attaches the cookie to a same-site cross-origin GET
    // (another port on the same host), and an open stream makes the hub
    // open upstreams — which can spawn agent runtimes. Same check as the
    // proxied /s/ routes.
    const subs = encodeURIComponent(JSON.stringify([{ topic: "document", key: "" }]));
    const upstreamsBefore = hub!.liveBroker.upstreamCount();
    const streamsBefore = hub!.live.streamCount();
    const foreign = await openStream(`ws=project&subs=${subs}`, { cookie, origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("cache-control")).toBe("no-store");
    await Bun.sleep(30);
    expect(hub!.live.streamCount()).toBe(streamsBefore);
    expect(hub!.liveBroker.upstreamCount()).toBe(upstreamsBefore);

    // A same-origin EventSource GET carries no Origin; a fetch from the
    // hub's own page carries the hub's.
    const bare = await openStream("ws=project");
    expect(bare.status).toBe(200);
    const own = await openStream("ws=project", { cookie, origin });
    expect(own.status).toBe(200);
    await bare.waitFor(r => r.hello !== null && own.hello !== null, "both hellos");
    await bare.cancel();
    await own.cancel();
  });

  test("subscription control needs the stream's own session and a same-origin cookie request", async () => {
    const stream = await openStream("ws=project");
    await stream.waitFor(r => r.hello !== null, "hello");
    const body = JSON.stringify({ add: [{ topic: "document", key: "" }] });
    const crossOrigin = await fetch(`${origin}${liveSubscriptionsPath(stream.hello!)}`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.example", "content-type": "application/json" },
      body,
    });
    expect(crossOrigin.status).toBe(403);
    const otherSession = (await sessionStore.issue("t", "other device")).id;
    const other = await fetch(`${origin}${liveSubscriptionsPath(stream.hello!)}`, {
      method: "POST",
      headers: { cookie: `uatu_hub=${otherSession}`, origin, "content-type": "application/json" },
      body,
    });
    expect(other.status).toBe(403);
    const unknown = await fetch(`${origin}${liveSubscriptionsPath("nope")}`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body,
    });
    expect(unknown.status).toBe(404);
    const ok = await fetch(`${origin}${liveSubscriptionsPath(stream.hello!)}`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    await stream.waitFor(r => r.envelopes.length === 2, "snapshot + ready after add");
    await stream.cancel();
  });

  test("the per-stream child routes are refused before the proxy and no request reaches the child", async () => {
    const before = childRequests.length;
    for (const suffix of [
      "/api/events",
      "/api/events?compareTarget=main",
      "/api/chat/conversations/events",
      "/api/chat/conversations/opencode%3Alocal/events",
      "/api/activity",
    ]) {
      const response = await fetch(`${origin}/s/project${suffix}`, { headers: { cookie, accept: "text/event-stream" } });
      expect(response.status).toBe(410);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const payload = (await response.json()) as { error: string; replacement: string };
      expect(payload.error).toContain(LIVE_STREAM_PATH);
      expect(payload.replacement).toBe(LIVE_STREAM_PATH);
    }
    await Bun.sleep(30);
    expect(childRequests.length).toBe(before);
  });

  test("sign-out ends that session's live streams", async () => {
    const doomed = (await sessionStore.issue("t", "doomed device")).id;
    const stream = await openStream("ws=project", { cookie: `uatu_hub=${doomed}` });
    await stream.waitFor(r => r.hello !== null, "hello");
    const logout = await fetch(`${origin}/logout`, { method: "POST", headers: { cookie: `uatu_hub=${doomed}`, origin }, redirect: "manual" });
    expect(logout.status).toBe(303);
    await stream.waitFor(r => r.ended, "stream ended on sign-out");
  });
});
