// Sidebar shell — top-level rendering of the sidebar (`renderSidebar`),
// collapse / expand chrome, and the resizable width control. Extracted
// from `app.ts` so the entire sidebar boot dance + main render lives
// together in the sidebar/ feature folder.

import { appState } from "../shell/state";
import { computeFilesPaneFilterMembership } from "./tree-view";
import {
  collectGitStatusEntries,
  filterEmptyStateCopy,
  filterMembershipHasAnyPath,
  formatFileCountDisplay,
  renderChangeOverview,
} from "./change-overview";
import { syncFilesPaneFilterControl } from "./files-filter";
import { renderGitLog } from "./git-log";
import {
  renderPanelsMenu,
  schedulePaneHeightNormalization,
  syncPaneDom,
} from "./panes";
import { disposeTreeView, ensureTreeView } from "./tree-mount";

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

export const SIDEBAR_COLLAPSED_KEY = "uatu:sidebar-collapsed";
export const SIDEBAR_WIDTH_KEY = "uatu:sidebar-width";
export const SIDEBAR_MIN_WIDTH = 260;
export const SIDEBAR_MAX_WIDTH = 620;

export function renderSidebar() {
  syncPaneDom();
  renderPanelsMenu();
  renderChangeOverview();
  renderGitLog();
  schedulePaneHeightNormalization();
  // Refresh the chip's tooltip every render — `primaryReviewBaseLabel`
  // depends on `appState.repositories` which changes on every refresh.
  syncFilesPaneFilterControl();

  const totalCount = appState.roots.reduce((sum, root) => sum + root.docs.length, 0);
  const totalBinaryCount = appState.roots.reduce(
    (sum, root) => sum + root.docs.filter(doc => doc.kind === "binary").length,
    0,
  );

  if (totalCount === 0) {
    disposeTreeView();
    documentCountElement.textContent = "0 files";
    // The library attaches a shadow root to #tree once mounted, and that
    // shadow root persists across innerHTML writes — so we keep the empty
    // message as a sibling element instead of overwriting #tree's children.
    treeElement.hidden = true;
    treeEmptyMessageElement.hidden = false;
    treeEmptyMessageElement.textContent = "No files found in the watched roots.";
    return;
  }

  const filterOn = appState.filesPaneFilter === "changed";
  const filter = filterOn ? computeFilesPaneFilterMembership(appState.repositories) : null;

  // Decide whether the filter has anything to render. The membership map's
  // emptiness is the right proxy: a non-git workspace has no entries; a clean
  // working tree has empty entries (because the change set is empty). Either
  // way the chip should fall into the empty state.
  const hasFilterMembership = filter !== null
    ? filterMembershipHasAnyPath(filter)
    : false;
  const showFilterEmptyState = filterOn && !hasFilterMembership;

  if (showFilterEmptyState) {
    disposeTreeView();
    treeElement.hidden = true;
    treeEmptyMessageElement.hidden = false;
    treeEmptyMessageElement.textContent = filterEmptyStateCopy(appState.repositories);
    documentCountElement.textContent = formatFileCountDisplay({
      filterOn: true,
      visibleCount: 0,
      visibleBinaryCount: 0,
      totalCount,
      totalBinaryCount,
    });
    return;
  }

  treeElement.hidden = false;
  treeEmptyMessageElement.hidden = true;
  const view = ensureTreeView();
  view.update(appState.roots, appState.selectedId, { filter });
  view.setGitStatus(collectGitStatusEntries(appState.repositories));

  documentCountElement.textContent = formatFileCountDisplay({
    filterOn,
    visibleCount: filterOn ? view.getVisibleLeafCount() : totalCount,
    visibleBinaryCount: filterOn ? view.getVisibleBinaryLeafCount() : totalBinaryCount,
    totalCount,
    totalBinaryCount,
  });
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

export function readSidebarWidthPreference(): number {
  try {
    const value = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(value)) {
      return clampSidebarWidth(value);
    }
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
  return 300;
}

export function setSidebarWidth(width: number, options: { persist?: boolean } = {}) {
  const nextWidth = clampSidebarWidth(width);
  document.documentElement.style.setProperty("--sidebar-width", `${nextWidth}px`);

  if (options.persist === false) {
    return;
  }

  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(nextWidth));
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}

export function clampSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)));
}

export function readCollapsedPreference(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSidebarCollapsed(collapsed: boolean, options: { persist?: boolean } = {}) {
  appShellElement.classList.toggle("is-sidebar-collapsed", collapsed);
  sidebarCollapseElement.setAttribute("aria-expanded", String(!collapsed));
  sidebarExpandElement.setAttribute("aria-expanded", String(!collapsed));

  if (options.persist === false) {
    return;
  }

  try {
    if (collapsed) {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    } else {
      window.localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
    }
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}
