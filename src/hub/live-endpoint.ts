// The hub-brokered live stream's HTTP surface (design D2, D3):
//
//   GET  /api/hub/live                         one SSE stream per page
//   POST /api/hub/live/<streamId>/subscriptions  add/remove topics on it
//
// Generic over who the caller is and which workspace they may see: the hub
// mounts it behind its authentication gate with the registry as the
// workspace resolver; the e2e harness mounts it with one fixed identity and
// one workspace. The broker (live-broker.ts) owns upstreams; this module
// owns client streams — their write queues, keepalives, subscription sets,
// and endings.

import crypto from "node:crypto";

import type { MetricsRegistry } from "../debug/metrics";
import { StreamLifecycleMetrics, type StreamOutcome } from "../debug/stream-metrics";
import {
  formatLiveEnvelope,
  formatLiveHello,
  LIVE_KEEPALIVE_FRAME,
  LIVE_KEEPALIVE_MS,
  LIVE_MAX_SUBSCRIPTIONS,
  LIVE_OPEN_FRAME,
  liveSubscriptionId,
  parseLiveStreamQuery,
  parseLiveSubscriptionChange,
  type LiveEnvelope,
  type LiveSubscription,
} from "../shared/live-protocol";
import type { LiveAttachment, LiveBroker } from "./live-broker";

export type LivePrincipal = {
  user: string;
  // The hub session id the stream was opened with. Subscription control
  // must present the same one (D3): two tabs of one user are independent,
  // and one user can never steer another's stream.
  sessionId: string;
};

export type LiveEndpointDeps = {
  broker: LiveBroker;
  // The canonical id of the workspace a stream serves, or null to refuse.
  resolveWorkspace(requested: string | null): string | null;
  // Re-checked on every keepalive: a revoked or expired session ends its
  // streams within one interval even without the explicit hook.
  principalStillValid?(principal: LivePrincipal): boolean;
  keepaliveMs?: number;
  // A client that stops reading is ended (it reconnects with cursors)
  // rather than growing hub memory. Bounds the backlog queued behind unread
  // data, never the frame being added: see ClientStream.enqueue.
  maxQueuedBytes?: number;
  metrics?: MetricsRegistry;
  streamId?(): string;
};

const NO_STORE = { "cache-control": "no-store" };
const MAX_QUEUED_BYTES = 1024 * 1024;
const STREAM_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store, no-transform",
  "x-accel-buffering": "no",
};

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

// 192 bits of randomness, base64url: unguessable, URL-safe.
function randomStreamId(): string {
  return crypto.randomBytes(24).toString("base64url");
}

type QueuedFrame = {
  subscriptionId: string | null;
  text: string;
  bytes: number;
  // A full snapshot the next one of its subscription supersedes: only the
  // newest undelivered is worth holding, and it stands outside the backlog
  // bound because coalescing already bounds it to one per subscription.
  coalescible: boolean;
};

class ClientStream {
  readonly subscriptions = new Map<string, LiveAttachment>();
  activity: LiveAttachment | null = null;
  private readonly queue: QueuedFrame[] = [];
  // Bytes of the queued frames that are not coalescible: the backlog the
  // cap applies to.
  private backlogBytes = 0;
  private wake: (() => void) | null = null;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private outcome: StreamOutcome | null = null;
  private readonly encoder = new TextEncoder();

  constructor(
    readonly id: string,
    readonly principal: LivePrincipal,
    readonly workspaceId: string,
    private readonly onEnd: (stream: ClientStream, outcome: StreamOutcome) => void,
    private readonly maxQueuedBytes: number,
  ) {}

  get ended(): boolean {
    return this.outcome !== null;
  }

  // The broker's sink for this stream. Envelopes are queued for the pull
  // loop, tagged with their subscription so a removal can purge what has
  // not left yet. A `resync` detaches its subscription broker-side; the
  // record goes too, so a later `add` is a fresh attach and a stray
  // `remove` a no-op.
  write(envelope: LiveEnvelope): void {
    if (this.ended) return;
    const subscriptionId = envelope.topic === "activity" ? null : liveSubscriptionId({ topic: envelope.topic, key: envelope.key });
    if (envelope.event.kind === "resync" && subscriptionId !== null) this.subscriptions.delete(subscriptionId);
    // Document frames are full workspace snapshots (megabytes for a large
    // tree); conversation frames are events and are never coalesced.
    const coalescible = envelope.topic === "document" && envelope.event.kind === "data";
    this.enqueue(subscriptionId, formatLiveEnvelope(envelope), coalescible);
  }

  writeRaw(text: string): void {
    if (this.ended) return;
    this.enqueue(null, text, false);
  }

