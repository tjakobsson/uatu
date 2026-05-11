export type DocumentKind = "markdown" | "asciidoc" | "text" | "binary";

export type DocumentMeta = {
  id: string;
  name: string;
  relativePath: string;
  mtimeMs: number;
  rootId: string;
  kind: DocumentKind;
};

export type RootGroup = {
  id: string;
  label: string;
  path: string;
  docs: DocumentMeta[];
  // Number of files filtered by the user-controlled ignore matcher
  // (`.uatu.json tree.exclude` and `.gitignore`). Excludes the built-in
  // directory denylist — those are infrastructure, not user choices, and we
  // never recurse into them so we cannot count their contents anyway.
  hiddenCount: number;
};

export type BuildSummary = {
  version: string;
  branch: string;
  commitSha: string;
  commitShort: string;
  release: boolean;
  identifier: string;
};

export type Scope = { kind: "folder" } | { kind: "file"; documentId: string };

export type ReviewBurdenLevel = "low" | "medium" | "high";

export type ReviewThresholds = {
  medium: number;
  high: number;
};

export type ReviewAreaConfig = {
  label: string;
  paths: string[];
  score?: number;
  perFile?: number;
  max?: number;
  maxDiscount?: number;
};

export type ReviewSettings = {
  baseRef?: string;
  thresholds: ReviewThresholds;
  riskAreas: ReviewAreaConfig[];
  supportAreas: ReviewAreaConfig[];
  ignoreAreas: ReviewAreaConfig[];
};

export type RepositoryMetadata = {
  id: string;
  rootPath: string;
  label: string;
  watchedRootIds: string[];
  status: "git" | "non-git" | "unavailable";
  branch: string | null;
  detached: boolean;
  commitShort: string | null;
  dirty: boolean;
  message: string | null;
};

export type ReviewBaseMode =
  | "configured"
  | "remote-default"
  | "fallback"
  | "dirty-worktree-only"
  | "unavailable";

export type ReviewBase = {
  mode: ReviewBaseMode;
  ref: string | null;
  mergeBase: string | null;
};

export type ChangedFileSummary = {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  hunks: number;
};

export type ReviewScoreDriver = {
  kind: "mechanical" | "risk" | "support" | "ignore" | "warning";
  label: string;
  score: number;
  detail: string;
  files: string[];
};

export type ReviewConfiguredArea = {
  kind: "risk" | "support" | "ignore";
  label: string;
  paths: string[];
  matchedFiles: string[];
  score: number;
};

export type ReviewLoadResult = {
  status: "available" | "non-git" | "unavailable";
  score: number;
  level: ReviewBurdenLevel;
  thresholds: ReviewThresholds;
  base: ReviewBase;
  changedFiles: ChangedFileSummary[];
  ignoredFiles: ChangedFileSummary[];
  drivers: ReviewScoreDriver[];
  configuredAreas: ReviewConfiguredArea[];
  settingsWarnings: string[];
  message: string | null;
};

export type CommitLogEntry = {
  sha: string;
  subject: string;
  message: string;
  author: string | null;
  relativeTime: string | null;
};

export type RepositoryReviewSnapshot = {
  id: string;
  rootPath: string;
  label: string;
  watchedRootIds: string[];
  metadata: RepositoryMetadata;
  reviewLoad: ReviewLoadResult;
  commitLog: CommitLogEntry[];
};

export type Mode = "author" | "review";

export const MODE_STORAGE_KEY = "uatu:mode";

export const DEFAULT_MODE: Mode = "author";

export type TerminalAvailability = "enabled" | "disabled";

export type TerminalConfigPayload = {
  fontFamily?: string;
  fontSize?: number;
};

export type StatePayload = {
  roots: RootGroup[];
  repositories: RepositoryReviewSnapshot[];
  initialFollow: boolean;
  defaultDocumentId: string | null;
  changedId: string | null;
  generatedAt: number;
  build: BuildSummary;
  scope: Scope;
  startupMode?: Mode;
  terminal?: TerminalAvailability;
  terminalConfig?: TerminalConfigPayload;
};

