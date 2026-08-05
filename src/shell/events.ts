// Live event stream — opens the /api/events EventSource and dispatches each
// `state` payload back into the app. The reducer logic for review-mode
// stale-hint behavior, follow-mode auto-switching, and on-disk-change reloads
// lives in here, intentionally close to its trigger (the SSE message).

import { chooseSelectionForFileEvent } from "./follow";
import { applyProjectIdentity } from "./identity";
import { findDocumentById, syncStateGeneration } from "./storage";
import { applyMonoConfig } from "../mono/apply";
import { signalActiveDocumentUpdated } from "../preview/file-facts-strip";
import { documentDiffCache, forgetDocumentCache, loadDocument } from "../preview/mount";
import { renderEmptyPreview } from "../preview/empty";
import { renderReviewScoreDetails } from "../sidebar/review-score-mount";
import { renderSidebar } from "../sidebar/shell";
import { markSearchResultsStale, noteSearchCorpusChange, syncSearchScope } from "../sidebar/search-pane";
import {
  hasDocument,
  shouldRefreshPreview,
  type StatePayload,
} from "../shared/types";
import { setConnectionState } from "./connection";
import { renderBuildBadge } from "./connection";
import { appUrl } from "../shared/app-url";
import { replaceSelection } from "./history";
import { setSelectedId } from "./selection";
import { appState } from "./state";
import { renderCommitPreview } from "./url";
import { contextualAppUrl, setClientScope } from "./watch-context";

let activeEvents: EventSource | null = null;

function scopesEqual(left: StatePayload["scope"], right: StatePayload["scope"]): boolean {
  return left.kind === right.kind
    && (left.kind === "folder" || (right.kind === "file" && left.documentId === right.documentId));
}

// Owner mutator for the server-snapshot triple (`roots`, `repositories`,
// `scope`). The SSE reducer below is the ongoing writer; the boot path
// (`shell/boot.ts`) applies its initial /api/state payload through this too.
export function applyServerSnapshot(payload: StatePayload): void {
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
  activeEvents?.close();
  const events = new EventSource(contextualAppUrl(appUrl("/api/events")));
  activeEvents = events;

  events.addEventListener("open", () => {
    setConnectionState("live", "Online");
  });

  events.addEventListener("error", () => {
    setConnectionState("reconnecting", "Reconnecting");
  });

  events.addEventListener("state", async event => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as StatePayload;
    const previousSelectedId = appState.selectedId;
    const previousScope = appState.scope;
    const shouldReload = shouldRefreshPreview(previousSelectedId, payload.changedId);

    applyServerSnapshot(payload);
    if (!scopesEqual(previousScope, payload.scope)) {
      // EventSource automatically reconnects its original URL. Replace it
      // after server-side normalization so a later reconnect cannot revive a
      // deleted file pin that this client has already widened away from.
      connectEvents();
    }
    applyMonoConfig(payload.monoConfig);
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
    if (previewMode.kind === "review-score") {
      renderSidebar();
      const repository = appState.repositories.find(candidate => candidate.id === previewMode.repositoryId);
      if (repository && repository.reviewLoad.status === "available") {
        renderReviewScoreDetails(repository);
      } else {
        renderEmptyPreview("Review score unavailable", "Repository data is not available for this score view.");
      }
      return;
    }

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
}

export async function refreshServerStateForContext(): Promise<StatePayload> {
  const response = await fetch(contextualAppUrl(appUrl("/api/state")));
  if (!response.ok) throw new Error(`state refresh failed: ${response.status}`);
  const payload = (await response.json()) as StatePayload;
  applyServerSnapshot(payload);
  applyMonoConfig(payload.monoConfig);
  syncStateGeneration(payload.generatedAt);
  renderBuildBadge(payload.build);
  renderSidebar();
  connectEvents();
  return payload;
}
