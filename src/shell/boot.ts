// Initial boot — fetches the first /api/state payload, resolves the URL
// against the available documents, configures the shell chrome, and hands
// off to `connectEvents` for the SSE stream. The follow-mode capability owns
// the Follow toggle's behavior; this file's only job is the initial state
// resolution.

import { appDocumentRelativePath, appUrl } from "../shared/app-url";
import { findDocumentById, findDocumentByRelativePath, syncStateGeneration } from "./storage";
import { loadDocument } from "../preview/mount";
import { renderEmptyPreview } from "../preview/empty";
import { renderReviewScoreDetails } from "../sidebar/review-score-mount";
import { renderSidebar } from "../sidebar/shell";
import { setupTerminalPanel } from "../terminal/panel";
import { applyMonoConfig } from "../mono/apply";
import { initColorSchemeTracking } from "./theme";
import { setFilesPaneFilter, syncFilesPaneFilterControl } from "../sidebar/files-filter";
import { adoptCompareTarget } from "../sidebar/change-overview";
import { setPaneState } from "../sidebar/panes";
import { setFollowEnabled, syncFollowToggle } from "./follow";
import type { StatePayload } from "../shared/types";
import { applyViewMode } from "../preview/view-mode";
import { renderBuildBadge } from "./connection";
import { applyServerSnapshot, connectEvents } from "./events";
import { replaceSelection, scrollToFragment } from "./history";
import {
  appState,
  readPaneState,
} from "./state";
import {
  enablePersonalStatePersistence,
  loadPersonalWorkspaceState,
  persistPersonalWorkspaceState,
} from "./personal-state";
import { contextualAppUrl } from "./watch-context";
import { setPreviewMode, setSelectedId } from "./selection";
import {
  commitPreviewParamsFromUrl,
  renderCommitPreview,
  reviewScoreRepositoryIdFromUrl,
} from "./url";

export async function loadInitialState() {
  // Decode the requested URL path BEFORE fetching state so we can decide
  // whether to honor the server's defaultDocumentId or override with a
  // URL-derived doc selection (direct-link arrival, per design D3).
  const urlRelativePath = appDocumentRelativePath(window.location.pathname);
  // Capture the hash before our own `replaceSelection` (below) overwrites
  // the URL with a hashless version — otherwise the post-load fragment
  // scroll has nothing to scroll to.
  const initialHash = window.location.hash;

  // Before any rendering: the tracker sets the theme-color meta for the
  // resolved scheme and starts listening for OS scheme flips (mermaid and
  // the tree view subscribe on their own).
  initColorSchemeTracking();

  const [response, personalState] = await Promise.all([
    fetch(appUrl("/api/state")),
    loadPersonalWorkspaceState(),
  ]);
  let payload = (await response.json()) as StatePayload;

  adoptCompareTarget(personalState.compareTarget ?? "base");
  if (personalState.previewMode) applyViewMode(personalState.previewMode);
  if (payload.compareTarget !== appState.compareTarget) {
    const contextualResponse = await fetch(contextualAppUrl(appUrl("/api/state")));
    if (contextualResponse.ok) payload = (await contextualResponse.json()) as StatePayload;
  }

  applyServerSnapshot(payload);
  syncStateGeneration(payload.generatedAt);
  renderBuildBadge(payload.build);
  applyMonoConfig(payload.monoConfig);
  setupTerminalPanel(payload.terminal === "enabled", payload.terminalConfig, personalState.lastPtyId);

  setPaneState(readPaneState());
  setFilesPaneFilter(personalState.filesFilter ?? "all");
  syncFilesPaneFilterControl();

  let directLinkMessage: { title: string; body: string } | null = null;
  const initialReviewScoreRepositoryId = reviewScoreRepositoryIdFromUrl();
  const initialCommitPreview = commitPreviewParamsFromUrl();

  if (initialReviewScoreRepositoryId) {
    setFollowEnabled(false);
    setSelectedId(null);
    setPreviewMode({ kind: "review-score", repositoryId: initialReviewScoreRepositoryId });
  } else if (initialCommitPreview) {
    setFollowEnabled(false);
    setSelectedId(null);
    setPreviewMode({ kind: "commit", ...initialCommitPreview });
  } else if (!urlRelativePath) {
    setFollowEnabled(personalState.follow ?? payload.initialFollow);
    const savedDocument = personalState.documentPath
      ? findDocumentByRelativePath(personalState.documentPath)
      : null;
    setSelectedId(savedDocument?.kind !== "binary" ? savedDocument?.id ?? payload.defaultDocumentId : payload.defaultDocumentId);
    setPreviewMode({ kind: "document" });
  } else {
    const requestedDoc = findDocumentByRelativePath(urlRelativePath);
    if (requestedDoc && requestedDoc.kind !== "binary") {
      // Direct link to a known non-binary doc — force follow off (Rule
      // "URL direct links force OFF on boot") and override the
      // server-provided default selection.
      setFollowEnabled(false);
      setSelectedId(requestedDoc.id);
      setPreviewMode({ kind: "document" });
    } else if (payload.scope.kind === "file") {
      // Direct link to a doc outside the CLI single-file watch scope. Keep
      // the scoped doc as the selection but render a "session scoped to a
      // single file" message in place of the preview. Follow stays at the
      // server-provided default — it's meaningless in a single-file session
      // (`syncFollowToggle` disables the chip when scope.kind === "file"),
      // so we don't need to explicitly clear it here.
      setSelectedId(payload.defaultDocumentId);
      setPreviewMode({ kind: "empty" });
      const scopedDoc = appState.selectedId
        ? findDocumentById(appState.selectedId)
        : null;
      directLinkMessage = {
        title: "Single-file session",
        body: scopedDoc
          ? `This session is scoped to ${scopedDoc.relativePath}. Restart uatu against the parent directory to view other documents.`
          : "This session is scoped to a single file. Restart uatu against the parent directory to view other documents.",
      };
    } else {
      // Direct link that doesn't resolve to any known doc in the index.
      setSelectedId(null);
      setPreviewMode({ kind: "empty" });
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

  // Local snapshot so the discriminant narrowing survives into the closures
  // below (narrowing on a mutable property does not).
  const previewMode = appState.previewMode;
  if (previewMode.kind === "review-score") {
    const repository = appState.repositories.find(candidate => candidate.id === previewMode.repositoryId);
    if (repository && repository.reviewLoad.status === "available") {
      renderReviewScoreDetails(repository);
    } else {
      renderEmptyPreview("Review score unavailable", "Repository data is not available for this score view.");
    }
  } else if (previewMode.kind === "commit") {
    renderCommitPreview(previewMode);
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
  enablePersonalStatePersistence();
  const selected = appState.selectedId ? findDocumentById(appState.selectedId) : null;
  persistPersonalWorkspaceState({
    ...(selected ? { documentPath: selected.relativePath } : {}),
    follow: appState.followEnabled,
    previewMode: appState.viewMode,
    compareTarget: appState.compareTarget,
    filesFilter: appState.filesPaneFilter,
  });
}
