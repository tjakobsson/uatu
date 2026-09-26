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
//                 (D5). The upstream is the BROKER's, not a feed's: it is
//                 opened while the workspace runs whether or not anyone is
//                 watching, because "work finished while you were away" is
//                 a fact no page-scoped subscription can see
//                 (fix-workspace-activity-states D11). Feeds merge hub
//                 session state (`running`) with the child's
//                 {working, awaiting} and only read what the broker observed.
//   worktrees     NO child upstream at all. The worktree inventory is the
//                 hub's own knowledge (src/hub/worktree-service.ts), so this
//                 topic is a hub-local fan-out: attaching writes one fresh
//                 invalidation and `ready`, and `publishWorktrees` writes one
//                 to every attached subscriber after a committed Uatu
//                 operation or a reconciliation that changed the inventory.
//                 It takes no cursor, buffers nothing, never fails, and is
//                 independent of whether the workspace's child is running —
//                 a stopped parent's picker still learns that its repository
//                 changed.
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
import type { ActivityMarkSink } from "./activity-marks";
import type { MetricsRegistry } from "../debug/metrics";
import { UpstreamSubscriptionMetrics, type UpstreamTopic } from "../debug/stream-metrics";
import {
  CHILD_ACTIVITY_EVENT,
  CHILD_ACTIVITY_PATH,
  CHILD_DOCUMENT_EVENTS_PATH,
  CHILD_INVENTORY_EVENTS_PATH,
  childConversationEventsPath,
  sanitizeWorkspaceActivity,
  WORKTREE_INVALIDATION,
  WORKTREE_TOPIC_CURSOR,
  type LiveEnvelope,
  type LiveEvent,
  type LiveSubscription,
  type LiveTopic,
  type WorkspaceActivity,
  CHILD_CONVERSATION_OPEN_EVENT,
} from "../shared/live-protocol";
import { SseFrameParser, type SseFrame } from "./live-sse";
import { statusCategoryOf, type ProxyStatusCategory } from "./proxy";
import { PRESENCE_GRACE_MS, type Presence, type PresenceSource } from "./presence";

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
  // A workspace left the registry. Its id is free to be minted again for a
  // different folder, so the broker forgets everything it keyed by it.
  onWorkspaceRemoved?(listener: (workspaceId: string) => void): () => void;
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
  // Where the finished/viewed marks are read from at startup and written
  // back on change (src/hub/activity-marks.ts). Absent — unit fixtures, the
  // e2e harness — the marks live for the broker's lifetime only.
  marks?: ActivityMarkSink;
  // Watch every running workspace's activity from construction rather than
  // from the first activity subscription (D11). The production hub sets it:
  // a client that starts a session and drives its chat through the proxy
  // without ever opening a page still has its finishes recorded. Brokers
  // built for tests leave it off, so fixtures for other topics and the e2e
  // harness open no activity upstream nobody asked for.
  watchActivityFromStart?: boolean;
  // How long a user stays `recent` after their last visible session page
  // goes, and after the broker starts (src/hub/presence.ts). Tests shorten it.
  presenceGraceMs?: number;
  now?: () => number;
};

