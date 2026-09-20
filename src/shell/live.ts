// The page's one live channel and its one lifecycle recovery.
//
// Every consumer of pushed updates — the document reducer in
// `shell/events.ts`, the chat client's inventory and conversation handlers,
// the workspace switcher's activity — shares the channel this module holds,
// so a session tab costs exactly one long-lived HTTP connection whatever is
// open in it. Wake-ups (a page restored from the back/forward cache, a return
// to the foreground, a regained network) recover that one channel and run
// the reconciliation work each consumer registered, in one coalesced pass.
//
// DOM-free apart from the lazily-read `window`/`document`/`EventSource`
// globals, so the chat surface and its tests can import it without pulling
// in the shell's rendering modules.

import { appBasePath, workspaceIdFromBasePath } from "../shared/app-url";
import { createLiveChannel, type LiveChannel } from "./live-channel";
import { createLifecycleRecovery, type LifecycleRecovery, type LifecycleRecoveryTimers } from "./recovery";
import { currentSessionRunningFact } from "./session-running";

let channel: LiveChannel | null = null;
let lifecycle: LifecycleRecovery | null = null;
const recoveryWork = new Set<() => Promise<unknown>>();
// Set while the page has released its stream because it was hidden.
let releasedInBackground = false;

// The page is being hidden, however the browser announces it: drop the
// connection and any pending reconnect, keeping every subscription and
// cursor. Reversible by construction — `suspend`, not `dispose` — because no
// hide is proof the document will never run again. iOS fires `pagehide`
// with `persisted: false` for a standalone page it then keeps alive, and a
// document that really unloads takes its timers with it, so there is nothing
// a permanent teardown would protect.
function releaseLiveChannel(): void {
  if (channel === null) return;
  releasedInBackground = true;
  channel.suspend();
}

// A page hidden from view holds no live connection. Browsers allow six
// HTTP/1.1 connections per host across every tab on the hub, so one stream
// per tab would still stall the sixth tab; only visible pages count now. The
// channel keeps every subscription and cursor, and the return to the
// foreground — which the lifecycle recovery below already treats as a
// wake-up — reconnects and resumes each topic. There is no grace period:
// that recovery reconnects on every return anyway, so holding the stream
// through a short absence would keep a socket without saving a reconnect.
// Notifications come from the hub's independent Web Push observer, so they do
// not require a hidden page to hold this connection. Title/favicon are static.
//
// The lifecycle recovery performs this release on every hide it observes
// (it has to know, so a recovery hidden mid-flight is followed up); this is
// only the boot-time check for a page opened in a background tab.
function releaseInBackground(): void {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") return;
  releaseLiveChannel();
}

export function liveChannel(): LiveChannel {
  if (channel === null) {
    // The workspace id comes from the hub-shaped base path ("/s/<id>/"). A
    // page served at "/" (the e2e harness) has none, omits `ws`, and does not
    // ask for other workspaces' activity — there are none to show.
    const ws = workspaceIdFromBasePath(appBasePath());
    channel = createLiveChannel({
      ws,
      activity: ws !== null,
      openSource: url => new EventSource(url),
      fetcher: (input, init) => fetch(input, init),
    });
  }
  return channel;
}

// Test seam: installs a controllable channel (or clears the singleton).
export function installLiveChannelForTests(next: LiveChannel | null): void {
  channel = next;
}

// Consumers register what a wake-up must reconcile for them — the document
// state fetch, the chat inventory re-read. The channel itself resumes every
// topic from its retained cursor; this is for authoritative state the stream
// cannot replay. Returns the unregister function.
export function registerRecoveryWork(work: () => Promise<unknown>): () => void {
  recoveryWork.add(work);
  return () => { recoveryWork.delete(work); };
}

