// Follow-mode capability — owns the four behavioral rules linking Follow,
// selection, and file events, plus the chip element wiring.
//
// Rule A (user clicks a tree row) → applyUserRowClick
// Rule B (user clicks the chip)  → applyChipClick
// Rule C/D (file event)          → see `chooseSelectionForFileEvent` below;
//                                   wired into the SSE handler in events.ts.
//
// See openspec/specs/follow-mode/spec.md for the full contract.

import { applyStaleHint } from "./stale-hint-mount";
import { chooseSelectionForFileEvent, selectionForChipTurnOn } from "./follow-rules";
import { findDocumentById } from "./storage";
import { loadDocument } from "../preview/mount";
import { nextStaleHint } from "./stale-hint";
import { renderSidebar } from "../sidebar/shell";
import { pushSelection } from "./history";
import { appState } from "./state";

export { chooseSelectionForFileEvent };

const followToggleElementMaybe = document.querySelector<HTMLButtonElement>("#follow-toggle");

if (!followToggleElementMaybe) {
  throw new Error("uatu UI failed to initialize (shell/follow)");
}

const followToggleElement: HTMLButtonElement = followToggleElementMaybe;

export function initFollowToggle(): void {
  followToggleElement.addEventListener("click", () => {
    applyChipClick();
  });
}

// Rule B: user clicks the Follow chip. Flip `followEnabled`. When flipping
// false → true, "catch up" to the latest changed file so the user sees
// something happen immediately instead of waiting for the next watcher event.
export function applyChipClick(): void {
  if (appState.scope.kind === "file") {
    return;
  }
  const wasEnabled = appState.followEnabled;
  appState.followEnabled = !wasEnabled;
  syncFollowToggle();

  if (!wasEnabled && appState.followEnabled) {
    const jumpTo = selectionForChipTurnOn(appState.roots, appState.selectedId);
    if (jumpTo) {
      appState.selectedId = jumpTo;
      appState.previewMode = { kind: "document" };
      const latestDoc = findDocumentById(jumpTo);
      if (latestDoc) {
        pushSelection(jumpTo, latestDoc.relativePath);
      }
      renderSidebar();
      void loadDocument(jumpTo);
    }
  }
}

// Rule A: user clicks a tree row. Selection moves; follow turns off. Only
// fires for genuine user clicks — programmatic / library-mount callbacks are
// suppressed at the TreeView's `duringProgrammaticUpdate` guard, so this
// function does NOT need to re-check origin.
export function applyUserRowClick(documentId: string): void {
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


export function syncFollowToggle(): void {
  // Single-file scope (`uatu watch some-file.md`) is the only remaining
  // reason to render the toggle as disabled — there's nothing to follow
  // when the session is scoped to one file.
  const pinned = appState.scope.kind === "file";
  const pressed = appState.followEnabled && !pinned;
  followToggleElement.hidden = false;
  followToggleElement.setAttribute("aria-pressed", String(pressed));
  followToggleElement.disabled = pinned;
  followToggleElement.title = pinned
    ? "Single-file session — no other files to follow"
    : pressed
      ? "Follow the latest changed document"
      : "Click to follow the latest changed document";
}
