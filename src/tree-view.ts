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

import type { DocumentMeta, RepositoryReviewSnapshot, RootGroup } from "./shared";

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

// Per-Mode filter membership computed in app.ts. Each entry maps a watched
// root's id to the set of watch-root-relative paths the chip should keep
// visible. Roots without an entry are treated as having an empty allow-set
// (their docs are filtered out entirely).
export type FilesPaneFilterMembership = {
  allowedByRoot: ReadonlyMap<string, ReadonlySet<string>>;
};

export type TreeViewUpdateOptions = {
  // When present, restricts the rendered path set to docs whose
  // watch-root-relative path is in the allow-list for their root (plus the
  // ancestor directories of those docs, auto-expanded). When null/undefined,
  // the tree renders the full path set unchanged.
  filter?: FilesPaneFilterMembership | null;
};

export class TreeView {
  private readonly container: HTMLElement;
  private readonly onSelectDocument: TreeViewSelectionHandler;
  private readonly pathToDocumentId = new Map<string, string>();
  private readonly rootPrefixById = new Map<string, string>();
  // Visible-leaf counts the library is currently rendering. Drives the
  // sidebar's `N of M files` chip count; under filter Changed, these reflect
  // the filtered subset (including the follow-override row if any).
  private renderedLeafCount = 0;
  private renderedBinaryLeafCount = 0;
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
  // Tracks the active filter kind so we can detect All↔Changed transitions
  // and snapshot/restore the user's full-tree expansion state across them.
  private lastFilterKind: "all" | "changed" = "all";
  // Snapshot of expanded directory paths captured the moment the user toggled
  // from All → Changed. Restored as `initialExpandedPaths` on the way back to
  // All, so manually-opened directories are not lost across a filter cycle.
  private fullTreeExpansionSnapshot: string[] | null = null;
  // Path currently included only because Follow asked for it (not because it
  // is in the change set). Cleared when the next update no longer needs the
  // override or when the filter is toggled off.
  private followOverridePath: string | null = null;
  // MutationObserver wired into the library's shadow root that stamps
  // `data-uatu-filter-reveal="true"` onto the follow-override row whenever
  // the library re-paints its virtualized row list. The library does not
  // expose a way to add arbitrary attributes via its decoration API, so we
  // do this from the outside. Connected only while `followOverridePath` is
  // non-null so we are not running a callback for every scroll/expand on
  // the common (no override) path.
  private followOverrideObserver: MutationObserver | null = null;
  // Style element injected into the shadow root so the reveal cue actually
  // renders — document-level stylesheets cannot pierce the library's open
  // shadow boundary, so a global rule in styles.css would be silently dead.
  private revealCueStyleElement: HTMLStyleElement | null = null;

  constructor(options: TreeViewOptions) {
    this.container = options.container;
    this.onSelectDocument = options.onSelectDocument;
  }

