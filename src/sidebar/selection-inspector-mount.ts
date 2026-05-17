// Selection Inspector pane mounting — translates the library's
// `InspectorPaneState` notifications into DOM updates inside the
// "Selection Inspector" pane on the sidebar. The actual inspector
// behavior (capture, formatting) lives in `src/selection-inspector.ts`;
// this file only owns the pane's HTML chrome.

import { copyToClipboard, showCopyConfirmation } from "../preview/code-block";
import { applyViewMode } from "../preview/view-mode";
import { formatReference, type PaneState as InspectorPaneState, type SelectionInspector } from "./selection-inspector";

const selectionInspectorEmptyElementMaybe = document.querySelector<HTMLElement>(
  "[data-selection-inspector-empty]",
);
const selectionInspectorControlElementMaybe = document.querySelector<HTMLButtonElement>(
  "[data-selection-inspector-control]",
);

if (!selectionInspectorEmptyElementMaybe || !selectionInspectorControlElementMaybe) {
  throw new Error("uatu UI failed to initialize (sidebar/selection-inspector-mount)");
}

const selectionInspectorEmptyElement: HTMLElement = selectionInspectorEmptyElementMaybe;
const selectionInspectorControlElement: HTMLButtonElement = selectionInspectorControlElementMaybe;

export function renderSelectionInspector(state: InspectorPaneState): void {
  if (state.kind === "placeholder") {
    selectionInspectorEmptyElement.hidden = false;
    selectionInspectorControlElement.hidden = true;
    selectionInspectorControlElement.textContent = "";
    selectionInspectorControlElement.dataset.state = "placeholder";
    selectionInspectorControlElement.removeAttribute("title");
    return;
  }

  selectionInspectorEmptyElement.hidden = true;
  selectionInspectorControlElement.hidden = false;

  if (state.kind === "hint") {
    selectionInspectorControlElement.dataset.state = "hint";
    selectionInspectorControlElement.textContent =
      "Switch to Source view to capture a line range.";
    selectionInspectorControlElement.title =
      "Click to flip the preview to Source view, where line ranges can be captured.";
    return;
  }

  // state.kind === "reference"
  const label = formatReference(state.record);
  selectionInspectorControlElement.dataset.state = "reference";
  selectionInspectorControlElement.textContent = label;
  selectionInspectorControlElement.title = `Click to copy ${label} to the clipboard.`;
}

export function initSelectionInspectorControl(selectionInspector: SelectionInspector): void {
  selectionInspectorControlElement.addEventListener("click", event => {
    event.preventDefault();
    const state = selectionInspector.current();
    if (state.kind === "hint") {
      applyViewMode("source");
      return;
    }
    if (state.kind === "reference") {
      void copyToClipboard(formatReference(state.record)).then(() => {
        showCopyConfirmation();
      });
    }
  });
}
