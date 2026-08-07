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
import { setPreviewMode, setSelectedId } from "./selection";
import { persistPersonalWorkspaceState } from "./personal-state";
import { revealPreviewSurface } from "./tab-bar";

export { chooseSelectionForFileEvent };

const followToggleElementMaybe = document.querySelector<HTMLButtonElement>("#follow-toggle");

if (!followToggleElementMaybe) {
  throw new Error("uatu UI failed to initialize (shell/follow)");
}

const followToggleElement: HTMLButtonElement = followToggleElementMaybe;

// Collapsed-rail presentation of the same toggle. Chip and rail icon are
// mutually exclusive (the rail renders only while the sidebar is collapsed),
// so `followEnabled` keeps a single visible representation at any moment.
const railFollowToggleElement = document.querySelector<HTMLButtonElement>("#rail-follow-toggle");

export function initFollowToggle(): void {
  followToggleElement.addEventListener("click", () => {
    applyChipClick();
  });
  railFollowToggleElement?.addEventListener("click", () => {
    applyChipClick();
  });
}

// Owner mutator for `appState.followEnabled`. The four follow-mode rules in
// this module flip it; boot / URL routing / navigation call sites use this
// instead of assigning directly (module-structure appState field ownership).
export function setFollowEnabled(next: boolean): void {
  appState.followEnabled = next;
  persistPersonalWorkspaceState({ follow: next });
}

// Rule B: user clicks the Follow chip. Flip `followEnabled`. When flipping
// false → true, "catch up" to the latest changed file so the user sees
// something happen immediately instead of waiting for the next watcher event.
export function applyChipClick(): void {
  if (appState.scope.kind === "file") {
    return;
  }
  const wasEnabled = appState.followEnabled;
  setFollowEnabled(!wasEnabled);
  syncFollowToggle();

  if (!wasEnabled && appState.followEnabled) {
    const jumpTo = selectionForChipTurnOn(appState.roots, appState.selectedId);
    if (jumpTo) {
      setSelectedId(jumpTo);
      setPreviewMode({ kind: "document" });
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
//
// Every Rule A entry point (tree row, search result) is a user asking to
// READ this document, so the touch Preview surface comes forward here — the
// one chokepoint — rather than in each caller. Doing it before the load
// also means the reveal logic downstream (search's match jump) measures a
// visible surface.
export function applyUserRowClick(documentId: string): Promise<void> {
  revealPreviewSurface();
  setFollowEnabled(false);
  setSelectedId(documentId);
  setPreviewMode({ kind: "document" });
  applyStaleHint(nextStaleHint(appState.staleHint, { kind: "manual-navigation" }));
  const doc = findDocumentById(documentId);
  if (doc) {
    pushSelection(documentId, doc.relativePath);
  }
  syncFollowToggle();
  renderSidebar();
  // Returns the load so callers that need to act on the mounted document —
  // project search jumping to a match — can await it. Callers that don't
  // simply ignore it, as the tree's selection handler does.
  return loadDocument(documentId);
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
  if (railFollowToggleElement) {
    railFollowToggleElement.setAttribute("aria-pressed", String(pressed));
    railFollowToggleElement.disabled = pinned;
    railFollowToggleElement.title = followToggleElement.title;
  }
}