// A wake-up IS a recovery: the stream this page holds may have died silently
// while it was suspended or off the network. The channel is superseded FIRST
// and synchronously, so the stream being replaced cannot deliver anything
// more and the replacement does not depend on any fetch succeeding — only a
// fresh attempt can error and hand recovery to the channel's retry cycle. The
// reconciliation work then runs against a page that already holds one
// current connection attempt.
export async function recoverLiveChannel(): Promise<void> {
  // A regained network while still in the background must not undo the
  // release; the return to the foreground recovers.
  if (releasedInBackground && typeof document !== "undefined" && document.visibilityState === "hidden") return;
  releasedInBackground = false;
  liveChannel().connect({ resumed: true });
  await Promise.allSettled([...recoveryWork].map(work => work()));
}

// Installed once, by boot. `pageshow` from the back/forward cache, a return
// to the foreground, and a regained network connection all mean the same
// thing — this page has been out of touch and cannot trust what it holds.
// `pagehide` releases the stream; nothing here ever disposes it, so the
// listeners stay armed for the life of the document.
export function watchPageLifecycle(): void {
  lifecycle ??= createLifecycleRecovery({
    win: window,
    doc: document,
    recover: recoverLiveChannel,
    release: releaseLiveChannel,
  });
  // Boot connects before this runs; a page opened in a background tab
  // releases that connection until it is first shown.
  releaseInBackground();
}

// ---------------------------------------------------------------------------
// Manual recovery: the user's way back from a stall, whatever caused it.
//
// Both the Chat surface's interruption line and the shell's connection
// indicator call this. It attempts the same recovery a wake-up performs and
// waits for the channel to confirm live — authoritative state applied, not
// merely a socket opened. If that does not happen within the window, the
// page reloads: an in-place attempt cannot rescue a page whose own recovery
// machinery is no longer running, and a reload is what the dashboard
// round-trip costs today anyway. Reached only after the in-place attempt has
// had its chance, so a recoverable stall keeps its scroll position, drafts,
// and view state.
//
// Except on a hub page whose session is stopped: a reload there can only
// reach the hub's "session unavailable" page and its Start button, and the
// connection indicator now offers that start in place. The attempt settles
// without navigating, and the indicator says `Stopped`.

// How long an in-place attempt has to confirm live before reloading. Longer
// than the channel's first reconnect delay and than a state fetch on a slow
// path; short enough that a user who tapped is not left wondering.
export const MANUAL_RECOVERY_WINDOW_MS = 10_000;

type ManualRecoveryDeps = {
  reload: () => void;
  windowMs: number;
  timers: LifecycleRecoveryTimers;
  // Whether the hub says this page's session is stopped (see
  // shell/session-running.ts); a timed-out attempt does not reload then.
  sessionStopped: () => boolean;
};

const defaultManualDeps: ManualRecoveryDeps = {
  reload: () => window.location.reload(),
  windowMs: MANUAL_RECOVERY_WINDOW_MS,
  timers: {
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: timer => clearTimeout(timer),
  },
  sessionStopped: () => currentSessionRunningFact() === false,
};

let manualDeps: ManualRecoveryDeps = defaultManualDeps;
// Holds on the reload fallback. The indicator's in-place start of a stopped
// session takes one for its duration: the session may already read running
// (so `sessionStopped` no longer protects the page) while its state is
// still on the way, and any recovery requested meanwhile — the Chat
// surface's Reconnect calls `requestManualRecovery` on its own — must not
// answer its timeout with the reload the start exists to avoid.
let reloadHolds = 0;

export function holdManualReload(): () => void {
  reloadHolds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reloadHolds -= 1;
  };
}
// The attempt in flight, or null. A second request while one is running
// joins it rather than starting another.
let manualAttempt: { promise: Promise<void>; cancel: () => void } | null = null;
const manualListeners = new Set<(inFlight: boolean) => void>();

// Test seam: an injected reload, window, and clock. `null` restores defaults.
export function installManualRecoveryForTests(deps: Partial<ManualRecoveryDeps> | null): void {
  manualDeps = deps ? { ...defaultManualDeps, ...deps } : defaultManualDeps;
}

