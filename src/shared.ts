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
  // Number of files filtered by the user-controlled ignore matchers
  // (`.uatuignore` and `.gitignore`). Excludes the hardcoded directory denylist
  // — those are infrastructure, not user choices, and we never recurse into
  // them so we cannot count their contents anyway.
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

export type TreeNode = {
  kind: "dir" | "doc";
  name: string;
  path: string;
  id?: string;
  children?: TreeNode[];
  documentKind?: DocumentKind;
  mtimeMs?: number;
};

export function formatRelativeTime(mtimeMs: number, nowMs: number): string {
  const diffSeconds = Math.max(0, (nowMs - mtimeMs) / 1000);
  if (diffSeconds < 5) return "now";
  if (diffSeconds < 60) return `${Math.floor(diffSeconds)}s`;
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m`;
  if (diffSeconds < 86_400) return `${Math.floor(diffSeconds / 3600)}h`;
  if (diffSeconds < 604_800) return `${Math.floor(diffSeconds / 86_400)}d`;
  if (diffSeconds < 2_592_000) return `${Math.floor(diffSeconds / 604_800)}w`;
  return `${Math.floor(diffSeconds / 2_592_000)}mo`;
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

export function buildTreeNodes(root: RootGroup): TreeNode[] {
  const tree = new Map<string, TreeNode>();
  const rootsByPath = new Map<string, TreeNode[]>();
  rootsByPath.set("", []);

  for (const doc of root.docs) {
    const parts = doc.relativePath.split("/").filter(Boolean);
    let currentPath = "";

    for (const [index, part] of parts.entries()) {
      const nextPath = currentPath ? `${currentPath}/${part}` : part;
      const isLeaf = index === parts.length - 1;
      const siblings = rootsByPath.get(currentPath) ?? [];

      if (isLeaf) {
        siblings.push({
          kind: "doc",
          name: part,
          path: nextPath,
          id: doc.id,
          documentKind: doc.kind,
          mtimeMs: doc.mtimeMs,
        });
        continue;
      }

      if (!tree.has(nextPath)) {
        const node: TreeNode = {
          kind: "dir",
          name: part,
          path: nextPath,
          children: [],
        };
        tree.set(nextPath, node);
        rootsByPath.set(nextPath, node.children ?? []);
        siblings.push(node);
      }

      currentPath = nextPath;
    }
  }

  return sortTreeNodes(rootsByPath.get("") ?? []);
}

function sortTreeNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .map(node => {
      if (node.kind === "dir" && node.children) {
        const sortedChildren = sortTreeNodes(node.children);
        // Bubble up the most recent mtime under this directory so the sidebar
        // can show "5m" next to a folder that contains a file modified 5
        // minutes ago — useful for spotting active subtrees at a glance
        // without expanding them.
        const newest = sortedChildren.reduce<number>((max, child) => {
          const childMtime = child.mtimeMs ?? 0;
          return childMtime > max ? childMtime : max;
        }, 0);
        return {
          ...node,
          children: sortedChildren,
          mtimeMs: newest > 0 ? newest : undefined,
        };
      }

      return node;
    })
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "dir" ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
}
