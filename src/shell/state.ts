// Application state singleton and the types / storage primitives that
// describe its shape. Lives in `shell/` because every feature module needs
// it; centralizing it here means no other module has to depend on
// `app.ts` to read or write the current state.
//
// This is the *minimum viable* extraction: `appState` is still a
// module-local mutable, not a reactive store. Replacing it with a proper
// observable store (or moving to pure-function reducers) is a separate,
// larger change and explicitly out of scope here.

import {
  DEFAULT_COMPARE_TARGET,
  DEFAULT_VIEW_MODE,
  isCompareTarget,
  readDiffStylePreference,
  readPreviewWrapPreference,
  readSplitRatioPreference,
  readViewLayoutPreference,
  type DiffStyle,
  type RepositorySnapshot,
  type CompareTarget,
  type RootGroup,
  type Scope,
  type SplitRatio,
  type ViewLayout,
  type ViewMode,
} from "../shared/types";
import type { StaleHint } from "./stale-hint";
import { presentationLocalStorage } from "./presentation-storage";

// Best-effort access to window.localStorage. Wrapped because cross-origin
// iframes, certain privacy modes, and quota issues can make the property
// access itself throw, not just `getItem` / `setItem`.
export function safeLocalStorage(): Storage | null {
  return presentationLocalStorage();
}

// Storage keys for state-related preferences. UI-only preferences (sidebar
// collapse, sidebar width, metadata-card open) live with their respective
// feature modules — only keys whose values appear inside `appState` are
// hosted here.
export const SIDEBAR_PANES_KEY = "uatu:sidebar-panes";
export const GIT_LOG_LIMIT_KEY = "uatu:git-log-limit";
export const ACTIVE_TAB_KEY = "uatu:active-tab";

// Discriminated union describing what the preview pane is showing. Drives
// the renderer dispatch in `connectEvents` / `loadInitialState`.
export type PreviewMode =
  | { kind: "document" }
  | { kind: "commit"; repositoryId: string; sha: string }
  | { kind: "empty" };

// Sidebar pane registry. Single mode-independent catalog.
export const ALL_PANE_DEFS = [
  { id: "change-overview", label: "Change Overview" },
  { id: "search", label: "Search" },
  { id: "files", label: "Files" },
  { id: "git-log", label: "Git Log" },
] as const;
export type PaneId = (typeof ALL_PANE_DEFS)[number]["id"];
export type PaneDef = (typeof ALL_PANE_DEFS)[number];
export type PaneState = Record<PaneId, { visible: boolean; collapsed: boolean; height: number | null }>;

function defaultPaneState(): PaneState {
  return {
    "change-overview": { visible: true, collapsed: false, height: 210 },
    // Hidden by default: search is opened on demand by ⇧⌘F, and a pane that
    // is empty until you ask it something should not take room from the tree.
    search: { visible: false, collapsed: false, height: 260 },
    files: { visible: true, collapsed: false, height: null },
    // Hidden by default: the commit log is a sometimes-tool, not a
    // first-screen need — one toggle away in the panes menu. Stored pane
    // state always wins, so existing arrangements are untouched.
    "git-log": { visible: false, collapsed: false, height: 120 },
  };
}

// Reads the persisted pane layout, merging stored values over defaults.
// Stored entries for pane ids that no longer exist (e.g. the retired
// `selection-inspector`) are ignored: the loop below only ever reads ids
// from ALL_PANE_DEFS. The storage parameter exists for tests; production
// callers use the presentation-storage default.
export function readPaneState(
  storage: Pick<Storage, "getItem"> | null = safeLocalStorage(),
): PaneState {
  const fallback = defaultPaneState();
  try {
    const raw = storage?.getItem(SIDEBAR_PANES_KEY);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<PaneState>;
    for (const pane of ALL_PANE_DEFS) {
      const value = parsed[pane.id];
      if (!value || typeof value !== "object") {
        continue;
      }
      fallback[pane.id] = {
        visible: typeof value.visible === "boolean" ? value.visible : fallback[pane.id].visible,
        collapsed: typeof value.collapsed === "boolean" ? value.collapsed : fallback[pane.id].collapsed,
        height: typeof value.height === "number" && Number.isFinite(value.height) ? value.height : null,
      };
    }
  } catch {
    return fallback;
  }
  return fallback;
}

// Which surface the user is working in. Drives find-shortcut routing, and is
// deliberately *not* derived from `document.activeElement` — see
// `find/active-surface.ts` for why focus gives the wrong answer here.
//
// `browser` denotes UatuCode Desktop's split browser, which lives in a
// separate WKWebView: page-side tracking never produces it, because when that
// pane has focus this page receives no events at all. The wrapper owns that
// state and resolves it before a key ever reaches here.
export type ActiveSurface = "preview" | "terminal" | "browser";

