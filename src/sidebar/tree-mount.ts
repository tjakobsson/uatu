// Tree-view mounting and selection handler. Holds the lazily-constructed
// TreeView singleton and the click handler that translates a tree-row
// selection into the app's "navigate to document" flow. Extracted from
// `app.ts` so the sidebar feature folder owns the integration with the
// library-backed tree view.

import { applyStaleHint } from "../shell/stale-hint-mount";
import { findDocumentById } from "../shell/storage";
import { syncFollowToggle } from "../shell/follow";
import { loadDocument } from "../preview/mount";
import { pushSelection } from "../shell/history";
import { appState } from "../shell/state";
import { nextStaleHint } from "../shell/stale-hint";
import { TreeView } from "./tree-view";
import { renderSidebar } from "./shell";

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
      onSelectDocument: handleTreeSelectDocument,
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

export function handleTreeSelectDocument(documentId: string): void {
  appState.followEnabled = false;
  appState.selectedId = documentId;
  appState.previewMode = { kind: "document" };
  applyStaleHint(nextStaleHint(appState.staleHint, { kind: "manual-navigation" }));
  const doc = findDocumentById(documentId);
  if (doc) {
    pushSelection(documentId, doc.relativePath);
  }
  syncFollowToggle();
  renderSidebar();
  void loadDocument(documentId);
}