export function isManualRecoveryInFlight(): boolean {
  return manualAttempt !== null;
}

// Whether an attempt is under way, for the controls that offer one to show
// it. Called at once with the current state.
export function onManualRecovery(listener: (inFlight: boolean) => void): () => void {
  manualListeners.add(listener);
  listener(manualAttempt !== null);
  return () => { manualListeners.delete(listener); };
}

function notifyManual(inFlight: boolean): void {
  for (const listener of [...manualListeners]) listener(inFlight);
}

export function requestManualRecovery(): Promise<void> {
  if (manualAttempt !== null) return manualAttempt.promise;
  const deps = manualDeps;
  const target = liveChannel();
  let settle!: (outcome: "live" | "timeout" | "cancelled") => void;
  const outcome = new Promise<"live" | "timeout" | "cancelled">(resolve => { settle = resolve; });
  // Listening BEFORE the recovery starts, so a fast confirmation cannot be
  // missed. Only a `live` emitted after this point counts: the recovery
  // supersedes the current generation, and only the replacement's confirm
  // can say the page is current again.
  const unsubscribe = target.onStatus(status => { if (status === "live") settle("live"); });
  const timer = deps.timers.setTimeout(() => settle("timeout"), deps.windowMs);
  const attempt = {
    promise: outcome.then(result => {
      unsubscribe();
      deps.timers.clearTimeout(timer);
      manualAttempt = null;
      notifyManual(false);
      if (result === "timeout" && !deps.sessionStopped() && reloadHolds === 0) deps.reload();
    }),
    cancel: () => settle("cancelled"),
  };
  manualAttempt = attempt;
  notifyManual(true);
  // Not awaited: the recovery's reconciliation work may itself take up to
  // its own budget, and what decides the outcome is the channel confirming,
  // which arrives over the stream independently of that work.
  void recoverLiveChannel();
  return attempt.promise;
}

// Waits for the channel to confirm live, for at most the manual-recovery
// window. What the indicator's start of a stopped session waits on: the
// started child's state arriving over the stream is what makes the page
// current again, and nothing this page does can hurry it. Armed BEFORE the
// start is requested, because a quick start confirms the channel before the
// hub's answer arrives, and `onStatus` does not replay; cancelled if the hub
// refuses. Does not start a recovery and does not reload — after a timeout
// the indicator simply shows whatever the channel reports.
export type ConfirmedLiveWait = {
  outcome: Promise<"live" | "timeout" | "cancelled">;
  cancel(): void;
};

// Waits not yet settled, so a teardown of the channel ends them (and
// releases whatever they hold) instead of leaving them to their timers.
const liveWaits = new Set<() => void>();

export function awaitConfirmedLive(): ConfirmedLiveWait {
  const deps = manualDeps;
  let finish!: (outcome: "live" | "timeout" | "cancelled") => void;
  const outcome = new Promise<"live" | "timeout" | "cancelled">(resolve => {
    let settled = false;
    finish = result => {
      if (settled) return;
      settled = true;
      liveWaits.delete(cancel);
      unsubscribe();
      deps.timers.clearTimeout(timer);
      resolve(result);
    };
    const unsubscribe = liveChannel().onStatus(status => { if (status === "live") finish("live"); });
    const timer = deps.timers.setTimeout(() => finish("timeout"), deps.windowMs);
  });
  const cancel = () => finish("cancelled");
  liveWaits.add(cancel);
  return { outcome, cancel };
}

// Tears the channel down for good. Explicit teardown only — tests, and a
// navigation away to the hub — never a lifecycle event: a hidden page is
// released (see `releaseLiveChannel`), not disposed, so it can come back.
export function disposeLiveChannel(): void {
  releasedInBackground = false;
  manualAttempt?.cancel();
  for (const cancel of [...liveWaits]) cancel();
  channel?.dispose();
  channel = null;
  lifecycle?.dispose();
  lifecycle = null;
}
