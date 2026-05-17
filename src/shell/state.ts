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
  DEFAULT_MODE,
  readDiffStylePreference,
  readSplitRatioPreference,
  readViewLayoutPreference,
  readViewModePreference,
  type DiffStyle,
  type Mode,
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
export const SIDEBAR_PANES_KEY_PREFIX = "uatu:sidebar-panes:";
export const GIT_LOG_LIMIT_KEY = "uatu:git-log-limit";
export const FILES_PANE_FILTER_KEY_PREFIX = "uatu.filesPaneFilter.";

// Discriminated union describing what the preview pane is showing. Drives
// the renderer dispatch in `connectEvents` / `loadInitialState`.
export type PreviewMode =
  | { kind: "document" }
  | { kind: "review-score"; repositoryId: string }
  | { kind: "commit"; repositoryId: string; sha: string }
  | { kind: "empty" };

// Sidebar pane registry. ALL_PANE_DEFS is the source of truth for the set
// of pane ids; PANE_DEFS_BY_MODE filters that set per Mode (Author hides
// Git Log and Selection Inspector).
export const ALL_PANE_DEFS = [
  { id: "change-overview", label: "Change Overview" },
  { id: "files", label: "Files" },
  { id: "git-log", label: "Git Log" },
  { id: "selection-inspector", label: "Selection Inspector" },
] as const;
export type PaneId = (typeof ALL_PANE_DEFS)[number]["id"];
export type PaneDef = (typeof ALL_PANE_DEFS)[number];
export type PaneState = Record<PaneId, { visible: boolean; collapsed: boolean; height: number | null }>;

export const AUTHOR_HIDDEN_PANES: ReadonlySet<PaneId> = new Set(["git-log", "selection-inspector"]);

export const PANE_DEFS_BY_MODE: Record<Mode, readonly PaneDef[]> = {
  // Author hides Git Log (past commits are a Review concern) and Selection
  // Inspector (Author's Follow auto-switches the active preview, which would
  // routinely yank captured selections out from under the pane).
  author: ALL_PANE_DEFS.filter(pane => !AUTHOR_HIDDEN_PANES.has(pane.id)),
  review: ALL_PANE_DEFS,
};

export function paneDefsForMode(mode: Mode): readonly PaneDef[] {
  return PANE_DEFS_BY_MODE[mode];
}

export function paneStorageKeyForMode(mode: Mode): string {
  return `${SIDEBAR_PANES_KEY_PREFIX}${mode}`;
}

export function defaultPaneState(): PaneState {
  return {
    "change-overview": { visible: true, collapsed: false, height: 210 },
    files: { visible: true, collapsed: false, height: null },
    "git-log": { visible: true, collapsed: false, height: 120 },
    "selection-inspector": { visible: true, collapsed: false, height: 160 },
  };
}

export function readPaneState(mode: Mode): PaneState {
  const fallback = defaultPaneState();
  try {
    const raw = window.localStorage.getItem(paneStorageKeyForMode(mode));
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
// Persisted per-Mode so Review and Author remember their own state.
export type FilesPaneFilter = "all" | "changed";

export const DEFAULT_FILES_PANE_FILTER_BY_MODE: Record<Mode, FilesPaneFilter> = {
  // Review opens onto the change set; users came here to review.
  review: "changed",
  // Author defaults to the full tree; Follow drives attention in that mode.
  author: "all",
};

export function readFilesPaneFilterPreference(mode: Mode): FilesPaneFilter {
  const fallback = DEFAULT_FILES_PANE_FILTER_BY_MODE[mode];
  try {
    const raw = window.localStorage.getItem(`${FILES_PANE_FILTER_KEY_PREFIX}${mode}`);
    return raw === "all" || raw === "changed" ? raw : fallback;
  } catch {
    return fallback;
  }
}

export function writeFilesPaneFilterPreference(mode: Mode, value: FilesPaneFilter): void {
  try {
    window.localStorage.setItem(`${FILES_PANE_FILTER_KEY_PREFIX}${mode}`, value);
  } catch {
    // best-effort persistence; localStorage may be disabled
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
  // Snapshot of the user's Follow choice while they were last in Author mode.
  // Captured when transitioning Author → Review (since Review forces Follow
  // off to honor the "no auto-switching" contract) and restored on the
  // reverse transition. Default `true` matches Author's natural default for
  // first-time users who boot directly into Review and then switch back.
  authorFollowPreference: true,
  // Author / Review posture. Resolved on boot from the CLI startupMode override
  // (when present) or persisted localStorage; falls back to DEFAULT_MODE.
  mode: DEFAULT_MODE as Mode,
  // Source / Rendered view preference for documents with a non-trivial
  // rendered representation (Markdown / AsciiDoc). Global, not per-document;
  // matches the persistence pattern of `mode` and Follow. Resolved on boot
  // from localStorage; defaults to "rendered". Files without a separate
  // rendered representation (text / source / code) ignore this — the server
  // forces source rendering for them.
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
  // Per-active-file stale-content hint state. Only set in Review mode; cleared
  // by manual navigation, mode switch back to Author, or refresh action.
  staleHint: null as StaleHint | null,
  scope: { kind: "folder" } as Scope,
  panes: readPaneState(DEFAULT_MODE),
  // Files-pane filter chip state for the active Mode. Resolved on boot and on
  // Mode switch from `readFilesPaneFilterPreference` (with the per-Mode default
  // when no value is persisted yet).
  filesPaneFilter: readFilesPaneFilterPreference(DEFAULT_MODE) as FilesPaneFilter,
  gitLogLimit: readGitLogLimitPreference(),
};

export type AppState = typeof appState;
