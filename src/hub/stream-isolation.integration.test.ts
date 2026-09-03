// Two browsers, one workspace, one hub. Each client's live streams must have
// an independent lifecycle: abandoning one has to reach the child and release
// its subscription, and must not close or stall the other's.
//
// The hub, its auth, and the whole proxy path are real. The child is a stand-in
// that counts its own subscribers per stream, because the assertion this file
// exists to make — "the child no longer counts it as a live subscription" — is
// only observable from inside the child.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RunningSession, SessionBackend } from "./backend";
import { EMPTY_CREDENTIAL_CONTEXT_RESOLVER } from "./credential-context";
import { hashPassword, HubSessionStore } from "./auth";
import type { HubConfig } from "./config";
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

const encoder = new TextEncoder();
const subscribers = new Map<number, Subscriber>();
let nextSubscriberId = 1;

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
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
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
      controller = null;
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
        return sseResponse("conversation", 'id: c0\nevent: chat\ndata: {"type":"conversation.status"}\n\n');
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
  hub = startHubServer({ config, registry, sessions, sessionStore, personalState });
  origin = `http://127.0.0.1:${hub.port}`;
  cookie = `uatu_hub=${(await sessionStore.issue("t", "test")).id}`;
});

afterAll(async () => {
  hub?.stop(true);
  child?.stop(true);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

// One browser-side stream: reads frames as they arrive and can be abandoned
// either by cancelling the body or by aborting the request.
async function openStream(pathname: string): Promise<{
  frames: string[];
  waitForFrames(count: number): Promise<void>;
  cancelBody(): Promise<void>;
  abortRequest(): void;
}> {
  const controller = new AbortController();
  const response = await fetch(`${origin}${pathname}`, {
    headers: { cookie, accept: "text/event-stream" },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  void (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        frames.push(decoder.decode(next.value, { stream: true }));
      }
    } catch {
      // Abandoned by the test; the assertions are on the child's view.
    }
  })();
  return {
    frames,
    async waitForFrames(count) {
      await waitFor(() => frames.length >= count, `${count} frames on ${pathname}`);
    },
    async cancelBody() {
      await reader.cancel().catch(() => undefined);
    },
    abortRequest() {
      controller.abort();
    },
  };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("proxied stream isolation between clients", () => {
  test("cancelling one client's document stream releases its child subscriber and leaves the other live", async () => {
    const first = await openStream("/s/project/api/events");
    const second = await openStream("/s/project/api/events");
    await first.waitForFrames(1);
    await second.waitForFrames(1);
    expect(liveCount("document")).toBe(2);

    await first.cancelBody();

    // Bounded: the child must stop counting it, not merely stop writing to it.
    await waitFor(() => liveCount("document") === 1, "the child to release the cancelled subscriber");

    // The survivor keeps receiving state without a reconnect.
    broadcast("document", 'event: state\ndata: {"generation":1}\n\n');
    await second.waitForFrames(2);
    expect(second.frames.at(-1)).toContain('"generation":1');
    expect(first.frames).toHaveLength(1);

    await second.cancelBody();
    await waitFor(() => liveCount("document") === 0, "every document subscriber to be released");
  }, 20_000);

  test("aborting one client's request releases the child subscriber too", async () => {
    const first = await openStream("/s/project/api/events");
    const second = await openStream("/s/project/api/events");
    await first.waitForFrames(1);
    await second.waitForFrames(1);
    expect(liveCount("document")).toBe(2);

    first.abortRequest();
    await waitFor(() => liveCount("document") === 1, "the child to release the aborted subscriber");

    broadcast("document", 'event: state\ndata: {"generation":2}\n\n');
    await second.waitForFrames(2);

    await second.cancelBody();
    await waitFor(() => liveCount("document") === 0, "every document subscriber to be released");
  }, 20_000);

  test("one client's Chat interruption and recovery neither closes nor delays the other's streams", async () => {
    const conversationPath = "/s/project/api/chat/conversations/opencode:local/events";
    const inventoryPath = "/s/project/api/chat/conversations/events";

    const watcher = {
      conversation: await openStream(conversationPath),
      inventory: await openStream(inventoryPath),
    };
    const flaky = {
      conversation: await openStream(conversationPath),
      inventory: await openStream(inventoryPath),
    };
    await watcher.conversation.waitForFrames(1);
    await watcher.inventory.waitForFrames(1);
    await flaky.conversation.waitForFrames(1);
    await flaky.inventory.waitForFrames(1);
    expect(liveCount("conversation")).toBe(2);
    expect(liveCount("inventory")).toBe(2);

    // The flaky client's transport drops — both of its streams at once, the
    // way a device losing its network path actually fails.
    flaky.conversation.abortRequest();
    await flaky.inventory.cancelBody();
    await waitFor(
      () => liveCount("conversation") === 1 && liveCount("inventory") === 1,
      "the child to release both of the interrupted client's subscribers",
    );

    // The other client is unaffected: still subscribed, still delivered to,
    // and not made to wait on the interruption.
    const deliveredAt = Date.now();
    broadcast("conversation", 'id: c1\nevent: chat\ndata: {"type":"conversation.status"}\n\n');
    broadcast("inventory", 'event: inventory\ndata: {"type":"conversation.inventory"}\n\n');
    await watcher.conversation.waitForFrames(2);
    await watcher.inventory.waitForFrames(2);
    expect(Date.now() - deliveredAt).toBeLessThan(2_000);

    // And the flaky client reconnects on its own, without disturbing the other.
    const recovered = {
      conversation: await openStream(`${conversationPath}?cursor=c0`),
      inventory: await openStream(inventoryPath),
    };
    await recovered.conversation.waitForFrames(1);
    await recovered.inventory.waitForFrames(1);
    expect(liveCount("conversation")).toBe(2);
    expect(liveCount("inventory")).toBe(2);

    broadcast("conversation", 'id: c2\nevent: chat\ndata: {"type":"conversation.status"}\n\n');
    await watcher.conversation.waitForFrames(3);
    await recovered.conversation.waitForFrames(2);
    // The interrupted client's original streams stayed closed — recovery
    // replaced them rather than reviving them.
    expect(flaky.conversation.frames).toHaveLength(1);
    expect(flaky.inventory.frames).toHaveLength(1);

    await Promise.all([
      watcher.conversation.cancelBody(),
      watcher.inventory.cancelBody(),
      recovered.conversation.cancelBody(),
      recovered.inventory.cancelBody(),
    ]);
    await waitFor(
      () => liveCount("conversation") === 0 && liveCount("inventory") === 0,
      "every Chat subscriber to be released",
    );
  }, 20_000);
});
