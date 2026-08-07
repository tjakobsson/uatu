// Bottom tab bar — touch mode's only navigation chrome (touch-tab-navigation
// change). Three tabs, each an existing surface rendered fullscreen: Files
// (the sidebar pane stack), Preview (the main-stack), Terminal (the
// fullscreen panel). This module owns the active-tab state in `appState`,
// its per-device persistence, the `data-active-tab` stamp on <html> that all
// surface CSS keys on, and the mode-escape controls (the bar's Desktop
// button on wide viewports, the desktop chrome's touch-mode return button).
//
// Surface behavior lives with the surfaces: terminal/panel.ts subscribes to
// tab changes to run its show/keep-attached semantics, and the tree's Rule A
// selection handler calls setActiveTab("preview") on a document pick.

import { ACTIVE_TAB_KEY, appState, safeLocalStorage, type TouchTab } from "./state";
import { onUiModeChange, setUiMode, uiMode } from "./ui-mode";

export type TabChangeListener = (tab: TouchTab, previous: TouchTab) => void;

const listeners = new Set<TabChangeListener>();

let barElement: HTMLElement | null = null;
let tabButtons: HTMLButtonElement[] = [];

export function activeTab(): TouchTab {
  return appState.activeTab;
}

/** Subscribe to active-tab changes. Returns an unsubscribe function. */
export function onActiveTabChange(listener: TabChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function writeActiveTabPreference(tab: TouchTab): void {
  try {
    safeLocalStorage()?.setItem(ACTIVE_TAB_KEY, tab);
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}

// Stamp the active tab on <html> (surface CSS keys on it, alongside
// data-ui-mode) and sync each tab button's aria-selected.
function applyActiveTabToDom(): void {
  document.documentElement.setAttribute("data-active-tab", appState.activeTab);
  for (const button of tabButtons) {
    button.setAttribute("aria-selected", button.dataset.tab === appState.activeTab ? "true" : "false");
  }
}

export function setActiveTab(tab: TouchTab): void {
  const previous = appState.activeTab;
  if (previous === tab) return;
  appState.activeTab = tab;
  writeActiveTabPreference(tab);
  applyActiveTabToDom();
  for (const listener of listeners) {
    listener(tab, previous);
  }
}

/** A user navigation just changed what the preview shows — a document pick
 *  (tree row, search result), a review-score click, a commit click. In
 *  touch mode that intent includes SEEING it, so the Preview surface comes
 *  forward; in desktop mode the preview is already visible and this is a
 *  no-op. Programmatic updates (follow Rules C/D, file events) must never
 *  call this. */
export function revealPreviewSurface(): void {
  if (uiMode() === "touch") {
    setActiveTab("preview");
  }
}

/** The vertical space the tab bar occupies at the bottom of the layout
 *  viewport (bar height + safe-area padding), 0 whenever the bar isn't
 *  rendered. The terminal panel subtracts the bar's still-visible portion
 *  from its visual-viewport height so fullscreen ends at the bar's top edge
 *  while the keyboard is down, and reclaims the space once the keyboard
 *  covers the bar. */
export function tabBarBottomInset(): number {
  if (uiMode() !== "touch" || !barElement) return 0;
  return barElement.offsetHeight;
}

/** Backend-off sessions have no terminal to show: the Terminal tab hides and
 *  an active Terminal tab falls back to Preview. Called by
 *  setupTerminalPanel once the backend state is known. */
export function setTerminalTabAvailable(available: boolean): void {
  const terminalButton = tabButtons.find(button => button.dataset.tab === "terminal");
  if (terminalButton) terminalButton.toggleAttribute("hidden", !available);
  if (!available && appState.activeTab === "terminal") {
    setActiveTab("preview");
  }
}

/** Show or clear the Terminal tab's unseen-output dot. Cleared implicitly on
 *  activation by the caller (terminal/panel.ts). */
export function setTerminalTabBadge(on: boolean): void {
  const terminalButton = tabButtons.find(button => button.dataset.tab === "terminal");
  terminalButton?.toggleAttribute("data-badge", on);
}

export function initTabBar(): void {
  barElement = document.getElementById("touch-tab-bar");
  if (!barElement) return;
  tabButtons = Array.from(barElement.querySelectorAll<HTMLButtonElement>("[data-tab]"));

  for (const button of tabButtons) {
    button.addEventListener("click", () => {
      const tab = button.dataset.tab;
      if (tab === "files" || tab === "preview" || tab === "terminal") {
        setActiveTab(tab);
      }
    });
  }

  // The UI-mode toggle (sidebar header, rendered inside the Files tab in
  // touch mode, plus the collapsed-rail variant): one control, both
  // directions, so neither mode can strand a coarse-pointer device.
  // Visibility and glyph are CSS-owned (mode attribute + pointer media);
  // the accessible labels sync here.
  const modeToggles = [
    document.getElementById("ui-mode-toggle"),
    document.getElementById("rail-ui-mode-toggle"),
  ];
  for (const toggle of modeToggles) {
    toggle?.addEventListener("click", () => {
      setUiMode(uiMode() === "touch" ? "desktop" : "touch");
    });
  }
  const syncModeToggleLabels = () => {
    const label = uiMode() === "touch" ? "Switch to desktop layout" : "Switch to touch layout";
    for (const toggle of modeToggles) {
      toggle?.setAttribute("aria-label", label);
      toggle?.setAttribute("title", label);
    }
  };
  onUiModeChange(syncModeToggleLabels);
  syncModeToggleLabels();

  // appState.activeTab was restored from storage at state-module init;
  // stamp it so the first paint lands on the persisted surface.
  applyActiveTabToDom();
}
