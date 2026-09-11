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
import { createLifecycleRecovery, type LifecycleRecovery } from "./recovery";

let channel: LiveChannel | null = null;
let lifecycle: LifecycleRecovery | null = null;
const recoveryWork = new Set<() => Promise<unknown>>();

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
  liveChannel().connect({ resumed: true });
  await Promise.allSettled([...recoveryWork].map(work => work()));
}

// Installed once, by boot. `pageshow` from the back/forward cache, a return
// to the foreground, and a regained network connection all mean the same
// thing — this page has been out of touch and cannot trust what it holds.
export function watchPageLifecycle(): void {
  lifecycle ??= createLifecycleRecovery({
    win: window,
    doc: document,
    recover: recoverLiveChannel,
    discard: disposeLiveChannel,
  });
}

// Tears the channel down for good. Called when the page is being discarded:
// a retry cycle outliving the page would keep firing timers against a
// document that is on its way out.
export function disposeLiveChannel(): void {
  channel?.dispose();
  channel = null;
  lifecycle?.dispose();
  lifecycle = null;
}
