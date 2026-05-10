// Bridge between uatu's path-keyed document index and `@pierre/trees`. The
// library owns rendering, expansion handling, keyboard navigation, and icon
// presentation; uatu owns walking the filesystem, classifying files, and the
// downstream selection plumbing (preview routing, follow-mode interaction).
//
// One single `FileTree` instance is mounted into the Files-pane container.
// When the user has multiple watched roots, every path is prefixed with the
// root's label so they share one tree (matching VS Code's multi-root workspace
// model). Selection events are translated from the prefixed canonical path
// back to the document ID expected by the existing routing flow.

import { FileTree, themeToTreeStyles, type GitStatusEntry } from "@pierre/trees";

import type { RootGroup } from "./shared";

// uatu is light-only at the moment. Forcing `type: "light"` here pins the
// library's color-scheme so it doesn't auto-flip on `prefers-color-scheme`
// dark. Re-revisit if/when uatu adds a dark-mode toggle.
const LIGHT_TREE_THEME = themeToTreeStyles({ type: "light" });

export type TreeViewSelectionHandler = (documentId: string) => void;

export type TreeViewOptions = {
  container: HTMLElement;
  onSelectDocument: TreeViewSelectionHandler;
};

export type GitStatusForView = {
  // Watch-root-relative path of the changed file (forward slash separated, no
  // leading slash). Must match what the index reports for `relativePath`.
  relativePath: string;
  rootId: string;
  status: GitStatusEntry["status"];
};

export class TreeView {
  private readonly container: HTMLElement;
  private readonly onSelectDocument: TreeViewSelectionHandler;
  private readonly pathToDocumentId = new Map<string, string>();
  private readonly rootPrefixById = new Map<string, string>();
  private tree: FileTree | null = null;
  // Fingerprint of the last paths we sent to the library. The path set only
  // changes when the filesystem changes (files added / removed / renamed) —
  // selection changes leave it intact. Calling resetPaths is what wipes the
  // library's internal expansion state, so we want to do it only when needed.
  private lastPathsKey = "";
  // While true, the library's onSelectionChange callback is treated as an
  // echo of our own programmatic select/deselect calls and is NOT forwarded
  // to the routing flow. Used to guard `revealAndSelect`, which performs
  // multiple library operations in a row (deselect previous, expand
  // ancestors, select leaf) — each of which can fire the callback.
  private duringProgrammaticUpdate = false;

  constructor(options: TreeViewOptions) {
    this.container = options.container;
    this.onSelectDocument = options.onSelectDocument;
  }

  // Replace the visible tree with the given roots. Safe to call repeatedly;
  // the underlying `FileTree` instance is created lazily on the first call.
  update(roots: readonly RootGroup[], selectedDocumentId: string | null): void {
    const { paths, mapping, rootPrefix } = buildPathInputs(roots);
    this.pathToDocumentId.clear();
    for (const [path, id] of mapping) {
      this.pathToDocumentId.set(path, id);
    }
    this.rootPrefixById.clear();
    for (const [id, prefix] of rootPrefix) {
      this.rootPrefixById.set(id, prefix);
    }

    const initialSelectedPath =
      selectedDocumentId !== null ? this.pathForDocumentId(selectedDocumentId) : null;
    const initialReveal =
      initialSelectedPath !== null ? ancestorPaths(initialSelectedPath) : [];

    if (this.tree === null) {
      this.tree = new FileTree({
        paths,
        initialExpansion: "closed",
        // Reveal the ancestor folders of the initially-selected file so that
        // file is visible (and visibly selected) on first paint — matching
        // VS Code's Explorer reveal behavior on open.
        initialExpandedPaths: initialReveal,
        initialSelectedPaths: initialSelectedPath ? [initialSelectedPath] : [],
        icons: { set: "standard", colored: true },
        onSelectionChange: selected => this.handleSelectionChange(selected),
      });
      // Pass our container AS the file-tree host (not as a wrapper around a
      // fresh `<file-tree-container>` element). The library calls
      // attachShadow() on whatever we give it here — using our `#tree` div
      // directly means its height = our container's height, which is what
      // the library's virtualization needs to know how many rows to render.
      this.container.innerHTML = "";
      Object.assign(this.container.style, LIGHT_TREE_THEME);
      this.tree.render({ fileTreeContainer: this.container });
      this.lastPathsKey = pathsFingerprint(paths);
      return;
    }

    const nextKey = pathsFingerprint(paths);
    if (nextKey !== this.lastPathsKey) {
      // Filesystem changed. resetPaths wipes the library's expansion state,
      // so capture what's currently open and merge with the new reveal set
      // before resetting — additive reveal, never closes a user's choice.
      const preserved = this.readExpandedPaths();
      const mergedReveal = Array.from(new Set([...preserved, ...initialReveal]));
      this.tree.resetPaths(paths, { initialExpandedPaths: mergedReveal });
      this.lastPathsKey = nextKey;
    }

    if (initialSelectedPath !== null) {
      this.revealAndSelect(initialSelectedPath);
    }
  }

  // Push the latest review-load changed-files into the library's git-status API.
  // Empty input clears all annotations.
  setGitStatus(entries: readonly GitStatusForView[]): void {
    if (this.tree === null) {
      return;
    }
    const out: GitStatusEntry[] = [];
    for (const entry of entries) {
      const prefix = this.rootPrefixById.get(entry.rootId);
      if (prefix === undefined) {
        continue;
      }
      const path = `${prefix}${entry.relativePath.replace(/^\/+/, "")}`;
      out.push({ path, status: entry.status });
    }
    this.tree.setGitStatus(out);
  }

