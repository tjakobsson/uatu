// The page's one live stream: `GET /api/hub/live` at the hub origin, carrying
// every topic the page cares about (document state, conversation inventory,
// conversation events, subagent transcripts, cross-workspace activity) as
// typed envelopes. See shared/live-protocol.ts for the wire contract and
// openspec/changes/hub-brokered-live-stream/design.md D6 for why the client
// owns exactly one connection.
//
// What this module owns:
//
//   - Transport recovery. A native `EventSource` retries on its own, but the
//     browser exposes no bound on how long it may sit in `CONNECTING` — on a
//     mobile device whose network path disappeared mid-stream, that wait is
//     effectively forever. On any error the failed source is closed and a
//     replacement opened on a capped-exponential schedule, until a connection
//     is confirmed or the page is disposed.
//   - Generations. Every attempt carries a monotonically increasing
//     generation; envelopes and callbacks from a superseded attempt are
//     dropped, so a slow reply from an older stream can never overwrite newer
//     state or revive a stale status.
//   - Subscriptions and cursors. Consumers subscribe to `(topic, key)` and
//     receive that topic's events; the channel tracks each topic's cursor
//     (advanced ONLY on `data`) and presents every retained cursor when it
//     reconnects, so each topic resumes independently. Changes on an open
//     stream go through the control route bound by the `hello` stream id;
//     changes made before `hello` ride the next connect's `subs`, except
//     what would take the connect URL past what proxies accept, which is
//     added over the control route once `hello` arrives.
//   - Control failures. A 400, 403, or 404 means the stream cannot take the
//     change, and repeating the request cannot help, so the stream is
//     treated as lost and the reconnect presents the whole set. A 5xx or a
//     request with no answer is retried with backoff, and escalates to a
//     reconnect after CONTROL_MAX_ATTEMPTS. A subscription the protocol
//     refuses is never sent (see `refuse`): it would make every reconnect
//     fail too.
//
// The channel deliberately does NOT treat an open socket as success. Whether
// the stream counts as connected is the document consumer's decision,
// expressed by `confirm(generation)` once that generation has proven the
// page's state current (see `shell/events.ts`). Chat topics report their own
// status inside the chat surface and never touch the shell indicator.

import {
  LIVE_ENVELOPE_EVENT,
  LIVE_HELLO_EVENT,
  LIVE_MAX_SUBSCRIPTIONS,
  LIVE_STREAM_PATH,
  buildLiveStreamQuery,
  liveSubscriptionId,
  liveSubscriptionsPath,
  parseLiveEnvelope,
  parseLiveHello,
  parseLiveSubscriptionChange,
  sanitizeWorkspaceActivity,
  type LiveEnvelope,
  type LiveSubscription,
  type LiveSubscriptionChange,
  type LiveSubscriptionKey,
  type WorkspaceActivity,
} from "../shared/live-protocol";

export type LiveChannelSource = {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
};

export type LiveChannelStatus = "connecting" | "reconnecting" | "live";

export type LiveChannelTimers = {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};

const defaultTimers: LiveChannelTimers = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timer => clearTimeout(timer),
};

export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 15_000;

export function reconnectDelay(consecutiveFailures: number): number {
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (consecutiveFailures - 1), RECONNECT_MAX_DELAY_MS);
}

// Consecutive failed attempts at a control change (5xx, or no answer) before
// the channel stops retrying against this stream and reconnects instead.
export const CONTROL_MAX_ATTEMPTS = 3;

// The longest connect URL the channel builds. `subs` rides the query string,
// and common proxies refuse a request line past about 8 KB (Bun.serve itself
// answers 431 at about 16 KB). A document key at the protocol's bound can
// expand to over 12 KB of query on its own.
export const LIVE_CONNECT_URL_MAX_BYTES = 6_144;

// Statuses worth repeating the same control request for. Any other failure
// is final for this stream.
function retryableControlStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

// The protocol's own parser, so the channel refuses exactly what the hub
// would answer 400 to.
function admissible(subscription: LiveSubscription): boolean {
  return !("error" in parseLiveSubscriptionChange({ add: [subscription] }));
}

