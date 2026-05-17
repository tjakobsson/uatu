// Selection Inspector singleton — owns the lone `SelectionInspector` instance
// that ties the preview's text selection to the sidebar's Selection
// Inspector pane. Extracted from `app.ts` so other modules can call
// `recomputeSelectionInspector()` without going through the entry point
// (which now has zero exports so Bun treats it as a pure entry, not a
// lazy library module).
//
// The module queries `#preview` once at load and throws if missing, mirroring
// the pattern used by `shell/connection.ts` and the rest of the shell DOM
// owners.

import { createSelectionInspector, type SelectionInspector } from "../sidebar/selection-inspector";
import { renderSelectionInspector } from "../sidebar/selection-inspector-mount";
import { activeDocumentPath, isPreviewSourceView } from "./storage";

const previewElementMaybe = document.querySelector<HTMLElement>("#preview");

if (!previewElementMaybe) {
  throw new Error("uatu UI failed to initialize (shell/inspector-instance)");
}

// Locally-scoped non-null alias. TypeScript's narrowing from the
// throw-if-null guard above doesn't survive into function bodies (the
// hoisted function declarations sit outside the if-block's control-flow
// scope), so we re-alias to `T` here.
const previewElement: HTMLElement = previewElementMaybe;

export const selectionInspector: SelectionInspector = createSelectionInspector({
  previewElement,
  getActiveDocumentPath: activeDocumentPath,
  isSourceView: () => isPreviewSourceView(),
});

selectionInspector.subscribe(renderSelectionInspector);

export function recomputeSelectionInspector(): void {
  selectionInspector.recompute();
}
