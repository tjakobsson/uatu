export type DocumentKind = "markdown" | "text" | "binary";

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

export type StatePayload = {
  roots: RootGroup[];
  initialFollow: boolean;
  defaultDocumentId: string | null;
  changedId: string | null;
  generatedAt: number;
  build: BuildSummary;
  scope: Scope;
};

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
