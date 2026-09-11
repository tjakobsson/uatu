// The hub's live-stream broker: one upstream subscription per
// (workspace, topic, key) to a child's internal SSE routes, refcounted by
// the client streams interested in it and fanned out to them as typed
// envelopes (design D1, D4, D5). Upstream connections are a function of what
// is watched, never of how many tabs watch it.
//
// Topics and their cursors (src/shared/live-protocol.ts is the contract):
//
//   document      child /api/events?<context>. Every frame is a full state
//                 snapshot, so a "replay" is the latest snapshot: a joiner
//                 behind the head gets it as `data`, one at the head gets
//                 nothing. Cursors are hub-assigned (`<epoch>.<seq>`).
//   inventory     child /api/chat/conversations/events — an invalidation
//                 tick. A joiner behind the head gets one tick. Hub cursors.
//   conversation  child /api/chat/conversations/<id>/events. Cursors are the
//                 child's own SSE ids (replay.ts). A bounded byte buffer
//                 replays a cursor inside it; one behind the buffer is
//                 caught up by a transient fetch of the child's own replay
//                 that merges into the shared upstream; a cursor the child
//                 cannot replay arrives as the child's `resync`.
//   activity      child /api/activity, one upstream per running workspace
//                 shared by every user's feed (D5). Feeds merge hub session
//                 state (`running`) with the child's {working, awaiting}.
//
// Lifecycle: the first subscriber opens the upstream; the last leaving
// starts a linger, after which the upstream is aborted — explicitly, so the
// cancellation reaches the child (resilient-live-connections D5). A failed
// upstream (fetch rejection, non-2xx, unexpected end, child exit) signals
// `unavailable` once per subscriber, keeps every client stream open, and
// retries with capped backoff while subscribers remain; recovery sends
// `ready` (with fresh data where the topic needs it). A session start/stop
// notification retries or fails at once instead of at the next tick.

import { decodeReplayCursor, type ReplayCursor } from "../chat/replay";
import type { MetricsRegistry } from "../debug/metrics";
import { UpstreamSubscriptionMetrics, type UpstreamTopic } from "../debug/stream-metrics";
import {
  CHILD_ACTIVITY_EVENT,
  CHILD_ACTIVITY_PATH,
  CHILD_DOCUMENT_EVENTS_PATH,
  CHILD_INVENTORY_EVENTS_PATH,
  childConversationEventsPath,
  sanitizeWorkspaceActivity,
  type LiveEnvelope,
  type LiveEvent,
  type LiveSubscription,
  type LiveTopic,
  type WorkspaceActivity,
  CHILD_CONVERSATION_OPEN_EVENT,
} from "../shared/live-protocol";
import { SseFrameParser, type SseFrame } from "./live-sse";
import { statusCategoryOf, type ProxyStatusCategory } from "./proxy";

// Where upstream bytes come from. The hub implements it over the session
// manager and the brokered child token; unit tests and the e2e harness
// supply their own.
export type LiveUpstreamRequest = {
  workspaceId: string;
  // Child-relative path including its query, e.g. "/api/events?scope=…".
  path: string;
  signal: AbortSignal;
};

export type LiveSessionChange = { workspaceId: string; running: boolean };

export type LiveUpstreamSource = {
  isRunning(workspaceId: string): boolean;
  // Every registered workspace, running or not — the activity topic
  // describes all of them.
  workspaceIds(): string[];
  // Rejects when the workspace has no running child.
  open(request: LiveUpstreamRequest): Promise<Response>;
  onSessionChange?(listener: (change: LiveSessionChange) => void): () => void;
};

export type LiveSink = {
  write(envelope: LiveEnvelope): void;
};

export type LiveAttachment = {
  detach(): void;
};

export type LiveBrokerOptions = {
  lingerMs?: number;
  replayBufferBytes?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  // The child's inventory route opens with an `: open` comment frame
  // (src/server/routes.ts), so a current child's fetch resolves at once and
  // the first chunk makes the upstream live before this grace can fire.
  // The grace stays for a child that lacks the frame — one reached through
  // a SessionBackend other than the local one, which spawns from the hub's
  // own binary — where Bun holds the response headers until the first
  // chunk and the fetch would not resolve until the first invalidation.
  // Such an upstream is presumed live after the grace unless the fetch has
  // rejected; a later rejection still signals `unavailable`.
  inventoryOpenGraceMs?: number;
  metrics?: MetricsRegistry;
};

export type LiveUpstreamDiagnostic = { topic: UpstreamTopic; status: ProxyStatusCategory };
export type LiveUpstreamDiagnosticSink = (record: LiveUpstreamDiagnostic) => void;