export function isMode(value: unknown): value is Mode {
  return value === "author" || value === "review";
}

export function reviewBurdenHeadlineLabel(mode: Mode): string {
  return mode === "review" ? "Change review burden" : "Reviewer burden forecast";
}

type ModeStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function readModePreference(
  storage: ModeStorage | null | undefined,
  startupMode?: Mode,
): Mode {
  if (startupMode && isMode(startupMode)) {
    return startupMode;
  }
  if (!storage) {
    return DEFAULT_MODE;
  }
  try {
    const raw = storage.getItem(MODE_STORAGE_KEY);
    return isMode(raw) ? raw : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export function writeModePreference(
  storage: ModeStorage | null | undefined,
  mode: Mode,
): void {
  if (!storage) return;
  try {
    storage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // localStorage may be disabled or full; persistence is best-effort.
  }
}

// View mode controls how the preview body renders the active document:
// "rendered" runs Markdown / AsciiDoc through their full pipelines, "source"
// shows the file's verbatim text inside the source-rendering `<pre><code>`
// path. The Selection Inspector pane only captures line ranges from the
// "source" view since the rendered HTML has no source-position information.
export type ViewMode = "source" | "rendered";

export const VIEW_MODE_STORAGE_KEY = "uatu:view-mode";

export const DEFAULT_VIEW_MODE: ViewMode = "rendered";

export function isViewMode(value: unknown): value is ViewMode {
  return value === "source" || value === "rendered";
}

export function readViewModePreference(storage: ModeStorage | null | undefined): ViewMode {
  if (!storage) {
    return DEFAULT_VIEW_MODE;
  }
  try {
    const raw = storage.getItem(VIEW_MODE_STORAGE_KEY);
    return isViewMode(raw) ? raw : DEFAULT_VIEW_MODE;
  } catch {
    return DEFAULT_VIEW_MODE;
  }
}

export function writeViewModePreference(
  storage: ModeStorage | null | undefined,
  view: ViewMode,
): void {
  if (!storage) return;
  try {
    storage.setItem(VIEW_MODE_STORAGE_KEY, view);
  } catch {
    // best-effort persistence
  }
}

// View layout controls how the preview body arranges the active document's
// representations. "single" shows one representation at a time (chosen by
// ViewMode); "split-h" places Source on the left and Rendered on the right;
// "split-v" places Source on top and Rendered below. Layout is a single
// global preference, persisted to localStorage, distinct from ViewMode.
export type ViewLayout = "single" | "split-h" | "split-v";

export const VIEW_LAYOUT_STORAGE_KEY = "uatu:view-layout";

export const DEFAULT_VIEW_LAYOUT: ViewLayout = "single";

export function isViewLayout(value: unknown): value is ViewLayout {
  return value === "single" || value === "split-h" || value === "split-v";
}

export function readViewLayoutPreference(storage: ModeStorage | null | undefined): ViewLayout {
  if (!storage) {
    return DEFAULT_VIEW_LAYOUT;
  }
  try {
    const raw = storage.getItem(VIEW_LAYOUT_STORAGE_KEY);
    return isViewLayout(raw) ? raw : DEFAULT_VIEW_LAYOUT;
  } catch {
    return DEFAULT_VIEW_LAYOUT;
  }
}

export function writeViewLayoutPreference(
  storage: ModeStorage | null | undefined,
  layout: ViewLayout,
): void {
  if (!storage) return;
  try {
    storage.setItem(VIEW_LAYOUT_STORAGE_KEY, layout);
  } catch {
    // best-effort persistence
  }
}

// Split ratio is the Source pane's fraction of the available split-container
// size along the active axis, stored independently per orientation so flipping
// side-by-side <-> stacked restores each orientation's last user-chosen ratio.
export type SplitRatio = { h: number; v: number };

export const VIEW_SPLIT_RATIO_STORAGE_KEY = "uatu:view-split-ratio";

export const DEFAULT_SPLIT_RATIO: SplitRatio = { h: 0.5, v: 0.5 };

// Minimum/maximum stored ratio: panes can still be smaller during a transient
// drag clamp, but the persisted value stays inside this range so it never gets
// "stuck" at 0 or 1.
const MIN_STORED_RATIO = 0.05;
const MAX_STORED_RATIO = 0.95;

function clampRatio(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value < MIN_STORED_RATIO) return MIN_STORED_RATIO;
  if (value > MAX_STORED_RATIO) return MAX_STORED_RATIO;
  return value;
}

export function readSplitRatioPreference(storage: ModeStorage | null | undefined): SplitRatio {
  if (!storage) {
    return { ...DEFAULT_SPLIT_RATIO };
  }
  try {
    const raw = storage.getItem(VIEW_SPLIT_RATIO_STORAGE_KEY);
    if (raw === null) {
      return { ...DEFAULT_SPLIT_RATIO };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULT_SPLIT_RATIO };
    }
    const h = clampRatio((parsed as { h?: unknown }).h);
    const v = clampRatio((parsed as { v?: unknown }).v);
    return {
      h: h ?? DEFAULT_SPLIT_RATIO.h,
      v: v ?? DEFAULT_SPLIT_RATIO.v,
    };
  } catch {
    return { ...DEFAULT_SPLIT_RATIO };
  }
}

