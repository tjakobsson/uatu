// Live event stream — opens the /api/events EventSource and dispatches each
// `state` payload back into the app. The reducer logic for build-freshness
// checking, follow-mode auto-switching, and on-disk-change reloads lives in
// here, intentionally close to its trigger (the SSE message).

import { chooseSelectionForFileEvent } from "./follow";
import { checkBuildFreshness } from "./freshness";
import { applyProjectIdentity } from "./identity";
import { findDocumentById, syncStateGeneration } from "./storage";
import { signalActiveDocumentUpdated } from "../preview/file-facts-strip";
import { documentDiffCache, forgetDocumentCache, loadDocument } from "../preview/mount";
import { renderEmptyPreview } from "../preview/empty";
import { renderSidebar } from "../sidebar/shell";
import { markSearchResultsStale, noteSearchCorpusChange, syncSearchScope } from "../sidebar/search-pane";
import {
  hasDocument,
  shouldRefreshPreview,
  type StatePayload,
} from "../shared/types";
import { applyChannelStatus } from "./connection";
import { createLiveChannel, type LiveChannel } from "./live-channel";
import { createLifecycleRecovery, createStateReconciler, type LifecycleRecovery } from "./recovery";
import { renderBuildBadge } from "./connection";
import { appUrl } from "../shared/app-url";
import { replaceSelection } from "./history";
import { setSelectedId } from "./selection";
import { appState } from "./state";
import { renderCommitPreview } from "./url";
import { contextualAppUrl, setClientScope } from "./watch-context";

// Recovery for this stream is owned by `createLiveChannel`, not by the
// browser. Native `EventSource` retry is unbounded in the one case that
// matters — a mobile device whose network path vanished leaves the source in
// `CONNECTING` with no error and no timeout, so the app sits on
// "Reconnecting" forever and never observes the server again (the
// client-freshness handshake rides the reconnect's first state payload). The
// channel closes each failed source and reopens on a capped-backoff schedule
// of its own, and it treats a generation as connected only once that
// generation's authoritative state has been applied below.
let channel: LiveChannel | null = null;

function documentChannel(): LiveChannel {
  channel ??= createLiveChannel({ open: openDocumentStream, onStatus: applyChannelStatus });
  return channel;
}

function scopesEqual(left: StatePayload["scope"], right: StatePayload["scope"]): boolean {
  return left.kind === right.kind
    && (left.kind === "folder" || (right.kind === "file" && left.documentId === right.documentId));
}

// Owner mutator for the server-snapshot triple (`roots`, `repositories`,
// `scope`). The SSE reducer below is the ongoing writer; the boot path
// (`shell/boot.ts`) applies its initial /api/state payload through this too.
export function applyServerSnapshot(payload: StatePayload): void {
  // Every payload carries the server's build identity — boot and SSE
  // reconnect both land here, so this is the one freshness chokepoint.
  checkBuildFreshness(payload.build);
  appState.roots = payload.roots;
  appState.repositories = payload.repositories ?? [];
  setClientScope(payload.scope);
  appState.unscopedFingerprint = payload.unscopedFingerprint ?? null;
  // The Search pane names the scope in effect; it has to hear about changes.
  syncSearchScope();
  // And a document vanishing from the corpus invalidates results that point at
  // it — a deletion arrives with no `changedId`, so the change path misses it.
  // (For widened results the fingerprint just stored is the signal instead.)
  noteSearchCorpusChange();
  // Title, favicon tint, and sidebar marker all derive from roots;
  // re-applying on every payload keeps them honest if roots change.
  applyProjectIdentity(payload.roots);
}

// `resumed` says this replaces a stream the client believes it lost, which is
// what makes it a recovery. A scope widening, a compare-target change, or the
// server normalizing an invalid pin all replace the stream too, and counting
// those as recoveries would make the diagnostic meaningless.
export function connectEvents(options: { resumed?: boolean } = {}) {
  documentChannel().connect(options);
}