// One topic subscription's callbacks. Every callback receives the generation
// of the stream that delivered the event so asynchronous work can be guarded
// with `isCurrent(generation)`.
export type LiveTopicConsumer = {
  data?: (data: unknown, cursor: string, generation: number) => void;
  // The subscription is attached to a live upstream and any replay owed to it
  // has been written — the per-topic analogue of EventSource `open`.
  ready?: (generation: number) => void;
  // The presented cursor is not replayable: take a fresh snapshot and
  // subscribe again from its cursor. Topic-scoped; says nothing about other
  // topics. `data` may carry the child's own resync event.
  resync?: (data: unknown, generation: number) => void;
  // The upstream failed or the child exited; the hub retries while
  // subscribers remain and sends `ready` on recovery.
  unavailable?: (generation: number) => void;
  // The whole stream dropped and a reconnect is scheduled. `drops` counts
  // consecutive drops since the stream last said hello, so a consumer can
  // stay quiet on the first one and speak once an outage persists.
  dropped?: (drops: number) => void;
};

export type LiveSubscriptionHandle = {
  // Re-attaches the same key from a cursor — an `add` of a subscribed key
  // replaces it. The resync path: snapshot, then resubscribe with its cursor.
  resubscribe(cursor?: string): void;
  close(): void;
};

export type LiveActivityListener = (ws: string, activity: WorkspaceActivity) => void;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type LiveChannelOptions = {
  // The workspace whose topics the stream carries; null when the page is
  // served at "/" (the e2e harness), where the query omits it.
  ws: string | null;
  // Whether to opt into the cross-workspace `activity` topic.
  activity: boolean;
  openSource: (url: string) => LiveChannelSource;
  fetcher: FetchLike;
  timers?: LiveChannelTimers;
};

export type LiveChannelConnectOptions = {
  // Whether this attempt replaces a stream the client believes it lost, as
  // opposed to the first connect. Only the former is transport recovery, and
  // only it is marked as one for the hub's diagnostics.
  resumed?: boolean;
};

export type LiveChannel = {
  // Supersedes any current attempt with a fresh one presenting every
  // retained cursor. Also the entry point for a lifecycle wake-up.
  connect(options?: LiveChannelConnectOptions): void;
  // Closes the stream without treating it as lost — no drop, no error, no
  // retry — and keeps every subscription with its cursor for the next
  // connect. A page in the background holds no connection this way.
  suspend(): void;
  subscribe(key: LiveSubscriptionKey, consumer: LiveTopicConsumer, options?: { cursor?: string }): LiveSubscriptionHandle;
  onActivity(listener: LiveActivityListener): () => void;
  onStatus(listener: (status: LiveChannelStatus) => void): () => void;
  // The owner applied authoritative state from `generation`. Resets failure
  // accounting and reports `live` — unless the generation has already been
  // superseded, in which case the report is stale and is dropped.
  confirm(generation: number): void;
  // The owner's state from `generation` is no longer proven current (the
  // document topic became unavailable): back to `reconnecting` until a
  // later confirm.
  invalidate(generation: number): void;
  isCurrent(generation: number): boolean;
  currentGeneration(): number;
  // True while a reconnect attempt is scheduled or in flight and no
  // generation has been confirmed since the interruption.
  isRecovering(): boolean;
  // The subscription set with retained cursors, as a reconnect would present it.
  subscriptions(): LiveSubscription[];
  dispose(): void;
};

type Entry = {
  key: LiveSubscriptionKey;
  cursor: string | undefined;
  consumer: LiveTopicConsumer;
  // Set when the handle closes; a closed handle is told nothing more.
  closed: boolean;
};

function keyOf(subscription: LiveSubscriptionKey): LiveSubscriptionKey {
  return subscription.key !== undefined ? { topic: subscription.topic, key: subscription.key } : { topic: subscription.topic };
}

function subscriptionOf(entry: Entry): LiveSubscription {
  return entry.cursor ? { ...entry.key, cursor: entry.cursor } : { ...entry.key };
}

function messageData(event: Event): string {
  const data = (event as MessageEvent<unknown>).data;
  return typeof data === "string" ? data : "";
}

