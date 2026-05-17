// Live event stream — opens the /api/events EventSource and dispatches each
// `state` payload back into the app. The reducer logic for review-mode
// stale-hint behavior, follow-mode auto-switching, and on-disk-change reloads
// lives in here, intentionally close to its trigger (the SSE message).

import { applyStaleHint } from "./stale-hint-mount";
import { findDocumentById, syncStateGeneration } from "./storage";
import { forgetDocumentCache, loadDocument } from "../preview/mount";
import { renderEmptyPreview } from "../preview/empty";
import { renderReviewScoreDetails } from "../sidebar/review-score-mount";
import { renderSidebar } from "../sidebar/shell";
import {
  hasDocument,
  nextSelectedDocumentId,
  shouldRefreshPreview,
  type StatePayload,
} from "../shared/types";
import { nextStaleHint } from "./stale-hint";
import { setConnectionState } from "./connection";
import { replaceSelection } from "./history";
import { appState } from "./state";
import { renderCommitPreview } from "./url";

export function connectEvents() {
  const events = new EventSource("/api/events");

  events.addEventListener("open", () => {
    setConnectionState("live", "Online");
  });

  events.addEventListener("error", () => {
    setConnectionState("reconnecting", "Reconnecting");
  });

  events.addEventListener("state", async event => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as StatePayload;
    const previousSelectedId = appState.selectedId;
    const shouldReload = shouldRefreshPreview(previousSelectedId, payload.changedId);

    appState.roots = payload.roots;
    appState.repositories = payload.repositories ?? [];
    appState.scope = payload.scope;
    syncStateGeneration(payload.generatedAt);

    if (appState.previewMode.kind === "review-score") {
      renderSidebar();
      const repository = appState.repositories.find(candidate => candidate.id === appState.previewMode.repositoryId);
      if (repository && repository.reviewLoad.status === "available") {
        renderReviewScoreDetails(repository);
      } else {
        renderEmptyPreview("Review score unavailable", "Repository data is not available for this score view.");
      }
      return;
    }

    if (appState.previewMode.kind === "commit") {
      renderSidebar();
      renderCommitPreview(appState.previewMode);
      return;
    }

    // Review mode contract: file-system events MUST NOT switch the active
    // preview, and the active file MUST NOT silently re-render in place when
    // it changes on disk. Sidebar / Change Overview / Git Log refresh
    // normally; only preview selection and reload are gated. The reducer
    // computes the stale-content hint state so the reviewer can refresh on
    // their own clock.
    if (appState.mode === "review") {
      const activeId = appState.selectedId;
      const activeStillExists = activeId
        ? hasDocument(payload.roots, activeId)
        : true;
      applyStaleHint(
        nextStaleHint(appState.staleHint, {
          kind: "file-event",
          mode: "review",
          activeId,
          changedId: payload.changedId,
          activeStillExists,
        }),
      );
      renderSidebar();
      return;
    }

    appState.selectedId = nextSelectedDocumentId(
      payload.roots,
      previousSelectedId,
      payload.changedId,
      appState.followEnabled,
    );

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

    if (appState.selectedId && (shouldReload || appState.selectedId !== previousSelectedId)) {
      if (shouldReload) {
        // The file changed on disk — any cached payload is now stale.
        forgetDocumentCache(appState.selectedId);
      }
      await loadDocument(appState.selectedId);
      return;
    }

    if (!hasDocument(payload.roots, appState.selectedId)) {
      renderEmptyPreview("No document selected", "Waiting for viewable files");
    }
  });
}
