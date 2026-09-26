// Wake-up recovery for the document channel.
//
// A mobile browser may freeze the page, move between networks, or hold a
// dead socket open with no error. None of those produce an application
// event, so the only honest response to "the page is running again" is to
// re-fetch authoritative state and install a fresh stream. Two pieces:
//
//   - `createStateReconciler` performs that fetch-and-apply with a guard that
//     drops any completion that a newer application of state has overtaken.
//   - `createLifecycleRecovery` collapses the several browser signals that all
//     mean "the page resumed" into a single reconciliation.
//
// Both are dependency-injected and free of DOM imports so the ordering rules
// they encode can be tested directly.

export type StateReconciler<T> = {
  // Fetches and applies authoritative state. Resolves `true` when this call's
  // payload was the one applied, `false` when fresher state had already been
  // applied by the time it answered.
  reconcile(): Promise<boolean>;
  // The gate for authoritative state arriving by another route — a live
  // stream frame. Returns `false` when state the server produced later has
  // already been applied, in which case the caller must ignore the frame;
  // returns `true` and records it otherwise.
  acceptFrame(freshness: number): boolean;
  // Records state the caller applied by a route of its own — boot's initial
  // fetch — as the freshness every later payload must beat. Never lowers the
  // watermark.
  recordApplied(freshness: number): void;
};

export function createStateReconciler<T>(options: {
  fetchState: () => Promise<T>;
  applyState: (value: T) => void;
  // When the SERVER produced this payload. Only the server's own clock can
  // order a fetch against a stream frame, and both come from the same process.
  freshnessOf: (value: T) => number;
}): StateReconciler<T> {
  // Two orderings, because the two hazards are different.
  //
  // Between REQUESTS, client intent decides. A request carries the context the
  // user asked for, so the newest one issued must win even if the server
  // happened to answer it first and stamp it earlier — otherwise an
  // overlapping pair of scope changes can settle on the older scope.
  //
  // Between ANY TWO PAYLOADS, server freshness decides. Arrival order says
  // nothing: a frame the server produced before a fetch can be delivered while
  // it is in flight, and a frame produced before a fetch's reply can be
  // dispatched after it. One watermark both sources must beat, so neither can
  // overwrite the other's newer state.
  let issued = 0;
  // The newest request that has ANSWERED — applied, superseded, or failed. All
  // three settle the intent: once a newer request has come back, an older
  // one's context is obsolete, whatever became of the newer payload.
  let settledSequence = 0;
  let appliedFreshness = Number.NEGATIVE_INFINITY;

  return {
    async reconcile() {
      const sequence = ++issued;
      let payload: T;
      try {
        payload = await options.fetchState();
      } catch (error) {
        if (sequence > settledSequence) settledSequence = sequence;
        throw error;
      }
      if (sequence <= settledSequence) return false;
      settledSequence = sequence;
      const freshness = options.freshnessOf(payload);
      if (freshness <= appliedFreshness) return false;
      appliedFreshness = freshness;
      options.applyState(payload);
      return true;
    },
    acceptFrame(freshness: number) {
      // Deliberately does NOT touch the request ordering: a frame proves the
      // server's state at a moment, not that any pending request is obsolete.
      if (freshness <= appliedFreshness) return false;
      appliedFreshness = freshness;
      return true;
    },
    recordApplied(freshness: number) {
      if (freshness > appliedFreshness) appliedFreshness = freshness;
    },
  };
}

export type LifecycleRecoveryTarget = {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
};

export type LifecycleRecoveryTimers = {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};

const defaultTimers: LifecycleRecoveryTimers = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timer => clearTimeout(timer),
};

// How long one recovery may hold the coalescer. Every registered task is
// meant to bound itself (the state fetch carries a timeout shorter than
// this); the ceiling guards against one that does not, so no single hung
// task can leave every later wake-up signal dropped. It releases the slot
// only — the work stays owned by whoever registered it, and the reconciler's
// ordering guards make a late completion harmless.
export const RECOVERY_CEILING_MS = 30_000;

export type LifecycleRecovery = {
  // Runs a recovery unless one is already in flight.
  request(): void;
  dispose(): void;
};

type Attempt = { timer: ReturnType<typeof setTimeout> | null };