  // Sync the library's selection to a programmatic change (e.g. follow-mode
  // auto-switch). Reveals ancestor folders before selecting. Suppresses the
  // resulting onSelectionChange echo so we don't re-route into the same
  // document.
  syncSelectionToDocument(documentId: string | null): void {
    if (this.tree === null) {
      return;
    }
    if (documentId === null) {
      return;
    }
    const path = this.pathForDocumentId(documentId);
    if (path !== null) {
      this.revealAndSelect(path);
    }
  }

  dispose(): void {
    if (this.tree !== null) {
      this.tree.unmount();
      this.tree = null;
    }
    this.pathToDocumentId.clear();
    this.rootPrefixById.clear();
    this.lastPathsKey = "";
  }

  // Walk the ancestor chain of `path`, expanding each directory that isn't
  // already open. Deselect any currently-selected paths that aren't `path`
  // (the library supports multi-select, but uatu has exactly one active
  // document at a time). Then select the leaf. Expansion is additive —
  // we never collapse a directory the user opened.
  private revealAndSelect(path: string): void {
    if (this.tree === null) {
      return;
    }
    this.duringProgrammaticUpdate = true;
    try {
      for (const ancestor of ancestorPaths(path)) {
        const handle = this.tree.getItem(ancestor);
        if (handle && handle.isDirectory() && !handle.isExpanded()) {
          handle.expand();
        }
      }
      for (const previouslySelected of this.tree.getSelectedPaths()) {
        if (previouslySelected === path) continue;
        const handle = this.tree.getItem(previouslySelected);
        if (handle && handle.isSelected()) {
          handle.deselect();
        }
      }
      const leaf = this.tree.getItem(path);
      if (leaf && !leaf.isSelected()) {
        leaf.select();
      }
    } finally {
      this.duringProgrammaticUpdate = false;
    }
  }

  private handleSelectionChange(selected: readonly string[]): void {
    if (this.duringProgrammaticUpdate) {
      return;
    }
    const first = selected[0];
    if (!first) {
      return;
    }
    const documentId = this.pathToDocumentId.get(first);
    if (!documentId) {
      return;
    }
    this.onSelectDocument(documentId);
  }

  private pathForDocumentId(documentId: string): string | null {
    for (const [path, id] of this.pathToDocumentId) {
      if (id === documentId) {
        return path;
      }
    }
    return null;
  }

  // Read the library's current expansion state by probing every directory
  // path derived from our path list. Used before resetPaths so that a
  // filesystem-driven refresh preserves the user's open folders.
  private readExpandedPaths(): string[] {
    if (this.tree === null) {
      return [];
    }
    const expanded: string[] = [];
    for (const dirPath of distinctDirectoryPaths(this.pathToDocumentId.keys())) {
      const handle = this.tree.getItem(dirPath);
      if (handle && handle.isDirectory() && handle.isExpanded()) {
        expanded.push(dirPath);
      }
    }
    return expanded;
  }
}

// Translate one or more `RootGroup`s into the flat path array the library
// expects, plus the path→document-id mapping uatu needs to route selections.
//
// Single-root sessions feed paths verbatim (no synthetic top-level folder),
// so the tree opens with the project's actual files at the top — matching
// VS Code's single-folder workspace UX. Multi-root sessions prefix every
// path with the watched root's label so a single tree can host all roots
// without collisions. Exported only for unit testing.
export function buildPathInputs(roots: readonly RootGroup[]): {
  paths: string[];
  mapping: ReadonlyMap<string, string>;
  // rootPrefix[rootId] = "" (single-root) | "label/" (multi-root). Used by
  // setGitStatus to translate review-load paths into the tree's path space.
  rootPrefix: ReadonlyMap<string, string>;
} {
  const paths: string[] = [];
  const mapping = new Map<string, string>();
  const rootPrefix = new Map<string, string>();

  if (roots.length === 0) {
    return { paths, mapping, rootPrefix };
  }

  const useRootPrefix = roots.length > 1;
  const labelCounts = new Map<string, number>();

  for (const root of roots) {
    let prefix = "";
    if (useRootPrefix) {
      const baseLabel = root.label.trim() || "root";
      const seen = labelCounts.get(baseLabel) ?? 0;
      labelCounts.set(baseLabel, seen + 1);
      const label = seen === 0 ? baseLabel : `${baseLabel} (${seen + 1})`;
      prefix = `${label}/`;
    }
    rootPrefix.set(root.id, prefix);

    for (const doc of root.docs) {
      const path = `${prefix}${doc.relativePath.replace(/^\/+/, "")}`;
      paths.push(path);
      mapping.set(path, doc.id);
    }
  }

  return { paths, mapping, rootPrefix };
}

// Compute ancestor directory paths for a given leaf path, from outermost to
// innermost. `"a/b/c.md"` → `["a/", "a/b/"]`. The leaf itself is not
// included. The library canonicalizes directory paths with a trailing slash
// in its public API (e.g. `data-item-path="guides/"`); `getItem(...)` and
// `initialExpandedPaths` both expect that form. Exported for unit testing.
export function ancestorPaths(path: string): string[] {
  if (!path) return [];
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return [];
  const out: string[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    out.push(`${parts.slice(0, i).join("/")}/`);
  }
  return out;
}

// Cheap fingerprint that distinguishes "same files in the same order" from
// "any change to the path set". The library only needs us to call resetPaths
// when something actually changed.
function pathsFingerprint(paths: readonly string[]): string {
  return `${paths.length}|${paths.join("\n")}`;
}

// All distinct ancestor directory paths derived from a path list.
function distinctDirectoryPaths(paths: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const path of paths) {
    for (const ancestor of ancestorPaths(path)) {
      dirs.add(ancestor);
    }
  }
  return dirs;
}