  // The frame being added is always admitted, whatever its size: the cap
  // is a stall detector, not a frame-size limit, and refusing a snapshot
  // larger than it would end every stream of a large workspace on open,
  // forever (the cursor never advances, so the reconnect gets the same
  // snapshot). What the cap bounds is the non-coalescible backlog already
  // waiting unread when a frame arrives — a client that has not drained
  // that much is stalled and is ended (it reconnects with cursors).
  private enqueue(subscriptionId: string | null, text: string, coalescible: boolean): void {
    if (this.backlogBytes > this.maxQueuedBytes) {
      this.end("failed");
      return;
    }
    const bytes = text.length;
    if (coalescible) {
      // The newest snapshot takes the slot of the oldest undelivered one for
      // its subscription, so it still precedes the signals that followed
      // that one (`ready` after the attach snapshot); signals never move a
      // client's cursor, so the order is harmless either way.
      const slot = this.queue.find(frame => frame.coalescible && frame.subscriptionId === subscriptionId);
      if (slot) {
        slot.text = text;
        slot.bytes = bytes;
        this.wake?.();
        return;
      }
    } else {
      this.backlogBytes += bytes;
    }
    this.queue.push({ subscriptionId, text, bytes, coalescible });
    this.wake?.();
  }

  purge(subscriptionId: string): void {
    let index = 0;
    while (index < this.queue.length) {
      const frame = this.queue[index]!;
      if (frame.subscriptionId === subscriptionId) {
        this.queue.splice(index, 1);
        if (!frame.coalescible) this.backlogBytes -= frame.bytes;
      } else {
        index += 1;
      }
    }
  }

  body(request: Request, keepaliveMs: number, stillValid: () => boolean): ReadableStream<Uint8Array> {
    const onAbort = () => this.end("cancelled");
    if (request.signal.aborted) this.end("cancelled");
    else request.signal.addEventListener("abort", onAbort, { once: true });
    return new ReadableStream<Uint8Array>({
      start: controller => {
        this.controller = controller;
        if (this.ended) {
          // Gone before the body was even constructed: nothing to keep alive.
          controller.close();
          return;
        }
        // Headers leave with the first chunk (the #350 lesson): the opening
        // comment and hello go out at once, before any topic has data.
        controller.enqueue(this.encoder.encode(LIVE_OPEN_FRAME + formatLiveHello({ streamId: this.id })));
        this.keepalive = setInterval(() => {
          if (!stillValid()) {
            this.end("completed");
            return;
          }
          this.writeRaw(LIVE_KEEPALIVE_FRAME);
        }, keepaliveMs);
        if (typeof this.keepalive.unref === "function") this.keepalive.unref();
      },
      pull: async controller => {
        for (;;) {
          if (this.ended) {
            try {
              controller.close();
            } catch {
              // Already closed.
            }
            return;
          }
          const frame = this.queue.shift();
          if (frame) {
            if (!frame.coalescible) this.backlogBytes -= frame.bytes;
            controller.enqueue(this.encoder.encode(frame.text));
            return;
          }
          await new Promise<void>(resolve => {
            this.wake = resolve;
          });
          this.wake = null;
        }
      },
      cancel: () => {
        request.signal.removeEventListener("abort", onAbort);
        this.end("cancelled");
      },
    }, { highWaterMark: 0 });
  }

  end(outcome: StreamOutcome): void {
    if (this.ended) return;
    this.outcome = outcome;
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    // Drained rather than iterated: a detach may write (and so re-enter
    // here, a no-op) or the caller may still be mid-attach — anything that
    // lands in the maps while this runs is released too.
    for (;;) {
      const next = this.subscriptions.entries().next();
      if (next.done) break;
      const [id, attachment] = next.value;
      this.subscriptions.delete(id);
      attachment.detach();
    }
    while (this.activity) {
      const activity = this.activity;
      this.activity = null;
      activity.detach();
    }
    this.queue.length = 0;
    this.backlogBytes = 0;
    this.wake?.();
    try {
      this.controller?.close();
    } catch {
      // The consumer is already gone.
    }
    this.onEnd(this, outcome);
  }
}

export class LiveEndpoint {
  private readonly streams = new Map<string, ClientStream>();
  private readonly metrics: StreamLifecycleMetrics;
  private readonly keepaliveMs: number;
  private readonly maxQueuedBytes: number;

  constructor(private readonly deps: LiveEndpointDeps) {
    this.metrics = new StreamLifecycleMetrics(deps.metrics);
    this.keepaliveMs = deps.keepaliveMs ?? LIVE_KEEPALIVE_MS;
    this.maxQueuedBytes = deps.maxQueuedBytes ?? MAX_QUEUED_BYTES;
  }

  streamCount(): number {
    return this.streams.size;
  }

