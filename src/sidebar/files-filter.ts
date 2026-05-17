// Files-pane filter chip (All / Changed). Owns the chip's runtime
// behavior and the resolved-base label that drives its tooltip.
// Extracted from `app.ts` so the chip's view-state and the filter logic
// live next to each other. The read/write storage helpers and the
// per-Mode default map already live in `shell/state.ts`.

import { primaryReviewBaseLabel } from "../shell/mode";
import { appState, type FilesPaneFilter, writeFilesPaneFilterPreference } from "../shell/state";
import { renderSidebar } from "./shell";

const filesPaneFilterAllButtonMaybe = document.querySelector<HTMLButtonElement>("#files-pane-filter-all");
const filesPaneFilterChangedButtonMaybe = document.querySelector<HTMLButtonElement>("#files-pane-filter-changed");

if (!filesPaneFilterAllButtonMaybe || !filesPaneFilterChangedButtonMaybe) {
  throw new Error("uatu UI failed to initialize (sidebar/files-filter)");
}

const filesPaneFilterAllButton: HTMLButtonElement = filesPaneFilterAllButtonMaybe;
const filesPaneFilterChangedButton: HTMLButtonElement = filesPaneFilterChangedButtonMaybe;

export function applyFilesPaneFilter(next: FilesPaneFilter): void {
  if (appState.filesPaneFilter === next) {
    return;
  }
  appState.filesPaneFilter = next;
  writeFilesPaneFilterPreference(appState.mode, next);
  syncFilesPaneFilterControl();
  renderSidebar();
}

export function syncFilesPaneFilterControl(): void {
  const allBtn = filesPaneFilterAllButton;
  const changedBtn = filesPaneFilterChangedButton;
  const isAll = appState.filesPaneFilter === "all";
  allBtn.setAttribute("aria-checked", String(isAll));
  allBtn.classList.toggle("is-active", isAll);
  changedBtn.setAttribute("aria-checked", String(!isAll));
  changedBtn.classList.toggle("is-active", !isAll);

  // Tooltip on the Changed segment names the resolved review base when one is
  // available so reviewers know what "Changed" is measured against. Falls back
  // to a generic hint when no repository has an available review-load.
  const baseLabel = primaryReviewBaseLabel();
  changedBtn.title = baseLabel
    ? `Show only files changed vs ${baseLabel}`
    : "Show only changed files";
}

// Boot-time wiring for the chip's click handlers.
export function initFilesPaneFilterControls(): void {
  filesPaneFilterAllButton.addEventListener("click", () => applyFilesPaneFilter("all"));
  filesPaneFilterChangedButton.addEventListener("click", () => applyFilesPaneFilter("changed"));
}
