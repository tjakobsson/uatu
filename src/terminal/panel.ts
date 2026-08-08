// Boot-time wiring for the embedded terminal panel. Extracted from app.ts
// so the panel controller lives next to the rest of the terminal feature
// (client mount, pane-state persistence, server protocol). The function
// owns the closure that mutates panel state — every UI handler funnels
// through its named methods so persistence and refit happen consistently.

import { appUrl } from "../shared/app-url";
import { mountTerminalPanel, persistTerminalToken, type TerminalPanelHandle } from "./client";
import { initTerminalKeybar, selectionSheetKeyRoute } from "./keybar";
import { pasteToActiveTerminal } from "./panel-paste";
import { refreshFindTarget } from "../find/find-bar";
import { registerTerminalFind } from "../find/shortcut";
import { createTerminalEngine, type TerminalSearchTarget } from "../find/terminal-engine";
import type { Osc52Notice } from "./clipboard";
import type { TerminalClipboardPolicy } from "../shared/types";
import {
  buildSwitcherRows,
  formatSessionAge,
  pickerCandidates,
  resolveActiveSessionId,
  resolveSessionPlan,
  type SwitcherRow,
  type SwitcherRowState,
} from "./picker";
import type { TerminalSessionInfo } from "./server";
import {
  TERMINAL_MAX_PANES,
  TERMINAL_RIGHT_DOCK_VIEWPORT_MIN,
  clampTerminalFontSize,
  clampTerminalHeight as clampTerminalHeightShared,
  clampTerminalWidth as clampTerminalWidthShared,
  readTerminalFontSizeOverride,
  readTerminalPanelState,
  readTerminalVisiblePreference as readTerminalVisiblePreferenceShared,
  resolveBootPaneRecords,
  resolveEffectiveDisplayMode,
  resolveTerminalEscapeAction,
  resolveTerminalFontSize,
  terminalActionForTabChange,
  writeOwnPaneRecords,
  writeTerminalFontSizeOverride,
  writeTerminalPanelState,
  writeTerminalVisiblePreference as writeTerminalVisiblePreferenceShared,
  type StorageLike,
  type TerminalDisplayMode,
  type TerminalDock,
  type TerminalPanelState,
  type TerminalPaneRecord,
} from "./pane-state";
import { composeStickyCtrl, createStickyCtrl } from "./sticky-ctrl";
import { createVisualViewportSizer } from "./visual-viewport";
import { presentationLocalStorage, presentationSessionStorage } from "../shell/presentation-storage";
import { persistPersonalWorkspaceState } from "../shell/personal-state";
import { onUiModeChange, uiMode } from "../shell/ui-mode";
import {
  activeTab,
  onActiveTabChange,
  setActiveTab,
  setTerminalTabAvailable,
  setTerminalTabBadge,
  tabBarBottomInset,
} from "../shell/tab-bar";

const TERMINAL_TOKEN_KEY_LOCAL = "uatu:terminal-token";

// Row subtitles in the touch switcher. "on screen" rather than "attached" for
// the visible pane: the user is looking at it, and the distinction that
// matters to them is which terminal they'd land in, not the protocol state.
const SWITCHER_STATE_COPY: Record<SwitcherRowState, string> = {
  "visible": "on screen",
  "attached-here": "open here",
  "detached": "detached",
  "attached-elsewhere": "attached elsewhere",
};

let terminalSetupRan = false;

const sessionStorageRef: StorageLike = presentationSessionStorage() ?? window.sessionStorage;
const localStorageRef: StorageLike = presentationLocalStorage() ?? window.localStorage;

function readTerminalVisiblePreference(): boolean {
  return readTerminalVisiblePreferenceShared(sessionStorageRef);
}

function writeTerminalVisiblePreference(visible: boolean): void {
  writeTerminalVisiblePreferenceShared(sessionStorageRef, visible);
}

function clampTerminalHeight(value: number): number {
  return clampTerminalHeightShared(value, window.innerHeight);
}

function clampTerminalWidth(value: number): number {
  return clampTerminalWidthShared(value, window.innerWidth);
}

// Touch-mode terminal surface: the panel renders fullscreen whenever the
// Terminal tab is active — the UI mode (not viewport width) is the layout
// gate, so iPads get the same behavior as phones and the desktop escape
// restores the stored dock/display.
function touchModeNow(): boolean {
  return uiMode() === "touch";
}

function touchTerminalActive(): boolean {
  return touchModeNow() && activeTab() === "terminal";
}

// Whether the terminal is a surface the user can actually see right now.
// A mounted panel is not the same as a visible one: in touch mode the panel
// deliberately stays mounted with its PTYs attached while another tab is
// active, hidden by CSS alone with no `hidden` attribute to test. Anything
// that consumes input on the terminal's behalf, or paints into it, has to ask
// this rather than the attribute.
function terminalSurfaceShowing(panel: HTMLElement): boolean {
  if (panel.hasAttribute("hidden")) return false;
  return !touchModeNow() || activeTab() === "terminal";
}

// Pane-scoped toast for OSC 52 bridge events. One toast element per pane;
// each `show` replaces the previous content (rapid copies coalesce instead of
// stacking) and re-arms the auto-dismiss timer. All content is set through
// textContent — terminal output is attacker-controlled and must never be
// interpreted as HTML.
type CopyToast = { show(notice: Osc52Notice): void };

const COPY_TOAST_DISMISS_MS = 2500;
const COPY_TOAST_ERROR_DISMISS_MS = 5000;

function createCopyToast(pane: HTMLElement): CopyToast {
  let toast: HTMLDivElement | null = null;
  let dismissTimer: ReturnType<typeof setTimeout> | null = null;

  function clear(): void {
    if (dismissTimer !== null) clearTimeout(dismissTimer);
    dismissTimer = null;
    toast?.remove();
    toast = null;
  }

  function render(text: string, options: { copyText?: string; dismissAfter?: number }): void {
    clear();
    toast = document.createElement("div");
    toast.className = "terminal-copy-toast";
    toast.setAttribute("role", "status");

    const label = document.createElement("span");
    label.className = "terminal-copy-toast-text";
    label.textContent = text;
    toast.append(label);

    if (options.copyText !== undefined) {
      const pending = options.copyText;
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "terminal-copy-toast-copy";
      copy.textContent = "Copy";
      copy.addEventListener("click", () => {
        // Inside a click gesture, so this works on browsers that refuse the
        // bridge's gestureless writeText (Firefox/Safari) too.
        navigator.clipboard.writeText(pending).then(
          () => render(`Copied ${pending.length} characters from terminal`, { dismissAfter: COPY_TOAST_DISMISS_MS }),
          () => render("Copy failed — clipboard unavailable", { dismissAfter: COPY_TOAST_ERROR_DISMISS_MS }),
        );
      });
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "terminal-copy-toast-dismiss";
      dismiss.setAttribute("aria-label", "Dismiss");
      dismiss.textContent = "×";
      dismiss.addEventListener("click", clear);
      toast.append(copy, dismiss);
    }

    pane.append(toast);
    if (options.dismissAfter !== undefined) {
      dismissTimer = setTimeout(clear, options.dismissAfter);
    }
  }

  return {
    show(notice) {
      switch (notice.kind) {
        case "copied":
          render(`Copied ${notice.chars} characters from terminal`, { dismissAfter: COPY_TOAST_DISMISS_MS });
          return;
        case "pending":
          render(`Terminal wants to copy ${notice.text.length} characters`, { copyText: notice.text });
          return;
        case "oversized":
          render("Terminal copy rejected: larger than 100 KB", { dismissAfter: COPY_TOAST_ERROR_DISMISS_MS });
          return;
      }
    },
  };
}

type TerminalPaneEntry = {
  record: TerminalPaneRecord;
  handle: TerminalPanelHandle;
  element: HTMLElement;
  hostElement: HTMLElement;
  closeButton: HTMLButtonElement;
};