// What the worktree reconciler learns from the broker: a page attached to a
// workspace's worktree topic (open), whether any page still holds it (the
// periodic cadence runs only while one does), and observed agent activity.
// Observers never influence what the broker writes.
export type WorktreeTopicObserver = {
  attached(workspaceId: string): void;
  interest(workspaceId: string, interested: boolean): void;
  activity(workspaceId: string, activity: WorkspaceActivity): void;
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
  // conversation catch-up is in flight. A catch-up that ends while the
  // upstream is not live leaves the subscriber pending at the cursor it
  // reached; the upstream's recovery attaches it from there.
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

// The upstream metrics describe subscriptions to a CHILD. `worktrees` has
// none, so it is deliberately absent from the counters rather than reported
// as an upstream that never opens.
function childUpstreamTopic(topic: LiveTopic): UpstreamTopic | null {
  return topic === "worktrees" ? null : topic;
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

const NOT_RUNNING: WorkspaceActivity = { running: false, working: false, awaiting: false, finished: false };
const RUNNING_UNKNOWN: WorkspaceActivity = { running: true, working: false, awaiting: false, finished: false };

function sameActivity(a: WorkspaceActivity, b: WorkspaceActivity): boolean {
  return a.running === b.running && a.working === b.working && a.awaiting === b.awaiting && a.finished === b.finished;
}

// One user's activity feed: the set of that user's streams that asked for
// the topic and the last value emitted per workspace. It holds no upstream
// subscription of its own — the broker watches every running workspace — so
// it is purely a reader of what the broker knows, composed for this user.
class ActivityFeed {
  readonly sinks = new Set<LiveSink>();
  readonly last = new Map<string, WorkspaceActivity>();
  readonly epoch = newEpoch();
  seq = 0;
}

export class LiveBroker implements PresenceSource {
  private readonly upstreams = new Map<string, Upstream>();
  private readonly feeds = new Map<string, ActivityFeed>();
  // The `finished` fact's ingredients, held at the broker rather than in a
  // feed: a user's feed is discarded when their last page closes, and
  // "switched away and came back later" is exactly the case the fact is
  // for. `observed` is the last value the workspace's activity upstream
  // delivered; `finishedAt` is stamped when that value goes from working to
  // quiet; `viewedAt` is stamped per user by acknowledgeViewed. Stamps come
  // from one broker counter, so a finish after the last view outranks it
  // without clocks; a restart resumes the counter above the highest stamp
  // read back, which is what keeps that comparison meaningful across one.
  private readonly observed = new Map<string, WorkspaceActivity>();
  private readonly finishedAt = new Map<string, number>();
  private readonly viewedAt = new Map<string, Map<string, number>>();
  private stamp = 0;
  private readonly marks: ActivityMarkSink | null;
  // The broker's own activity attachment per running workspace. One per
  // workspace, opened when the session starts and released when it stops —
  // not one per feed, so what finishes while every page is closed is still
  // seen (D11).
  private readonly activityWatches = new Map<string, LiveAttachment>();
  // Set at construction when the broker watches from the start (the
  // production hub), otherwise by the first activity subscription of this
  // broker's lifetime; never cleared: from then on the watches are held
  // regardless of feeds. A lazy broker nobody has ever asked for activity —
  // the e2e harness, the unit fixtures for other topics — opens no activity
  // upstream at all.
  private watchingActivity = false;
  private readonly lingerMs: number;
  private readonly replayBufferBytes: number;
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;
  private readonly inventoryOpenGraceMs: number;
  private readonly metrics: UpstreamSubscriptionMetrics;
  private readonly unsubscribeSessions: (() => void) | null;
  private readonly unsubscribeRemovals: (() => void) | null;
  private disposed = false;
  private worktreeObserver: WorktreeTopicObserver | null = null;
  // Presence (src/hub/presence.ts). A user is present while their activity
  // feed has a sink: only visible session pages hold a stream that asked for
  // the topic. `lastSeenAt` is stamped when the last sink goes; a timer per
  // user announces the end of the grace period so readers need not poll.
  private readonly presenceGraceMs: number;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly lastSeenAt = new Map<string, number>();
  private readonly presenceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly presenceListeners = new Set<(user: string) => void>();

  constructor(private readonly source: LiveUpstreamSource, options: LiveBrokerOptions = {}) {
    this.lingerMs = options.lingerMs ?? LIVE_LINGER_MS;
    this.replayBufferBytes = options.replayBufferBytes ?? LIVE_REPLAY_BUFFER_BYTES;
    this.retryMinMs = options.retryMinMs ?? RETRY_MIN_MS;
    this.retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS;
    this.inventoryOpenGraceMs = options.inventoryOpenGraceMs ?? INVENTORY_OPEN_GRACE_MS;
    this.metrics = new UpstreamSubscriptionMetrics(options.metrics);
    this.marks = options.marks ?? null;
    this.presenceGraceMs = options.presenceGraceMs ?? PRESENCE_GRACE_MS;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.restoreMarks();
    this.unsubscribeSessions = source.onSessionChange?.(change => this.onSessionChange(change)) ?? null;
    this.unsubscribeRemovals = source.onWorkspaceRemoved?.(workspaceId => this.forgetWorkspace(workspaceId)) ?? null;
    // Last, so the marks are restored before any watch can observe a frame
    // and compose a value against them, and the session listener is already
    // in place for a start that lands while the watches open. What is
    // running now is watched now; what starts later is picked up by
    // onSessionChange.
    if (options.watchActivityFromStart) {
      this.watchingActivity = true;
      this.syncActivityWatches();
    }
  }

  // What the previous hub left behind. `observed` is deliberately not among
  // it: the hub has heard nothing yet, so the first frame after startup has
  // no predecessor and cannot be read as a transition (D3/D12). The stamp
  // counter resumes above everything restored, so a view taken now outranks
  // a finish recorded before the restart, and vice versa.
  //
  // Marks for a workspace the registry no longer names are dropped here,
  // at load (D12): it may have been forgotten while the hub was down, and
  // its freed slug can be minted again for a different folder, which must
  // not inherit a stranger's finish. The stamps still count towards the
  // counter's resume point — that costs nothing and keeps it monotonic.
  private restoreMarks(): void {
    const restored = this.marks?.read();
    if (!restored) return;
    const known = new Set(this.source.workspaceIds());
    let highest = 0;
    let dropped = false;
    for (const [workspaceId, stamp] of restored.finishedAt) {
      highest = Math.max(highest, stamp);
      if (known.has(workspaceId)) this.finishedAt.set(workspaceId, stamp);
      else dropped = true;
    }
    for (const [user, workspaces] of restored.viewedAt) {
      const kept = new Map<string, number>();
      for (const [workspaceId, stamp] of workspaces) {
        highest = Math.max(highest, stamp);
        if (known.has(workspaceId)) kept.set(workspaceId, stamp);
        else dropped = true;
      }
      if (kept.size > 0) this.viewedAt.set(user, kept);
    }
    this.stamp = highest;
    if (dropped) this.persistMarks();
  }

  private persistMarks(): void {
    this.marks?.write({ finishedAt: this.finishedAt, viewedAt: this.viewedAt });
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
    // A lazy broker's first feed turns the watches on (one built to watch
    // from the start already has them); from then on they are the broker's,
    // so this feed's arrival or departure changes nothing about what is
    // observed.
    this.watchingActivity = true;
    this.syncActivityWatches();
    // Reconcile before adding the sink: changes reach the feed's existing
    // sinks, and the new one gets the whole picture below.
    this.refreshFeed(user, feed);
    feed.sinks.add(sink);
    if (feed.sinks.size === 1) this.presenceChanged(user, false);
    for (const [workspaceId, activity] of feed.last) {
      sink.write(this.activityEnvelope(feed, workspaceId, activity));
    }
    return {
      detach: () => {
        if (!feed.sinks.delete(sink)) return;
        if (feed.sinks.size === 0) this.presenceChanged(user, true);
        if (feed.sinks.size > 0 || this.feeds.get(user) !== feed) return;
        // The feed goes; the watches stay. What finishes now is still
        // recorded, and the next feed this user opens reads it.
        this.feeds.delete(user);
      },
    };
  }

  presence(user: string): Presence {
    if ((this.feeds.get(user)?.sinks.size ?? 0) > 0) return "present";
    const since = this.lastSeenAt.get(user) ?? this.startedAt;
    return this.now() - since < this.presenceGraceMs ? "recent" : "away";
  }

  onPresenceChange(listener: (user: string) => void): () => void {
    this.presenceListeners.add(listener);
    return () => { this.presenceListeners.delete(listener); };
  }

  // A user's first visible page arrived, or their last one went. Leaving
  // stamps the grace period and arms the timer that reports its end.
  private presenceChanged(user: string, left: boolean): void {
    const timer = this.presenceTimers.get(user);
    if (timer) clearTimeout(timer);
    this.presenceTimers.delete(user);
    if (left && !this.disposed) {
      this.lastSeenAt.set(user, this.now());
      const next = setTimeout(() => {
        this.presenceTimers.delete(user);
        this.emitPresence(user);
      }, this.presenceGraceMs);
      (next as { unref?: () => void }).unref?.();
      this.presenceTimers.set(user, next);
    }
    this.emitPresence(user);
  }

  private emitPresence(user: string): void {
    for (const listener of [...this.presenceListeners]) {
      try { listener(user); } catch { /* a reader's failure is its own */ }
    }
  }

  // The user has the workspace's chat in view: whatever finished there is
  // seen. Re-derives that user's feed value alone — the mark and the other
  // users' views are untouched — and emits only if it changed.
  //
  // With no finish on record, or one this user has already seen, there is
  // nothing to clear and nothing is stamped or written: each of a user's
  // pages posts for the same finish, and any client may post at any time,
  // so each would otherwise cost a stamp and a persist. Skipping
  // is safe because the composed value already reads not finished in both
  // cases, and a later finish always takes a higher stamp than any view.
  acknowledgeViewed(user: string, workspaceId: string): void {
    const finishedAt = this.finishedAt.get(workspaceId);
    if (finishedAt === undefined) return;
    let marks = this.viewedAt.get(user);
    if (finishedAt <= (marks?.get(workspaceId) ?? -Infinity)) return;
    if (!marks) {
      marks = new Map();
      this.viewedAt.set(user, marks);
    }
    marks.set(workspaceId, this.nextStamp());
    this.persistMarks();
    const feed = this.feeds.get(user);
    const last = feed?.last.get(workspaceId);
    if (!feed || !last) return;
    this.setFeedValue(feed, workspaceId, this.composeActivity(user, workspaceId, last));
  }

  // The workspace left the registry (the hub wires this to every removal,
  // through LiveUpstreamSource.onWorkspaceRemoved). The session is already
  // stopped — a forget requires it — but nothing else would announce the
  // removal: syncActivityWatches prunes only when a session changes or a
  // feed opens, and a new registration can take the freed slug before
  // either happens, inheriting the old workspace's finish.
  forgetWorkspace(workspaceId: string): void {
    if (this.disposed) return;
    this.unwatchActivity(workspaceId);
    this.forgetMarks(workspaceId);
    for (const feed of this.feeds.values()) feed.last.delete(workspaceId);
  }

  observeWorktrees(observer: WorktreeTopicObserver | null): void {
    this.worktreeObserver = observer;
  }

  private notifyWorktrees(notify: (observer: WorktreeTopicObserver) => void): void {
    if (!this.worktreeObserver) return;
    try {
      notify(this.worktreeObserver);
    } catch {
      // An observer never breaks the stream it observes.
    }
  }

  // A committed Uatu worktree operation, or a reconciliation that changed
  // the inventory, invalidates every page subscribed to an affected source
  // workspace. Authorization is the subscription's: a sink only ever holds
  // the topic for a workspace its stream was opened for, so naming a
  // workspace here can never reveal one the user may not access. The
  // payload is the bare invalidation — no path, no branch, no identity.
  publishWorktrees(workspaceIds: Iterable<string>): void {
    if (this.disposed) return;
    for (const workspaceId of new Set(workspaceIds)) {
      const upstream = this.upstreams.get(upstreamId(workspaceId, "worktrees", undefined));
      if (!upstream || upstream.state === "closed") continue;
      for (const subscriber of [...upstream.subscribers]) {
        if (subscriber.live) this.emitData(subscriber, WORKTREE_INVALIDATION, WORKTREE_TOPIC_CURSOR);
      }
    }
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
    this.unsubscribeRemovals?.();
    // Release the broker's own attachments before the upstreams go, so no
    // watch outlives the broker holding it. The marks themselves are left
    // alone: the hub is going down, not the workspaces.
    for (const workspaceId of [...this.activityWatches.keys()]) this.unwatchActivity(workspaceId);
    for (const upstream of [...this.upstreams.values()]) this.drop(upstream, false);
    this.feeds.clear();
    for (const timer of this.presenceTimers.values()) clearTimeout(timer);
    this.presenceTimers.clear();
    this.presenceListeners.clear();
  }

  // ---------------------------------------------------------------------
  // Subscriptions

  private attachSubscriber(subscriber: Subscriber, topic: LiveTopic, key: string | undefined): void {
    const id = upstreamId(subscriber.workspaceId, topic, key);
    let upstream = this.upstreams.get(id);
    if (!upstream) {
      upstream = new Upstream(id, subscriber.workspaceId, topic, key);
      this.upstreams.set(id, upstream);
      if (topic === "worktrees") this.notifyWorktrees(observer => observer.interest(subscriber.workspaceId, true));
    }
    if (upstream.lingerTimer) {
      clearTimeout(upstream.lingerTimer);
      upstream.lingerTimer = null;
    }
    upstream.subscribers.add(subscriber);
    if (topic === "worktrees") {
      // Hub-local: there is nothing to open, so the upstream is live from
      // the moment it exists and can never fail.
      if (upstream.state === "idle") upstream.state = "live";
      this.attachLive(upstream, subscriber);
      this.notifyWorktrees(observer => observer.attached(subscriber.workspaceId));
      return;
    }
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
        //
        // A first attach (no cursor) is owed the tick the child's own route
        // opens every subscription with: the client read its baseline
        // inventory before subscribing, so a change between that read and
        // this attach is only announced by that opening tick. A fresh upstream
        // still carries it (seq 0: the child's first frame is on its way and
        // fans out to this subscriber); a shared or lingering one delivered
        // it already, to someone else, so the joiner gets one of its own.
        const joinerOwedOpeningTick = subscriber.cursor === undefined && upstream.seq > 0;
        const behindHead = subscriber.cursor !== undefined && subscriber.cursor !== upstream.head;
        if (joinerOwedOpeningTick || behindHead) {
          this.emitData(subscriber, { type: "conversation.inventory" }, upstream.head);
        }
        this.emitSignal(subscriber, { kind: "ready" }, upstream);
        return;
      }
      case "worktrees": {
        // No cursor, no replay, no condition: every attach — a first
        // subscribe or a reconnect presenting nothing — is told to refetch
        // authoritative inventory. That is what makes a missed invalidation
        // during an outage harmless.
        subscriber.live = true;
        this.emitData(subscriber, WORKTREE_INVALIDATION, WORKTREE_TOPIC_CURSOR);
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
    const release = () => {
      subscriber.catchUp = null;
      if (upstream.catchUpOwner === subscriber) upstream.catchUpOwner = null;
      controller.abort();
    };
    // The child's verdict on the cursor, or a replay that died under a live
    // upstream: the subscriber takes a fresh snapshot.
    const finishWithResync = (data?: unknown) => {
      if (controller.signal.aborted || subscriber.detached) return;
      release();
      subscriber.sink.write(this.envelope(subscriber, data === undefined ? { kind: "resync" } : { kind: "resync", data }, upstream.head || subscriber.cursor || ""));
      this.detach(subscriber);
    };
    // The replay ended (or was refused) without reaching the shared
    // upstream. Under a live upstream that is a failure of its own. Under
    // one that is down it is the same outage: the subscriber was told
    // `unavailable` and keeps its progress, and recovery resumes the
    // catch-up from the cursor it reached. A resync would send the page to
    // a child that cannot answer.
    const finishWithoutMerging = () => {
      if (controller.signal.aborted || subscriber.detached) return;
      if (upstream.state !== "live") {
        release();
        return;
      }
      finishWithResync();
    };
    void (async () => {
      let response: Response;
      try {
        response = await this.source.open({ workspaceId: upstream.workspaceId, path, signal: controller.signal });
      } catch {
        finishWithoutMerging();
        return;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        finishWithoutMerging();
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
              release();
              await reader.cancel().catch(() => undefined);
              return;
            }
          }
        }
      } catch {
        // Aborted by the merge, a detach, or a dead child — decided below.
      }
      // Ended without merging: the child's stream never ends on its own.
      finishWithoutMerging();
    })();
  }

  // After forwarding a caught-up event with `cursor`: has the subscriber
  // reached the shared upstream? Then the catch-up is over. Under a live
  // upstream, replay what the buffer holds beyond the cursor, skip anything
  // the fan-out will repeat, and go live. Under one that failed or is
  // reopening, the subscriber stays pending at that cursor: `becomeLive`
  // attaches it through the normal path, which replays what it is owed and
  // sends its `ready`. Going live here would tell the page the stream had
  // recovered when nothing is live, and recovery would pass it over.
  private mergeCatchUp(upstream: Upstream, subscriber: Subscriber, cursor: string): boolean {
    const at = decodeReplayCursor(cursor);
    if (!at) return false;
    const reference = upstream.head ? decodeReplayCursor(upstream.head) : upstream.originCursor ? decodeReplayCursor(upstream.originCursor) : null;
    const buffered = upstream.buffer.some(entry => entry.cursor === cursor);
    const reached = buffered || (reference !== null && reference.generation === at.generation && at.sequence >= reference.sequence);
    if (!reached) return false;
    if (upstream.state !== "live") return true;
    subscriber.notifiedUnavailable = false;
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
      case "worktrees":
        // Unreachable: open() never runs for a hub-local topic.
        throw new Error("the worktrees topic has no child upstream");
    }
  }

  private open(upstream: Upstream): void {
    // Hub-local topics have no child to open; attachSubscriber never routes
    // them here, and neither does a retry, because they never fail.
    if (upstream.topic === "worktrees") return;
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
    this.metrics.opened(childUpstreamTopic(upstream.topic)!, { reopen: upstream.counted });
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
      case "worktrees":
        // Unreachable: no child stream feeds a hub-local topic.
        return false;
    }
  }

  private recordActivity(upstream: Upstream, activity: WorkspaceActivity): void {
    const cursor = this.nextHubCursor(upstream);
    upstream.latest = { cursor, data: activity };
    this.fanOut(upstream, activity, cursor);
    this.notifyWorktrees(observer => observer.activity(upstream.workspaceId, activity));
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
    const metricTopic = childUpstreamTopic(upstream.topic);
    if (!upstream.failing && metricTopic) {
      upstream.failing = true;
      this.metrics.failed(metricTopic);
      recordUpstreamFailure({ topic: metricTopic, status });
    }
    // A catch-up in flight is left to run: it forwards to its subscriber
    // alone and settles into the pending state (mergeCatchUp,
    // finishWithoutMerging) when it ends, for recovery to finish.
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
    if (upstream.topic === "worktrees") this.notifyWorktrees(observer => observer.interest(upstream.workspaceId, false));
    // A finish is detected only between values one attached upstream
    // delivered. Once the upstream is gone the next value has no
    // predecessor: what happened while nobody watched is not invented from
    // a stale last sight. The upstream now goes only when the workspace
    // stops, is unregistered, or the broker closes, each of which also
    // forgets the marks — kept because the upstream's end is the point
    // after which nothing it said is current.
    if (upstream.topic === "activity") this.observed.delete(upstream.workspaceId);
    const metricTopic = childUpstreamTopic(upstream.topic);
    if (released && upstream.counted && metricTopic) this.metrics.released(metricTopic);
  }

  private onSessionChange(change: LiveSessionChange): void {
    for (const upstream of [...this.upstreams.values()]) {
      if (upstream.workspaceId !== change.workspaceId) continue;
      // A hub-local topic does not describe the child, so a start or stop
      // says nothing about it: the worktree inventory of a stopped parent
      // is still readable and still worth invalidating.
      if (upstream.topic === "worktrees") continue;
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
    // Here rather than only in a feed refresh: a stop with no feed open must
    // still clear the marks, or a later page would inherit them.
    if (!change.running) this.forgetMarks(change.workspaceId);
    // A start opens this workspace's watch; a stop releases it.
    this.syncActivityWatches();
    for (const [user, feed] of this.feeds) this.refreshFeed(user, feed);
  }

  // ---------------------------------------------------------------------
  // Activity feeds

  private activityEnvelope(feed: ActivityFeed, workspaceId: string, activity: WorkspaceActivity): LiveEnvelope {
    return { ws: workspaceId, topic: "activity", cursor: `${feed.epoch}.${feed.seq}`, event: { kind: "data", data: activity } };
  }

  // Reconciles the broker's own watches with the registry and the session
  // table: one activity attachment per registered, running workspace, held
  // for as long as it runs and regardless of who is looking.
  private syncActivityWatches(): void {
    if (this.disposed || !this.watchingActivity) return;
    const known = new Set(this.source.workspaceIds());
    for (const workspaceId of [...this.activityWatches.keys()]) {
      if (known.has(workspaceId) && this.source.isRunning(workspaceId)) continue;
      // The session this watch was following is gone — stopped, or the
      // workspace left the registry. Nothing it did is finished any more.
      this.unwatchActivity(workspaceId);
      this.forgetMarks(workspaceId);
    }
    // Marks for a workspace the registry no longer names are forgotten
    // here too. The hub's registry announces every removal
    // (forgetWorkspace) and restoreMarks drops what it no longer names at
    // load, so this is the backstop for a source that cannot announce
    // removals. A registered workspace that is merely not running
    // keeps its marks: after a restart every session is stopped, and
    // dropping them then would be the amnesia the persistence exists to
    // prevent. A stop the hub actually observes clears them above and in
    // onSessionChange.
    for (const workspaceId of this.markedWorkspaces()) {
      if (!known.has(workspaceId)) this.forgetMarks(workspaceId);
    }
    for (const workspaceId of known) {
      if (this.source.isRunning(workspaceId)) this.watchActivity(workspaceId);
    }
  }

  private markedWorkspaces(): Set<string> {
    const marked = new Set<string>([...this.finishedAt.keys(), ...this.observed.keys()]);
    for (const workspaces of this.viewedAt.values()) {
      for (const workspaceId of workspaces.keys()) marked.add(workspaceId);
    }
    return marked;
  }

  // The broker's own subscription to a running workspace's activity. It
  // feeds observeActivity exactly as a feed's sink used to, and is the only
  // activity subscriber there is: a feed reads what this records.
  private watchActivity(workspaceId: string): void {
    if (this.activityWatches.has(workspaceId)) return;
    let released = false;
    const sink: LiveSink = {
      write: envelope => {
        if (released) return;
        switch (envelope.event.kind) {
          case "data":
            this.observeActivity(workspaceId, sanitizeWorkspaceActivity(envelope.event.data));
            return;
          case "unavailable":
            // The child is unreachable although the session table still
            // names it running. The upstream says this on the FIRST failure
            // of any episode — a single stream end the retry recovers from
            // included — so it is not a stop and the marks stay: erasing an
            // unviewed finish on a transient drop is the loss persisting them
            // exists to prevent (D2). What changes is the reading. Recorded
            // as not running, so a feed refresh — which cannot see the
            // upstream's state — seeds the workspace as not running rather
            // than resurrecting it from a missing reading as running; a
            // failed upstream never repeats this signal to correct it. And
            // the recovered upstream's first frame then has a predecessor
            // that is not working, so recovery is never read as a finish
            // (observeActivity); the mark shows again once the child answers
            // quiet, and work resuming clears it as usual.
            this.observed.set(workspaceId, NOT_RUNNING);
            this.publishActivity(workspaceId, NOT_RUNNING);
            return;
          case "ready":
          case "resync":
            return;
        }
      },
    };
    // attachSink can write synchronously (a live upstream replays its latest
    // frame), so the guard is a flag rather than a lookup of the attachment
    // this call is about to record.
    const attachment = this.attachSink(sink, workspaceId, "activity", undefined, undefined);
    this.activityWatches.set(workspaceId, {
      detach: () => {
        released = true;
        attachment.detach();
      },
    });
  }

  private unwatchActivity(workspaceId: string): void {
    const watch = this.activityWatches.get(workspaceId);
    if (!watch) return;
    this.activityWatches.delete(workspaceId);
    watch.detach();
  }

  // Seeds the feed from what the broker already knows: every registered
  // workspace has a value, and a running one whose activity has not been
  // heard yet reads as running-unknown — the dot shows, the badge waits —
  // unless a finish is already on record for this user, which a feed opened
  // after the fact must show at once. One whose child the watch found
  // unreachable reads as the not-running the watch recorded, so opening a
  // page does not bring it back as running.
  private refreshFeed(user: string, feed: ActivityFeed): void {
    const known = new Set(this.source.workspaceIds());
    for (const workspaceId of [...feed.last.keys()]) {
      if (!known.has(workspaceId)) feed.last.delete(workspaceId);
    }
    for (const workspaceId of known) {
      if (!this.source.isRunning(workspaceId)) {
        this.setFeedValue(feed, workspaceId, NOT_RUNNING);
        continue;
      }
      const facts = this.observed.get(workspaceId) ?? RUNNING_UNKNOWN;
      this.setFeedValue(feed, workspaceId, this.composeActivity(user, workspaceId, facts));
    }
  }

  // One upstream value, seen through the broker's watch. The transition is
  // judged against the workspace-level `observed`, never against a feed's
  // last value: a feed can appear and disappear at any point in a run, and
  // the fact is about the workspace, not about who happened to be looking.
  // The facts are the same for every user, so every feed is re-derived; the
  // per-user part is only `viewedAt`.
  private observeActivity(workspaceId: string, activity: WorkspaceActivity): void {
    const previous = this.observed.get(workspaceId);
    this.observed.set(workspaceId, activity);
    if (activity.working || activity.awaiting) {
      // Work resumed, or an interaction awaits: whatever finished before
      // is superseded by what the user will look at now.
      if (this.finishedAt.delete(workspaceId)) this.persistMarks();
    } else if (previous?.working && !previous.awaiting) {
      // Working → quiet. Not from unknown (a page opening onto an idle
      // workspace invents nothing), not from awaiting (the answer was given
      // from somewhere the user was looking — a pending question keeps the
      // turn in flight, so "working and awaiting" is the awaiting case).
      this.finishedAt.set(workspaceId, this.nextStamp());
      this.persistMarks();
    }
    this.publishActivity(workspaceId, activity);
  }

  // The same facts, composed per user, to every feed there is.
  private publishActivity(workspaceId: string, facts: WorkspaceActivity): void {
    for (const [user, feed] of this.feeds) {
      this.setFeedValue(feed, workspaceId, this.composeActivity(user, workspaceId, facts));
    }
  }

  private composeActivity(user: string, workspaceId: string, facts: WorkspaceActivity): WorkspaceActivity {
    const quiet = facts.running && !facts.working && !facts.awaiting;
    const finishedAt = this.finishedAt.get(workspaceId);
    const viewedAt = this.viewedAt.get(user)?.get(workspaceId) ?? -Infinity;
    return {
      running: facts.running,
      working: facts.working,
      awaiting: facts.awaiting,
      finished: quiet && finishedAt !== undefined && finishedAt > viewedAt,
    };
  }

  private nextStamp(): number {
    this.stamp += 1;
    return this.stamp;
  }

  // The hub observed the workspace stop, or it left the registry: nothing it
  // did before is finished any more, and nobody's view of it needs keeping.
  // NOT called when its child is merely unreachable (the watch's
  // `unavailable`): that may be a transient drop the retry recovers from,
  // and the session it describes is still the same one.
  private forgetMarks(workspaceId: string): void {
    this.observed.delete(workspaceId);
    let changed = this.finishedAt.delete(workspaceId);
    for (const [user, marks] of this.viewedAt) {
      if (marks.delete(workspaceId)) changed = true;
      if (marks.size === 0) this.viewedAt.delete(user);
    }
    if (changed) this.persistMarks();
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
