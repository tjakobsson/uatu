// Two browsers, one workspace, one hub. Each client's live stream must have
// an independent lifecycle: abandoning one has to release what only it
// watched, must not close or stall the other's, and a shared topic stays
// subscribed at the child exactly once until the last watcher leaves.
//
// The hub, its auth, and the whole brokered path are real. The child is a
// stand-in that counts its own subscribers per stream, because the assertion
// this file exists to make — "the child no longer counts it as a live
// subscription" — is only observable from inside the child.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { encodeReplayCursor } from "../chat/replay";
import { LIVE_STREAM_PATH, liveSubscriptionsPath, parseLiveEnvelope, parseLiveHello, type LiveEnvelope, type LiveSubscription } from "../shared/live-protocol";
import type { RunningSession, SessionBackend } from "./backend";
import { EMPTY_CREDENTIAL_CONTEXT_RESOLVER } from "./credential-context";
import { hashPassword, HubSessionStore } from "./auth";
import type { HubConfig } from "./config";
import { LiveBroker } from "./live-broker";
import { createHubUpstreamSource } from "./live-source";
import { SseFrameParser } from "./live-sse";
import { PersonalWorkspaceStateStore } from "./personal-state";
import { WorkspaceRegistry } from "./registry";
import { startHubServer } from "./server";
import { SessionManager } from "./sessions";

type StreamKind = "document" | "inventory" | "conversation";

type Subscriber = {
  kind: StreamKind;
  push(frame: string): void;
  close(): void;
};

const LINGER_MS = 200;
const encoder = new TextEncoder();
const subscribers = new Map<number, Subscriber>();
let nextSubscriberId = 1;
let conversationSequence = 0;
const cursorOf = (sequence: number) => encodeReplayCursor({ generation: "g", sequence });

function liveCount(kind: StreamKind): number {
  let total = 0;
  for (const subscriber of subscribers.values()) if (subscriber.kind === kind) total += 1;
  return total;
}

function broadcast(kind: StreamKind, frame: string): void {
  for (const subscriber of subscribers.values()) {
    if (subscriber.kind === kind) subscriber.push(frame);
  }
}

function sseResponse(kind: StreamKind, initial: string): Response {
  const id = nextSubscriberId++;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      subscribers.set(id, {
        kind,
        push(frame) {
          try {
            streamController.enqueue(encoder.encode(frame));
          } catch {
            subscribers.delete(id);
          }
        },
        close() {
          try {
            streamController.close();
          } catch {
            // Already gone.
          }
          subscribers.delete(id);
        },
      });
      streamController.enqueue(encoder.encode(initial));
    },
    cancel() {
      subscribers.delete(id);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform" },
  });
}

let tempRoot = "";
let child: ReturnType<typeof Bun.serve> | null = null;
let hub: ReturnType<typeof startHubServer> | null = null;
let sessions: SessionManager;
let sessionStore: HubSessionStore;
let origin = "";
let cookie = "";

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-streams-"));

  child = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/api/events")) {
        return sseResponse("document", 'event: state\ndata: {"generation":0}\n\n');
      }
      if (url.pathname.endsWith("/api/chat/conversations/events")) {
        return sseResponse("inventory", 'event: inventory\ndata: {"type":"conversation.inventory"}\n\n');
      }
      if (/\/api\/chat\/conversations\/[^/]+\/events$/.test(url.pathname)) {
        return sseResponse("conversation", ": open\n\n");
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
  sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
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
  const liveBroker = new LiveBroker(createHubUpstreamSource({ sessions, registry }), { lingerMs: LINGER_MS });
  hub = startHubServer({ config, registry, sessions, sessionStore, personalState, liveBroker });
  origin = `http://127.0.0.1:${hub.port}`;
  cookie = `uatu_hub=${(await sessionStore.issue("t", "test")).id}`;
});