  // Replace the visible tree with the given roots. Safe to call repeatedly;
  // the underlying `FileTree` instance is created lazily on the first call.
  update(
    roots: readonly RootGroup[],
    selectedDocumentId: string | null,
    options?: TreeViewUpdateOptions,
  ): void {
    const { paths: fullPaths, mapping, rootPrefix } = buildPathInputs(roots);
    this.pathToDocumentId.clear();
    for (const [path, id] of mapping) {
      this.pathToDocumentId.set(path, id);
    }
    this.rootPrefixById.clear();
    for (const [id, prefix] of rootPrefix) {
      this.rootPrefixById.set(id, prefix);
    }

    const filter = options?.filter ?? null;
    const nextFilterKind: "all" | "changed" = filter !== null ? "changed" : "all";
    const previousFilterKind = this.lastFilterKind;

    const initialSelectedPath =
      selectedDocumentId !== null ? this.pathForDocumentId(selectedDocumentId) : null;
    const initialReveal =
      initialSelectedPath !== null ? ancestorPaths(initialSelectedPath) : [];

    // Compute the path set we'll hand to the library plus the auto-expand
    // list. Filter-on returns the reduced set; filter-off returns the full
    // set. The follow-override fold-in (selected path + ancestors when the
    // selection isn't in the filter set) is applied here so the library sees
    // a single coherent `resetPaths` call.
    let renderedPaths: string[];
    let autoExpanded: string[];
    let renderedLeafCount: number;
    let renderedBinaryLeafCount: number;
    let followOverridePath: string | null = null;

    if (filter !== null) {
      const reduced = computeFilteredPaths(roots, rootPrefix, filter);
      let leaves = new Set(reduced.paths);
      let ancestors = new Set(reduced.ancestors);

      if (initialSelectedPath !== null && !leaves.has(initialSelectedPath)) {
        // The active document is not in the change set — include it (and its
        // ancestors) so the "active doc is always visible" invariant holds.
        leaves.add(initialSelectedPath);
        for (const ancestor of ancestorPaths(initialSelectedPath)) {
          ancestors.add(ancestor);
        }
        followOverridePath = initialSelectedPath;
      }

      // Library infers directory entries from the leaf paths' separators —
      // only leaves go into `paths`; ancestors live in `initialExpandedPaths`.
      renderedPaths = [...leaves];
      autoExpanded = [...ancestors];
      // Count leaves in the reduced set excluding directory entries; for the
      // chip's "N of M files" display, also count the follow-override path
      // (it's visible, so the user expects it to count).
      const docsByPath = collectDocByPath(roots, rootPrefix);
      renderedLeafCount = 0;
      renderedBinaryLeafCount = 0;
      for (const leaf of leaves) {
        const doc = docsByPath.get(leaf);
        if (!doc) continue;
        renderedLeafCount += 1;
        if (doc.kind === "binary") renderedBinaryLeafCount += 1;
      }
    } else {
      renderedPaths = fullPaths;
      autoExpanded = initialReveal;
      renderedLeafCount = fullPaths.length;
      renderedBinaryLeafCount = countBinaryLeaves(roots);
    }

    // Filter-state transition: snapshot expanded paths on All→Changed,
    // restore them on Changed→All. The snapshot survives until the next
    // All→Changed transition.
    const reconciled = reconcileFilterExpansion({
      previousFilterKind,
      nextFilterKind,
      autoExpanded,
      currentlyExpanded:
        previousFilterKind === "all" && nextFilterKind === "changed" && this.tree !== null
          ? this.readExpandedPaths()
          : null,
      storedSnapshot: this.fullTreeExpansionSnapshot,
    });
    autoExpanded = reconciled.initialExpandedPaths;
    this.fullTreeExpansionSnapshot = reconciled.nextSnapshot;

    this.lastFilterKind = nextFilterKind;
    this.followOverridePath = followOverridePath;
    this.renderedLeafCount = renderedLeafCount;
    this.renderedBinaryLeafCount = renderedBinaryLeafCount;

    if (this.tree === null) {
      this.tree = new FileTree({
        paths: renderedPaths,
        initialExpansion: "closed",
        initialExpandedPaths: autoExpanded,
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
      this.lastPathsKey = pathsFingerprint(renderedPaths);
      this.ensureRevealCueStyleElement();
      this.syncFollowOverrideObserver();
      this.applyFollowOverrideAttribute();
      if (initialSelectedPath !== null) {
        this.revealAndSelect(initialSelectedPath);
      }
      // Backstop the synchronous attribute stamp — the library may render
      // the override row on the next frame after first mount.
      if (this.followOverridePath !== null) {
        requestAnimationFrame(() => this.applyFollowOverrideAttribute());
      }
      return;
    }

    const nextKey = pathsFingerprint(renderedPaths);
    if (
      nextKey !== this.lastPathsKey
      || previousFilterKind !== nextFilterKind
    ) {
      // Filesystem changed OR filter transitioned. resetPaths wipes the
      // library's expansion state, so merge any preserved-open dirs (under
      // All) with the new reveal set before resetting.
      const preserved = nextFilterKind === "all" ? this.readExpandedPaths() : [];
      const mergedReveal = mergeUnique(autoExpanded, preserved);
      this.tree.resetPaths(renderedPaths, { initialExpandedPaths: mergedReveal });
      this.lastPathsKey = nextKey;
    }

    this.ensureRevealCueStyleElement();
    this.syncFollowOverrideObserver();
    this.applyFollowOverrideAttribute();

    if (initialSelectedPath !== null) {
      this.revealAndSelect(initialSelectedPath);
    }

    // revealAndSelect and resetPaths drive library re-renders that may not
    // be in the DOM yet by the time the synchronous applyFollowOverrideAttribute
    // above runs. Re-apply on the next frame as a backstop — the
    // MutationObserver should also catch the row insertion, but Playwright
    // sometimes polls the row before the observer microtask fires.
    if (this.followOverridePath !== null) {
      requestAnimationFrame(() => this.applyFollowOverrideAttribute());
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

  // Number of leaf paths the library is currently rendering. Used by the
  // sidebar's `N of M files` count under the Changed filter; matches the
  // visible-row total seen by the user (follow-override row included).
  getVisibleLeafCount(): number {
    return this.renderedLeafCount;
  }

  // Number of currently-rendered leaf paths whose underlying doc is binary.
  // Under filter, this is the binary subcount within the visible set — NOT
  // the total binary count across the watched roots.
  getVisibleBinaryLeafCount(): number {
    return this.renderedBinaryLeafCount;
  }

  dispose(): void {
    if (this.followOverrideObserver !== null) {
      this.followOverrideObserver.disconnect();
      this.followOverrideObserver = null;
    }
    // The style element lives inside the library's shadow root, which the
    // unmount call below tears down — so we just drop our reference here.
    this.revealCueStyleElement = null;
    if (this.tree !== null) {
      this.tree.unmount();
      this.tree = null;
    }
    this.pathToDocumentId.clear();
    this.rootPrefixById.clear();
    this.renderedLeafCount = 0;
    this.renderedBinaryLeafCount = 0;
    this.lastPathsKey = "";
    this.lastFilterKind = "all";
    this.fullTreeExpansionSnapshot = null;
    this.followOverridePath = null;
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

  // The library re-renders its virtualized rows on every scroll/expand/etc.,
  // and we don't get a hook into row creation. A MutationObserver inside its
  // shadow root catches row insertions/recycle so we can keep the reveal
  // attribute on the follow-override row.
  //
  // Connected on demand — only while `followOverridePath` is non-null — so
  // the common no-override case doesn't run a callback on every scroll.
  private syncFollowOverrideObserver(): void {
    if (this.followOverridePath === null) {
      if (this.followOverrideObserver !== null) {
        this.followOverrideObserver.disconnect();
        this.followOverrideObserver = null;
      }
      return;
    }
    if (this.followOverrideObserver !== null || this.tree === null) {
      return;
    }
    const shadow = this.container.shadowRoot;
    if (!shadow) {
      return;
    }
    this.followOverrideObserver = new MutationObserver(() => {
      this.applyFollowOverrideAttribute();
    });
    // The library virtualizes rows — re-painting a row often updates its
    // `data-item-path` attribute on an existing DOM node instead of inserting
    // a fresh element. Observe attribute mutations as well as childList so
    // the reveal attribute follows the override path across recycle.
    this.followOverrideObserver.observe(shadow, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-item-path"],
    });
  }

  // Inject the reveal-cue CSS rule directly into the library's shadow root.
  // Document-level stylesheets cannot reach across the shadow boundary, so a
  // matching rule in styles.css would never apply. Idempotent — calling it
  // repeatedly is cheap.
  private ensureRevealCueStyleElement(): void {
    if (this.revealCueStyleElement !== null) {
      return;
    }
    const shadow = this.container.shadowRoot;
    if (!shadow) {
      return;
    }
    const style = document.createElement("style");
    style.setAttribute("data-uatu-style", "filter-reveal-cue");
    style.textContent = `[data-uatu-filter-reveal="true"] { opacity: 0.55; font-style: italic; }`;
    shadow.appendChild(style);
    this.revealCueStyleElement = style;
  }

  // Stamp `data-uatu-filter-reveal="true"` on every row currently mounted for
  // the follow-override path; clear the attribute from any other row that
  // still carries it (handles the case where the override path changed).
  private applyFollowOverrideAttribute(): void {
    const shadow = this.container.shadowRoot;
    if (!shadow) {
      return;
    }
    const previouslyMarked = shadow.querySelectorAll<HTMLElement>(
      "[data-uatu-filter-reveal='true']",
    );
    for (const el of previouslyMarked) {
      const path = el.getAttribute("data-item-path");
      if (path !== this.followOverridePath) {
        el.removeAttribute("data-uatu-filter-reveal");
      }
    }
    if (this.followOverridePath === null) {
      return;
    }
    const selector = `[data-item-path="${escapeAttributeValue(this.followOverridePath)}"]`;
    const matches = shadow.querySelectorAll<HTMLElement>(selector);
    for (const el of matches) {
      if (el.getAttribute("data-uatu-filter-reveal") !== "true") {
        el.setAttribute("data-uatu-filter-reveal", "true");
      }
    }
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

// Build the per-Mode filter membership from review-load. Sourced from the
// union of `changedFiles` and `ignoredFiles` — the same set the row
// annotations source from after `harmonize-untracked-presentation`. Files in
// `gitIgnoredFiles` are NOT included by design (ambient git policy, not
// change content). Exported for unit testing.
export function computeFilesPaneFilterMembership(
  repos: readonly RepositoryReviewSnapshot[],
): FilesPaneFilterMembership {
  const allowedByRoot = new Map<string, Set<string>>();
  for (const repo of repos) {
    if (repo.reviewLoad.status !== "available") {
      continue;
    }
    const pathSet = new Set<string>();
    // Normalise leading slashes for symmetry with `computeFilteredPaths`,
    // which strips them off `doc.relativePath` before comparing. Without
    // matching normalisation here, a stray leading slash from upstream
    // would silently miss the allow-list.
    for (const entry of repo.reviewLoad.changedFiles) {
      pathSet.add(entry.path.replace(/^\/+/, ""));
    }
    for (const entry of repo.reviewLoad.ignoredFiles) {
      pathSet.add(entry.path.replace(/^\/+/, ""));
    }
    for (const rootId of repo.watchedRootIds) {
      const existing = allowedByRoot.get(rootId);
      if (existing) {
        for (const p of pathSet) existing.add(p);
      } else {
        allowedByRoot.set(rootId, new Set(pathSet));
      }
    }
  }
  return { allowedByRoot };
}

// Reduce the per-root doc list to the leaves whose watch-root-relative path
// is in the per-root allow-list, then add every ancestor directory of each
// surviving leaf. Returns leaves (prefixed) and ancestors (prefixed) so the
// caller can wire them into both `paths` and `initialExpandedPaths`.
// Exported for unit testing.
export function computeFilteredPaths(
  roots: readonly RootGroup[],
  rootPrefix: ReadonlyMap<string, string>,
  filter: FilesPaneFilterMembership,
): { paths: string[]; ancestors: string[] } {
  const paths: string[] = [];
  const ancestorsSet = new Set<string>();
  for (const root of roots) {
    const allowed = filter.allowedByRoot.get(root.id);
    if (!allowed || allowed.size === 0) {
      continue;
    }
    const prefix = rootPrefix.get(root.id) ?? "";
    for (const doc of root.docs) {
      const normalized = doc.relativePath.replace(/^\/+/, "");
      if (!allowed.has(normalized)) {
        continue;
      }
      const prefixed = `${prefix}${normalized}`;
      paths.push(prefixed);
      for (const ancestor of ancestorPaths(prefixed)) {
        ancestorsSet.add(ancestor);
      }
    }
  }
  return { paths, ancestors: [...ancestorsSet] };
}

// Index documents by their prefixed path for O(1) lookup when counting
// filter-visible binaries. Single pass over `roots`; cheap relative to a
// linear search per filtered leaf.
function collectDocByPath(
  roots: readonly RootGroup[],
  rootPrefix: ReadonlyMap<string, string>,
): Map<string, DocumentMeta> {
  const out = new Map<string, DocumentMeta>();
  for (const root of roots) {
    const prefix = rootPrefix.get(root.id) ?? "";
    for (const doc of root.docs) {
      const normalized = doc.relativePath.replace(/^\/+/, "");
      out.set(`${prefix}${normalized}`, doc);
    }
  }
  return out;
}

function countBinaryLeaves(roots: readonly RootGroup[]): number {
  let count = 0;
  for (const root of roots) {
    for (const doc of root.docs) {
      if (doc.kind === "binary") count += 1;
    }
  }
  return count;
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

// Merge two string arrays into a new array containing each value once, in
// the order it first appears. Used to combine auto-expand reveal sets with
// preserved expansion snapshots without losing ordering or duplicating work.
function mergeUnique(a: readonly string[], b: readonly string[]): string[] {
  return Array.from(new Set([...a, ...b]));
}

// Snapshot/restore of the full-tree expansion state across filter toggles.
// All → Changed snapshots whatever directories the user has manually opened.
// Changed → All restores that snapshot as `initialExpandedPaths`. Same-kind
// transitions are pass-throughs (auto-expanded set is fed back unchanged).
// Pure helper extracted from the class for unit testing.
export function reconcileFilterExpansion(input: {
  previousFilterKind: "all" | "changed";
  nextFilterKind: "all" | "changed";
  autoExpanded: readonly string[];
  // Snapshot of `readExpandedPaths()` taken right before this transition.
  // Only consulted on the All → Changed edge; callers may pass `null` when
  // not on that edge.
  currentlyExpanded: readonly string[] | null;
  storedSnapshot: readonly string[] | null;
}): { initialExpandedPaths: string[]; nextSnapshot: string[] | null } {
  if (input.previousFilterKind === "all" && input.nextFilterKind === "changed") {
    return {
      initialExpandedPaths: [...input.autoExpanded],
      nextSnapshot: input.currentlyExpanded !== null ? [...input.currentlyExpanded] : null,
    };
  }
  if (input.previousFilterKind === "changed" && input.nextFilterKind === "all") {
    if (input.storedSnapshot !== null) {
      return {
        initialExpandedPaths: mergeUnique(input.autoExpanded, input.storedSnapshot),
        nextSnapshot: null,
      };
    }
    return { initialExpandedPaths: [...input.autoExpanded], nextSnapshot: null };
  }
  return {
    initialExpandedPaths: [...input.autoExpanded],
    nextSnapshot: input.storedSnapshot !== null ? [...input.storedSnapshot] : null,
  };
}

// Escape for use inside a CSS attribute selector value (`[attr="..."]`).
// Only `"` and `\` are special inside a quoted attribute value; `/` and `.`
// are literal characters there (CSS.escape over-escapes them, which works
// in some engines but trips Playwright's underlying selector parser).
function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
