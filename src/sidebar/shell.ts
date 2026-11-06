// Sidebar shell — top-level rendering of the sidebar (`renderSidebar`),
// collapse / expand chrome, and the resizable width control. Extracted
// from `app.ts` so the entire sidebar boot dance + main render lives
// together in the sidebar/ feature folder.

import { appState } from "../shell/state";
import { presentationLocalStorage } from "../shell/presentation-storage";
import { computeFilesPaneFilterMembership } from "./tree-view";
import {
  collectGitStatusEntries,
  filterEmptyStateCopy,
  renderChangeOverview,
} from "./change-overview";
import { filesQuery, syncFilesPaneFilterControl } from "./files-filter";
import { renderGitLog } from "./git-log";
import {
  renderPanelsMenu,
  schedulePaneHeightNormalization,
  syncPaneDom,
} from "./panes";
import { ensureTreeView } from "./tree-mount";
import type { DocumentPatch } from "../shared/document-updates";
import { syncIndexStatus } from "../shell/index-status";
import { matchesFileQuery, RecentModel } from "./recent-model";
import { RecentView } from "./recent-view";
import { applyUserRowClick } from "../shell/follow";
import { isDocumentVisible } from "../shared/file-visibility";
import { syncIgnoredVisibilityControl } from "./ignored-visibility";
import { reconcileSearchVisibility } from "./search-pane";
import { auditionFromFiles, filesMediaType } from "./media-browsing";
import { matchesMediaType } from "./media-browsing-model";

const appShellElementMaybe = document.querySelector<HTMLDivElement>(".app-shell");
const sidebarResizerElementMaybe = document.querySelector<HTMLDivElement>("#sidebar-resizer");
const sidebarCollapseElementMaybe = document.querySelector<HTMLButtonElement>("#sidebar-collapse");
const sidebarExpandElementMaybe = document.querySelector<HTMLButtonElement>("#sidebar-expand");
const treeElementMaybe = document.querySelector<HTMLDivElement>("#tree");
const treeEmptyMessageElementMaybe = document.querySelector<HTMLElement>("#tree-empty-message");
const documentCountElementMaybe = document.querySelector<HTMLElement>("#document-count");

if (
  !appShellElementMaybe
  || !sidebarResizerElementMaybe
  || !sidebarCollapseElementMaybe
  || !sidebarExpandElementMaybe
  || !treeElementMaybe
  || !treeEmptyMessageElementMaybe
  || !documentCountElementMaybe
) {
  throw new Error("uatu UI failed to initialize (sidebar/shell)");
}

// Locally-scoped non-null aliases. TypeScript's narrowing from the
// throw-if-null guard above doesn't survive into function bodies.
const appShellElement: HTMLDivElement = appShellElementMaybe;
const sidebarResizerElement: HTMLDivElement = sidebarResizerElementMaybe;
const sidebarCollapseElement: HTMLButtonElement = sidebarCollapseElementMaybe;
const sidebarExpandElement: HTMLButtonElement = sidebarExpandElementMaybe;
const treeElement: HTMLDivElement = treeElementMaybe;
const treeEmptyMessageElement: HTMLElement = treeEmptyMessageElementMaybe;
const documentCountElement: HTMLElement = documentCountElementMaybe;
const recentElement = document.querySelector<HTMLElement>("#recent-files")!;
const recentModel = new RecentModel();
let recentRoots: typeof appState.roots | null = null;
const recentView = new RecentView(recentElement, recentModel, applyUserRowClick, auditionFromFiles);

export function currentAuditionDocuments() {
  return appState.filesPaneFilter === "recent" ? recentView.getDocuments().filter(doc => isDocumentVisible(doc, appState.showIgnored)
    && matchesMediaType(doc, filesMediaType) && matchesFileQuery(recentModel.searchPath(doc), filesQuery)) : ensureTreeView().getEligibleDocuments();
}

export function syncFilesPlayingIndicator(key: string | null): void {
  recentView.setPlayingFile(key);
  ensureTreeView().setPlayingFile(key);
}

function setResultCount(count: number): void {
  documentCountElement.textContent = String(count);
  documentCountElement.setAttribute("aria-label", `${count} ${count === 1 ? "file" : "files"}`);
}

function syncFilesPresentation(): void {
  const view = ensureTreeView();
  view.setQuery(filesQuery);
  const recent = appState.filesPaneFilter === "recent";
  syncIgnoredVisibilityControl();
  const entries = recentModel.entries(filesQuery).filter(doc => isDocumentVisible(doc, appState.showIgnored) && matchesMediaType(doc, filesMediaType));
  recentElement.hidden = !recent;
  if (recent) recentView.update(entries, appState.selectedId);
  const filterEmpty = appState.filesPaneFilter === "changed" && !view.hasFilterMembers();
  const count = recent ? entries.length : filterEmpty ? 0 : view.getVisibleLeafCount();
  setResultCount(count);
  treeElement.hidden = recent || count === 0;
  treeEmptyMessageElement.hidden = count > 0;
  if (count === 0) treeEmptyMessageElement.textContent = filesQuery ? "No matching files."
    : filterEmpty ? filterEmptyStateCopy(appState.repositories)
    : appState.discovery.status === "ready" ? "No files found in the watched roots."
    : appState.discovery.status === "error" ? `Indexing failed: ${appState.discovery.message ?? "Unavailable"}` : "Indexing files…";
}

