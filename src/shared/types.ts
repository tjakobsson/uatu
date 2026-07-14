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

// Repo-derived facts about the on-disk file behind a rendered document,
// computed fresh on every /api/document render (live reload keeps them
// current). `git` is absent for non-git roots and whenever the git lookup
// fails — the render itself must never fail because facts collection did.
// String fields are HTML-escaped server-side before serialization, matching
// the sanitizeMetadata posture.
export type FileFactsGit = {
  // null when the file has never been committed (dirty is then true).
  author: string | null;
  authoredAt: string | null; // ISO 8601
  shortSha: string | null;
  subject: string | null;
  // Working tree differs from HEAD for this path.
  dirty: boolean;
};

export type FileFacts = {
  // null when the collector was invoked without the file source (the diff
  // endpoint) — computing it there would mean an unbounded file read for a
  // value the Diff strip never renders.
  lines: number | null;
  bytes: number;
  mtime: string; // ISO 8601
  git?: FileFactsGit;
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

// What the review burden / diff is measured against. `base` is the resolved
// review base (merge-base..worktree — the reviewer's view, the default and the
// product's hero). `last-commit` is plain git: staged + unstaged changes
// against HEAD (the author's working view).
export type ReviewCompareTarget = "base" | "last-commit";

export const DEFAULT_COMPARE_TARGET: ReviewCompareTarget = "base";

export function isReviewCompareTarget(value: unknown): value is ReviewCompareTarget {
  return value === "base" || value === "last-commit";
}

export type ReviewBase = {
  mode: ReviewBaseMode;
  ref: string | null;
  mergeBase: string | null;
  // Which compare target produced this result.
  compareTarget: ReviewCompareTarget;
  // Precise, portable ref the score was actually computed against — the
  // resolved base ref (e.g. `origin/main`, a configured `origin/develop`) for
  // the `base` target, or `HEAD` for `last-commit` and the dirty-worktree
  // fallback. This is the *label* shown in the burden anchor, not the literal
  // git arg (which is the merge-base SHA for `base`).
  comparedAgainstRef: string;
  // True when no base ref is resolvable, so `base` and `last-commit` describe
  // the same diff and the choice is not meaningful.
  targetsCollapsed: boolean;
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
  // Repo-root-relative paths of files in the tree that are matched by git's
  // ignore rules (.gitignore, core.excludesFile, etc.). Pre-filtered server-
  // side to paths uatu actually displays so we do not ship full ignored sets
  // (e.g. node_modules contents) over the wire. These files contribute
  // nothing to the score; their only consumer is tree row annotation.
  gitIgnoredFiles: string[];
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

export type TerminalAvailability = "enabled" | "disabled";

// Policy for bridging application-initiated OSC 52 copy sequences to the
// host clipboard. `notify` writes and shows a toast, `confirm` requires a
// click on the toast's Copy button, `silent` writes without feedback, `off`
// leaves OSC 52 unhandled. The bridge is write-only in every mode — clipboard
// read queries are never answered.
export type TerminalClipboardPolicy = "notify" | "confirm" | "silent" | "off";

export type TerminalConfigPayload = {
  fontFamily?: string;
  fontSize?: number;
  clipboard?: TerminalClipboardPolicy;
};

export type MonoConfigPayload = {
  fontFamily?: string;
};

export type StatePayload = {
  roots: RootGroup[];
  repositories: RepositoryReviewSnapshot[];
  // The server-session compare target the snapshots were computed for. The
  // client reconciles its persisted preference against this on boot.
  compareTarget: ReviewCompareTarget;
  initialFollow: boolean;
  defaultDocumentId: string | null;
  changedId: string | null;
  generatedAt: number;
  build: BuildSummary;
  scope: Scope;
  terminal?: TerminalAvailability;
  terminalConfig?: TerminalConfigPayload;
  monoConfig?: MonoConfigPayload;
};

type ModeStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

// View mode controls how the preview body renders the active document:
// "rendered" runs Markdown / AsciiDoc through their full pipelines, "source"
// shows the file's verbatim text inside the source-rendering `<pre><code>`
// path, and "diff" renders the file's git diff against the resolved review
// base. The Selection Inspector pane only captures line ranges from the
// "source" view since the other views have no source-position information.
export type ViewMode = "source" | "rendered" | "diff";

export const VIEW_MODE_STORAGE_KEY = "uatu:view-mode";

export const DEFAULT_VIEW_MODE: ViewMode = "rendered";

export function isViewMode(value: unknown): value is ViewMode {
  return value === "source" || value === "rendered" || value === "diff";
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

// Diff style controls how the Diff view's @pierre/diffs renderer arranges
// added and deleted lines inside the diff itself. "unified" stacks them
// vertically (the default, like classic `git diff` output); "split" puts
// deletions on the left and additions on the right inside the Pierre
// component. This is independent of the outer ViewLayout chooser — the
// outer chooser is hidden when the Diff view is active.
export type DiffStyle = "unified" | "split";

export const DIFF_STYLE_STORAGE_KEY = "uatu:diff-style";

export const DEFAULT_DIFF_STYLE: DiffStyle = "unified";

export function isDiffStyle(value: unknown): value is DiffStyle {
  return value === "unified" || value === "split";
}

export function readDiffStylePreference(storage: ModeStorage | null | undefined): DiffStyle {
  if (!storage) {
    return DEFAULT_DIFF_STYLE;
  }
  try {
    const raw = storage.getItem(DIFF_STYLE_STORAGE_KEY);
    return isDiffStyle(raw) ? raw : DEFAULT_DIFF_STYLE;
  } catch {
    return DEFAULT_DIFF_STYLE;
  }
}

export function writeDiffStylePreference(
  storage: ModeStorage | null | undefined,
  style: DiffStyle,
): void {
  if (!storage) return;
  try {
    storage.setItem(DIFF_STYLE_STORAGE_KEY, style);
  } catch {
    // best-effort persistence
  }
}

// Soft word-wrap preference for the preview. A single global on/off applied
// to whichever view supports wrapping (Source and Diff); meaningless in
// Rendered view. Persisted to localStorage, default off. Stored as the
// literal strings "on"/"off" so a stray value never reads as truthy.
export const PREVIEW_WRAP_STORAGE_KEY = "uatu:preview-wrap";

export const DEFAULT_PREVIEW_WRAP = false;

export function readPreviewWrapPreference(storage: ModeStorage | null | undefined): boolean {
  if (!storage) {
    return DEFAULT_PREVIEW_WRAP;
  }
  try {
    const raw = storage.getItem(PREVIEW_WRAP_STORAGE_KEY);
    if (raw === "on") return true;
    if (raw === "off") return false;
    return DEFAULT_PREVIEW_WRAP;
  } catch {
    return DEFAULT_PREVIEW_WRAP;
  }
}

export function writePreviewWrapPreference(
  storage: ModeStorage | null | undefined,
  wrap: boolean,
): void {
  if (!storage) return;
  try {
    storage.setItem(PREVIEW_WRAP_STORAGE_KEY, wrap ? "on" : "off");
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

