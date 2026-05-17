// Author / Review mode switching. Owns the mode-control radio chrome,
// the mode-change side effects (pane state reload, Follow snapshot/restore,
// stale-hint resolution), and the resolved review-base label used by
// other surfaces. Extracted from `app.ts` so the shell-level Mode posture
// lives next to the other shell modules.

import { renderEmptyPreview } from "../preview/empty";
import { forgetDocumentCache, loadDocument } from "../preview/mount";
import { syncFilesPaneFilterControl } from "../sidebar/files-filter";
import {
  persistPaneState,
  schedulePaneHeightNormalization,
} from "../sidebar/panes";
import { renderSidebar } from "../sidebar/shell";
import { writeModePreference, type Mode } from "../shared/types";
import { nextStaleHint } from "./stale-hint";
import { syncFollowToggle } from "./follow";
import {
  appState,
  readFilesPaneFilterPreference,
  readPaneState,
  safeLocalStorage,
} from "./state";
import { applyStaleHint } from "./stale-hint-mount";

const modeAuthorButtonMaybe = document.querySelector<HTMLButtonElement>("#mode-author");
const modeReviewButtonMaybe = document.querySelector<HTMLButtonElement>("#mode-review");
const previewShellElementMaybe = document.querySelector<HTMLElement>(".preview-shell");

if (!modeAuthorButtonMaybe || !modeReviewButtonMaybe || !previewShellElementMaybe) {
  throw new Error("uatu UI failed to initialize (shell/mode)");
}

const modeAuthorButton: HTMLButtonElement = modeAuthorButtonMaybe;
const modeReviewButton: HTMLButtonElement = modeReviewButtonMaybe;
const previewShellElement: HTMLElement = previewShellElementMaybe;

export function syncModeControl() {
  const isAuthor = appState.mode === "author";
  modeAuthorButton.setAttribute("aria-checked", String(isAuthor));
  modeAuthorButton.classList.toggle("is-active", isAuthor);
  modeReviewButton.setAttribute("aria-checked", String(!isAuthor));
  modeReviewButton.classList.toggle("is-active", !isAuthor);

  // Body / preview-shell classes drive the Mode-aware preview chrome.
  document.body.classList.toggle("is-mode-author", isAuthor);
  document.body.classList.toggle("is-mode-review", !isAuthor);
  previewShellElement.classList.toggle("is-mode-review", !isAuthor);
}

export function applyMode(next: Mode) {
  if (appState.mode === next) {
    return;
  }
  const previous = appState.mode;
  // Persist the OUTGOING mode's pane state before swapping, so user-driven
  // pane changes that haven't been written yet aren't lost on mode switch.
  persistPaneState(previous);
  appState.mode = next;
  writeModePreference(safeLocalStorage(), next);
  // Each mode keeps its own pane state — visibility, collapse, height — so
  // flipping the toggle restores the layout the user left in that mode.
  appState.panes = readPaneState(next);
  // Same per-Mode treatment for the Files-pane filter chip: switching Modes
  // restores whatever filter state the destination Mode last had (defaults
  // when never set).
  appState.filesPaneFilter = readFilesPaneFilterPreference(next);

  // Author <-> Review round-trip: snapshot Author's Follow choice on the way
  // out, restore it on the way back. Review must force Follow off (the
  // "no auto-switching" contract); without the snapshot, the user would
  // have to re-enable Follow every time they peek into Review and back.
  if (previous === "author" && next === "review") {
    appState.authorFollowPreference = appState.followEnabled;
    appState.followEnabled = false;
  } else if (previous === "review" && next === "author") {
    appState.followEnabled = appState.authorFollowPreference;
  }

  // Mode change clears any visible hint. When switching from Review (with a
  // hint pointed at the active doc) to Author, resolve the staleness eagerly
  // so the user doesn't briefly see dead content waiting for the next SSE.
  const activeHint =
    previous === "review" && appState.staleHint?.documentId === appState.selectedId
      ? appState.staleHint
      : null;

  applyStaleHint(nextStaleHint(appState.staleHint, { kind: "mode-changed", nextMode: next }));

  syncModeControl();
  syncFilesPaneFilterControl();
  syncFollowToggle();
  renderSidebar();
  schedulePaneHeightNormalization();

  if (next === "author" && activeHint && appState.selectedId) {
    if (activeHint.kind === "changed") {
      // The on-disk content changed while the user was in Review and a
      // stale hint was active. Drop the cached payload before reloading so
      // we don't serve the stale rendering.
      forgetDocumentCache(appState.selectedId);
      void loadDocument(appState.selectedId);
    } else {
      appState.selectedId = null;
      renderEmptyPreview("File no longer on disk", "The file you were viewing has been deleted.");
      renderSidebar();
    }
  }
}

// First repository with an available review-load wins; the chip is global
// across multi-root sessions, so a single base label is sufficient (and
// degrading to a generic label is fine when bases differ or aren't available).
export function primaryReviewBaseLabel(): string | null {
  for (const repo of appState.repositories) {
    if (repo.reviewLoad.status !== "available") {
      continue;
    }
    const base = repo.reviewLoad.base;
    if (base.ref) {
      return base.ref;
    }
    if (base.mode === "dirty-worktree-only") {
      return "dirty worktree";
    }
  }
  return null;
}

// Boot-time wiring for the mode-radio click handlers.
export function initModeControls(): void {
  modeAuthorButton.addEventListener("click", () => applyMode("author"));
  modeReviewButton.addEventListener("click", () => applyMode("review"));
}