export function createLiveChannel(options: LiveChannelOptions): LiveChannel {
  const timers = options.timers ?? defaultTimers;
  let generation = 0;
  let source: LiveChannelSource | null = null;
  let streamId: string | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let controlRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveFailures = 0;
  let dropsSinceHello = 0;
  let disposed = false;
  let recovering = false;

  const entries = new Map<string, Entry>();
  // Subscriptions the current stream is believed to hold (by id), and ids
  // whose desired state has changed since the stream last heard about them.
  let presented = new Map<string, LiveSubscriptionKey>();
  const dirty = new Set<string>();
  // Generation of the control request in flight, 0 when none. A reply from
  // a request bound to a superseded stream is ignored.
  let controlInFlight = 0;
  let flushQueued = false;
  // Consecutive retryable failures of the current control change.
  let controlFailures = 0;

  const activityListeners = new Set<LiveActivityListener>();
  // The latest activity per described workspace, replayed to a listener as
  // it registers: the hub sends its snapshot once, when the stream opens.
  // Only the current stream's facts: every new stream resends the whole
  // snapshot, and one that omits a workspace (forgotten while this page
  // held no stream) must not let the previous stream's facts replay.
  const latestActivity = new Map<string, WorkspaceActivity>();
  const statusListeners = new Set<(status: LiveChannelStatus) => void>();

  const emitStatus = (status: LiveChannelStatus) => {
    for (const listener of [...statusListeners]) listener(status);
  };

  const cancelPendingReconnect = () => {
    if (reconnectTimer !== null) {
      timers.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const cancelControlRetry = () => {
    if (controlRetryTimer !== null) {
      timers.clearTimeout(controlRetryTimer);
      controlRetryTimer = null;
    }
  };

  const scheduleReconnect = () => {
    // One pending attempt at a time: an `error` burst (some browsers fire it
    // more than once as a socket tears down) must not fan out into a storm of
    // parallel reconnects.
    if (disposed || reconnectTimer !== null) return;
    consecutiveFailures += 1;
    dropsSinceHello += 1;
    const drops = dropsSinceHello;
    for (const entry of [...entries.values()]) entry.consumer.dropped?.(drops);
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      connect({ resumed: true });
    }, reconnectDelay(consecutiveFailures));
  };

  // The stream is gone — by error, or because the hub no longer knows its
  // id. Close before scheduling: leaving the failed source open would let the
  // browser's own retry race ours, and a source left in `CONNECTING` is
  // exactly the stall this module exists to break.
  const lost = (failed: LiveChannelSource) => {
    failed.close();
    if (source === failed) source = null;
    streamId = null;
    controlInFlight = 0;
    controlFailures = 0;
    cancelControlRetry();
    recovering = true;
    emitStatus("reconnecting");
    scheduleReconnect();
  };

  // A subscription the protocol refuses (a key or cursor past its byte
  // bound, one subscription past the per-stream count) can never be sent:
  // the hub answers 400 to the change, and to every reconnect that presents
  // it, so sending it would turn one bad subscription into a reconnect storm
  // for all of them. It is dropped locally and its consumer is told
  // `unavailable`, which every consumer already reads as "no live updates
  // here until further notice": the document topic stops claiming
  // Connected, and chat shows its interruption status. `resync` would be
  // wrong, because consumers answer it by subscribing the same key again,
  // which loops. `dropped` is wrong too, because it describes the whole
  // stream. The consumer is told on a microtask, so a caller of `subscribe`
  // already holds its handle when the callback runs.
  const refuse = (id: string, entry: Entry) => {
    if (entries.get(id) === entry) entries.delete(id);
    queueMicrotask(() => {
      if (!disposed && !entry.closed) entry.consumer.unavailable?.(generation);
    });
  };

  const scheduleControlFlush = () => {
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      flushControl();
    });
  };

  // Serialized: one control request at a time, carrying every change made
  // since the last one. A remove followed by an add of one key collapses
  // into the add (an add of a subscribed key replaces it), and an add
  // followed by a remove into the remove.
  const flushControl = () => {
    // A failed request's changes wait for their retry timer; anything made
    // meanwhile is merged into that retry rather than overtaking it.
    if (disposed || streamId === null || controlInFlight !== 0 || controlRetryTimer !== null || dirty.size === 0) return;
    const add: LiveSubscription[] = [];
    const remove: LiveSubscriptionKey[] = [];
    for (const id of dirty) {
      let entry = entries.get(id);
      if (entry && !admissible(subscriptionOf(entry))) {
        // Validated on subscribe, but a `data` envelope may have moved the
        // cursor since. Refused, it is released at the hub like a close.
        refuse(id, entry);
        entry = undefined;
      }
      const held = presented.get(id);
      if (entry) add.push(subscriptionOf(entry));
      else if (held) remove.push(held);
    }
    dirty.clear();
    if (add.length === 0 && remove.length === 0) return;
    const change: LiveSubscriptionChange = {};
    if (add.length > 0) change.add = add;
    if (remove.length > 0) change.remove = remove;
    const attempt = generation;
    const current = source;
    controlInFlight = attempt;
    void options.fetcher(liveSubscriptionsPath(streamId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(change),
    }).then(response => {
      if (attempt !== generation || disposed) return;
      if (!response.ok && !retryableControlStatus(response.status)) {
        // 404: the hub has ended this stream. 403: it belongs to another hub
        // session. 400: it cannot take this change. The same request would
        // fail the same way, so the stream is lost to the change. The next
        // connect presents the whole set, so nothing is re-queued.
        if (current) lost(current);
        return;
      }
      if (!response.ok) throw new Error(`subscription change failed: ${response.status}`);
      controlFailures = 0;
      for (const subscription of add) presented.set(liveSubscriptionId(subscription), keyOf(subscription));
      for (const key of remove) presented.delete(liveSubscriptionId(key));
    }).catch(() => {
      if (attempt !== generation || disposed) return;
      controlFailures += 1;
      if (controlFailures >= CONTROL_MAX_ATTEMPTS) {
        // The stream keeps failing this change. Stop retrying against it;
        // a reconnect presents the set in full.
        if (current) lost(current);
        return;
      }
      // Put the change back and try again after a backoff; a reconnect in
      // the meantime supersedes it by presenting the set in full.
      for (const subscription of add) dirty.add(liveSubscriptionId(subscription));
      for (const key of remove) dirty.add(liveSubscriptionId(key));
      if (controlRetryTimer === null) {
        controlRetryTimer = timers.setTimeout(() => {
          controlRetryTimer = null;
          flushControl();
        }, reconnectDelay(controlFailures));
      }
    }).finally(() => {
      if (controlInFlight === attempt) {
        controlInFlight = 0;
        flushControl();
      }
    });
  };

  const dispatch = (envelope: LiveEnvelope, attempt: number) => {
    if (envelope.topic === "activity") {
      // `ws` names the described workspace here, any the user may access.
      if (envelope.event.kind !== "data") return;
      const activity = sanitizeWorkspaceActivity(envelope.event.data);
      latestActivity.set(envelope.ws, activity);
      for (const listener of [...activityListeners]) listener(envelope.ws, activity);
      return;
    }
    if (options.ws !== null && envelope.ws !== options.ws) return;
    // A removal takes effect locally at once: nothing for a key the page no
    // longer holds is delivered, however long the hub takes to stop it.
    const entry = entries.get(liveSubscriptionId({ topic: envelope.topic, key: envelope.key }));
    if (!entry) return;
    const event = envelope.event;
    switch (event.kind) {
      case "data":
        // The only place a cursor moves. Signals carry the topic's current
        // cursor unchanged and keepalives never reach here at all.
        entry.cursor = envelope.cursor;
        entry.consumer.data?.(event.data, envelope.cursor, attempt);
        return;
      case "ready":
        entry.consumer.ready?.(attempt);
        return;
      case "resync":
        entry.consumer.resync?.(event.data, attempt);
        return;
      case "unavailable":
        entry.consumer.unavailable?.(attempt);
        return;
    }
  };

  function connect(connectOptions: LiveChannelConnectOptions = {}): void {
    if (disposed) return;
    cancelPendingReconnect();
    cancelControlRetry();
    source?.close();
    source = null;
    streamId = null;
    controlInFlight = 0;
    controlFailures = 0;
    dirty.clear();
    latestActivity.clear();
    const superseding = generation > 0;
    generation += 1;
    const attempt = generation;
    // Superseding a generation leaves nothing confirmed. Continuing to report
    // `Connected` through a replacement that may take arbitrarily long would
    // be a claim this channel cannot back — the new generation has delivered
    // no state yet. Before the first connect the shell is still `Connecting`,
    // which is its own truthful state.
    if (superseding) {
      recovering = true;
      emitStatus("reconnecting");
    }
    // A cursor the hub handed over past the protocol's bound would make the
    // hub refuse this whole stream, on every attempt.
    for (const [id, entry] of [...entries]) {
      if (!admissible(subscriptionOf(entry))) refuse(id, entry);
    }
    const urlFor = (subs: LiveSubscription[]): string => {
      const query = buildLiveStreamQuery({
        ws: options.ws,
        activity: options.activity,
        subs,
        reconnect: connectOptions.resumed === true,
      }).toString();
      return query === "" ? LIVE_STREAM_PATH : `${LIVE_STREAM_PATH}?${query}`;
    };
    // Whatever would take the URL past the budget is added over the control
    // route once the stream says hello instead: the same attach, from the
    // same cursor. The URL is ASCII after encoding, so length is bytes.
    const subs: LiveSubscription[] = [];
    const deferred: string[] = [];
    for (const [id, entry] of entries) {
      const subscription = subscriptionOf(entry);
      if (urlFor([...subs, subscription]).length <= LIVE_CONNECT_URL_MAX_BYTES) subs.push(subscription);
      else deferred.push(id);
    }
    presented = new Map(subs.map(subscription => [liveSubscriptionId(subscription), keyOf(subscription)]));
    for (const id of deferred) dirty.add(id);
    const next = options.openSource(urlFor(subs));
    source = next;
    next.addEventListener("error", () => {
      if (attempt !== generation || disposed) return;
      lost(next);
    });
    next.addEventListener(LIVE_HELLO_EVENT, event => {
      if (attempt !== generation || disposed) return;
      const hello = parseLiveHello(messageData(event));
      if (!hello) return;
      streamId = hello.streamId;
      dropsSinceHello = 0;
      // Anything subscribed or closed while the stream was connecting.
      flushControl();
    });
    next.addEventListener(LIVE_ENVELOPE_EVENT, event => {
      if (attempt !== generation || disposed) return;
      const envelope = parseLiveEnvelope(messageData(event));
      if (envelope) dispatch(envelope, attempt);
    });
  }

  return {
    connect,
    subscribe(key, consumer, subscribeOptions = {}) {
      const id = liveSubscriptionId(key);
      const entry: Entry = { key: { ...key }, cursor: subscribeOptions.cursor || undefined, consumer, closed: false };
      // The hub caps each stream's set; a replacement for a held key does
      // not grow it.
      const overBound = !entries.has(id) && entries.size >= LIVE_MAX_SUBSCRIPTIONS;
      if (overBound || !admissible(subscriptionOf(entry))) {
        refuse(id, entry);
        return {
          resubscribe() {},
          close() { entry.closed = true; },
        };
      }
      entries.set(id, entry);
      dirty.add(id);
      scheduleControlFlush();
      return {
        resubscribe(cursor) {
          if (disposed || entries.get(id) !== entry) return;
          entry.cursor = cursor || undefined;
          // Refused, the key is released at the hub like a close.
          if (!admissible(subscriptionOf(entry))) refuse(id, entry);
          dirty.add(id);
          scheduleControlFlush();
        },
        close() {
          entry.closed = true;
          // A handle closes only its own subscription: a replacement for the
          // same key installed after this handle is left alone.
          if (entries.get(id) !== entry) return;
          entries.delete(id);
          dirty.add(id);
          scheduleControlFlush();
        },
      };
    },
    onActivity(listener) {
      activityListeners.add(listener);
      // A listener that registers after the stream opened (the switcher
      // waits for its own hub probe) would otherwise show nothing until a
      // workspace next changes.
      for (const [ws, activity] of [...latestActivity]) listener(ws, activity);
      return () => { activityListeners.delete(listener); };
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => { statusListeners.delete(listener); };
    },
    confirm(confirmedGeneration) {
      if (disposed || confirmedGeneration !== generation) return;
      consecutiveFailures = 0;
      recovering = false;
      emitStatus("live");
    },
    invalidate(invalidatedGeneration) {
      if (disposed || invalidatedGeneration !== generation || recovering) return;
      recovering = true;
      emitStatus("reconnecting");
    },
    isCurrent(candidate) {
      return !disposed && candidate === generation;
    },
    currentGeneration() {
      return generation;
    },
    isRecovering() {
      return recovering;
    },
    subscriptions() {
      return [...entries.values()].map(subscriptionOf);
    },
    suspend() {
      if (disposed) return;
      cancelPendingReconnect();
      cancelControlRetry();
      source?.close();
      source = null;
      streamId = null;
      controlInFlight = 0;
      // Anything the closed source still delivers is from a superseded
      // attempt, and the next connect is a replacement, not a first connect.
      generation += 1;
      recovering = false;
      latestActivity.clear();
    },
    dispose() {
      disposed = true;
      recovering = false;
      cancelPendingReconnect();
      cancelControlRetry();
      source?.close();
      source = null;
      streamId = null;
      entries.clear();
      dirty.clear();
      latestActivity.clear();
    },
  };
}
