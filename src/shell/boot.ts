// Initial boot — fetches the first /api/state payload, resolves the URL
// against the available documents, configures the shell chrome, and hands
// off to `connectEvents` for the SSE stream. The follow-mode capability owns
// the Follow toggle's behavior; this file's only job is the initial state
// resolution.

import { appDocumentRelativePath, appUrl } from "../shared/app-url";
import { findDocumentById, findDocumentByRelativePath, syncStateGeneration } from "./storage";
import { loadDocument } from "../preview/mount";
import { renderEmptyPreview } from "../preview/empty";
import { renderSidebar } from "../sidebar/shell";
import { setupTerminalPanel } from "../terminal/panel";
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
  const hasExplicitRoute = Boolean(urlRelativePath || initialHash);

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
  setupTerminalPanel(payload.terminal === "enabled", personalState.lastPtyId);

  setPaneState(readPaneState());
  setFilesPaneFilter(personalState.filesFilter ?? "all");
  syncFilesPaneFilterControl();

  let directLinkMessage: { title: string; body: string } | null = null;
  let explicitDocumentPath: string | null = null;
  const initialCommitPreview = commitPreviewParamsFromUrl();

  if (initialCommitPreview) {
    setFollowEnabled(false);
    setSelectedId(null);
    setPreviewMode({ kind: "commit", ...initialCommitPreview });
  } else if (!hasExplicitRoute) {
    setFollowEnabled(personalState.follow ?? payload.initialFollow);
    const savedDocument = personalState.documentPath
      ? findDocumentByRelativePath(personalState.documentPath)
      : null;
    setSelectedId(savedDocument?.kind !== "binary" ? savedDocument?.id ?? payload.defaultDocumentId : payload.defaultDocumentId);
    setPreviewMode({ kind: "document" });
  } else if (!urlRelativePath) {
    // A fragment-bearing root URL is explicit navigation. Render the session
    // default rather than applying a saved document from another route.
    setFollowEnabled(false);
    setSelectedId(payload.defaultDocumentId);
    setPreviewMode({ kind: "document" });
  } else {
    setFollowEnabled(false);
    const requestedDoc = findDocumentByRelativePath(urlRelativePath);
    if (requestedDoc && requestedDoc.kind !== "binary") {
      // Direct link to a known non-binary doc — force follow off (Rule
      // "URL direct links force OFF on boot") and override the
      // server-provided default selection.
      setSelectedId(requestedDoc.id);
      explicitDocumentPath = requestedDoc.relativePath;
      setPreviewMode({ kind: "document" });
    } else if (payload.scope.kind === "file") {
      // Direct link to a doc outside the CLI single-file watch scope. Keep
      // the scoped doc as the selection but render a "session scoped to a
      // single file" message in place of the preview without widening it.
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
  if (previewMode.kind === "commit") {
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
  // Restored/default values are read-only at boot: writing a full snapshot
  // here could overwrite newer field-level writes from another open client.
  // An explicit route is current user intent, so only its affected fields are
  // persisted for future root arrivals.
  if (initialCommitPreview || hasExplicitRoute) {
    persistPersonalWorkspaceState({
      follow: false,
      ...(explicitDocumentPath ? { documentPath: explicitDocumentPath } : {}),
    });
  }
}
