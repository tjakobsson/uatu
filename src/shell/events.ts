// Live event stream — opens the /api/events EventSource and dispatches each
// `state` payload back into the app. The reducer logic for review-mode
// stale-hint behavior, follow-mode auto-switching, and on-disk-change reloads
// lives in here, intentionally close to its trigger (the SSE message).

import { chooseSelectionForFileEvent } from "./follow";
import { applyProjectIdentity } from "./identity";
import { findDocumentById, syncStateGeneration } from "./storage";
import { applyMonoConfig } from "../mono/apply";
import { documentDiffCache, forgetDocumentCache, loadDocument } from "../preview/mount";
import { renderEmptyPreview } from "../preview/empty";
import { renderReviewScoreDetails } from "../sidebar/review-score-mount";
import { renderSidebar } from "../sidebar/shell";
import {
  hasDocument,
  shouldRefreshPreview,
  type StatePayload,
} from "../shared/types";
import { adoptCompareTarget } from "../sidebar/change-overview";
import { setConnectionState } from "./connection";
import { replaceSelection } from "./history";
import { setSelectedId } from "./selection";
import { appState } from "./state";
import { renderCommitPreview } from "./url";

// Owner mutator for the server-snapshot triple (`roots`, `repositories`,
// `scope`). The SSE reducer below is the ongoing writer; the boot path
// (`shell/boot.ts`) applies its initial /api/state payload through this too.
export function applyServerSnapshot(payload: StatePayload): void {
  appState.roots = payload.roots;
  appState.repositories = payload.repositories ?? [];
  appState.scope = payload.scope;
  // Title, favicon tint, and sidebar marker all derive from roots;
  // re-applying on every payload keeps them honest if roots change.
  applyProjectIdentity(payload.roots);
}

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

    applyServerSnapshot(payload);
    // The compare target is server-session state shared across clients. If
    // another tab switched it, adopt the broadcast value so this tab's toggle,
    // persisted preference, and cached diffs all reflect the shared session —
    // otherwise we'd show repositories computed for the new target under the
    // old toggle, with a stale cached diff. (A switch initiated by this tab is
    // already applied optimistically, so this is a no-op in that case.)
    const compareTargetChanged =
      typeof payload.compareTarget === "string" && payload.compareTarget !== appState.compareTarget;
    if (compareTargetChanged) {
      adoptCompareTarget(payload.compareTarget);
    }
    applyMonoConfig(payload.monoConfig);
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

    // An externally-driven compare-target switch must refresh an open Diff
    // view against the new target (its cached payload was cleared above).
    const needsDiffReload = compareTargetChanged && appState.viewMode === "diff";
    if (
      appState.selectedId &&
      (shouldReload || appState.selectedId !== previousSelectedId || needsDiffReload)
    ) {
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
