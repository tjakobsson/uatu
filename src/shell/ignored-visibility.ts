import { appState } from "./state";
import { persistPersonalWorkspaceState } from "./personal-state";
import { renderSidebar } from "../sidebar/shell";
import { refreshServerStateForVisibility } from "./events";

export function setShowIgnored(value: boolean): void {
  appState.showIgnored = value;
  persistPersonalWorkspaceState({ showIgnored: value });
}

export function applyShowIgnored(value: boolean): void {
  if (appState.showIgnored === value) return;
  setShowIgnored(value);
  renderSidebar();
  // Replace only the document topic; the page's single live channel remains.
  void refreshServerStateForVisibility();
}
