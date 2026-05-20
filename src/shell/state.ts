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
  readDiffStylePreference,
  readSplitRatioPreference,
  readViewLayoutPreference,
  readViewModePreference,
  type DiffStyle,
  type RepositoryReviewSnapshot,
  type RootGroup,
  type Scope,
  type SplitRatio,
  type ViewLayout,
  type ViewMode,
} from "../shared/types";
import type { StaleHint } from "./stale-hint";

// Best-effort access to window.localStorage. Wrapped because cross-origin
// iframes, certain privacy modes, and quota issues can make the property
// access itself throw, not just `getItem` / `setItem`.
export function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// Storage keys for state-related preferences. UI-only preferences (sidebar
// collapse, sidebar width, metadata-card open) live with their respective
// feature modules — only keys whose values appear inside `appState` are
// hosted here.
export const SIDEBAR_PANES_KEY = "uatu:sidebar-panes";
export const GIT_LOG_LIMIT_KEY = "uatu:git-log-limit";
export const FILES_PANE_FILTER_KEY = "uatu.filesPaneFilter";

// Legacy per-Mode keys retained as constants so the boot-time migration can
// find and remove them. Not used by any reader after the migration runs.
export const LEGACY_MODE_KEY = "uatu:mode";
export const LEGACY_SIDEBAR_PANES_KEY_AUTHOR = "uatu:sidebar-panes:author";
export const LEGACY_SIDEBAR_PANES_KEY_REVIEW = "uatu:sidebar-panes:review";
export const LEGACY_FILES_PANE_FILTER_KEY_AUTHOR = "uatu.filesPaneFilter.author";
export const LEGACY_FILES_PANE_FILTER_KEY_REVIEW = "uatu.filesPaneFilter.review";

// Discriminated union describing what the preview pane is showing. Drives
// the renderer dispatch in `connectEvents` / `loadInitialState`.
export type PreviewMode =
  | { kind: "document" }
  | { kind: "review-score"; repositoryId: string }
  | { kind: "commit"; repositoryId: string; sha: string }
  | { kind: "empty" };

// Sidebar pane registry. Single mode-independent catalog.
export const ALL_PANE_DEFS = [
  { id: "change-overview", label: "Change Overview" },
  { id: "files", label: "Files" },
  { id: "git-log", label: "Git Log" },
  { id: "selection-inspector", label: "Selection Inspector" },
] as const;
export type PaneId = (typeof ALL_PANE_DEFS)[number]["id"];
export type PaneDef = (typeof ALL_PANE_DEFS)[number];
export type PaneState = Record<PaneId, { visible: boolean; collapsed: boolean; height: number | null }>;

export function defaultPaneState(): PaneState {
  return {
    "change-overview": { visible: true, collapsed: false, height: 210 },
    files: { visible: true, collapsed: false, height: null },
    "git-log": { visible: true, collapsed: false, height: 120 },
    "selection-inspector": { visible: true, collapsed: false, height: 160 },
  };
}

export function readPaneState(): PaneState {
  const fallback = defaultPaneState();
  try {
    const raw = window.localStorage.getItem(SIDEBAR_PANES_KEY);
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

// Files-pane filter chip: `all` shows the full tree, `changed` reduces the
// tree to `reviewLoad.changedFiles ∪ ignoredFiles` plus ancestor directories.
export type FilesPaneFilter = "all" | "changed";

export const DEFAULT_FILES_PANE_FILTER: FilesPaneFilter = "all";

export function readFilesPaneFilterPreference(): FilesPaneFilter {
  try {
    const raw = window.localStorage.getItem(FILES_PANE_FILTER_KEY);
    return raw === "all" || raw === "changed" ? raw : DEFAULT_FILES_PANE_FILTER;
  } catch {
    return DEFAULT_FILES_PANE_FILTER;
  }
}

export function writeFilesPaneFilterPreference(value: FilesPaneFilter): void {
  try {
    window.localStorage.setItem(FILES_PANE_FILTER_KEY, value);
  } catch {
    // best-effort persistence; localStorage may be disabled
  }
}

// One-time migration from per-Mode storage keys to the single keys above.
// Reads the Author-mode pane layout if present (it's the historical default
// most users sat in) and writes it to the new bare key. Removes all legacy
// `:author` / `:review` variants and the discarded `uatu:mode` preference.
export function migrateLegacyModeStorage(): void {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    if (storage.getItem(SIDEBAR_PANES_KEY) === null) {
      const author = storage.getItem(LEGACY_SIDEBAR_PANES_KEY_AUTHOR);
      if (author !== null) {
        storage.setItem(SIDEBAR_PANES_KEY, author);
      }
    }
    if (storage.getItem(FILES_PANE_FILTER_KEY) === null) {
      const author = storage.getItem(LEGACY_FILES_PANE_FILTER_KEY_AUTHOR);
      if (author === "all" || author === "changed") {
        storage.setItem(FILES_PANE_FILTER_KEY, author);
      }
    }
    storage.removeItem(LEGACY_SIDEBAR_PANES_KEY_AUTHOR);
    storage.removeItem(LEGACY_SIDEBAR_PANES_KEY_REVIEW);
    storage.removeItem(LEGACY_FILES_PANE_FILTER_KEY_AUTHOR);
    storage.removeItem(LEGACY_FILES_PANE_FILTER_KEY_REVIEW);
    storage.removeItem(LEGACY_MODE_KEY);
  } catch {
    // best-effort; storage may be disabled or quota-bound
  }
}

export function isGitLogLimit(value: number): value is 10 | 25 | 50 | 100 {
  return value === 10 || value === 25 || value === 50 || value === 100;
}

export function readGitLogLimitPreference(): number {
  try {
    const value = Number(window.localStorage.getItem(GIT_LOG_LIMIT_KEY));
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
  repositories: [] as RepositoryReviewSnapshot[],
  selectedId: null as string | null,
  previewMode: { kind: "document" } as PreviewMode,
  followEnabled: true,
  // Source / Rendered view preference for documents with a non-trivial
  // rendered representation (Markdown / AsciiDoc). Global, not per-document;
  // resolved on boot from localStorage; defaults to "rendered". Files without
  // a separate rendered representation (text / source / code) ignore this —
  // the server forces source rendering for them.
  viewMode: readViewModePreference(safeLocalStorage()) as ViewMode,
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
  // Per-active-file stale-content hint state. Cleared by manual navigation
  // or refresh action.
  staleHint: null as StaleHint | null,
  scope: { kind: "folder" } as Scope,
  panes: readPaneState(),
  filesPaneFilter: readFilesPaneFilterPreference() as FilesPaneFilter,
  gitLogLimit: readGitLogLimitPreference(),
};

export type AppState = typeof appState;
