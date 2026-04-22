export type DocumentMeta = {
  id: string;
  name: string;
  relativePath: string;
  mtimeMs: number;
  rootId: string;
};

export type RootGroup = {
  id: string;
  label: string;
  path: string;
  docs: DocumentMeta[];
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
};

export function flattenDocuments(roots: RootGroup[]): DocumentMeta[] {
  return roots.flatMap(root => root.docs);
}

export function hasDocument(roots: RootGroup[], documentId: string | null): boolean {
  if (!documentId) {
    return false;
  }

  return flattenDocuments(roots).some(doc => doc.id === documentId);
}

export function defaultDocumentId(roots: RootGroup[]): string | null {
  const docs = flattenDocuments(roots);
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

  if (followEnabled && changedId && hasDocument(roots, changedId)) {
    return changedId;
  }

  if (currentId && hasDocument(roots, currentId)) {
    return currentId;
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
        return {
          ...node,
          children: sortTreeNodes(node.children),
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