// Touch-mode tab surfaces (touch-tab-navigation). One surface fills the
// viewport at a time; `preview` is the first-use default. Persisted per
// device (presentation storage) so a reload lands where the user left off.
export type TouchTab = "files" | "preview" | "terminal";

export function isTouchTab(value: unknown): value is TouchTab {
  return value === "files" || value === "preview" || value === "terminal";
}

export function readActiveTabPreference(
  storage: Pick<Storage, "getItem"> | null = safeLocalStorage(),
): TouchTab {
  try {
    const raw = storage?.getItem(ACTIVE_TAB_KEY);
    if (isTouchTab(raw)) {
      return raw;
    }
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
  return "preview";
}

// Files-pane filter chip: `all` shows the full tree, `changed` reduces the
// tree to the changed-files list plus ancestor directories.
export type FilesPaneFilter = "all" | "changed";

const DEFAULT_FILES_PANE_FILTER: FilesPaneFilter = "all";

export function isGitLogLimit(value: number): value is 10 | 25 | 50 | 100 {
  return value === 10 || value === 25 || value === 50 || value === 100;
}

export function readGitLogLimitPreference(): number {
  try {
    const value = Number(safeLocalStorage()?.getItem(GIT_LOG_LIMIT_KEY));
    if (isGitLogLimit(value)) {
      return value;
    }
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
  return 25;
}

export const appState = {
  roots: [] as RootGroup[],
  repositories: [] as RepositorySnapshot[],
  selectedId: null as string | null,
  previewMode: { kind: "document" } as PreviewMode,
  followEnabled: true,
  // Source / Rendered view preference for documents with a non-trivial
  // rendered representation (Markdown / AsciiDoc). Global, not per-document;
  // resolved on boot from localStorage; defaults to "rendered". Files without
  // a separate rendered representation (text / source / code) ignore this —
  // the server forces source rendering for them.
  viewMode: DEFAULT_VIEW_MODE as ViewMode,
  // Preview layout for Markdown / AsciiDoc: "single" shows one representation
  // (driven by viewMode); "split-h" and "split-v" show both side-by-side or
  // stacked. Global preference, persisted to localStorage.
  viewLayout: readViewLayoutPreference(safeLocalStorage()) as ViewLayout,
  // Source-pane fraction of the split container size, stored per orientation
  // so flipping side-by-side <-> stacked restores each orientation's ratio.
  splitRatio: readSplitRatioPreference(safeLocalStorage()) as SplitRatio,
  // Pierre's internal diff layout: "unified" (stacked, classic git-diff
  // shape) or "split" (side-by-side inside the diff component). Distinct
  // from `viewLayout` — applies only when viewMode === "diff".
  diffStyle: readDiffStylePreference(safeLocalStorage()) as DiffStyle,
  // Soft word-wrap for the preview. Single global preference applied to
  // whichever view supports wrapping (Source and Diff); ignored in
  // Rendered. Resolved on boot from localStorage; defaults to off.
  wrap: readPreviewWrapPreference(safeLocalStorage()),
  // Per-active-file stale-content hint state. Cleared by manual navigation
  // or refresh action.
  staleHint: null as StaleHint | null,
  scope: { kind: "folder" } as Scope,
  // Opaque hash of the unscoped corpus, from the server snapshot. The Search
  // pane compares it across snapshots to notice out-of-scope documents
  // changing under a widened ("Search all roots") result set — the only
  // signal it gets, since those documents never appear in `roots`.
  unscopedFingerprint: null as string | null,
  // Which surface find acts on. Set only from user interaction; file events
  // and programmatic selection must leave it alone.
  activeSurface: "preview" as ActiveSurface,
  panes: readPaneState(),
  // Touch mode's active tab surface. Meaningful only while the UI mode is
  // `touch`; desktop mode ignores it (and CSS keys every surface rule on
  // the mode attribute). Owned by shell/tab-bar.ts.
  activeTab: readActiveTabPreference() as TouchTab,
  filesPaneFilter: DEFAULT_FILES_PANE_FILTER as FilesPaneFilter,
  gitLogLimit: readGitLogLimitPreference(),
  // Which lens the Change Overview measures changes against. Mirrors the
  // server-session value; persisted and reconciled to the server on boot.
  compareTarget: DEFAULT_COMPARE_TARGET as CompareTarget,
};

export type AppState = typeof appState;
