// Tree-view mounting. Holds the lazily-constructed TreeView singleton; the
// selection handler delegates to the `follow-mode` capability (Rule A).

import { applyUserRowClick } from "../shell/follow";
import { TreeView } from "./tree-view";

const treeElementMaybe = document.querySelector<HTMLDivElement>("#tree");

if (!treeElementMaybe) {
  throw new Error("uatu UI failed to initialize (sidebar/tree-mount)");
}

const treeElement: HTMLDivElement = treeElementMaybe;

// The library-backed tree view. Created lazily on first non-empty render so
// teardowns when the watched roots become empty don't leak a hidden instance.
let treeView: TreeView | null = null;

export function ensureTreeView(): TreeView {
  if (treeView === null) {
    treeView = new TreeView({
      container: treeElement,
      // Real user clicks only (the withProgrammaticUpdate guard suppresses
      // library-fired callbacks). Rule A itself brings the touch Preview
      // surface forward, so a pick lands on the Preview tab — but follow-
      // driven and file-event tree updates can never steal the active tab.
      // Directory taps don't reach this handler at all.
      onSelectDocument: documentId => applyUserRowClick(documentId),
    });
  }
  return treeView;
}

export function disposeTreeView(): void {
  if (treeView !== null) {
    treeView.dispose();
    treeView = null;
  }
}