// Only failures speak, and they say nothing but the topic class and the
// status category (design D6).
const defaultDiagnosticSink: LiveUpstreamDiagnosticSink = record => {
  console.error(`uatu hub: live upstream ${record.topic} subscription failed (${record.status})`);
};

let diagnosticSink: LiveUpstreamDiagnosticSink = defaultDiagnosticSink;

export function setLiveUpstreamDiagnostics(sink: LiveUpstreamDiagnosticSink | null): void {
  diagnosticSink = sink ?? defaultDiagnosticSink;
}

function recordUpstreamFailure(record: LiveUpstreamDiagnostic): void {
  try {
    diagnosticSink(record);
  } catch {
    // A diagnostic never takes the broker down with it.
  }
}

export const LIVE_LINGER_MS = 3_000;
export const LIVE_REPLAY_BUFFER_BYTES = 256 * 1024;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 15_000;
const INVENTORY_OPEN_GRACE_MS = 250;

type UpstreamState = "idle" | "opening" | "live" | "failed" | "unsupported" | "closed";

type Subscriber = {
  sink: LiveSink;
  workspaceId: string;
  topic: LiveTopic;
  key: string | undefined;
  // The last cursor this subscriber applied: presented on attach, advanced
  // on every `data` written to it.
  cursor: string | undefined;
  // Receives fan-out. False while pending (upstream not live) or while a
  // conversation catch-up is in flight.
  live: boolean;
  // Conversation: fan-out skips events at or before this (same generation)
  // — the subscriber already holds them from its snapshot or catch-up.
  skip: ReplayCursor | null;
  catchUp: AbortController | null;
  notifiedUnavailable: boolean;
  detached: boolean;
};

type BufferedEvent = { cursor: string; data: unknown; bytes: number };

class Upstream {
  readonly subscribers = new Set<Subscriber>();
  state: UpstreamState = "idle";
  abort: AbortController | null = null;
  // Hub-assigned cursor prefix, new per (re)open of a hub-cursored topic.
  epoch = "";
  seq = 0;
  // Latest cursor: the child's id for conversations, hub-assigned otherwise.
  head = "";
  // Conversation: the cursor the current fetch was opened from.
  originCursor: string | undefined;
  buffer: BufferedEvent[] = [];
  bufferBytes = 0;
  // Document / activity: the latest snapshot, retained regardless of bytes.
  latest: { cursor: string; data: unknown } | null = null;
  lingerTimer: ReturnType<typeof setTimeout> | null = null;
  retryTimer: ReturnType<typeof setTimeout> | null = null;
  retryDelayMs = 0;
  // True from a failure until the next successful open: the failure counter
  // and log speak once per episode, not once per retry.
  failing = false;
  // Whether this upstream has moved the active gauge. Set by its first
  // attempt, so a retry is not counted twice and a release only returns what
  // was counted.
  counted = false;
  // When the latest open attempt began, and when the pending retry fires:
  // together they bound how often subscribers joining a failed upstream can
  // make the broker try the child again.
  lastAttemptAt = 0;
  retryAt = 0;
  // The subscriber whose child replay is in flight. One per upstream: child
  // requests must not scale with the number of lagging clients.
  catchUpOwner: Subscriber | null = null;

  constructor(
    readonly id: string,
    readonly workspaceId: string,
    readonly topic: LiveTopic,
    readonly key: string | undefined,
  ) {}
}

function upstreamId(workspaceId: string, topic: LiveTopic, key: string | undefined): string {
  return `${workspaceId}\n${topic}\n${key ?? ""}`;
}