// `setupTerminalPanel` runs once at boot when the backend is enabled. It
// builds the controller closure and wires every header button + the sidebar
// toggle + keyboard shortcuts + the close-confirmation modal. The controller
// is the only thing that mutates panel state; UI handlers all funnel through
// its named methods so persistence and refit happen consistently.
export function setupTerminalPanel(
  enabled: boolean,
  config?: { fontFamily?: string; fontSize?: number; clipboard?: TerminalClipboardPolicy },
  initialLastPtyId?: string,
) {
  if (terminalSetupRan) return;
  terminalSetupRan = true;

  // Backend-off sessions have no terminal surface: the touch Terminal tab
  // hides and an active Terminal tab falls back to Preview.
  setTerminalTabAvailable(enabled);
  if (!enabled) return;

  const panel = document.getElementById("terminal-panel");
  const panesContainer = document.getElementById("terminal-panes");
  const resizer = document.getElementById("terminal-resizer");
  const toggle = document.getElementById("terminal-toggle");
  const sidebarRow = document.querySelector<HTMLElement>(".sidebar-terminal-row");
  const splitButton = document.getElementById("terminal-split");
  const dockButton = document.getElementById("terminal-dock-toggle");
  const minimizeButton = document.getElementById("terminal-minimize");
  const fullscreenButton = document.getElementById("terminal-fullscreen");
  const closeButton = document.getElementById("terminal-close");
  const modal = document.getElementById("terminal-confirm");
  const modalCancel = document.getElementById("terminal-confirm-cancel");
  const modalAccept = document.getElementById("terminal-confirm-accept");
  // Touch-only surface; a missing element must not take the panel down with
  // it, so this one is optional unlike the checked set below.
  const switcherEl = document.getElementById("terminal-switcher");
  if (
    !panel ||
    !panesContainer ||
    !resizer ||
    !toggle ||
    !sidebarRow ||
    !splitButton ||
    !dockButton ||
    !minimizeButton ||
    !fullscreenButton ||
    !closeButton ||
    !modal ||
    !modalCancel ||
    !modalAccept
  ) {
    return;
  }

  // Sidebar control becomes visible once we know the backend is on — and so
  // does its collapsed-rail counterpart, which drives the same toggle so a
  // collapsed sidebar (or an iPad with no Ctrl+` available) never locks the
  // terminal away.
  sidebarRow.removeAttribute("hidden");
  const railTerminalToggle = document.getElementById("rail-terminal-toggle");
  railTerminalToggle?.removeAttribute("hidden");

  const panes = new Map<string, TerminalPaneEntry>();
  let lastPtyId = initialLastPtyId;
  let activePaneId: string | null = null;
  // A user-initiated panel show that found no pane yet (fresh spawn path):
  // the next pane added takes focus once its terminal opens.
  let focusPaneWhenReady = false;
  // Suppresses per-pane activation, focus and refit while a planned batch
  // attaches; the batch performs each once when it finishes.
  let batchingAttach = false;
  // Whether the touch terminal switcher is up. Tracked here rather than read
  // off the element because the sheet's content arrives from an async
  // inventory read: between the tap and the first paint the element is still
  // hidden, and anything that asked the DOM in that window would be told the
  // sheet is closed. That gap is what makes a second tap render a second sheet
  // instead of toggling, and what lets an in-flight refresh reopen a sheet the
  // user already dismissed.
  //
  // Declared with the rest of the panel's state, NOT beside the switcher
  // functions further down: `initTerminalKeybar` runs during setup and calls
  // `isSwitcherOpen()` synchronously to seed the switch button's
  // `aria-expanded`. A `let` declared after that call site is still in its
  // temporal dead zone when it runs, and the ReferenceError aborts the whole
  // boot — the panel never mounts and the app hangs at "Connecting".
  let switcherOpen = false;

  // Sticky Ctrl latch shared by the keybar's ctrl button (arms it) and every
  // pane's input path (composes the next keystroke, then releases).
  const stickyCtrl = createStickyCtrl();

  // Touch keybar (visible on coarse pointers only, CSS-gated): control
  // sequences software keyboards can't type, sent to the focused pane.
  const keybarContainer = document.getElementById("terminal-keybar");
  if (keybarContainer) {
    initTerminalKeybar({
      container: keybarContainer,
      sendToActivePane(sequence) {
        const entry = activePaneId ? panes.get(activePaneId) : undefined;
        if (!entry || !entry.handle.isAttached()) {
          return false;
        }
        const route = selectionSheetKeyRoute(entry.handle.isSelectionSheetOpen(), sequence);
        if (route === "dismiss") return entry.handle.dismissSelectionSheet();
        if (route === "block") return false;
        entry.handle.sendInput(sequence);
        entry.handle.focus();
        return true;
      },
      pasteToActivePane(text) {
        return pasteToActiveTerminal(() => {
          const entry = activePaneId ? panes.get(activePaneId) : undefined;
          if (entry?.handle.isSelectionSheetOpen()) return null;
          return entry?.handle ?? null;
        }, text);
      },
      showSelectionSheet() {
        const entry = activePaneId ? panes.get(activePaneId) : undefined;
        return entry?.handle.showSelectionSheet() ?? false;
      },
      dismissSelectionSheet() {
        const entry = activePaneId ? panes.get(activePaneId) : undefined;
        return entry?.handle.dismissSelectionSheet() ?? false;
      },
      isSelectionSheetOpen() {
        const entry = activePaneId ? panes.get(activePaneId) : undefined;
        return entry?.handle.isSelectionSheetOpen() ?? false;
      },
      openSwitcher: () => openSwitcher(),
      dismissSwitcher: () => dismissSwitcher(),
      isSwitcherOpen: () => isSwitcherOpen(),
      stickyCtrl,
      readClipboardText: () => navigator.clipboard.readText(),
    });
  }

  // One search target per pane, cached.
  //
  // The engine compares targets by identity to decide whether find has moved
  // between panes, and moving resets the pane it left. Handing back a fresh
  // wrapper each call would make every ⌘G look like a pane switch: the search
  // would be cleared and restarted, so Find Next would land on the first match
  // for ever instead of advancing.
  const searchTargets = new WeakMap<TerminalPaneEntry, TerminalSearchTarget>();

  function searchTargetFor(entry: TerminalPaneEntry): TerminalSearchTarget {
    const existing = searchTargets.get(entry);
    if (existing) {
      return existing;
    }
    const target: TerminalSearchTarget = {
      findNext: (query, options) => entry.handle.search.findNext(query, options),
      findPrevious: (query, options) => entry.handle.search.findPrevious(query, options),
      clear: () => entry.handle.search.clear(),
      focus: () => entry.handle.focus(),
      onResults: listener => entry.handle.search.onResults(listener),
    };
    searchTargets.set(entry, target);
    return target;
  }

  // Find over the terminal is scoped to the pane the user is in: searching a
  // pane you are not looking at would be a strange thing to offer. The engine
  // resolves the target at call time rather than capturing it, so splitting or
  // closing panes mid-search cannot leave it pointed at a dead one.
  registerTerminalFind(
    createTerminalEngine(() => {
      if (activePaneId === null) {
        return null;
      }
      const entry = panes.get(activePaneId);
      if (!entry || !entry.handle.isAttached()) {
        return null;
      }
      return searchTargetFor(entry);
    }, () => document.getElementById("terminal-find-slot")),
  );
  let state: TerminalPanelState = readTerminalPanelState(localStorageRef);

  // Runtime font size: per-device override (touch stepper) → `.uatu.json`
  // → built-in 13. The override is cleared when stepping back onto the
  // configured default so later config changes show through.
  let fontOverride = readTerminalFontSizeOverride(localStorageRef);
  let currentFontSize = resolveTerminalFontSize(fontOverride, config?.fontSize);

  function stepFontSize(delta: number): void {
    const next = clampTerminalFontSize(currentFontSize + delta);
    if (next === currentFontSize) return;
    currentFontSize = next;
    const configDefault = resolveTerminalFontSize(null, config?.fontSize);
    fontOverride = next === configDefault ? null : next;
    writeTerminalFontSizeOverride(localStorageRef, fontOverride);
    for (const entry of panes.values()) {
      try {
        entry.handle.setFontSize(next);
      } catch {
        // Pane torn down mid-iteration.
      }
    }
  }

  // Pane records are per-window. Long-lived presentation state contains only
  // geometry, never server PTY references.
  const bootRecords = resolveBootPaneRecords(sessionStorageRef, state);
  state = { ...state, panes: bootRecords.panes };

  // Height/width restore: write the persisted value to the CSS var so the
  // first paint matches the user's last layout.
  document.documentElement.style.setProperty(
    "--terminal-panel-height",
    `${clampTerminalHeight(state.bottomHeight)}px`,
  );
  document.documentElement.style.setProperty(
    "--terminal-panel-width",
    `${clampTerminalWidth(state.rightWidth)}px`,
  );

  function persistState() {
    state = {
      ...state,
      panes: Array.from(panes.values()).map(entry => entry.record),
    };
    // This window's records always go to its own store.
    writeOwnPaneRecords(sessionStorageRef, { panes: state.panes });
    writeTerminalPanelState(localStorageRef, state);
  }

  function clearLastPty(sessionId: string): void {
    if (lastPtyId !== sessionId) return;
    lastPtyId = undefined;
    persistPersonalWorkspaceState({ lastPtyId: null });
  }

  function getToken(): string | null {
    try {
      return window.sessionStorage.getItem(TERMINAL_TOKEN_KEY_LOCAL);
    } catch {
      return null;
    }
  }

  // Right-dock auto-fallback: at narrow viewports we force bottom-dock, but
  // keep the user's stored preference so widening the viewport snaps it back.
  function effectiveDock(): TerminalDock {
    if (state.dock === "right" && window.innerWidth < TERMINAL_RIGHT_DOCK_VIEWPORT_MIN) {
      return "bottom";
    }
    return state.dock;
  }

  function applyDockToDom() {
    const dock = effectiveDock();
    panel!.setAttribute("data-dock", dock);
    // Split orientation flips with the dock axis: bottom-dock splits side-by-
    // side (panes share full height); right-dock stacks panes (share full
    // width). Driven via a data attribute so CSS handles the flexbox swap.
    panesContainer!.setAttribute("data-orientation", dock === "bottom" ? "horizontal" : "vertical");
    resizer!.setAttribute("data-orientation", dock === "bottom" ? "horizontal" : "vertical");
    // Update dock toggle's affordance to indicate the OPPOSITE dock (where
    // clicking will move the panel to). The icon itself swaps via CSS keyed
    // off [data-dock]; we sync the accessible label here.
    const target = dock === "bottom" ? "right" : "bottom";
    dockButton!.setAttribute("aria-label", `Dock to ${target}`);
    dockButton!.setAttribute("title", `Dock to ${target}`);
  }

  // The mode the panel actually renders. While the touch Terminal tab is
  // active EVERY stored mode is promoted to fullscreen (neither the docked
  // strip nor the minimized strip ever renders in touch mode); the stored
  // preference survives for desktop mode — same pattern as the right-dock
  // fallback in effectiveDock().
  function effectiveDisplayMode(): TerminalDisplayMode {
    return resolveEffectiveDisplayMode(state.displayMode, touchTerminalActive());
  }

  // Visible-viewport sizing: while touch-fullscreen the panel tracks
  // window.visualViewport — height (keyboard show/hide) AND offsetTop
  // (viewport pans while the keyboard is up) — so the iOS software keyboard
  // never covers the prompt line. The written height is netted of the tab
  // bar's still-visible portion: keyboard down, the panel ends at the bar's
  // top edge; keyboard up (covering the bar), the panel takes the whole
  // space above it. The CSS fallbacks (100dvh − bar, top: 0) apply whenever
  // the override custom properties are absent.
  const viewportSizer = createVisualViewportSizer({
    viewport: window.visualViewport ?? null,
    onMetrics(metrics) {
      if (metrics === null) {
        panel!.style.removeProperty("--terminal-visual-height");
        panel!.style.removeProperty("--terminal-visual-top");
      } else {
        const occluded = Math.max(0, window.innerHeight - metrics.height - metrics.offsetTop);
        const barInset = Math.max(0, tabBarBottomInset() - occluded);
        panel!.style.setProperty(
          "--terminal-visual-height",
          `${Math.round(metrics.height - barInset)}px`,
        );
        panel!.style.setProperty("--terminal-visual-top", `${Math.round(metrics.offsetTop)}px`);
      }
      requestAnimationFrame(() => fitAll());
    },
  });

  function syncViewportSizer() {
    const active =
      !panel!.hasAttribute("hidden") && touchTerminalActive() && effectiveDisplayMode() === "fullscreen";
    if (active) {
      viewportSizer.attach();
    } else {
      viewportSizer.detach();
    }
  }

  function applyDisplayModeToDom() {
    const display = effectiveDisplayMode();
    panel!.setAttribute("data-display", display);
    minimizeButton!.setAttribute(
      "aria-pressed",
      display === "minimized" ? "true" : "false",
    );
    fullscreenButton!.setAttribute(
      "aria-pressed",
      display === "fullscreen" ? "true" : "false",
    );
    // Sync the accessible labels with the action the button now performs;
    // the visible icon swaps via CSS keyed off [data-display].
    if (display === "minimized") {
      minimizeButton!.setAttribute("aria-label", "Restore terminal");
      minimizeButton!.setAttribute("title", "Restore terminal");
    } else {
      minimizeButton!.setAttribute("aria-label", "Minimize terminal");
      minimizeButton!.setAttribute("title", "Minimize terminal");
    }
    if (display === "fullscreen") {
      fullscreenButton!.setAttribute("aria-label", "Exit fullscreen");
      fullscreenButton!.setAttribute("title", "Exit fullscreen");
    } else {
      fullscreenButton!.setAttribute("aria-label", "Enter fullscreen");
      fullscreenButton!.setAttribute("title", "Enter fullscreen");
    }
    syncViewportSizer();
  }

  function fitAll() {
    for (const entry of panes.values()) {
      try {
        entry.handle.fit();
      } catch {
        // Ignored: hidden / zero-rect panes throw from FitAddon.
      }
    }
  }

  function paneCount(): number {
    return panes.size;
  }

  function refreshSplitControl() {
    if (paneCount() >= TERMINAL_MAX_PANES) {
      splitButton!.setAttribute("disabled", "");
    } else {
      splitButton!.removeAttribute("disabled");
    }
  }

  function setActivePane(id: string | null) {
    const paneChanged = activePaneId !== id;
    activePaneId = id;
    const activeSessionId = id === null ? undefined : panes.get(id)?.record.sessionId;
    if (activeSessionId && activeSessionId !== lastPtyId) {
      lastPtyId = activeSessionId;
      persistPersonalWorkspaceState({ lastPtyId: activeSessionId });
    }
    let activeEntry: TerminalPaneEntry | null = null;
    for (const entry of panes.values()) {
      if (entry.record.id === id) {
        entry.element.setAttribute("data-active", "true");
        activeEntry = entry;
      } else {
        entry.element.removeAttribute("data-active");
      }
    }
    // With terminal find open, the engine is bound to the pane that was
    // active — switching panes must rebind it now, or the old pane stays
    // highlighted and the counter keeps describing it until the query is
    // edited. The engine resolves its target at call time, so a re-run is
    // the whole rebind.
    if (paneChanged) {
      refreshFindTarget("terminal");
      // Touch mode renders one pane at a time, so the pane this switch just
      // revealed was `display: none` and measured zero. It has to be refit
      // before xterm paints, or the first frame lands at the wrong grid. The
      // now-hidden panes throw out of FitAddon on a zero rect, which fitAll
      // already swallows per pane.
      if (touchModeNow()) requestAnimationFrame(() => fitAll());
    }
    // Move keyboard focus into the active pane's xterm so the user can
    // type immediately after a split, restore, or close. requestAnimationFrame
    // gives xterm.js a tick to finish opening when this runs in the same
    // frame as `addPane()`.
    if (activeEntry) {
      const entry = activeEntry;
      requestAnimationFrame(() => {
        try {
          entry.handle.focus();
        } catch {
          // Pane was torn down between the frame schedule and now.
        }
      });
    }
  }

  function buildPaneElement(
    record: TerminalPaneRecord,
    options: { takeover?: boolean } = {},
  ): TerminalPaneEntry {
    const element = document.createElement("div");
    element.className = "terminal-pane";
    element.dataset.sessionId = record.sessionId;

    const host = document.createElement("div");
    host.className = "terminal-pane-host";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "terminal-pane-close";
    close.setAttribute("aria-label", "Close pane");
    close.setAttribute("title", "Close pane");
    close.textContent = "×";

    element.append(host, close);

    // Click anywhere in the pane (other than the close button) makes it
    // active so a subsequent split / keyboard input goes to the right place.
    element.addEventListener("pointerdown", event => {
      if (event.target === close) return;
      setActivePane(record.id);
    });

    const copyToast = createCopyToast(element);

    const handle = mountTerminalPanel({
      container: host,
      getToken,
      sessionId: record.sessionId,
      fontFamily: config?.fontFamily,
      fontSize: currentFontSize,
      clipboardPolicy: config?.clipboard,
      onOsc52Notice: notice => copyToast.show(notice),
      // Badge the Terminal tab when PTY output arrives while another touch
      // tab is active; activating the tab clears it (tab-change wiring).
      onOutput: () => {
        if (touchModeNow() && activeTab() !== "terminal") {
          setTerminalTabBadge(true);
        }
      },
      // Server-initiated disconnect (shell exited via `exit`, server
      // gone, network drop) → tear the dead pane down automatically.
      // No confirmation modal — there's nothing left to confirm losing.
      onClose: () => {
        if (panes.has(record.id)) removePane(record.id);
      },
      // A valid credential with a refused upgrade means this reference is
      // stale or attached elsewhere. Reconcile it through inventory so any
      // takeover remains an explicit user action.
      onCollision: () => handlePaneUnavailable(record.id),
      takeover: options.takeover === true,
      // Sticky Ctrl: compose the next single keystroke while the latch is
      // armed. Identity pass-through when unarmed (composeStickyCtrl's
      // contract), so ordinary typing never touches this path's behavior.
      transformInput: data => {
        const result = composeStickyCtrl(stickyCtrl.isArmed(), data);
        if (result.composed) stickyCtrl.disarm();
        return result.output;
      },
    });

    const entry: TerminalPaneEntry = { record, handle, element, hostElement: host, closeButton: close };

    close.addEventListener("click", () => {
      requestClosePane(record.id);
    });

    return entry;
  }

  function rebuildPanesContainer() {
    // Render order: by record.createdAt ascending. Inserts the inter-pane
    // resizer between siblings so the user can adjust the split ratio.
    const ordered = Array.from(panes.values()).sort(
      (a, b) => a.record.createdAt - b.record.createdAt,
    );
    panesContainer!.replaceChildren();
    ordered.forEach((entry, index) => {
      panesContainer!.appendChild(entry.element);
      if (index < ordered.length - 1) {
        const innerResizer = document.createElement("div");
        innerResizer.className = "terminal-pane-resizer";
        innerResizer.setAttribute("role", "separator");
        innerResizer.setAttribute("aria-label", "Resize split");
        wireSplitResizer(innerResizer, ordered[index]!.element, ordered[index + 1]!.element);
        panesContainer!.appendChild(innerResizer);
      }
    });
    // The last pane is the absorber: it always carries `flex: 1 1 0` so
    // any space freed by closing a sibling (or container growth) gets
    // filled instead of leaving a gap. Without this, after a resize the
    // surviving panes still hold their `flex: 0 1 <px>` from drag and the
    // panel under-fills its container — which is the symptom of the
    // close-after-resize bug.
    if (ordered.length > 0) {
      ordered[ordered.length - 1]!.element.style.flex = "1 1 0";
    }
    refreshSplitControl();
  }

  // Drag handler for the resizer between two split panes. Locks both
  // adjacent panes with `flex: 0 1 <px>` so flexbox stops redistributing
  // free space across them — without this, every other pane's flex-grow:1
  // pulls width away from the dragged pair and the resizer drifts away
  // from the pointer. The last pane in the container always stays
  // growable so the panel never shows a gap.
  function wireSplitResizer(
    handle: HTMLElement,
    first: HTMLElement,
    second: HTMLElement,
  ) {
    handle.addEventListener("pointerdown", event => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const horizontal = panesContainer!.getAttribute("data-orientation") !== "vertical";
      const start = horizontal ? event.clientX : event.clientY;
      // Snapshot every pane's current size and freeze the ones NOT being
      // dragged. Without this freeze, panes that still have the default
      // `flex: 1 1 0` participate in flexbox redistribution and shrink/grow
      // alongside the dragged pair — visible as: dragging the last
      // resizer (e.g. B-C in 3-pane A B C) also resizes A, because A and
      // the absorber share the leftover space proportionally to their
      // grow factors.
      const allPanes = Array.from(
        panesContainer!.querySelectorAll(".terminal-pane"),
      ) as HTMLElement[];
      const absorber = allPanes[allPanes.length - 1] ?? null;
      for (const pane of allPanes) {
        if (pane === first || pane === second || pane === absorber) continue;
        const rect = pane.getBoundingClientRect();
        const size = horizontal ? rect.width : rect.height;
        pane.style.flex = `0 1 ${size}px`;
      }
      // Re-measure on pointerdown so we always work from current sizes,
      // even if a sibling resizer already locked some panes.
      const firstRect = first.getBoundingClientRect();
      const secondRect = second.getBoundingClientRect();
      const startFirst = horizontal ? firstRect.width : firstRect.height;
      const startSecond = horizontal ? secondRect.width : secondRect.height;
      const total = startFirst + startSecond;
      const minPx = 80;
      document.body.classList.add("is-resizing-terminal");

      function applySizes(nextFirst: number, nextSecond: number) {
        first.style.flex = `0 1 ${nextFirst}px`;
        // Keep the absorber (last pane) growable so the panel never shows a
        // gap when sibling panes' locked bases sum to less than the
        // container. When the absorber itself IS the second pane, the math
        // still works because every other pane is now locked, so the
        // absorber's actual size lands at exactly the expected nextSecond.
        if (second === absorber) {
          second.style.flex = "1 1 0";
        } else {
          second.style.flex = `0 1 ${nextSecond}px`;
        }
      }

      function onMove(ev: PointerEvent) {
        const now = horizontal ? ev.clientX : ev.clientY;
        const delta = now - start;
        const nextFirst = Math.max(minPx, Math.min(total - minPx, startFirst + delta));
        const nextSecond = total - nextFirst;
        applySizes(nextFirst, nextSecond);
        fitAll();
      }
      function onUp(ev: PointerEvent) {
        try {
          handle.releasePointerCapture(ev.pointerId);
        } catch {
          // Pointer already released.
        }
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.body.classList.remove("is-resizing-terminal");
      }
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
  }

  async function addPane(
    record?: Partial<TerminalPaneRecord>,
    options: { takeover?: boolean } = {},
  ): Promise<TerminalPaneEntry | null> {
    if (panes.size >= TERMINAL_MAX_PANES) return null;
    const created = record?.sessionId ? null : await createSessionRemote();
    if (!record?.sessionId && !created) return null;
    if (panes.size >= TERMINAL_MAX_PANES || panel!.hasAttribute("hidden")) {
      if (created) void killSessionRemote(created.id);
      return null;
    }
    const id = record?.id ?? crypto.randomUUID();
    const sessionId = record?.sessionId ?? created!.id;
    const createdAt = record?.createdAt ?? Date.now();
    const fullRecord: TerminalPaneRecord = { id, sessionId, createdAt };
    const entry = buildPaneElement(fullRecord, { takeover: options.takeover });
    panes.set(id, entry);
    rebuildPanesContainer();
    entry.handle.attach();
    // Inside a batch attach, activation, focus and the refit all belong to the
    // batch, which performs them once against the pane it picked. Activating
    // here would also overwrite the saved last-active PTY the batch is about
    // to consult. See `attachSessionBatch`.
    if (!batchingAttach) {
      setActivePane(id);
      if (focusPaneWhenReady) {
        focusPaneWhenReady = false;
        entry.handle.focus();
      }
    }
    persistState();
    if (!batchingAttach) requestAnimationFrame(() => fitAll());
    return entry;
  }

  async function fetchSessionInventory(): Promise<TerminalSessionInfo[]> {
    try {
      const token = getToken();
      const url = token
        ? appUrl(`/api/terminal/sessions?t=${encodeURIComponent(token)}`)
        : appUrl("/api/terminal/sessions");
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) return [];
      const body = (await response.json()) as { sessions?: TerminalSessionInfo[] };
      const sessions = Array.isArray(body.sessions) ? body.sessions : [];
      if (lastPtyId && !sessions.some(session => session.id === lastPtyId)) {
        lastPtyId = undefined;
        persistPersonalWorkspaceState({ lastPtyId: null });
      }
      return sessions;
    } catch {
      return [];
    }
  }

  async function createSessionRemote(): Promise<TerminalSessionInfo | null> {
    try {
      const token = getToken();
      const url = token
        ? appUrl(`/api/terminal/sessions?t=${encodeURIComponent(token)}`)
        : appUrl("/api/terminal/sessions");
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cols: 80, rows: 24 }),
      });
      if (response.status === 401) renderTerminalAuth();
      if (response.status === 403) renderTerminalOriginRejected();
      return response.ok ? await response.json() as TerminalSessionInfo : null;
    } catch {
      return null;
    }
  }

  function renderTerminalAuth(): void {
    if (panesContainer!.querySelector(".terminal-auth")) return;
    const wrap = document.createElement("div");
    wrap.className = "terminal-pane terminal-auth";
    const heading = document.createElement("p");
    heading.className = "terminal-auth-heading";
    heading.textContent = "Reconnect to uatu";
    const help = document.createElement("p");
    help.className = "terminal-auth-help";
    help.textContent = "Paste the token printed by `uatu` in your shell to continue.";
    const form = document.createElement("form");
    form.className = "terminal-auth-form";
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.className = "terminal-auth-input";
    input.placeholder = "paste token";
    input.setAttribute("aria-label", "uatu terminal token");
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "terminal-auth-submit";
    submit.textContent = "Connect";
    const status = document.createElement("p");
    status.className = "terminal-auth-status";
    status.setAttribute("aria-live", "polite");
    form.append(input, submit);
    wrap.append(heading, help, form, status);
    panesContainer!.append(wrap);
    requestAnimationFrame(() => input.focus());

    form.addEventListener("submit", async event => {
      event.preventDefault();
      const token = input.value.trim();
      if (!token) return;
      submit.disabled = true;
      status.textContent = "Validating…";
      if (!await persistTerminalToken(token)) {
        submit.disabled = false;
        status.textContent = "Token rejected. Check the value printed by uatu in your shell.";
        input.select();
        return;
      }
      try {
        window.sessionStorage.setItem(TERMINAL_TOKEN_KEY_LOCAL, token);
      } catch {
        // The HttpOnly cookie is sufficient when sessionStorage is unavailable.
      }
      wrap.remove();
      void addPaneInteractive();
    });
  }

  function renderTerminalOriginRejected(): void {
    if (panesContainer!.querySelector(".terminal-origin-rejected")) return;
    const wrap = document.createElement("div");
    wrap.className = "terminal-pane terminal-origin-rejected";
    const heading = document.createElement("p");
    heading.className = "terminal-origin-rejected-heading";
    heading.textContent = "Terminal blocked for this address";
    const help = document.createElement("p");
    help.className = "terminal-origin-rejected-help";
    help.textContent =
      `Your credentials are valid, but ${window.location.host} did not pass the terminal origin check. `
      + "Open uatu through localhost or 127.0.0.1 on the same port.";
    wrap.append(heading, help);
    panesContainer!.append(wrap);
  }

  async function killSessionRemote(id: string): Promise<boolean> {
    try {
      const token = getToken();
      const url = token
        ? appUrl(`/api/terminal/sessions/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`)
        : appUrl(`/api/terminal/sessions/${encodeURIComponent(id)}`);
      const response = await fetch(url, { method: "DELETE" });
      return response.status === 204;
    } catch {
      return false;
    }
  }

  // Pane-spawn against live inventory. A detached PTY belongs to nobody, so
  // every one of them attaches silently — asking about a session no client
  // owns is friction that buys nothing. What's left needs the user: sessions
  // held by another window (takeover is destructive to that window) and
  // detached overflow past the pane cap. Empty inventory falls straight
  // through to a fresh pane, keeping the zero-friction default.
  async function addPaneInteractive(): Promise<void> {
    if (panes.size >= TERMINAL_MAX_PANES) return;
    const inventory = await fetchSessionInventory();
    // The await yields: bail if the panel closed or filled up meanwhile.
    if (panel!.hasAttribute("hidden") || panes.size >= TERMINAL_MAX_PANES) return;
    const plan = resolveSessionPlan(
      inventory,
      Array.from(panes.values(), pane => pane.record.sessionId),
      TERMINAL_MAX_PANES - panes.size,
    );
    if (plan.attach.length > 0) {
      await attachSessionBatch(plan.attach);
      return;
    }
    if (plan.decide.length === 0) {
      await addPane();
      return;
    }
    // Touch mode has no room for two competing session surfaces: the switcher
    // is the chooser there, and it already lists everything `decide` holds.
    if (touchModeNow()) {
      openSwitcher(inventory);
      return;
    }
    renderSessionPicker(plan.decide);
  }

  // Attach a planned batch, one at a time: `addPane` re-checks the pane cap
  // and the panel's hidden state on every call and mutates shared DOM through
  // `rebuildPanesContainer`, so sequencing keeps both invariants without new
  // locking.
  //
  // `batchingAttach` suppresses per-pane activation for the whole loop. That
  // is not an optimization detail — activating a pane writes `lastPtyId` and
  // persists it, so letting each attach activate itself would overwrite the
  // user's saved last-active reference with the last session attached, and
  // the "last-active wins" rule below would then always resolve to it. The
  // saved id is snapshotted anyway, so the rule survives even if some future
  // path activates mid-batch. Suppression also spares N-1 refits, N-1 focus
  // grabs (each one a software-keyboard flash on touch), and N-1 personal-
  // state writes.
  async function attachSessionBatch(sessions: TerminalSessionInfo[]): Promise<void> {
    const savedLastPtyId = lastPtyId;
    const landed: TerminalSessionInfo[] = [];
    batchingAttach = true;
    try {
      for (const session of sessions) {
        if (panel!.hasAttribute("hidden") || panes.size >= TERMINAL_MAX_PANES) break;
        const entry = await addPane({ sessionId: session.id, createdAt: Date.now() });
        if (entry) landed.push(session);
      }
    } finally {
      batchingAttach = false;
    }
    if (landed.length === 0) return;
    const activeSessionId = resolveActiveSessionId(landed, savedLastPtyId);
    const ordered = Array.from(panes.values());
    const activeEntry =
      ordered.find(entry => entry.record.sessionId === activeSessionId) ?? ordered.at(-1);
    if (activeEntry) {
      setActivePane(activeEntry.record.id);
      // A user-initiated show parks its focus intent until a pane exists.
      // Consume it here rather than in `addPane`, so focus lands on the pane
      // the batch chose instead of whichever one happened to attach first.
      if (focusPaneWhenReady) {
        focusPaneWhenReady = false;
        activeEntry.handle.focus();
      }
    }
    requestAnimationFrame(() => fitAll());
  }

  function renderSessionPicker(candidates: TerminalSessionInfo[]) {
    const wrap = document.createElement("div");
    wrap.className = "terminal-pane terminal-picker";
    const heading = document.createElement("p");
    heading.className = "terminal-picker-heading";
    heading.textContent = "Running sessions";
    const list = document.createElement("div");
    list.className = "terminal-picker-list";

    const dismiss = () => wrap.remove();

    for (const session of candidates) {
      const row = document.createElement("div");
      row.className = "terminal-picker-row";
      if (session.id === lastPtyId) row.classList.add("is-last-active");

      const label = document.createElement("span");
      label.className = "terminal-picker-label";
      label.textContent = session.label;
      const meta = document.createElement("span");
      meta.className = "terminal-picker-meta";
      const lastActive = session.id === lastPtyId ? "last active · " : "";
      meta.textContent = `${lastActive}${session.attached ? "attached elsewhere" : "detached"} · ${formatSessionAge(session.createdAt, Date.now())}`;

      const attach = document.createElement("button");
      attach.type = "button";
      attach.className = "terminal-picker-attach";
      attach.textContent = session.attached ? "Take over" : "Attach";
      attach.addEventListener("click", () => {
        dismiss();
        void addPane({ sessionId: session.id, createdAt: Date.now() }, { takeover: session.attached });
      });

      const kill = document.createElement("button");
      kill.type = "button";
      kill.className = "terminal-picker-kill";
      kill.textContent = "Kill";
      kill.setAttribute("aria-label", `Kill session ${session.label}`);
      kill.addEventListener("click", () => {
        kill.disabled = true;
        void killSessionRemote(session.id).then(ok => {
          if (ok) {
            if (lastPtyId === session.id) {
              lastPtyId = undefined;
              persistPersonalWorkspaceState({ lastPtyId: null });
            }
            row.remove();
            if (list.childElementCount === 0) {
              // Nothing left to offer — fall through to a fresh shell.
              dismiss();
              void addPane();
            }
          } else {
            kill.disabled = false;
          }
        });
      });

      row.append(label, meta, attach, kill);
      list.append(row);
    }

    const fresh = document.createElement("button");
    fresh.type = "button";
    fresh.className = "terminal-picker-fresh";
    fresh.textContent = "New shell";
    fresh.addEventListener("click", () => {
      dismiss();
      void addPane();
    });

    wrap.append(heading, list, fresh);
    panesContainer!.appendChild(wrap);
    requestAnimationFrame(() => fresh.focus());
  }

  // ------------- Touch terminal switcher -------------
  //
  // Touch mode renders one pane at a time, so this sheet is the only way to
  // reach the others. It also absorbs everything the desktop chooser does —
  // attach, take over, terminate, new shell — because a phone has no room for
  // two competing session surfaces.

  function isSwitcherOpen(): boolean {
    return switcherOpen;
  }

  function dismissSwitcher(): boolean {
    if (!switcherEl || !switcherOpen) return false;
    switcherOpen = false;
    switcherEl.setAttribute("hidden", "");
    switcherEl.replaceChildren();
    // The keybar button mirrors the sheet's state; every dismissal path
    // (backdrop, Escape, a chosen row, panel hide) has to announce itself or
    // `aria-expanded` goes stale.
    document.dispatchEvent(new Event("uatu:terminal-switcher-change"));
    // Focus goes back where the user left it: the visible terminal. Without
    // this the software keyboard stays down after a dismissal that changed
    // nothing.
    const entry = activePaneId ? panes.get(activePaneId) : undefined;
    try {
      entry?.handle.focus();
    } catch {
      // Pane torn down while the sheet was open.
    }
    return true;
  }

  // `known` lets a caller that just read inventory hand it over instead of
  // paying for a second round trip a moment later.
  function openSwitcher(known?: TerminalSessionInfo[]): boolean {
    if (!switcherEl || switcherOpen) return false;
    // Claim the open state before awaiting anything, so a second activation
    // during the fetch closes the sheet instead of racing another render.
    switcherOpen = true;
    document.dispatchEvent(new Event("uatu:terminal-switcher-change"));
    void renderSwitcher(known);
    return true;
  }

  // Paints the sheet's current content. Also called to refresh an open sheet
  // after a listed session is terminated — never to open one, which is
  // `openSwitcher`'s job.
  async function renderSwitcher(known?: TerminalSessionInfo[]): Promise<void> {
    if (!switcherEl || !switcherOpen) return;
    const inventory = known ?? await fetchSessionInventory();
    // The await yields. A dismissal, a panel close, or a tab switch during the
    // fetch must win: repainting here would resurrect a sheet the user already
    // closed, or paint one into a surface that is no longer on screen.
    if (!switcherOpen) return;
    if (!terminalSurfaceShowing(panel!)) {
      dismissSwitcher();
      return;
    }
    const activeSessionId = activePaneId
      ? panes.get(activePaneId)?.record.sessionId
      : undefined;
    const rows = buildSwitcherRows(
      Array.from(panes.values(), entry => ({ sessionId: entry.record.sessionId })),
      inventory,
      activeSessionId,
      lastPtyId,
      Date.now(),
      TERMINAL_MAX_PANES - panes.size,
    );

    switcherEl.replaceChildren();
    switcherEl.removeAttribute("hidden");

    const backdrop = document.createElement("div");
    backdrop.className = "terminal-switcher-backdrop";
    backdrop.addEventListener("click", () => dismissSwitcher());

    const sheet = document.createElement("div");
    sheet.className = "terminal-switcher-sheet";

    const heading = document.createElement("p");
    heading.className = "terminal-switcher-heading";
    heading.textContent = "Terminals";

    const list = document.createElement("div");
    list.className = "terminal-switcher-list";
    for (const row of rows) list.append(buildSwitcherRow(row));

    const atCap = panes.size >= TERMINAL_MAX_PANES;
    const fresh = document.createElement("button");
    fresh.type = "button";
    fresh.className = "terminal-switcher-new";
    fresh.textContent = "New terminal";
    if (atCap) {
      fresh.disabled = true;
      fresh.title = `Close a terminal first — this window holds the maximum of ${TERMINAL_MAX_PANES}.`;
    }
    fresh.addEventListener("click", () => {
      dismissSwitcher();
      void addPane();
    });

    sheet.append(heading, list);
    if (atCap) {
      const note = document.createElement("p");
      note.className = "terminal-switcher-note";
      note.textContent = `This window holds the maximum of ${TERMINAL_MAX_PANES} terminals. Close one to attach or create another.`;
      sheet.append(note);
    }
    sheet.append(fresh);
    // The sheet is marked `aria-modal`, which is a promise that the rest of
    // the app is unreachable while it is up. Keyboard focus has to honor that
    // promise: without a wrap, Tab walks straight out of the dialog and into
    // an xterm the user cannot see behind the backdrop. Escape still closes
    // (the panel's capture-phase handler), so this is never a trap the user
    // cannot leave.
    sheet.addEventListener("keydown", event => {
      if (event.key !== "Tab") return;
      const focusable = [...sheet.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = sheet.ownerDocument.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    });
    switcherEl.append(backdrop, sheet);
    // The sheet takes focus deliberately — it is a context switch, and the
    // software keyboard going away is the point.
    requestAnimationFrame(() => {
      const first = sheet.querySelector<HTMLButtonElement>("button:not(:disabled)");
      (first ?? fresh).focus();
    });
  }

  function buildSwitcherRow(row: SwitcherRow): HTMLElement {
    const element = document.createElement("div");
    element.className = "terminal-switcher-row";
    element.dataset.sessionId = row.sessionId;
    element.dataset.state = row.state;
    if (row.state === "visible") element.dataset.current = "true";
    if (row.lastActive) element.classList.add("is-last-active");

    const select = document.createElement("button");
    select.type = "button";
    select.className = "terminal-switcher-select";
    select.disabled = !row.canSelect;

    const label = document.createElement("span");
    label.className = "terminal-switcher-label";
    label.textContent = row.label;

    const meta = document.createElement("span");
    meta.className = "terminal-switcher-meta";
    const lastActive = row.lastActive ? "last active · " : "";
    meta.textContent = `${lastActive}${SWITCHER_STATE_COPY[row.state]}${row.age ? ` · ${row.age}` : ""}`;

    select.append(label, meta);
    select.addEventListener("click", () => {
      if (!row.canSelect) return;
      const held = Array.from(panes.values()).find(
        entry => entry.record.sessionId === row.sessionId,
      );
      dismissSwitcher();
      if (held) {
        setActivePane(held.record.id);
        return;
      }
      void addPane({ sessionId: row.sessionId, createdAt: Date.now() });
    });
    element.append(select);

    if (row.state === "attached-elsewhere") {
      const takeOver = document.createElement("button");
      takeOver.type = "button";
      takeOver.className = "terminal-switcher-takeover";
      takeOver.textContent = "Take over";
      takeOver.setAttribute("aria-label", `Take over ${row.label}`);
      takeOver.disabled = !row.canTakeOver;
      takeOver.addEventListener("click", () => {
        dismissSwitcher();
        void addPane({ sessionId: row.sessionId, createdAt: Date.now() }, { takeover: true });
      });
      element.append(takeOver);
    }

    const kill = document.createElement("button");
    kill.type = "button";
    kill.className = "terminal-switcher-kill";
    kill.textContent = "Kill";
    kill.setAttribute("aria-label", `Kill session ${row.label}`);
    kill.addEventListener("click", () => {
      kill.disabled = true;
      void terminateFromSwitcher(row.sessionId).then(ok => {
        if (!ok) kill.disabled = false;
      });
    });
    element.append(kill);

    return element;
  }

  // Terminating from the switcher covers sessions this window holds as well as
  // ones it doesn't, and the two are genuinely different actions. A held
  // session is a terminal the user can see: it goes through `requestClosePane`,
  // which confirms the loss, terminates the PTY, hands the visible slot to a
  // surviving pane, and closes the panel when there is none. A session held by
  // nobody (or by another window) has no pane to lose, so it is a plain DELETE
  // with the sheet staying open — the same contract as the desktop chooser.
  async function terminateFromSwitcher(sessionId: string): Promise<boolean> {
    const held = Array.from(panes.values()).find(
      entry => entry.record.sessionId === sessionId,
    );
    if (held) {
      // The confirm modal is the surface now; two stacked sheets on a phone
      // is one too many.
      dismissSwitcher();
      requestClosePane(held.record.id);
      return true;
    }
    const ok = await killSessionRemote(sessionId);
    if (ok) {
      clearLastPty(sessionId);
      // Refresh the list so the terminated row disappears. A no-op when the
      // user dismissed the sheet while the DELETE was in flight — repainting
      // then would reopen a sheet they already closed.
      void renderSwitcher();
    }
    return ok;
  }

  function removePane(id: string) {
    const entry = panes.get(id);
    if (!entry) return;

    // Pick the successor BEFORE removing so we know the visual neighbor.
    // Prefer the next pane (right of bottom-dock, below in right-dock); if
    // closing the last pane, fall back to its predecessor.
    let successorId: string | null = null;
    if (activePaneId === id) {
      const ordered = Array.from(panes.values()).sort(
        (a, b) => a.record.createdAt - b.record.createdAt,
      );
      const closedIndex = ordered.findIndex(e => e.record.id === id);
      const successor = ordered[closedIndex + 1] ?? ordered[closedIndex - 1] ?? null;
      successorId = successor ? successor.record.id : null;
    }

    try {
      entry.handle.detach();
    } catch {
      // Already detached.
    }
    panes.delete(id);
    rebuildPanesContainer();
    if (activePaneId === id) {
      setActivePane(successorId);
    }
    persistState();
    if (panes.size === 0) {
      setVisible(false);
    } else {
      requestAnimationFrame(() => fitAll());
    }
  }

  let modalAcceptHandler: (() => void) | null = null;
  let modalPreviousFocus: HTMLElement | null = null;
  const modalTitleEl = document.getElementById("terminal-confirm-title");
  const modalBodyEl = document.getElementById("terminal-confirm-body");

  // Modal copy varies with how many sessions the user is about to lose:
  // closing one of several panes is a smaller action than closing the
  // whole panel.
  const MODAL_COPY = {
    pane: {
      title: "Close pane?",
      body: "You'll lose this terminal session and any running processes.",
    },
    panel: {
      title: "Close terminal?",
      body: "You'll lose every shell session in this panel and any running processes.",
    },
  } as const;

  function openConfirmModal(scope: "pane" | "panel", onAccept: () => void) {
    const copy = MODAL_COPY[scope];
    if (modalTitleEl) modalTitleEl.textContent = copy.title;
    if (modalBodyEl) modalBodyEl.textContent = copy.body;
    modalPreviousFocus = (document.activeElement as HTMLElement) ?? null;
    modalAcceptHandler = onAccept;
    modal!.removeAttribute("hidden");
    requestAnimationFrame(() => (modalCancel as HTMLButtonElement).focus());
  }

  function closeConfirmModal(accepted: boolean) {
    modal!.setAttribute("hidden", "");
    const handler = modalAcceptHandler;
    modalAcceptHandler = null;
    if (modalPreviousFocus && document.contains(modalPreviousFocus)) {
      modalPreviousFocus.focus();
    }
    modalPreviousFocus = null;
    if (accepted && handler) handler();
  }

  // Reconcile a stale or occupied saved reference against live inventory.
  // Takeover stays an explicit user action throughout.
  //
  // The reconcile is self-limiting: inventory's `attached` flag and the
  // upgrade gate's collision check read the same holder state server-side, so
  // the session that just refused this window comes back from the GET as
  // attached-elsewhere and lands in the decision set rather than being
  // auto-attached into the same collision. If the winner released it in the
  // meantime, re-attaching is the right answer anyway.
  function handlePaneUnavailable(id: string) {
    const entry = panes.get(id);
    if (!entry) return;
    try {
      entry.handle.detach();
    } catch {
      // Mount already tore itself down.
    }
    panes.delete(id);
    rebuildPanesContainer();
    if (activePaneId === id) activePaneId = null;
    persistState();
    void addPaneInteractive();
  }

  function requestClosePane(id: string) {
    const entry = panes.get(id);
    if (!entry) return;
    if (!entry.handle.isAttached()) {
      // The shell already exited (or the pane never attached). No session
      // to lose, so close silently.
      removePane(id);
      return;
    }
    openConfirmModal("pane", () => {
      // The user accepted losing the session: terminate() closes with the
      // user-terminate code so the server kills the PTY — a plain detach
      // would leave the shell running forever with its pane record gone.
      const current = panes.get(id);
      try {
        current?.handle.terminate();
      } catch {
        // Already torn down.
      }
      if (current) clearLastPty(current.record.sessionId);
      removePane(id);
    });
  }

  // Header × — destructive close: terminates every session AND clears the
  // persisted pane list so the next visibility toggle starts fresh. Must
  // terminate (not detach): the pane records are wiped below, so a detached
  // PTY would keep running with no way to ever reattach to it. The keyboard
  // toggle path (setVisible(false) without persist mutation) is intentionally
  // non-destructive: it's symmetric with hide, and the user can re-toggle to
  // reattach to the still-live PTYs.
  function closeAllPanes() {
    const attachedSessionIds = Array.from(panes.values(), pane => pane.record.sessionId);
    for (const id of Array.from(panes.keys())) {
      const entry = panes.get(id);
      if (entry) {
        try {
          entry.handle.terminate();
        } catch {
          // Already torn down.
        }
      }
      panes.delete(id);
    }
    if (attachedSessionIds.some(id => id === lastPtyId)) {
      lastPtyId = undefined;
      persistPersonalWorkspaceState({ lastPtyId: null });
    }
    panesContainer!.replaceChildren();
    activePaneId = null;
    // persistState() reads from the panes Map (now empty) so state.panes
    // becomes [], wiping the reattach hints.
    persistState();
    setVisible(false);
  }

  function setVisible(visible: boolean, persist = true, focusOnShow = false) {
    if (visible) {
      panel!.removeAttribute("hidden");
      resizer!.removeAttribute("hidden");
      toggle!.setAttribute("aria-pressed", "true");
      railTerminalToggle?.setAttribute("aria-pressed", "true");
      // Restore display mode and dock from persisted state on each show.
      applyDockToDom();
      applyDisplayModeToDom();
      // First show with no panes: spawn one. If the persisted pane list has
      // entries (reload / browser-restart restore path), reuse those
      // sessionIds so the server can hand back the still-live PTYs.
      if (panes.size === 0) {
        if (state.panes.length > 0) {
          for (const record of state.panes.slice(0, TERMINAL_MAX_PANES)) {
            void addPane(record);
          }
        } else {
          // Nothing to restore: offer existing sessions (orphans, other
          // windows' shells) before minting a fresh one.
          void addPaneInteractive();
        }
      }
      requestAnimationFrame(() => fitAll());
      // A user-initiated show should land the cursor in the terminal —
      // opening a terminal and then having to click into it is dead UX.
      // handle.focus() is deferred client-side (it parks the intent until
      // xterm actually opens), so no frame-timing guesses are needed. When
      // no pane exists yet (fresh spawn, session chooser), addPane consumes
      // the flag once the pane is created. Restore-on-boot shows pass
      // focusOnShow=false so page load never steals focus.
      if (focusOnShow) {
        const entry = activePaneId ? panes.get(activePaneId) : undefined;
        if (entry) {
          entry.handle.focus();
        } else {
          focusPaneWhenReady = true;
        }
      }
    } else {
      panel!.setAttribute("hidden", "");
      resizer!.setAttribute("hidden", "");
      toggle!.setAttribute("aria-pressed", "false");
      railTerminalToggle?.setAttribute("aria-pressed", "false");
      syncViewportSizer();
      // Detach every pane on hide. The PTYs keep running server-side, so a
      // re-show reattaches to the same sessions — hiding is never destructive.
      for (const entry of panes.values()) {
        try {
          entry.handle.detach();
        } catch {
          // Already detached.
        }
      }
      panes.clear();
      panesContainer!.replaceChildren();
      activePaneId = null;
      dismissSwitcher();
      // A hidden panel is not a surface: if the Terminal tab was active
      // (last pane closed, panel × in touch mode), land on Preview rather
      // than a blank screen. The resulting tab-change sees panelHidden and
      // is a no-op on pane state.
      if (touchTerminalActive()) {
        setActiveTab("preview");
      }
    }
    if (persist) writeTerminalVisiblePreference(visible);
  }

  function toggleVisible() {
    if (touchModeNow()) {
      // Hardware-keyboard toggle on a touch device: tabs own terminal
      // visibility, so Ctrl+` switches surfaces instead of hiding panes.
      setActiveTab(activeTab() === "terminal" ? "preview" : "terminal");
      return;
    }
    const visible = !panel!.hasAttribute("hidden");
    setVisible(!visible, true, true);
  }

  function setDock(next: TerminalDock) {
    state = { ...state, dock: next };
    persistState();
    applyDockToDom();
    // Reset any per-pane flex inline style from a previous split so panes
    // share equally after re-orientation — pixel widths set against the
    // horizontal axis don't translate to the vertical axis (and vice
    // versa). The user can re-resize after.
    for (const entry of panes.values()) {
      entry.element.style.flex = "";
      entry.element.style.flexBasis = "";
    }
    requestAnimationFrame(() => fitAll());
  }

  function setDisplayMode(next: TerminalDisplayMode) {
    state = { ...state, displayMode: next };
    persistState();
    applyDisplayModeToDom();
    if (next === "minimized") {
      // Minimized is a header strip; the sheet has no surface left to cover.
      // CSS hides it, but the state has to follow or Escape would keep
      // consuming keys on behalf of a sheet nobody can see.
      dismissSwitcher();
      // Don't dispose xterm — the PTY stays attached so output that arrives
      // while minimized renders into scrollback as soon as we restore.
      return;
    }
    // Restoring (normal | fullscreen) needs xterm to re-fit because the
    // body's rect just changed.
    requestAnimationFrame(() => fitAll());
  }

  function splitActive() {
    if (panes.size >= TERMINAL_MAX_PANES) return;
    // Explicit new-pane action: same picker-first flow as the first open, so
    // orphaned or other-window sessions are reachable from any window.
    void addPaneInteractive();
  }

  // ------------- Wiring -------------

  toggle.addEventListener("click", toggleVisible);
  railTerminalToggle?.addEventListener("click", toggleVisible);

  // Extra refits around software-keyboard focus transitions: visualViewport
  // height can lag the keyboard animation, so a fit on focus change closes
  // the final gap (D4 in the change's design.md).
  panel.addEventListener("focusin", () => {
    if (viewportSizer.isAttached()) requestAnimationFrame(() => fitAll());
  });
  panel.addEventListener("focusout", () => {
    if (viewportSizer.isAttached()) requestAnimationFrame(() => fitAll());
  });
  closeButton.addEventListener("click", () => {
    if (panes.size === 0) {
      setVisible(false);
      return;
    }
    // Closing the panel via the panel-level × is treated as closing every
    // pane; if any are attached, confirm once.
    const anyAttached = Array.from(panes.values()).some(p => p.handle.isAttached());
    if (!anyAttached) {
      closeAllPanes();
      return;
    }
    openConfirmModal("panel", () => closeAllPanes());
  });

  splitButton.addEventListener("click", () => splitActive());
  dockButton.addEventListener("click", () => {
    setDock(state.dock === "bottom" ? "right" : "bottom");
  });
  minimizeButton.addEventListener("click", () => {
    setDisplayMode(effectiveDisplayMode() === "minimized" ? "normal" : "minimized");
  });
  fullscreenButton.addEventListener("click", () => {
    if (effectiveDisplayMode() === "fullscreen") {
      // In touch mode leaving the fullscreen terminal is a tab switch —
      // the stored display-mode preference stays untouched and every PTY
      // stays attached. Desktop restores the docked strip.
      if (touchModeNow()) {
        setActiveTab("preview");
      } else {
        setDisplayMode("normal");
      }
    } else {
      setDisplayMode("fullscreen");
    }
  });

  // Font-size stepper (coarse-pointer only, CSS-gated like the keybar).
  const fontDecreaseButton = document.getElementById("terminal-font-decrease");
  const fontIncreaseButton = document.getElementById("terminal-font-increase");
  fontDecreaseButton?.addEventListener("click", () => stepFontSize(-1));
  fontIncreaseButton?.addEventListener("click", () => stepFontSize(1));
  modalCancel.addEventListener("click", () => closeConfirmModal(false));
  modalAccept.addEventListener("click", () => closeConfirmModal(true));
  modal.addEventListener("click", event => {
    // Backdrop click cancels (treated as "no").
    if (event.target === modal) closeConfirmModal(false);
  });

  // Keyboard shortcuts. Capture phase so xterm.js — which attaches its own
  // keydown listener on the helper-textarea inside each pane and may
  // stopPropagation on certain keys — can't shadow our panel-level
  // shortcuts. Don't shadow normal backtick typing inside the terminal —
  // only intercept when a modifier is held; for non-shortcut keys we
  // simply return without preventDefault so xterm still receives them.
  document.addEventListener(
    "keydown",
    event => {
      if (event.altKey) return;
      if (event.key === "`" || event.key === "´") {
        if (!event.ctrlKey && !event.metaKey) return;
        if (event.shiftKey) {
          // Cmd/Ctrl+Shift+` → split.
          if (panel!.hasAttribute("hidden")) return;
          event.preventDefault();
          event.stopPropagation();
          splitActive();
          return;
        }
        // Cmd/Ctrl+` → toggle.
        event.preventDefault();
        event.stopPropagation();
        toggleVisible();
        return;
      }
      // Esc cancels the confirm modal if open; otherwise exits fullscreen.
      // No panel-focus check — when the panel is in fullscreen it's filling
      // the main area and the user expects Esc to escape it regardless of
      // exact focus.
      if (event.key === "Escape") {
        const activeEntry = activePaneId ? panes.get(activePaneId) : undefined;
        const action = resolveTerminalEscapeAction({
          switcherOpen: isSwitcherOpen(),
          selectionSheetOpen: activeEntry?.handle.isSelectionSheetOpen() ?? false,
          confirmModalOpen: !modal!.hasAttribute("hidden"),
          storedDisplayMode: state.displayMode,
          touchMode: touchModeNow(),
          terminalTabActive: activeTab() === "terminal",
        });
        if (action === "pass-through") return;
        event.preventDefault();
        event.stopPropagation();
        switch (action) {
          case "dismiss-switcher":
            dismissSwitcher();
            return;
          case "dismiss-selection":
            activeEntry?.handle.dismissSelectionSheet();
            return;
          case "cancel-modal":
            closeConfirmModal(false);
            return;
          case "exit-fullscreen":
            if (touchModeNow()) {
              setActiveTab("preview");
            } else {
              setDisplayMode("normal");
            }
            return;
        }
      }
    },
    true,
  );

  // Drag-to-resize for the panel itself. Orientation depends on the dock:
  // bottom = vertical drag (height), right = horizontal drag (width).
  resizer.addEventListener("pointerdown", event => {
    event.preventDefault();
    // setPointerCapture so a drag that escapes the 4px resizer (or leaves
    // the browser window momentarily) keeps receiving move/up events on
    // this element. Without it, an interrupted drag could leave
    // `is-resizing-terminal` stuck on <body> with the cursor and event
    // routing in a "still resizing" state.
    resizer.setPointerCapture(event.pointerId);
    const dock = effectiveDock();
    document.body.classList.add("is-resizing-terminal");
    const startX = event.clientX;
    const startY = event.clientY;
    const rect = panel!.getBoundingClientRect();
    const startHeight = rect.height;
    const startWidth = rect.width;

    function onMove(ev: PointerEvent) {
      if (dock === "bottom") {
        const delta = startY - ev.clientY;
        const next = clampTerminalHeight(startHeight + delta);
        document.documentElement.style.setProperty("--terminal-panel-height", `${next}px`);
      } else {
        const delta = startX - ev.clientX;
        const next = clampTerminalWidth(startWidth + delta);
        document.documentElement.style.setProperty("--terminal-panel-width", `${next}px`);
      }
      fitAll();
    }

    function onUp(ev: PointerEvent) {
      try {
        resizer!.releasePointerCapture(ev.pointerId);
      } catch {
        // Pointer already released.
      }
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-resizing-terminal");
      const finalRect = panel!.getBoundingClientRect();
      if (dock === "bottom") {
        state = { ...state, bottomHeight: Math.round(finalRect.height) };
      } else {
        state = { ...state, rightWidth: Math.round(finalRect.width) };
      }
      persistState();
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });

  // Re-evaluate the right-dock fallback on viewport changes (rotation
  // crosses the width breakpoint), so users who resize mid-session don't
  // get stuck with an unusable layout.
  window.addEventListener("resize", () => {
    applyDockToDom();
    applyDisplayModeToDom();
    fitAll();
  });

  // Touch tab switching (touch-tab-navigation). The PTY-preserving contract
  // lives in terminalActionForTabChange (unit-pinned): leaving the Terminal
  // tab NEVER routes through setVisible(false) — the surface hides via CSS
  // only, panes and PTYs stay attached, exactly like minimize.
  onActiveTabChange(tab => {
    if (!touchModeNow()) return;
    if (tab === "terminal") setTerminalTabBadge(false);
    const action = terminalActionForTabChange(tab === "terminal", panel!.hasAttribute("hidden"));
    switch (action) {
      case "show":
        // Same spawn/reattach path as the desktop toggle.
        setVisible(true, true, true);
        break;
      case "reveal": {
        // Panes stayed attached while parked; the surface reappears via
        // CSS. Recompute the display promotion, refit, focus.
        applyDisplayModeToDom();
        requestAnimationFrame(() => fitAll());
        const entry = activePaneId ? panes.get(activePaneId) : undefined;
        entry?.handle.focus();
        break;
      }
      case "keep-attached":
        // Minimize semantics without the strip: only the display attribute
        // and viewport sizer change. No pane teardown of any kind.
        applyDisplayModeToDom();
        break;
      case "none":
        break;
    }
    // Leaving the Terminal tab takes the sheet with it. The panel stays
    // mounted here by design (PTYs must survive the switch), so nothing else
    // marks the switcher as gone: it would keep claiming Escape from the
    // Preview find bar, absorb an inventory refresh into an invisible
    // repaint, and reappear unbidden on the way back.
    if (tab !== "terminal") dismissSwitcher();
  });

  // Mode flips normalize surface state live: desktop restores the stored
  // dock/display (the promotion evaporates with the mode), touch re-applies
  // the active tab's surface. An active Terminal tab with no live panel
  // falls back to Preview instead of a blank surface.
  onUiModeChange(() => {
    if (touchModeNow() && activeTab() === "terminal" && panel!.hasAttribute("hidden")) {
      setActiveTab("preview");
    }
    applyDockToDom();
    applyDisplayModeToDom();
    requestAnimationFrame(() => fitAll());
  });

  // First paint: apply persisted dock + display mode even before any panes
  // exist so the panel chrome is correctly oriented when shown.
  applyDockToDom();
  applyDisplayModeToDom();

  // Restore visibility from the previous session in this tab.
  if (readTerminalVisiblePreference()) {
    setVisible(true, false);
  } else if (touchTerminalActive()) {
    // The persisted active tab says Terminal but this browser tab has no
    // terminal session to restore. Spawning one would violate the
    // no-auto-spawn boot contract, so land on Preview instead.
    setActiveTab("preview");
  }
}
