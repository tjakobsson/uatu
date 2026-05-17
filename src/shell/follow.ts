// Follow-mode chip — Author's "auto-switch to the latest changed document"
// affordance. The chip is hidden in Review (which contracts away from
// auto-switching entirely), greyed when the scope is pinned to a file,
// and pressed/unpressed in Author depending on the current preference.
// Extracted from `app.ts` so the shell module folder owns the chip's
// view-state alongside Mode.

import { defaultDocumentId } from "../shared/types";
import { findDocumentById } from "./storage";
import { loadDocument } from "../preview/mount";
import { renderSidebar } from "../sidebar/shell";
import { pushSelection } from "./history";
import { appState } from "./state";

const followToggleElementMaybe = document.querySelector<HTMLButtonElement>("#follow-toggle");

if (!followToggleElementMaybe) {
  throw new Error("uatu UI failed to initialize (shell/follow)");
}

const followToggleElement: HTMLButtonElement = followToggleElementMaybe;

export function initFollowToggle(): void {
  followToggleElement.addEventListener("click", () => {
    if (appState.scope.kind === "file") {
      return;
    }
    const wasEnabled = appState.followEnabled;
    appState.followEnabled = !wasEnabled;
    syncFollowToggle();

    // Enabling follow should "catch up" to the latest changed file rather than
    // wait for the next change event — otherwise the user clicks Follow and
    // nothing visible happens until a file is touched.
    if (!wasEnabled && appState.followEnabled) {
      const latestId = defaultDocumentId(appState.roots);
      if (latestId && latestId !== appState.selectedId) {
        appState.selectedId = latestId;
        appState.previewMode = { kind: "document" };
        const latestDoc = findDocumentById(latestId);
        if (latestDoc) {
          pushSelection(latestId, latestDoc.relativePath);
        }
        renderSidebar();
        void loadDocument(latestId);
      }
    }
  });
}

export function syncFollowToggle() {
  const label = followToggleElement.querySelector<HTMLElement>(".chip-label");
  if (label) {
    label.textContent = "Follow";
  }

  const pinned = appState.scope.kind === "file";
  const reviewMode = appState.mode === "review";
  // Review mode does not auto-follow by contract — there is no scenario in
  // which the chip is interactive in Review, so hide it entirely rather than
  // showing a disabled control. Pinned still renders the chip (greyed) since
  // the user can resolve that state from elsewhere.
  followToggleElement.hidden = reviewMode;
  const pressed = appState.followEnabled && !pinned && !reviewMode;
  followToggleElement.setAttribute("aria-pressed", String(pressed));
  followToggleElement.classList.toggle("is-active", pressed);
  followToggleElement.classList.toggle("is-mode-disabled", reviewMode);
  followToggleElement.disabled = pinned || reviewMode;
  followToggleElement.title = reviewMode
    ? "Follow is unavailable in Review mode"
    : pinned
      ? "Unpin to re-enable follow mode"
      : pressed
        ? "Follow the latest changed document"
        : "Click to follow the latest changed document";
}