function newEpoch(): string {
  return Math.random().toString(36).slice(2, 10);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const NOT_RUNNING: WorkspaceActivity = { running: false, working: false, awaiting: false };
const RUNNING_UNKNOWN: WorkspaceActivity = { running: true, working: false, awaiting: false };

function sameActivity(a: WorkspaceActivity, b: WorkspaceActivity): boolean {
  return a.running === b.running && a.working === b.working && a.awaiting === b.awaiting;
}

// One user's activity feed: the set of that user's streams that asked for
// the topic, the last value emitted per workspace, and one broker
// subscription per running workspace's activity upstream.
class ActivityFeed {
  readonly sinks = new Set<LiveSink>();
  readonly last = new Map<string, WorkspaceActivity>();
  readonly attachments = new Map<string, LiveAttachment>();
  readonly epoch = newEpoch();
  seq = 0;
}

export class LiveBroker {
  private readonly upstreams = new Map<string, Upstream>();
  private readonly feeds = new Map<string, ActivityFeed>();
  private readonly lingerMs: number;
  private readonly replayBufferBytes: number;
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;
  private readonly inventoryOpenGraceMs: number;
  private readonly metrics: UpstreamSubscriptionMetrics;
  private readonly unsubscribeSessions: (() => void) | null;
  private disposed = false;

  constructor(private readonly source: LiveUpstreamSource, options: LiveBrokerOptions = {}) {
    this.lingerMs = options.lingerMs ?? LIVE_LINGER_MS;
    this.replayBufferBytes = options.replayBufferBytes ?? LIVE_REPLAY_BUFFER_BYTES;
    this.retryMinMs = options.retryMinMs ?? RETRY_MIN_MS;
    this.retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS;
    this.inventoryOpenGraceMs = options.inventoryOpenGraceMs ?? INVENTORY_OPEN_GRACE_MS;
    this.metrics = new UpstreamSubscriptionMetrics(options.metrics);
    this.unsubscribeSessions = source.onSessionChange?.(change => this.onSessionChange(change)) ?? null;
  }

  // ---------------------------------------------------------------------
  // Public API

  // Attaches a client sink to one workspace topic. The subscription's
  // cursor is where the sink resumes from (absent: the current position).
  subscribe(sink: LiveSink, workspaceId: string, subscription: LiveSubscription): LiveAttachment {
    if (this.disposed) throw new Error("live broker is disposed");
    return this.attachSink(sink, workspaceId, subscription.topic, subscription.key, subscription.cursor);
  }

  private attachSink(sink: LiveSink, workspaceId: string, topic: LiveTopic, key: string | undefined, cursor: string | undefined): LiveAttachment {
    const subscriber: Subscriber = {
      sink,
      workspaceId,
      topic,
      key,
      cursor,
      live: false,
      skip: null,
      catchUp: null,
      notifiedUnavailable: false,
      detached: false,
    };
    this.attachSubscriber(subscriber, topic, key);
    return { detach: () => this.detach(subscriber) };
  }

  // Attaches a client sink to the user's activity feed: one `data` per
  // registered workspace now, then one whenever a workspace's facts change.
  subscribeActivity(sink: LiveSink, user: string): LiveAttachment {
    if (this.disposed) throw new Error("live broker is disposed");
    let feed = this.feeds.get(user);
    if (!feed) {
      feed = new ActivityFeed();
      this.feeds.set(user, feed);
    }
    // Reconcile before adding the sink: changes reach the feed's existing
    // sinks, and the new one gets the whole picture below.
    this.refreshFeed(user, feed);
    feed.sinks.add(sink);
    for (const [workspaceId, activity] of feed.last) {
      sink.write(this.activityEnvelope(feed, workspaceId, activity));
    }
    return {
      detach: () => {
        feed.sinks.delete(sink);
        if (feed.sinks.size > 0 || this.feeds.get(user) !== feed) return;
        this.feeds.delete(user);
        for (const attachment of feed.attachments.values()) attachment.detach();
        feed.attachments.clear();
      },
    };
  }

  // Test and diagnostic visibility: the live upstream count per topic.
  upstreamCount(topic?: LiveTopic): number {
    let total = 0;
    for (const upstream of this.upstreams.values()) {
      if (upstream.state === "closed") continue;
      if (topic === undefined || upstream.topic === topic) total += 1;
    }
    return total;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeSessions?.();
    for (const upstream of [...this.upstreams.values()]) this.drop(upstream, false);
    this.feeds.clear();
  }

  // ---------------------------------------------------------------------
  // Subscriptions

  private attachSubscriber(subscriber: Subscriber, topic: LiveTopic, key: string | undefined): void {
    const id = upstreamId(subscriber.workspaceId, topic, key);
    let upstream = this.upstreams.get(id);
    if (!upstream) {
      upstream = new Upstream(id, subscriber.workspaceId, topic, key);
      this.upstreams.set(id, upstream);
    }
    if (upstream.lingerTimer) {
      clearTimeout(upstream.lingerTimer);
      upstream.lingerTimer = null;
    }
    upstream.subscribers.add(subscriber);
    switch (upstream.state) {
      case "idle":
        this.open(upstream);
        return;
      case "live":
      case "unsupported":
        this.attachLive(upstream, subscriber);
        return;
      case "failed": {
        // Told at once. A page joining a failed upstream must not inherit the
        // backoff an earlier episode accrued, but tabs joining one after
        // another must not each restart it either: joiners within the retry
        // floor share the attempt that failed and bring the next one forward
        // to the floor. A joiner after the floor tries again now.
        this.signalUnavailable(upstream, subscriber);
        upstream.retryDelayMs = 0;
        const sinceAttempt = Date.now() - upstream.lastAttemptAt;
        if (sinceAttempt >= this.retryMinMs) this.open(upstream);
        else this.retryWithin(upstream, this.retryMinMs - sinceAttempt);
        return;
      }
      case "opening":
      case "closed":
        // Pending until the fetch settles; `closed` cannot be in the map.
        return;
    }
  }

  private detach(subscriber: Subscriber): void {
    if (subscriber.detached) return;
    subscriber.detached = true;
    subscriber.live = false;
    subscriber.catchUp?.abort();
    subscriber.catchUp = null;
    const upstream = this.upstreams.get(upstreamId(subscriber.workspaceId, subscriber.topic, subscriber.key));
    if (upstream?.catchUpOwner === subscriber) upstream.catchUpOwner = null;
    if (!upstream || !upstream.subscribers.delete(subscriber)) return;
    if (upstream.subscribers.size > 0 || upstream.lingerTimer) return;
    // Linger: a reload or a quick A→B→A reuses the upstream instead of
    // thrashing the child.
    upstream.lingerTimer = setTimeout(() => {
      upstream.lingerTimer = null;
      if (upstream.subscribers.size === 0) this.drop(upstream, true);
    }, this.lingerMs);
    if (typeof upstream.lingerTimer.unref === "function") upstream.lingerTimer.unref();
  }

  private envelope(subscriber: Subscriber, event: LiveEvent, cursor: string): LiveEnvelope {
    return {
      ws: subscriber.workspaceId,
      topic: subscriber.topic,
      ...(subscriber.key === undefined ? {} : { key: subscriber.key }),
      cursor,
      event,
    };
  }

  private emitData(subscriber: Subscriber, data: unknown, cursor: string): void {
    if (subscriber.detached) return;
    subscriber.cursor = cursor;
    subscriber.sink.write(this.envelope(subscriber, { kind: "data", data }, cursor));
  }

  private emitSignal(subscriber: Subscriber, event: Exclude<LiveEvent, { kind: "data" }>, upstream: Upstream): void {
    if (subscriber.detached) return;
    subscriber.sink.write(this.envelope(subscriber, event, upstream.head || subscriber.cursor || ""));
  }

  private signalUnavailable(upstream: Upstream, subscriber: Subscriber): void {
    subscriber.live = false;
    if (subscriber.notifiedUnavailable) return;
    subscriber.notifiedUnavailable = true;
    this.emitSignal(subscriber, { kind: "unavailable" }, upstream);
  }

  // The upstream is live: hand the subscriber whatever its cursor is owed,
  // then `ready`. Sets `live` first so fan-out and replay cannot interleave
  // (everything here is synchronous).
  private attachLive(upstream: Upstream, subscriber: Subscriber): void {
    subscriber.notifiedUnavailable = false;
    switch (upstream.topic) {
      case "document":
      case "activity": {
        subscriber.live = true;
        if (upstream.latest && subscriber.cursor !== upstream.head) {
          this.emitData(subscriber, upstream.latest.data, upstream.latest.cursor);
        }
        this.emitSignal(subscriber, { kind: "ready" }, upstream);
        return;
      }
      case "inventory": {
        subscriber.live = true;
        // A cursor that is not the head — from an earlier epoch or behind
        // this one — means an invalidation may have been missed: one tick
        // stands for every tick it would have replayed.
        if (subscriber.cursor !== undefined && subscriber.cursor !== upstream.head) {
          this.emitData(subscriber, { type: "conversation.inventory" }, upstream.head);
        }
        this.emitSignal(subscriber, { kind: "ready" }, upstream);
        return;
      }
      case "conversation":
        this.attachConversation(upstream, subscriber);
        return;
    }
  }

  private attachConversation(upstream: Upstream, subscriber: Subscriber): void {
    subscriber.skip = null;
    if (subscriber.cursor === undefined || subscriber.cursor === upstream.head) {
      subscriber.live = true;
      this.emitSignal(subscriber, { kind: "ready" }, upstream);
      return;
    }
    const cursor = decodeReplayCursor(subscriber.cursor);
    if (!cursor) {
      this.catchUp(upstream, subscriber);
      return;
    }
    const head = upstream.head ? decodeReplayCursor(upstream.head) : null;
    if (head) {
      if (cursor.generation !== head.generation) {
        this.catchUp(upstream, subscriber);
        return;
      }
      if (cursor.sequence > head.sequence) {
        // The snapshot raced the upstream: those events are still to come.
        subscriber.skip = cursor;
        subscriber.live = true;
        this.emitSignal(subscriber, { kind: "ready" }, upstream);
        return;
      }
      const oldest = upstream.buffer[0] ? decodeReplayCursor(upstream.buffer[0].cursor) : null;
      if (oldest && oldest.generation === head.generation && cursor.sequence >= oldest.sequence - 1) {
        subscriber.live = true;
        this.replayFromBuffer(upstream, subscriber, cursor);
        this.emitSignal(subscriber, { kind: "ready" }, upstream);
        return;
      }
      this.catchUp(upstream, subscriber);
      return;
    }
    // Nothing seen on this upstream yet: the child replays from the origin
    // cursor into it, so anything at or after the origin arrives here.
    const origin = upstream.originCursor ? decodeReplayCursor(upstream.originCursor) : null;
    if (origin && cursor.generation === origin.generation && cursor.sequence >= origin.sequence) {
      if (cursor.sequence > origin.sequence) subscriber.skip = cursor;
      subscriber.live = true;
      this.emitSignal(subscriber, { kind: "ready" }, upstream);
      return;
    }
    // Behind the origin, from another generation, or with no origin known
    // (a child that did not name where its stream begins): the shared stream
    // cannot deliver what lies between this cursor and its start, so the
    // child replays it. Marking it ready here would skip the gap silently.
    this.catchUp(upstream, subscriber);
  }

  private replayFromBuffer(upstream: Upstream, subscriber: Subscriber, after: ReplayCursor): void {
    let last: ReplayCursor = after;
    for (const entry of upstream.buffer) {
      const at = decodeReplayCursor(entry.cursor);
      if (!at || at.generation !== after.generation || at.sequence <= after.sequence) continue;
      this.emitData(subscriber, entry.data, entry.cursor);
      last = at;
    }
    subscriber.skip = last;
  }

  // A transient fetch of the child's own replay from the subscriber's
  // cursor, forwarded to that subscriber alone until it reaches an event the
  // shared upstream holds (or is about to), then merged. The child's resync
  // for an unreplayable cursor is forwarded as the topic-scoped `resync`.
  private catchUp(upstream: Upstream, subscriber: Subscriber): void {
    subscriber.live = false;
    subscriber.catchUp?.abort();
    subscriber.catchUp = null;
    const owner = upstream.catchUpOwner;
    if (owner && owner !== subscriber && !owner.detached && owner.catchUp) {
      // One child replay per upstream at a time. A second subscriber behind
      // the buffer while it runs takes a fresh snapshot — one short request
      // from its client — instead of a long-lived child request of its own,
      // so several tabs waking together cannot multiply child connections.
      subscriber.sink.write(this.envelope(subscriber, { kind: "resync" }, upstream.head || subscriber.cursor || ""));
      this.detach(subscriber);
      return;
    }
    upstream.catchUpOwner = subscriber;
    const controller = new AbortController();
    subscriber.catchUp = controller;
    const path = `${childConversationEventsPath(upstream.key ?? "")}?cursor=${encodeURIComponent(subscriber.cursor ?? "")}`;
    const finishWithResync = (data?: unknown) => {
      if (controller.signal.aborted || subscriber.detached) return;
      subscriber.catchUp = null;
      controller.abort();
      subscriber.sink.write(this.envelope(subscriber, data === undefined ? { kind: "resync" } : { kind: "resync", data }, upstream.head || subscriber.cursor || ""));
      this.detach(subscriber);
    };
    void (async () => {
      let response: Response;
      try {
        response = await this.source.open({ workspaceId: upstream.workspaceId, path, signal: controller.signal });
      } catch {
        finishWithResync();
        return;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        finishWithResync();
        return;
      }
      const parser = new SseFrameParser();
      const reader = response.body.getReader();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          for (const frame of parser.push(next.value)) {
            if ("comment" in frame) continue;
            if (controller.signal.aborted || subscriber.detached) return;
            if (frame.event === "resync") {
              finishWithResync(parseJson(frame.data));
              return;
            }
            if (frame.event !== "chat" || frame.id === undefined) continue;
            this.emitData(subscriber, parseJson(frame.data), frame.id);
            if (this.mergeCatchUp(upstream, subscriber, frame.id)) {
              subscriber.catchUp = null;
              if (upstream.catchUpOwner === subscriber) upstream.catchUpOwner = null;
              controller.abort();
              await reader.cancel().catch(() => undefined);
              return;
            }
          }
        }
      } catch {
        // Aborted by the merge, a detach, or a dead child — decided below.
      }
      // Ended without merging: the child's stream never ends on its own, so
      // this is a failure; the subscriber takes a fresh snapshot.
      finishWithResync();
    })();
  }

  // After forwarding a caught-up event with `cursor`: has the subscriber
  // reached the shared upstream? Then replay what the buffer holds beyond
  // it, skip anything the fan-out will repeat, and go live.
  private mergeCatchUp(upstream: Upstream, subscriber: Subscriber, cursor: string): boolean {
    const at = decodeReplayCursor(cursor);
    if (!at) return false;
    const reference = upstream.head ? decodeReplayCursor(upstream.head) : upstream.originCursor ? decodeReplayCursor(upstream.originCursor) : null;
    const buffered = upstream.buffer.some(entry => entry.cursor === cursor);
    const reached = buffered || (reference !== null && reference.generation === at.generation && at.sequence >= reference.sequence);
    if (!reached) return false;
    subscriber.live = true;
    this.replayFromBuffer(upstream, subscriber, at);
    this.emitSignal(subscriber, { kind: "ready" }, upstream);
    return true;
  }

  // ---------------------------------------------------------------------
  // Upstream lifecycle

  private childPath(upstream: Upstream): string {
    switch (upstream.topic) {
      case "document":
        return upstream.key ? `${CHILD_DOCUMENT_EVENTS_PATH}?${upstream.key}` : CHILD_DOCUMENT_EVENTS_PATH;
      case "inventory":
        return CHILD_INVENTORY_EVENTS_PATH;
      case "conversation": {
        const base = childConversationEventsPath(upstream.key ?? "");
        const from = upstream.head || upstream.originCursor;
        return from ? `${base}?cursor=${encodeURIComponent(from)}` : base;
      }
      case "activity":
        return CHILD_ACTIVITY_PATH;
    }
  }

  private open(upstream: Upstream): void {
    if (upstream.retryTimer) {
      clearTimeout(upstream.retryTimer);
      upstream.retryTimer = null;
    }
    upstream.lastAttemptAt = Date.now();
    if (!this.source.isRunning(upstream.workspaceId)) {
      this.fail(upstream, "unreachable");
      return;
    }
    if (upstream.topic === "conversation") {
      // A fresh open resumes from the head the hub last saw, or from the
      // first subscriber's cursor so the child replays what it holds.
      if (!upstream.head) {
        const first = [...upstream.subscribers][0];
        upstream.originCursor = first?.cursor;
      }
    } else {
      upstream.epoch = newEpoch();
      upstream.seq = 0;
      upstream.head = `${upstream.epoch}.0`;
      upstream.latest = null;
      upstream.buffer = [];
      upstream.bufferBytes = 0;
    }
    const controller = new AbortController();
    upstream.abort = controller;
    upstream.state = "opening";
    // Every attempt is an open; only the first moves the active gauge — a
    // retry is the same logical upstream.
    this.metrics.opened(upstream.topic, { reopen: upstream.counted });
    upstream.counted = true;
    const path = this.childPath(upstream);
    // Presumed live after the grace unless refused first — see
    // LiveBrokerOptions.inventoryOpenGraceMs. Runs until the first chunk or
    // a refusal, whichever comes first, not merely until the fetch settles.
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const clearGrace = () => {
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = null;
    };
    if (upstream.topic === "inventory") {
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (upstream.abort === controller && upstream.state === "opening") this.becomeLive(upstream);
      }, this.inventoryOpenGraceMs);
    }
    void (async () => {
      let response: Response;
      try {
        response = await this.source.open({ workspaceId: upstream.workspaceId, path, signal: controller.signal });
      } catch {
        clearGrace();
        if (controller.signal.aborted) return;
        this.fail(upstream, "unreachable");
        return;
      }
      if (controller.signal.aborted) {
        clearGrace();
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      if (!response.ok) clearGrace();
      if (response.status === 404 && upstream.topic === "activity") {
        // An older child without the activity route (mid-upgrade): running,
        // activity unknown. No retry until the session restarts.
        await response.body?.cancel().catch(() => undefined);
        upstream.state = "unsupported";
        upstream.retryDelayMs = 0;
        upstream.failing = false;
        this.recordActivity(upstream, RUNNING_UNKNOWN);
        for (const subscriber of [...upstream.subscribers]) {
          if (!subscriber.live) this.attachLive(upstream, subscriber);
        }
        return;
      }
      if (!response.ok || !response.body) {
        const status = response.status;
        await response.body?.cancel().catch(() => undefined);
        this.fail(upstream, statusCategoryOf(status));
        return;
      }
      const parser = new SseFrameParser();
      const reader = response.body.getReader();
      let sawResync = false;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          if (upstream.abort !== controller) return;
          clearGrace();
          for (const frame of parser.push(next.value)) {
            if ("comment" in frame) continue;
            if (this.handleFrame(upstream, frame)) {
              sawResync = true;
              break;
            }
          }
          if (sawResync) break;
          if (upstream.state === "opening" && (upstream.topic !== "document" || upstream.latest !== null)) {
            this.becomeLive(upstream);
          }
        }
      } catch {
        // Decided below: an abort is ours, anything else is a failure.
      }
      clearGrace();
      if (sawResync || upstream.abort !== controller || controller.signal.aborted) return;
      await reader.cancel().catch(() => undefined);
      this.fail(upstream, "unreachable");
    })();
  }

  private becomeLive(upstream: Upstream): void {
    upstream.state = "live";
    upstream.retryDelayMs = 0;
    upstream.failing = false;
    for (const subscriber of [...upstream.subscribers]) {
      if (!subscriber.live && !subscriber.catchUp) this.attachLive(upstream, subscriber);
    }
  }

  // Returns true when the child ended the stream with a resync (the
  // upstream is dropped and every subscriber detached).
  private handleFrame(upstream: Upstream, frame: SseFrame): boolean {
    switch (upstream.topic) {
      case "document": {
        if (frame.event !== "state") return false;
        const cursor = this.nextHubCursor(upstream);
        const data = parseJson(frame.data);
        upstream.latest = { cursor, data };
        this.fanOut(upstream, data, cursor);
        return false;
      }
      case "inventory": {
        if (frame.event !== "inventory") return false;
        const cursor = this.nextHubCursor(upstream);
        this.fanOut(upstream, parseJson(frame.data), cursor);
        return false;
      }
      case "conversation": {
        const data = parseJson(frame.data);
        if (frame.event === "resync") {
          for (const subscriber of [...upstream.subscribers]) {
            subscriber.catchUp?.abort();
            subscriber.catchUp = null;
            subscriber.sink.write(this.envelope(subscriber, { kind: "resync", data }, upstream.head || subscriber.cursor || ""));
            subscriber.detached = true;
            subscriber.live = false;
          }
          upstream.subscribers.clear();
          this.drop(upstream, true);
          return true;
        }
        if (frame.event === CHILD_CONVERSATION_OPEN_EVENT) {
          // Where a stream opened without a cursor begins. A stream opened
          // from a cursor already knows, and the child replays from it.
          if (!upstream.head && !upstream.originCursor) {
            const cursor = (data as { cursor?: unknown } | undefined)?.cursor;
            if (typeof cursor === "string" && cursor.length > 0) upstream.originCursor = cursor;
          }
          return false;
        }
        if (frame.event !== "chat" || frame.id === undefined) return false;
        upstream.head = frame.id;
        this.bufferPush(upstream, frame.id, data, frame.data.length);
        this.fanOut(upstream, data, frame.id);
        return false;
      }
      case "activity": {
        if (frame.event !== CHILD_ACTIVITY_EVENT) return false;
        const record = (typeof parseJson(frame.data) === "object" ? parseJson(frame.data) : {}) as Record<string, unknown>;
        this.recordActivity(upstream, sanitizeWorkspaceActivity({ running: true, ...record }));
        return false;
      }
    }
  }

  private recordActivity(upstream: Upstream, activity: WorkspaceActivity): void {
    const cursor = this.nextHubCursor(upstream);
    upstream.latest = { cursor, data: activity };
    this.fanOut(upstream, activity, cursor);
  }

  private nextHubCursor(upstream: Upstream): string {
    upstream.seq += 1;
    upstream.head = `${upstream.epoch}.${upstream.seq}`;
    return upstream.head;
  }

  private bufferPush(upstream: Upstream, cursor: string, data: unknown, bytes: number): void {
    upstream.buffer.push({ cursor, data, bytes });
    upstream.bufferBytes += bytes;
    while (upstream.bufferBytes > this.replayBufferBytes && upstream.buffer.length > 1) {
      const removed = upstream.buffer.shift();
      if (removed) upstream.bufferBytes -= removed.bytes;
    }
  }

  private fanOut(upstream: Upstream, data: unknown, cursor: string): void {
    const at = upstream.topic === "conversation" ? decodeReplayCursor(cursor) : null;
    for (const subscriber of [...upstream.subscribers]) {
      if (!subscriber.live) continue;
      if (subscriber.skip) {
        if (at && at.generation === subscriber.skip.generation && at.sequence <= subscriber.skip.sequence) continue;
        subscriber.skip = null;
      }
      this.emitData(subscriber, data, cursor);
    }
  }

  private fail(upstream: Upstream, status: ProxyStatusCategory): void {
    if (upstream.state === "closed") return;
    upstream.abort?.abort();
    upstream.abort = null;
    upstream.state = "failed";
    if (!upstream.failing) {
      upstream.failing = true;
      this.metrics.failed(upstream.topic);
      recordUpstreamFailure({ topic: upstream.topic, status });
    }
    for (const subscriber of [...upstream.subscribers]) this.signalUnavailable(upstream, subscriber);
    this.scheduleRetry(upstream);
  }

  private scheduleRetry(upstream: Upstream): void {
    if (upstream.retryTimer) return;
    upstream.retryDelayMs = upstream.retryDelayMs === 0
      ? this.retryMinMs
      : Math.min(this.retryMaxMs, upstream.retryDelayMs * 2);
    this.armRetry(upstream, upstream.retryDelayMs);
  }

  // Brings the pending retry forward to `delayMs` from now, never later.
  private retryWithin(upstream: Upstream, delayMs: number): void {
    if (upstream.retryTimer && upstream.retryAt <= Date.now() + delayMs) return;
    this.armRetry(upstream, delayMs);
  }

  private armRetry(upstream: Upstream, delayMs: number): void {
    if (upstream.retryTimer) clearTimeout(upstream.retryTimer);
    upstream.retryAt = Date.now() + delayMs;
    upstream.retryTimer = setTimeout(() => {
      upstream.retryTimer = null;
      if (upstream.state !== "failed" || upstream.subscribers.size === 0) return;
      this.open(upstream);
    }, delayMs);
    if (typeof upstream.retryTimer.unref === "function") upstream.retryTimer.unref();
  }

  private drop(upstream: Upstream, released: boolean): void {
    if (upstream.state === "closed") return;
    if (upstream.lingerTimer) clearTimeout(upstream.lingerTimer);
    if (upstream.retryTimer) clearTimeout(upstream.retryTimer);
    upstream.lingerTimer = null;
    upstream.retryTimer = null;
    upstream.state = "closed";
    upstream.abort?.abort();
    upstream.abort = null;
    for (const subscriber of upstream.subscribers) {
      subscriber.catchUp?.abort();
      subscriber.catchUp = null;
      subscriber.live = false;
    }
    upstream.catchUpOwner = null;
    if (this.upstreams.get(upstream.id) === upstream) this.upstreams.delete(upstream.id);
    if (released && upstream.counted) this.metrics.released(upstream.topic);
  }

  private onSessionChange(change: LiveSessionChange): void {
    for (const upstream of [...this.upstreams.values()]) {
      if (upstream.workspaceId !== change.workspaceId) continue;
      if (change.running) {
        if (upstream.state === "failed" || upstream.state === "unsupported") {
          upstream.state = "failed";
          upstream.retryDelayMs = 0;
          this.open(upstream);
        }
      } else if (upstream.state === "opening" || upstream.state === "live" || upstream.state === "unsupported") {
        this.fail(upstream, "unreachable");
      }
    }
    for (const [user, feed] of this.feeds) this.refreshFeed(user, feed);
  }

  // ---------------------------------------------------------------------
  // Activity feeds

  private activityEnvelope(feed: ActivityFeed, workspaceId: string, activity: WorkspaceActivity): LiveEnvelope {
    return { ws: workspaceId, topic: "activity", cursor: `${feed.epoch}.${feed.seq}`, event: { kind: "data", data: activity } };
  }

  // Reconciles the feed with the registry and the session table: every
  // registered workspace has a value, running ones hold an activity upstream
  // subscription, stopped ones do not.
  private refreshFeed(user: string, feed: ActivityFeed): void {
    const known = new Set(this.source.workspaceIds());
    for (const workspaceId of [...feed.last.keys()]) {
      if (known.has(workspaceId)) continue;
      feed.last.delete(workspaceId);
      feed.attachments.get(workspaceId)?.detach();
      feed.attachments.delete(workspaceId);
    }
    for (const workspaceId of known) {
      const running = this.source.isRunning(workspaceId);
      if (!running) {
        feed.attachments.get(workspaceId)?.detach();
        feed.attachments.delete(workspaceId);
        this.setFeedValue(feed, workspaceId, NOT_RUNNING);
        continue;
      }
      if (feed.attachments.has(workspaceId)) continue;
      // Running, activity not yet known: the dot shows, the badge waits.
      this.setFeedValue(feed, workspaceId, RUNNING_UNKNOWN);
      const sink: LiveSink = {
        write: envelope => {
          if (this.feeds.get(user) !== feed) return;
          switch (envelope.event.kind) {
            case "data":
              this.setFeedValue(feed, workspaceId, sanitizeWorkspaceActivity(envelope.event.data));
              return;
            case "unavailable":
              this.setFeedValue(feed, workspaceId, NOT_RUNNING);
              return;
            case "ready":
            case "resync":
              return;
          }
        },
      };
      feed.attachments.set(workspaceId, this.attachSink(sink, workspaceId, "activity", undefined, undefined));
    }
  }

  // Emits only on change — the badge must not flicker on every keepalive or
  // reconcile pass.
  private setFeedValue(feed: ActivityFeed, workspaceId: string, activity: WorkspaceActivity): void {
    const previous = feed.last.get(workspaceId);
    if (previous && sameActivity(previous, activity)) return;
    feed.last.set(workspaceId, activity);
    feed.seq += 1;
    for (const sink of feed.sinks) sink.write(this.activityEnvelope(feed, workspaceId, activity));
  }
}
