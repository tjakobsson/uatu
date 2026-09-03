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
  // payload was the one applied, `false` when a newer application overtook it.
  reconcile(): Promise<boolean>;
  // Records that authoritative state arrived by some other route — a live
  // stream frame. This invalidates any fetch already in flight, whose payload
  // is now the older of the two.
  noteApplied(): void;
};

export function createStateReconciler<T>(options: {
  fetchState: () => Promise<T>;
  applyState: (value: T) => void;
}): StateReconciler<T> {
  // Monotonic count of applications of authoritative state, from any source.
  // A reconcile captures it before its fetch and refuses to apply if it moved
  // — that single token covers both "a second reconcile finished first" and
  // "the live stream delivered state while this fetch was in flight".
  let applied = 0;

  return {
    async reconcile() {
      const token = applied;
      const payload = await options.fetchState();
      if (token !== applied) return false;
      options.applyState(payload);
      applied += 1;
      return true;
    },
    noteApplied() {
      applied += 1;
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