  // GET /api/hub/live — the caller has already authenticated `principal`.
  openStream(request: Request, principal: LivePrincipal): Response {
    const query = parseLiveStreamQuery(new URL(request.url).searchParams);
    if ("error" in query) return json(400, { error: query.error });
    const workspaceId = this.deps.resolveWorkspace(query.ws);
    if (workspaceId === null) return json(404, { error: "unknown workspace" });
    if (query.subs.length > LIVE_MAX_SUBSCRIPTIONS) return json(400, { error: "too many subscriptions" });

    const stream = new ClientStream(
      (this.deps.streamId ?? randomStreamId)(),
      principal,
      workspaceId,
      (ended, outcome) => {
        if (this.streams.get(ended.id) === ended) this.streams.delete(ended.id);
        this.metrics.closed("hub-live", outcome);
      },
      this.maxQueuedBytes,
    );
    this.streams.set(stream.id, stream);
    this.metrics.opened("hub-live", { reconnect: query.reconnect });
    const stillValid = () => this.deps.principalStillValid?.(principal) ?? true;
    const body = stream.body(request, this.keepaliveMs, stillValid);
    // Attach after the opening frames are queued so envelopes follow hello.
    // Any attach can end the stream (its synchronous writes overflow the
    // queue), so `ended` is re-read before each one.
    for (const subscription of query.subs) {
      if (stream.ended) break;
      this.attach(stream, subscription);
    }
    if (query.activity && !stream.ended) this.attachActivity(stream);
    return new Response(body, { status: 200, headers: STREAM_HEADERS });
  }

  // POST /api/hub/live/<streamId>/subscriptions — CSRF and authentication
  // are the caller's; this binds the change to the stream and its session.
  async changeSubscriptions(request: Request, streamId: string, principal: LivePrincipal): Promise<Response> {
    const stream = this.streams.get(streamId);
    if (!stream || stream.ended) return json(404, { error: "unknown stream" });
    if (stream.principal.sessionId !== principal.sessionId) return json(403, { error: "stream belongs to another session" });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
    const change = parseLiveSubscriptionChange(body);
    if ("error" in change) return json(400, { error: change.error });
    // Removals before adds; the resulting set stays bounded.
    const resulting = new Set(stream.subscriptions.keys());
    for (const key of change.remove ?? []) resulting.delete(liveSubscriptionId(key));
    for (const subscription of change.add ?? []) resulting.add(liveSubscriptionId(subscription));
    if (resulting.size > LIVE_MAX_SUBSCRIPTIONS) return json(400, { error: "too many subscriptions" });
    if (stream.ended) return json(404, { error: "unknown stream" });
    for (const key of change.remove ?? []) this.detach(stream, liveSubscriptionId(key));
    for (const subscription of change.add ?? []) {
      // An add replays onto the queue; on a nearly full one that ends the
      // stream, and the later adds must not attach to the corpse.
      if (stream.ended) break;
      this.attach(stream, subscription);
    }
    return json(200, { ok: true });
  }

  // Sign-out or revocation: every stream that session opened ends now.
  endStreamsForSession(sessionId: string): void {
    for (const stream of [...this.streams.values()]) {
      if (stream.principal.sessionId === sessionId) stream.end("completed");
    }
  }

  endAll(): void {
    for (const stream of [...this.streams.values()]) stream.end("completed");
  }

  // The broker's subscribe writes synchronously (the latest document
  // snapshot and its `ready`, a replay, the activity snapshot) and returns
  // its handle afterwards. If a write ended the stream, `end()` has already
  // drained the maps, so the handle it returns would be stored on a dead
  // stream and never detached: its upstream would never linger out and
  // would pin a child fetch for the hub's lifetime. Detach such a handle at
  // once instead.
  private attach(stream: ClientStream, subscription: LiveSubscription): void {
    const id = liveSubscriptionId(subscription);
    // `add` of a subscribed key replaces it: re-attach from the new cursor,
    // and nothing queued for the old attachment survives.
    this.detach(stream, id);
    const attachment = this.deps.broker.subscribe(stream, stream.workspaceId, subscription);
    if (stream.ended) {
      attachment.detach();
      return;
    }
    stream.subscriptions.set(id, attachment);
  }

  private attachActivity(stream: ClientStream): void {
    const attachment = this.deps.broker.subscribeActivity(stream, stream.principal.user);
    if (stream.ended) {
      attachment.detach();
      return;
    }
    stream.activity = attachment;
  }

  private detach(stream: ClientStream, id: string): void {
    const existing = stream.subscriptions.get(id);
    if (existing) {
      stream.subscriptions.delete(id);
      existing.detach();
    }
    stream.purge(id);
  }
}
