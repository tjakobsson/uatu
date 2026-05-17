// Initial boot — fetches the first /api/state payload, resolves the URL
// against the available documents, configures the shell chrome (Mode,
// Files-pane filter, panes, follow toggle), and hands off to `connectEvents`
// for the SSE stream. Extracted from `app.ts` so the entry point only has
// to call `loadInitialState()` and the rest of the boot dance lives in one
// place that's easy to reason about.

import { findDocumentById, findDocumentByRelativePath, syncStateGeneration } from "./storage";
import { loadDocument } from "../preview/mount";
import { renderEmptyPreview } from "../preview/empty";
import { renderReviewScoreDetails } from "../sidebar/review-score-mount";
import { renderSidebar } from "../sidebar/shell";
import { setupTerminalPanel } from "../terminal/panel";
import { syncFilesPaneFilterControl } from "../sidebar/files-filter";
import { syncFollowToggle } from "./follow";
import { syncModeControl } from "./mode";
import { readModePreference, writeModePreference, type StatePayload } from "../shared/types";
import { renderBuildBadge } from "./connection";
import { connectEvents } from "./events";
import { replaceSelection, scrollToFragment } from "./history";
import { appState, readFilesPaneFilterPreference, readPaneState, safeLocalStorage } from "./state";
import {
  commitPreviewParamsFromUrl,
  renderCommitPreview,
  reviewScoreRepositoryIdFromUrl,
} from "./url";

export async function loadInitialState() {
  // Decode the requested URL path BEFORE fetching state so we can decide
  // whether to honor the server's defaultDocumentId or override with a
  // URL-derived doc selection (direct-link arrival, per design D3).
  let urlRelativePath = "";
  try {
    urlRelativePath = decodeURIComponent(window.location.pathname).replace(/^\/+/, "");
  } catch {
    urlRelativePath = "";
  }
  // Capture the hash before our own `replaceSelection` (below) overwrites
  // the URL with a hashless version — otherwise the post-load fragment
  // scroll has nothing to scroll to.
  const initialHash = window.location.hash;

  const response = await fetch("/api/state");
  const payload = (await response.json()) as StatePayload;

  appState.roots = payload.roots;
  appState.repositories = payload.repositories ?? [];
  appState.scope = payload.scope;
  syncStateGeneration(payload.generatedAt);
  renderBuildBadge(payload.build);
  setupTerminalPanel(payload.terminal === "enabled", payload.terminalConfig);

  // Mode precedence: CLI --mode override (`startupMode` in the payload) wins
  // at boot, then the persisted browser preference, then DEFAULT_MODE. Whatever
  // we resolve here gets persisted so subsequent reloads are stable even when
  // the CLI flag was the source.
  const resolvedMode = readModePreference(safeLocalStorage(), payload.startupMode);
  appState.mode = resolvedMode;
  writeModePreference(safeLocalStorage(), resolvedMode);
  // Pane state is per-mode; load the resolved mode's persisted layout (the
  // initial `appState.panes` was a placeholder for DEFAULT_MODE).
  appState.panes = readPaneState(resolvedMode);
  // Same per-Mode persistence pattern: load the chip state for the resolved
  // Mode (or its default) so the first paint matches the persisted choice.
  appState.filesPaneFilter = readFilesPaneFilterPreference(resolvedMode);
  syncModeControl();
  syncFilesPaneFilterControl();

  let directLinkMessage: { title: string; body: string } | null = null;
  const initialReviewScoreRepositoryId = reviewScoreRepositoryIdFromUrl();
  const initialCommitPreview = commitPreviewParamsFromUrl();

  if (initialReviewScoreRepositoryId) {
    appState.followEnabled = false;
    appState.selectedId = null;
    appState.previewMode = { kind: "review-score", repositoryId: initialReviewScoreRepositoryId };
  } else if (initialCommitPreview) {
    appState.followEnabled = false;
    appState.selectedId = null;
    appState.previewMode = { kind: "commit", ...initialCommitPreview };
  } else if (!urlRelativePath) {
    // Default boot at `/` — today's behavior.
    appState.followEnabled = payload.initialFollow;
    appState.selectedId = payload.defaultDocumentId;
    appState.previewMode = { kind: "document" };
  } else {
    const requestedDoc = findDocumentByRelativePath(urlRelativePath);
    if (requestedDoc && requestedDoc.kind !== "binary") {
      // Direct link to a known non-binary doc — force follow off (D3) and
      // override the server-provided default selection.
      appState.followEnabled = false;
      appState.selectedId = requestedDoc.id;
      appState.previewMode = { kind: "document" };
    } else if (payload.scope.kind === "file") {
      // Direct link to a doc outside the pinned scope. Keep the pinned doc
      // as the selection so the sidebar reflects it, but render a "session
      // pinned" message in place of the preview (per design D4).
      appState.followEnabled = false;
      appState.selectedId = payload.defaultDocumentId;
      appState.previewMode = { kind: "empty" };
      const pinnedDoc = appState.selectedId
        ? findDocumentById(appState.selectedId)
        : null;
      directLinkMessage = {
        title: "Session pinned",
        body: pinnedDoc
          ? `Session pinned to ${pinnedDoc.relativePath}. Unpin to view other documents.`
          : "Session pinned to another file. Unpin to view other documents.",
      };
    } else {
      // Direct link that doesn't resolve to any known doc in the index.
      appState.followEnabled = false;
      appState.selectedId = null;
      appState.previewMode = { kind: "empty" };
      directLinkMessage = {
        title: "Document not found",
        body: `Document not found at ${urlRelativePath}.`,
      };
    }
  }

  syncFollowToggle();
  renderSidebar();

  // Populate history.state with the document id so subsequent popstate
  // events have an unambiguous target without re-resolving the path each
  // time. The initial entry has `state === null` until we set it.
  if (appState.previewMode.kind === "document" && appState.selectedId) {
    const selected = findDocumentById(appState.selectedId);
    if (selected) {
      replaceSelection(appState.selectedId, selected.relativePath);
    }
  }

  if (appState.previewMode.kind === "review-score") {
    const repository = appState.repositories.find(candidate => candidate.id === appState.previewMode.repositoryId);
    if (repository && repository.reviewLoad.status === "available") {
      renderReviewScoreDetails(repository);
    } else {
      renderEmptyPreview("Review score unavailable", "Repository data is not available for this score view.");
    }
  } else if (appState.previewMode.kind === "commit") {
    renderCommitPreview(appState.previewMode);
  } else if (directLinkMessage) {
    renderEmptyPreview(directLinkMessage.title, directLinkMessage.body);
  } else if (appState.selectedId) {
    await loadDocument(appState.selectedId);
    if (initialHash) {
      // The browser hasn't laid out the freshly-rendered preview yet — defer
      // the scroll to the next frame so `scrollIntoView` has positions to
      // work with. Mirrors the TOC click path's timing (which only fires
      // after the preview is fully painted).
      requestAnimationFrame(() => scrollToFragment(initialHash.slice(1)));
    }
  }

  connectEvents();
}