afterAll(async () => {
  hub?.live.endAll();
  hub?.liveBroker.dispose();
  hub?.stop(true);
  child?.stop(true);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

// One browser tab: its single brokered stream, read as it arrives, and
// abandoned either by cancelling the body or by aborting the request.
async function openTab(subs: LiveSubscription[]): Promise<{
  hello: string | null;
  envelopes: LiveEnvelope[];
  ended: boolean;
  of(topic: string): LiveEnvelope[];
  waitFor(predicate: () => boolean, what: string): Promise<void>;
  change(body: unknown): Promise<Response>;
  cancelBody(): Promise<void>;
  abortRequest(): void;
}> {
  const controller = new AbortController();
  const response = await fetch(`${origin}${LIVE_STREAM_PATH}?ws=project&subs=${encodeURIComponent(JSON.stringify(subs))}`, {
    headers: { cookie, accept: "text/event-stream" },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const parser = new SseFrameParser();
  const tab = {
    hello: null as string | null,
    envelopes: [] as LiveEnvelope[],
    ended: false,
    of(topic: string) {
      return tab.envelopes.filter(envelope => envelope.topic === topic);
    },
    async waitFor(predicate: () => boolean, what: string) {
      await waitFor(predicate, what);
    },
    change(body: unknown) {
      return fetch(`${origin}${liveSubscriptionsPath(tab.hello!)}`, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    async cancelBody() {
      await reader.cancel().catch(() => undefined);
    },
    abortRequest() {
      controller.abort();
    },
  };
  void (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        for (const frame of parser.push(next.value)) {
          if ("comment" in frame) continue;
          if (frame.event === "hello") tab.hello = parseLiveHello(frame.data)?.streamId ?? null;
          if (frame.event === "live") {
            const envelope = parseLiveEnvelope(frame.data);
            if (envelope) tab.envelopes.push(envelope);
          }
        }
      }
    } catch {
      // Abandoned by the test; the assertions are on the child's view.
    } finally {
      tab.ended = true;
    }
  })();
  return tab;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const DOCUMENT: LiveSubscription = { topic: "document", key: "" };
const INVENTORY: LiveSubscription = { topic: "inventory" };
const conversation = (cursor?: string): LiveSubscription => ({ topic: "conversation", key: "opencode:local", ...(cursor ? { cursor } : {}) });

describe("brokered stream isolation between clients", () => {
  test("cancelling one client's stream leaves the shared document subscription with the other, released only when both are gone", async () => {
    const first = await openTab([DOCUMENT]);
    const second = await openTab([DOCUMENT]);
    await first.waitFor(() => first.of("document").length === 2, "first snapshot + ready");
    await second.waitFor(() => second.of("document").length === 2, "second snapshot + ready");
    // Fan-out: one child subscription for two tabs.
    expect(liveCount("document")).toBe(1);

    await first.cancelBody();
    await Bun.sleep(LINGER_MS * 2);
    expect(liveCount("document")).toBe(1);

    // The survivor keeps receiving state without a reconnect.
    broadcast("document", 'event: state\ndata: {"generation":1}\n\n');
    await second.waitFor(() => second.of("document").length === 3, "live state on the survivor");
    expect((second.of("document")[2]!.event as { data: { generation: number } }).data.generation).toBe(1);
    expect(first.of("document")).toHaveLength(2);

    await second.cancelBody();
    // Bounded: the child must stop counting it, not merely stop writing to it.
    await waitFor(() => liveCount("document") === 0, "the child to release the document subscriber after linger");
  }, 20_000);

  test("aborting one client's request releases only what it alone watched", async () => {
    const first = await openTab([DOCUMENT, INVENTORY]);
    const second = await openTab([DOCUMENT]);
    await first.waitFor(() => first.of("document").length === 2 && first.of("inventory").length >= 1, "first attached");
    await second.waitFor(() => second.of("document").length === 2, "second attached");
    expect(liveCount("document")).toBe(1);
    expect(liveCount("inventory")).toBe(1);

    first.abortRequest();
    await waitFor(() => liveCount("inventory") === 0, "the child to release the inventory subscriber only the aborted tab watched");
    expect(liveCount("document")).toBe(1);

    broadcast("document", 'event: state\ndata: {"generation":2}\n\n');
    await second.waitFor(() => second.of("document").length === 3, "live state on the survivor");

    await second.cancelBody();
    await waitFor(() => liveCount("document") === 0, "every document subscriber to be released");
  }, 20_000);

  test("one client's interruption and recovery neither closes nor delays the other's topics", async () => {
    const watcher = await openTab([conversation(cursorOf(0)), INVENTORY]);
    const flaky = await openTab([conversation(cursorOf(0)), INVENTORY]);
    await watcher.waitFor(() => watcher.of("conversation").length === 1 && watcher.of("inventory").length >= 1, "watcher attached");
    await flaky.waitFor(() => flaky.of("conversation").length === 1 && flaky.of("inventory").length >= 1, "flaky attached");
    expect(liveCount("conversation")).toBe(1);
    expect(liveCount("inventory")).toBe(1);

    // The flaky client's transport drops, the way a device losing its
    // network path actually fails. The shared topics stay subscribed for
    // the watcher; the child sees no churn.
    flaky.abortRequest();
    await waitFor(() => flaky.ended, "the flaky tab's stream to end");
    await Bun.sleep(LINGER_MS * 2);
    expect(liveCount("conversation")).toBe(1);
    expect(liveCount("inventory")).toBe(1);

    // The other client is unaffected: still subscribed, still delivered to,
    // and not made to wait on the interruption.
    const deliveredAt = Date.now();
    conversationSequence = 1;
    broadcast("conversation", `id: ${cursorOf(1)}\nevent: chat\ndata: {"type":"conversation.status"}\n\n`);
    broadcast("inventory", 'event: inventory\ndata: {"type":"conversation.inventory"}\n\n');
    await watcher.waitFor(() => watcher.of("conversation").length === 2, "conversation event on the watcher");
    await watcher.waitFor(() => watcher.of("inventory").some(e => e.event.kind === "data"), "inventory tick on the watcher");
    expect(Date.now() - deliveredAt).toBeLessThan(2_000);

    // And the flaky client reconnects on its own with its retained cursor:
    // the event it missed is replayed from the hub, without a child round
    // trip and without disturbing the other.
    const recovered = await openTab([conversation(cursorOf(0)), INVENTORY]);
    await recovered.waitFor(() => recovered.of("conversation").some(e => e.event.kind === "ready"), "recovered ready");
    const replayed = recovered.of("conversation").filter(e => e.event.kind === "data");
    expect(replayed.map(e => e.cursor)).toEqual([cursorOf(1)]);
    expect(liveCount("conversation")).toBe(1);
    expect(liveCount("inventory")).toBe(1);

    conversationSequence = 2;
    broadcast("conversation", `id: ${cursorOf(2)}\nevent: chat\ndata: {"type":"conversation.status"}\n\n`);
    await watcher.waitFor(() => watcher.of("conversation").length === 3, "watcher sees the third");
    await recovered.waitFor(() => recovered.of("conversation").filter(e => e.event.kind === "data").length === 2, "recovered sees it too");
    // The interrupted client's original stream stayed closed — recovery
    // replaced it rather than reviving it.
    expect(flaky.of("conversation")).toHaveLength(1);

    // Unsubscribing a topic on one stream (closing a drill-down) does not
    // touch the other's copy of that topic at the child.
    expect((await recovered.change({ remove: [{ topic: "conversation", key: "opencode:local" }] })).status).toBe(200);
    await Bun.sleep(LINGER_MS * 2);
    expect(liveCount("conversation")).toBe(1);
    broadcast("conversation", `id: ${cursorOf(3)}\nevent: chat\ndata: {"type":"conversation.status"}\n\n`);
    await watcher.waitFor(() => watcher.of("conversation").length === 4, "watcher still receives");
    expect(recovered.of("conversation").filter(e => e.event.kind === "data")).toHaveLength(2);

    await Promise.all([watcher.cancelBody(), recovered.cancelBody()]);
    await waitFor(() => liveCount("conversation") === 0 && liveCount("inventory") === 0, "every Chat subscriber to be released");
  }, 20_000);
});