// Tears down the live channel for good. Called when the page is being
// discarded: a retry cycle outliving the page would keep firing timers
// against a document that is on its way out.
export function disconnectEvents() {
  channel?.dispose();
  channel = null;
  lifecycle?.dispose();
  lifecycle = null;
}

function openDocumentStream(generation: number, context: { reconnect: boolean }): EventSource {
  // A bare marker so the workspace can count recoveries apart from first
  // connects. Nothing about the connection that was lost travels with it.
  const url = new URL(contextualAppUrl(appUrl("/api/events")), window.location.href);
  if (context.reconnect) url.searchParams.set("reconnect", "1");
  const events = new EventSource(`${url.pathname}${url.search}`);

  events.addEventListener("state", async event => {
    // A payload from a superseded attempt describes a connection this client
    // has already replaced; applying it could overwrite newer state.
    if (!documentChannel().isCurrent(generation)) return;
    const payload = JSON.parse((event as MessageEvent<string>).data) as StatePayload;
    // A frame the server produced before state this client has already applied
    // — the initial frame of a stream opened just before a reconciliation
    // fetch answered, typically. Applying it would put back the older roots,
    // repositories, and scope. The transport is still proven live, so the
    // channel is confirmed either way.
    if (!stateReconciler.acceptFrame(payload.generatedAt)) {
      documentChannel().confirm(generation);
      return;
    }
    const previousSelectedId = appState.selectedId;
    const previousScope = appState.scope;
    const shouldReload = shouldRefreshPreview(
      previousSelectedId,
      payload.changedId,
      appState.roots,
      payload.roots,
    );

    applyServerSnapshot(payload);
    // Transport is only proven once this generation's authoritative state has
    // been applied — an open socket that never delivers state is exactly the
    // half-dead connection the indicator must not call `Connected`.
    documentChannel().confirm(generation);
    if (!scopesEqual(previousScope, payload.scope)) {
      // EventSource automatically reconnects its original URL. Replace it
      // after server-side normalization so a later reconnect cannot revive a
      // deleted file pin that this client has already widened away from. Not a
      // recovery: the transport never failed, the server changed the context.
      connectEvents();
    }
    syncStateGeneration(payload.generatedAt);

    // A watched file changed, so displayed search results captured line
    // numbers that may no longer hold. Mark them rather than re-running: in a
    // watched repository that would be a query storm, and rows would jump
    // under the reader's cursor while they are reading them. The pane checks
    // the id against its rows — a change to an unlisted file proves nothing
    // about the results. This must precede the preview-mode returns below:
    // the Search pane is visible in those modes too, and its results go stale
    // the same way there.
    if (payload.changedId) {
      markSearchResultsStale(payload.changedId);
    }

    // Local snapshot so the discriminant narrowing survives into the closure.
    const previewMode = appState.previewMode;
    if (previewMode.kind === "commit") {
      renderSidebar();
      renderCommitPreview(previewMode);
      return;
    }

    // Rule C/D selection decision (see follow-mode capability).
    setSelectedId(chooseSelectionForFileEvent(
      payload.roots,
      previousSelectedId,
      payload.changedId,
      appState.followEnabled,
    ));

    // Reveal the newly-selected file only when selection actually changed —
    // so a user-closed ancestor isn't re-opened by unrelated state updates.
    if (appState.selectedId && appState.selectedId !== previousSelectedId) {
      // Server-driven selection change (follow auto-switch, or current doc
      // was deleted and we fell back to the default). The URL must follow
      // what's on screen, but we use replaceState — pushing here would
      // pollute the back stack with file-change-driven entries the user
      // never asked for.
      const switched = findDocumentById(appState.selectedId);
      if (switched) {
        replaceSelection(appState.selectedId, switched.relativePath);
      }
    }

    renderSidebar();

    if (
      appState.selectedId &&
      (shouldReload || appState.selectedId !== previousSelectedId)
    ) {
      if (shouldReload) {
        // The file changed on disk — any cached payload is now stale.
        forgetDocumentCache(appState.selectedId);
      }
      await loadDocument(appState.selectedId);
      if (shouldReload && appState.selectedId === previousSelectedId) {
        // In-place reload of the document being viewed (Rule D): surface the
        // otherwise-silent swap. A selection switch is a new document, not an
        // update of what the user was reading — no signal there.
        signalActiveDocumentUpdated();
      }
      return;
    }

    if (!hasDocument(payload.roots, appState.selectedId)) {
      renderEmptyPreview("No document selected", "Waiting for viewable files");
    }
  });

  return events;
}

