// Transport ownership for the document live-update channel.
//
// A native `EventSource` retries on its own, but the browser exposes no bound
// on how long it may sit in `CONNECTING` — on a mobile device whose network
// path disappeared mid-stream, that wait is effectively forever and the app
// is stranded on "Reconnecting". This module takes recovery away from the
// browser: on any error it closes the failed source and opens a replacement
// on its own capped-exponential schedule, and it keeps doing so until a
// connection is confirmed or the page is disposed.
//
// Every attempt carries a monotonically increasing *generation*. Callbacks
// and asynchronous state application from a superseded attempt are dropped by
// comparing against the current generation, so a slow reply from an older
// stream can never overwrite newer state or revive a stale status.
//
// The channel deliberately does NOT treat `open` as success. Whether an open
// stream counts as connected is the owner's decision, expressed by calling
// `confirm(generation)`; for the document channel that happens only once a
// fresh authoritative state payload from that generation has been applied
// (see `shell/events.ts`).

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

// Matches the Chat streams' schedule (see `chat/client.ts`) — the two live
// channels have the same failure modes and there is no reason for a user to
// experience two different recovery cadences on one screen.
export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 15_000;

export function reconnectDelay(consecutiveFailures: number): number {
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (consecutiveFailures - 1), RECONNECT_MAX_DELAY_MS);
}

export type LiveChannelOptions = {
  // Opens one attempt. The owner attaches its own message listeners here and
  // guards them with `isCurrent(generation)`. `reconnect` says whether this
  // attempt replaces a stream that was lost, so the workspace can count
  // recoveries apart from first connects and context changes.
  open: (generation: number, context: { reconnect: boolean }) => LiveChannelSource;
  onStatus: (status: LiveChannelStatus) => void;
  timers?: LiveChannelTimers;
};

export type LiveChannelConnectOptions = {
  // Whether this attempt replaces a stream the client believes it lost, as
  // opposed to a deliberate context change. Only the former is transport
  // recovery, and only it should be counted as one.
  resumed?: boolean;
};

export type LiveChannel = {
  // Supersedes any current attempt with a fresh one. Also the entry point for
  // deliberate replacement (a scope change, a lifecycle wake-up).
  connect(options?: LiveChannelConnectOptions): void;
  // The owner applied authoritative state from `generation`. Resets failure
  // accounting and reports `live` — unless the generation has already been
  // superseded, in which case the report is stale and is dropped.
  confirm(generation: number): void;
  isCurrent(generation: number): boolean;
  currentGeneration(): number;
  // True while a reconnect attempt is scheduled or in flight and no
  // generation has been confirmed since the interruption.
  isRecovering(): boolean;
  dispose(): void;
};

export function createLiveChannel(options: LiveChannelOptions): LiveChannel {
  const timers = options.timers ?? defaultTimers;
  let generation = 0;
  let source: LiveChannelSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveFailures = 0;
  let disposed = false;
  let recovering = false;

  const cancelPendingReconnect = () => {
    if (reconnectTimer !== null) {
      timers.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = () => {
    // One pending attempt at a time: an `error` burst (some browsers fire it
    // more than once as a socket tears down) must not fan out into a storm of
    // parallel reconnects.
    if (disposed || reconnectTimer !== null) return;
    consecutiveFailures += 1;
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      connect({ resumed: true });
    }, reconnectDelay(consecutiveFailures));
  };

  function connect(connectOptions: LiveChannelConnectOptions = {}): void {
    if (disposed) return;
    cancelPendingReconnect();
    source?.close();
    source = null;
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
      options.onStatus("reconnecting");
    }
    const next = options.open(attempt, { reconnect: connectOptions.resumed === true });
    source = next;
    next.addEventListener("error", () => {
      if (attempt !== generation || disposed) return;
      // Close before scheduling: leaving the failed source open would let the
      // browser's own retry race ours, and a source left in `CONNECTING` is
      // exactly the stall this module exists to break.
      next.close();
      source = null;
      recovering = true;
      options.onStatus("reconnecting");
      scheduleReconnect();
    });
  }

  return {
    connect,
    confirm(confirmedGeneration: number) {
      if (disposed || confirmedGeneration !== generation) return;
      consecutiveFailures = 0;
      recovering = false;
      options.onStatus("live");
    },
    isCurrent(candidate: number) {
      return !disposed && candidate === generation;
    },
    currentGeneration() {
      return generation;
    },
    isRecovering() {
      return recovering;
    },
    dispose() {
      disposed = true;
      recovering = false;
      cancelPendingReconnect();
      source?.close();
      source = null;
    },
  };
}