const SIDEBAR_COLLAPSED_KEY = "uatu:sidebar-collapsed";
const SIDEBAR_WIDTH_KEY = "uatu:sidebar-width";
const SIDEBAR_MIN_WIDTH = 320;
const SIDEBAR_MAX_WIDTH = 620;

export function renderSidebar(incremental = false) {
  reconcileSearchVisibility();
  syncIndexStatus();
  syncPaneDom();
  renderPanelsMenu();
  renderChangeOverview();
  renderGitLog();
  schedulePaneHeightNormalization();
  // Refresh the chip's tooltip every render — `primaryCompareBaseLabel`
  // depends on `appState.repositories` which changes on every refresh.
  syncFilesPaneFilterControl();

  if (recentRoots !== appState.roots) {
    recentModel.reset(appState.roots);
    recentRoots = appState.roots;
  }
  const filterOn = appState.filesPaneFilter === "changed";
  const filter = filterOn ? computeFilesPaneFilterMembership(appState.repositories) : null;

  treeElement.hidden = appState.filesPaneFilter === "recent";
  const view = ensureTreeView();
  view.update(appState.roots, appState.selectedId, { filter, incremental, showIgnored: appState.showIgnored, mediaType: filesMediaType });
  view.setGitStatus(collectGitStatusEntries(appState.repositories));
  syncFilesPresentation();
}

export function renderSidebarPatch(patch: DocumentPatch): void {
  syncIndexStatus();
  recentModel.applyPatch(patch);
  recentRoots = appState.roots;
  const view = ensureTreeView();
  if (!view.applyPatch(patch, appState.selectedId)) {
    renderSidebar(true);
    return;
  }
  if (patch.repositories && appState.filesPaneFilter === "changed" && !view.updateFilter(computeFilesPaneFilterMembership(appState.repositories))) {
    renderSidebar(true);
    return;
  }
  syncFilesPresentation();
  documentCountElement.title = appState.discovery.status === "ready" ? "" : appState.discovery.message ?? "Indexing files…";
  if (patch.repositories || patch.repositoryState) renderChangeOverview();
  if (patch.repositories) {
    renderGitLog(); syncFilesPaneFilterControl();
    view.setGitStatus(collectGitStatusEntries(appState.repositories));
  }
}

export function initSidebarCollapse() {
  const stored = readCollapsedPreference();
  setSidebarCollapsed(stored, { persist: false });
  sidebarCollapseElement.addEventListener("click", () => setSidebarCollapsed(true));
  sidebarExpandElement.addEventListener("click", () => setSidebarCollapsed(false));
}

export function initSidebarWidth() {
  setSidebarWidth(readSidebarWidthPreference(), { persist: false });

  sidebarResizerElement.addEventListener("pointerdown", event => {
    if (appShellElement.classList.contains("is-sidebar-collapsed")) {
      return;
    }

    event.preventDefault();
    sidebarResizerElement.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing-sidebar");

    const onMove = (moveEvent: PointerEvent) => {
      setSidebarWidth(moveEvent.clientX);
    };
    const onUp = () => {
      document.body.classList.remove("is-resizing-sidebar");
      sidebarResizerElement.removeEventListener("pointermove", onMove);
      sidebarResizerElement.removeEventListener("pointerup", onUp);
      sidebarResizerElement.removeEventListener("pointercancel", onUp);
    };

    sidebarResizerElement.addEventListener("pointermove", onMove);
    sidebarResizerElement.addEventListener("pointerup", onUp);
    sidebarResizerElement.addEventListener("pointercancel", onUp);
  });
}

function readSidebarWidthPreference(): number {
  try {
    const value = Number(presentationLocalStorage()?.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(value)) {
      return clampSidebarWidth(value);
    }
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
  return 300;
}

function setSidebarWidth(width: number, options: { persist?: boolean } = {}) {
  const nextWidth = clampSidebarWidth(width);
  document.documentElement.style.setProperty("--sidebar-width", `${nextWidth}px`);

  if (options.persist === false) {
    return;
  }

  try {
    presentationLocalStorage()?.setItem(SIDEBAR_WIDTH_KEY, String(nextWidth));
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}

function clampSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)));
}

function readCollapsedPreference(): boolean {
  try {
    return presentationLocalStorage()?.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

// Exported for callers that reveal sidebar content programmatically — the
// project-search shortcut must be able to un-collapse the whole sidebar, or
// it would focus an input inside `display: none`.
export function setSidebarCollapsed(collapsed: boolean, options: { persist?: boolean } = {}) {
  appShellElement.classList.toggle("is-sidebar-collapsed", collapsed);
  sidebarCollapseElement.setAttribute("aria-expanded", String(!collapsed));
  sidebarExpandElement.setAttribute("aria-expanded", String(!collapsed));

  if (options.persist === false) {
    return;
  }

  try {
    if (collapsed) {
      presentationLocalStorage()?.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    } else {
      presentationLocalStorage()?.removeItem(SIDEBAR_COLLAPSED_KEY);
    }
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}