export function createLifecycleRecovery(options: {
  win: LifecycleRecoveryTarget;
  doc: LifecycleRecoveryTarget & { visibilityState?: string };
  recover: () => Promise<unknown>;
  // The page is being hidden (`pagehide`, whether or not the browser
  // promises to restore it): drop the connection and its pending timers,
  // keeping subscriptions and cursors, so a later wake-up resumes. Never a
  // teardown. iOS fires an unpersisted `pagehide` for a standalone page it
  // then keeps alive, and a page that really unloads takes its timers with
  // it — so no lifecycle event is proof the document will never run again.
  release: () => void;
  timers?: LifecycleRecoveryTimers;
  ceilingMs?: number;
}): LifecycleRecovery {
  const timers = options.timers ?? defaultTimers;
  const ceilingMs = options.ceilingMs ?? RECOVERY_CEILING_MS;
  // The recovery holding the coalescer. An object rather than a flag so the
  // late settlement of an abandoned recovery cannot release a newer one's slot.
  let inFlight: Attempt | null = null;
  // Set when the page was released while a recovery was in flight. That
  // recovery's channel is gone — the release suspended it — so its completion
  // no longer leaves the page connected, and the next signal cannot be
  // treated as a duplicate of it.
  let releasedInFlight = false;
  // A signal that arrived after such a release, to run once the slot frees.
  let queued = false;
  let disposed = false;

  const settle = (attempt: Attempt) => {
    if (inFlight !== attempt) return;
    if (attempt.timer !== null) timers.clearTimeout(attempt.timer);
    inFlight = null;
    releasedInFlight = false;
    if (queued) {
      queued = false;
      request();
    }
  };

  const request = () => {
    if (disposed) return;
    if (inFlight !== null) {
      // An overlapping signal usually has nothing to add: the recovery in
      // flight fetches current state and installs a fresh stream, which is
      // the whole of what a second one would do. Dropping it — rather than
      // queuing it — is what keeps a `pageshow` + `visibilitychange` +
      // `online` burst from turning into a request storm on a phone waking
      // up. The exception is a page hidden and shown again while that
      // recovery was still waiting on its work: the hide took its channel
      // away, so this signal is the only thing that will bring one back.
      if (releasedInFlight) queued = true;
      return;
    }
    const attempt: Attempt = { timer: null };
    inFlight = attempt;
    attempt.timer = timers.setTimeout(() => settle(attempt), ceilingMs);
    let running: Promise<unknown>;
    try {
      running = Promise.resolve(options.recover());
    } catch {
      // A synchronous throw is still a finished attempt; the next signal
      // must be free to try again.
      settle(attempt);
      return;
    }
    void running.catch(() => undefined).then(() => settle(attempt));
  };

  const onPageShow = (event: Event) => {
    // A restore from the back/forward cache: the page's timers, sockets and
    // JavaScript were frozen, so nothing it believes about the server is
    // trustworthy. A first load also fires `pageshow`, but with
    // `persisted: false`, and boot already installed a stream.
    if ((event as PageTransitionEvent).persisted) request();
  };
  // Every hide goes through here — a hidden page, and `pagehide` whatever
  // `persisted` says (a frozen page and a "discarded" one the browser keeps
  // alive anyway are released the same way, and the listeners stay armed for
  // whichever wake-up comes) — so the coalescer knows when an in-flight
  // recovery has lost its channel.
  const release = () => {
    options.release();
    if (inFlight !== null) releasedInFlight = true;
  };
  const onVisibility = () => {
    if (options.doc.visibilityState === "visible") request();
    else release();
  };
  const onOnline = () => request();
  const onPageHide = () => release();

  options.win.addEventListener("pageshow", onPageShow);
  options.win.addEventListener("online", onOnline);
  options.win.addEventListener("pagehide", onPageHide);
  options.doc.addEventListener("visibilitychange", onVisibility);

  return {
    request,
    dispose() {
      disposed = true;
      queued = false;
      if (inFlight !== null) settle(inFlight);
      options.win.removeEventListener("pageshow", onPageShow);
      options.win.removeEventListener("online", onOnline);
      options.win.removeEventListener("pagehide", onPageHide);
      options.doc.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
