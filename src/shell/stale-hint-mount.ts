// Stale-content hint chrome — historically used in Review mode to surface
// disk-change hints. With Modes removed, no code path sets a non-null hint
// (callers that still pass through `nextStaleHint` with `manual-navigation`
// or `refresh-action` events always resolve to `null`), so the chrome
// stays hidden in normal operation. The DOM elements and the click handler
// remain so a future change can re-introduce a freeze-while-reading
// affordance without rebuilding the chrome from scratch.

import { forgetDocumentCache, loadDocument } from "../preview/mount";
import { renderSidebar } from "../sidebar/shell";
import { renderEmptyPreview } from "../preview/empty";
import { nextStaleHint, type StaleHint } from "./stale-hint";
import { appState } from "./state";
import { setPreviewMode, setSelectedId } from "./selection";

const staleHintElementMaybe = document.querySelector<HTMLDivElement>("#stale-hint");
const staleHintMessageElementMaybe = document.querySelector<HTMLElement>("#stale-hint-message");
const staleHintActionElementMaybe = document.querySelector<HTMLButtonElement>("#stale-hint-action");

if (!staleHintElementMaybe || !staleHintMessageElementMaybe || !staleHintActionElementMaybe) {
  throw new Error("uatu UI failed to initialize (shell/stale-hint-mount)");
}

const staleHintElement: HTMLDivElement = staleHintElementMaybe;
const staleHintMessageElement: HTMLElement = staleHintMessageElementMaybe;
const staleHintActionElement: HTMLButtonElement = staleHintActionElementMaybe;

export function applyStaleHint(next: StaleHint | null) {
  appState.staleHint = next;
  syncStaleHint();
}

export function syncStaleHint() {
  const hint = appState.staleHint;
  if (!hint) {
    staleHintElement.hidden = true;
    staleHintElement.classList.remove("is-changed", "is-deleted");
    return;
  }
  staleHintElement.hidden = false;
  staleHintElement.classList.toggle("is-changed", hint.kind === "changed");
  staleHintElement.classList.toggle("is-deleted", hint.kind === "deleted");
  if (hint.kind === "deleted") {
    staleHintMessageElement.textContent = "This file no longer exists on disk.";
    staleHintActionElement.textContent = "Close";
    staleHintActionElement.setAttribute("aria-label", "Close stale preview and return to default");
    staleHintActionElement.title = "Close this preview";
  } else {
    staleHintMessageElement.textContent = "This file has changed on disk.";
    staleHintActionElement.textContent = "Refresh";
    staleHintActionElement.setAttribute("aria-label", "Refresh the active preview to current on-disk content");
    staleHintActionElement.title = "Refresh to load current on-disk content";
  }
}

export function initStaleHintActionHandler(): void {
  staleHintActionElement.addEventListener("click", () => {
    const hint = appState.staleHint;
    if (!hint) {
      return;
    }
    if (hint.kind === "deleted") {
      // Close: clear the preview and the hint. Switch to the empty state since
      // there's no on-disk content to render.
      applyStaleHint(nextStaleHint(hint, { kind: "refresh-action" }));
      setSelectedId(null);
      setPreviewMode({ kind: "empty" });
      renderSidebar();
      renderEmptyPreview("File no longer on disk", "The file you were viewing has been deleted.");
      return;
    }
    // Changed: re-render the active preview to the latest content for the same file.
    applyStaleHint(nextStaleHint(hint, { kind: "refresh-action" }));
    if (appState.selectedId) {
      // The on-disk content is what triggered this hint — any cached payload
      // for the active doc is stale. Drop it so loadDocument refetches.
      forgetDocumentCache(appState.selectedId);
      void loadDocument(appState.selectedId);
    }
  });
}
