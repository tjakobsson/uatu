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
  // Records authoritative state that arrived by some other route — a live
  // stream frame — with the server-side freshness of that payload.
  noteApplied(freshness: number): void;
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
  // Between a request and a STREAM FRAME, server freshness decides. Arrival
  // order says nothing there: a frame the server produced before the fetch can
  // still be delivered while it is in flight, and treating it as newer would
  // discard the fresher payload.
  let issued = 0;
  // The newest request that has ANSWERED — applied, superseded by a frame, or
  // failed. All three settle the intent: once a newer request has come back,
  // an older one's context is obsolete and must not be reinstated, whatever
  // became of the newer payload.
  let settledSequence = 0;
  let frameFreshness = Number.NEGATIVE_INFINITY;

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
      if (options.freshnessOf(payload) <= frameFreshness) return false;
      options.applyState(payload);
      return true;
    },
    noteApplied(freshness: number) {
      // Deliberately does NOT touch the request ordering: a frame proves the
      // server's state at a moment, not that any pending request is obsolete.
      if (freshness > frameFreshness) frameFreshness = freshness;
    },
  };
}

export type LifecycleRecoveryTarget = {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
};

export type LifecycleRecovery = {
  // Runs a recovery unless one is already in flight.
  request(): void;
  dispose(): void;
};

export function createLifecycleRecovery(options: {
  win: LifecycleRecoveryTarget;
  doc: LifecycleRecoveryTarget & { visibilityState?: string };
  recover: () => Promise<unknown>;
  // The page is being discarded rather than frozen: tear the channel down for
  // good so its retry cycle does not outlive the document.
  discard: () => void;
}): LifecycleRecovery {
  let inFlight = false;
  let disposed = false;

  const request = () => {
    // An overlapping signal has nothing to add: the recovery already in
    // flight fetches current state and installs a fresh stream, which is the
    // whole of what a second one would do. Dropping it — rather than queuing
    // it — is what keeps a `pageshow` + `visibilitychange` + `online` burst
    // from turning into a request storm on a phone waking up.
    if (disposed || inFlight) return;
    inFlight = true;
    let running: Promise<unknown>;
    try {
      running = Promise.resolve(options.recover());
    } catch {
      // A synchronous throw is still a finished attempt; the next signal
      // must be free to try again.
      inFlight = false;
      return;
    }
    void running.catch(() => undefined).then(() => {
      inFlight = false;
    });
  };

  const onPageShow = (event: Event) => {
    // A restore from the back/forward cache: the page's timers, sockets and
    // JavaScript were frozen, so nothing it believes about the server is
    // trustworthy. A first load also fires `pageshow`, but with
    // `persisted: false`, and boot already installed a stream.
    if ((event as PageTransitionEvent).persisted) request();
  };
  const onVisibility = () => {
    if (options.doc.visibilityState === "visible") request();
  };
  const onOnline = () => request();
  const onPageHide = (event: Event) => {
    // `persisted` means frozen for the back/forward cache — a later `pageshow`
    // brings it back and recovers. Only an unpersisted hide is a discard.
    if (!(event as PageTransitionEvent).persisted) options.discard();
  };

  options.win.addEventListener("pageshow", onPageShow);
  options.win.addEventListener("online", onOnline);
  options.win.addEventListener("pagehide", onPageHide);
  options.doc.addEventListener("visibilitychange", onVisibility);

  return {
    request,
    dispose() {
      disposed = true;
      options.win.removeEventListener("pageshow", onPageShow);
      options.win.removeEventListener("online", onOnline);
      options.win.removeEventListener("pagehide", onPageHide);
      options.doc.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