export function writeSplitRatioPreference(
  storage: ModeStorage | null | undefined,
  ratio: SplitRatio,
): void {
  if (!storage) return;
  try {
    const safe: SplitRatio = {
      h: clampRatio(ratio.h) ?? DEFAULT_SPLIT_RATIO.h,
      v: clampRatio(ratio.v) ?? DEFAULT_SPLIT_RATIO.v,
    };
    storage.setItem(VIEW_SPLIT_RATIO_STORAGE_KEY, JSON.stringify(safe));
  } catch {
    // best-effort persistence
  }
}

export function flattenDocuments(roots: RootGroup[]): DocumentMeta[] {
  return roots.flatMap(root => root.docs);
}

export function hasDocument(roots: RootGroup[], documentId: string | null): boolean {
  if (!documentId) {
    return false;
  }

  return flattenDocuments(roots).some(doc => doc.id === documentId);
}

export function findDocument(
  roots: RootGroup[],
  documentId: string | null,
): DocumentMeta | undefined {
  if (!documentId) {
    return undefined;
  }

  return flattenDocuments(roots).find(doc => doc.id === documentId);
}

export function defaultDocumentId(roots: RootGroup[]): string | null {
  const docs = flattenDocuments(roots).filter(doc => doc.kind !== "binary");
  if (docs.length === 0) {
    return null;
  }

  return docs
    .slice()
    .sort((left, right) => {
      if (right.mtimeMs !== left.mtimeMs) {
        return right.mtimeMs - left.mtimeMs;
      }

      return left.relativePath.localeCompare(right.relativePath);
    })[0]?.id ?? null;
}

export function shouldRefreshPreview(selectedId: string | null, changedId: string | null): boolean {
  return Boolean(selectedId && changedId && selectedId === changedId);
}

export function nextSelectedDocumentId(
  roots: RootGroup[],
  currentId: string | null,
  changedId: string | null,
  followEnabled: boolean,
): string | null {
  if (roots.length === 0 || flattenDocuments(roots).length === 0) {
    return null;
  }

  if (followEnabled && changedId) {
    const changed = findDocument(roots, changedId);
    if (changed && changed.kind !== "binary") {
      return changedId;
    }
  }

  if (currentId) {
    const current = findDocument(roots, currentId);
    if (current && current.kind !== "binary") {
      return currentId;
    }
  }

  return defaultDocumentId(roots);
}