// The one path that converges this client on authoritative state and a fresh
// stream. Both the explicit callers (scope widening, compare-target change)
// and the lifecycle wake-up below go through it, so the reconciler's ordering
// guard covers them all: an older fetch cannot land on top of newer state,
// whichever route delivered that state.
const stateReconciler = createStateReconciler<StatePayload>({
  fetchState: async () => {
    const response = await fetch(contextualAppUrl(appUrl("/api/state")));
    if (!response.ok) throw new Error(`state refresh failed: ${response.status}`);
    return (await response.json()) as StatePayload;
  },
  freshnessOf: payload => payload.generatedAt,
  applyState: payload => {
    // Decided against the roots this client still holds, BEFORE the snapshot
    // overwrites them. A document edited while the page was suspended arrives
    // with no `changedId` and, once these roots are replaced, the replacement
    // stream's first frame sees no mtime difference either — so this is the
    // only place the staleness is still visible.
    const selectedId = appState.selectedId;
    const staleSelection = shouldRefreshPreview(
      selectedId,
      payload.changedId,
      appState.roots,
      payload.roots,
    );

    applyServerSnapshot(payload);
    syncStateGeneration(payload.generatedAt);
    renderBuildBadge(payload.build);
    renderSidebar();
    if (selectedId && staleSelection) {
      forgetDocumentCache(selectedId);
      void loadDocument(selectedId).then(() => {
        // Same signal the in-place reload gives on Rule D: the document the
        // user was reading changed under them, and the swap is otherwise
        // silent.
        if (appState.selectedId === selectedId) signalActiveDocumentUpdated();
      });
    }
  },
});

// Reconcile authoritative state AND ensure a current channel.
//
// The channel is superseded FIRST, and there is no `await` between the
// caller's context change and this call, so the stream being replaced cannot
// deliver anything more. That ordering matters twice over:
//
//   - The old stream carries the context the client has just moved away from
//     (a file pin the caller is widening, an old compare target). A frame from
//     it would reinstate that context — and, being newer by the server's own
//     clock, would also discard the payload this fetch is about to bring back,
//     leaving the session on the context the user asked to leave.
//   - The stream this page holds may be the half-dead one that prompted a
//     wake-up. Replacing it must not depend on the fetch succeeding: only a
//     fresh attempt can error and hand recovery to the channel's retry cycle.
//
// The fetch is then a fallback rather than the primary path — when the fresh
// stream connects, its own first frame is the newer state and this payload is
// correctly discarded.
async function reconcileDocumentState(options: { resumed?: boolean } = {}): Promise<void> {
  connectEvents(options);
  await stateReconciler.reconcile();
}

export async function refreshServerStateForContext(): Promise<void> {
  // A context change, not a recovery — the caller moved the scope or the
  // compare target and the transport was never in doubt.
  await reconcileDocumentState();
}

// Installed once, by boot. `pageshow` from the back/forward cache, a return
// to the foreground, and a regained network connection all mean the same
// thing — this page has been out of touch and cannot trust what it holds.
let lifecycle: LifecycleRecovery | null = null;

export function watchPageLifecycle(): void {
  lifecycle ??= createLifecycleRecovery({
    win: window,
    doc: document,
    // A wake-up IS a recovery: the stream this page holds may have died
    // silently while it was suspended or off the network.
    recover: () => reconcileDocumentState({ resumed: true }),
    discard: disconnectEvents,
  });
}
