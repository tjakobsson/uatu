// Files-pane filter chip (All / Changed). Owns the chip's runtime
// behavior and the resolved-base label that drives its tooltip.
// Extracted from `app.ts` so the chip's view-state and the filter logic
// live next to each other. The read/write storage helpers and the
// per-Mode default map already live in `shell/state.ts`.

import { primaryCompareBaseLabel } from "./change-overview";
import { appState, type FilesPaneFilter } from "../shell/state";
import { persistPersonalWorkspaceState } from "../shell/personal-state";
import { renderSidebar } from "./shell";
import { initIgnoredVisibilityControl } from "./ignored-visibility";
import { initMediaBrowsing } from "./media-browsing";

const filesPaneFilterAllButtonMaybe = document.querySelector<HTMLButtonElement>("#files-pane-filter-all");
const filesPaneFilterChangedButtonMaybe = document.querySelector<HTMLButtonElement>("#files-pane-filter-changed");
const recentButton = document.querySelector<HTMLButtonElement>("#files-pane-filter-recent")!;
export let filesQuery = "";

if (!filesPaneFilterAllButtonMaybe || !filesPaneFilterChangedButtonMaybe) {
  throw new Error("uatu UI failed to initialize (sidebar/files-filter)");
}

const filesPaneFilterAllButton: HTMLButtonElement = filesPaneFilterAllButtonMaybe;
const filesPaneFilterChangedButton: HTMLButtonElement = filesPaneFilterChangedButtonMaybe;

// Owner mutator for `appState.filesPaneFilter`: assign + persist. Boot-time
// hydration and the chip handler both go through here.
export function setFilesPaneFilter(next: FilesPaneFilter): void {
  appState.filesPaneFilter = next;
  persistPersonalWorkspaceState({ filesFilter: next });
}

export function applyFilesPaneFilter(next: FilesPaneFilter): void {
  if (appState.filesPaneFilter === next) {
    return;
  }
  setFilesPaneFilter(next);
  syncFilesPaneFilterControl();
  renderSidebar();
}

export function syncFilesPaneFilterControl(): void {
  const allBtn = filesPaneFilterAllButton;
  const changedBtn = filesPaneFilterChangedButton;
  for (const [value, button] of [["all", allBtn], ["recent", recentButton], ["changed", changedBtn]] as const) {
    const active = appState.filesPaneFilter === value;
    button.setAttribute("aria-checked", String(active));
    button.classList.toggle("is-active", active);
    button.tabIndex = active ? 0 : -1;
  }

  // Tooltip on the Changed segment names the resolved compare base when one is
  // available so reviewers know what "Changed" is measured against. Falls back
  // to a generic hint when no repository has available change data.
  const baseLabel = primaryCompareBaseLabel();
  changedBtn.title = baseLabel
    ? `Show only files changed vs ${baseLabel}`
    : "Show only changed files";
}

// Boot-time wiring for the chip's click handlers.
export function initFilesPaneFilterControls(): void {
  initIgnoredVisibilityControl();
  initMediaBrowsing();
  filesPaneFilterAllButton.addEventListener("click", () => applyFilesPaneFilter("all"));
  filesPaneFilterChangedButton.addEventListener("click", () => applyFilesPaneFilter("changed"));
  recentButton.addEventListener("click", () => applyFilesPaneFilter("recent"));
  const buttons = [filesPaneFilterAllButton, recentButton, filesPaneFilterChangedButton];
  for (const [index, button] of buttons.entries()) button.addEventListener("keydown", event => {
    const next = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : event.key === "Home" ? 0 : event.key === "End" ? 2 : -1;
    if (next < 0) return;
    event.preventDefault(); buttons[next]!.click(); buttons[next]!.focus();
  });
  const query = document.querySelector<HTMLInputElement>("#files-query")!;
  query.addEventListener("input", () => { filesQuery = query.value; renderSidebar(); });
  document.querySelector("#files-query-clear")!.addEventListener("click", () => {
    query.value = ""; filesQuery = ""; renderSidebar(); query.focus();
  });
}
