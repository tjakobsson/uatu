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

export function connectEvents() {
  documentChannel().connect();
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

function openDocumentStream(generation: number): EventSource {
  // Every attempt after the first is a recovery. Saying so lets the workspace
  // count reconnects apart from fresh connects without the request carrying
  // anything about the connection that was lost.
  const url = new URL(contextualAppUrl(appUrl("/api/events")), window.location.href);
  if (generation > 1) url.searchParams.set("reconnect", "1");
  const events = new EventSource(`${url.pathname}${url.search}`);

  events.addEventListener("state", async event => {
    // A payload from a superseded attempt describes a connection this client
    // has already replaced; applying it could overwrite newer state.
    if (!documentChannel().isCurrent(generation)) return;
    const payload = JSON.parse((event as MessageEvent<string>).data) as StatePayload;
    const previousSelectedId = appState.selectedId;
    const previousScope = appState.scope;
    const shouldReload = shouldRefreshPreview(
      previousSelectedId,
      payload.changedId,
      appState.roots,
      payload.roots,
    );

    applyServerSnapshot(payload);
    // This is newer than anything a reconciliation fetch still has in flight;
    // telling the reconciler keeps that older payload from landing on top.
    stateReconciler.noteApplied();
    // Transport is only proven once this generation's authoritative state has
    // been applied — an open socket that never delivers state is exactly the
    // half-dead connection the indicator must not call `Connected`.
    documentChannel().confirm(generation);
    if (!scopesEqual(previousScope, payload.scope)) {
      // EventSource automatically reconnects its original URL. Replace it
      // after server-side normalization so a later reconnect cannot revive a
      // deleted file pin that this client has already widened away from.
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
    // Replace the transport too: after a gap, the stream that was open (or
    // silently dead) has no claim to being current.
    connectEvents();
  },
});

export async function refreshServerStateForContext(): Promise<void> {
  await stateReconciler.reconcile();
}

// Installed once, by boot. `pageshow` from the back/forward cache, a return
// to the foreground, and a regained network connection all mean the same
// thing — this page has been out of touch and cannot trust what it holds.
let lifecycle: LifecycleRecovery | null = null;

export function watchPageLifecycle(): void {
  lifecycle ??= createLifecycleRecovery({
    win: window,
    doc: document,
    recover: async () => {
      try {
        await stateReconciler.reconcile();
      } catch {
        // The workspace was unreachable — but the transport still has to be
        // replaced. The stream this page is holding may be the half-dead one
        // that prompted the wake-up, and only a fresh attempt can error and
        // hand recovery to the channel's own retry cycle. Without this, a
        // wake-up that arrives while the network is still down leaves nothing
        // running at all.
        connectEvents();
      }
    },
    discard: disconnectEvents,
  });
}
