// Touch navigation presents four persistent surfaces through an overlay and
// movable edge handle. This owner controls active-tab state, workspace-local
// tab persistence, presentation timing, and the sidebar's mode escape.
//
// Surface behavior lives with the surfaces: terminal/panel.ts subscribes to
// tab changes to run its show/keep-attached semantics, and the tree's Rule A
// selection handler calls setActiveTab("preview") on a document pick.

import { ACTIVE_TAB_KEY, appState, safeLocalStorage, type TouchTab } from "./state";
import { workspaceForeground, onWorkspaceForegroundChange } from "../hub/mobile/coordinator-context";
import { onUiModeChange, setUiMode, uiMode } from "./ui-mode";
import { isChatPanelOpen } from "../chat/surface";
import { isHubAvailable, onHubAvailabilityChange } from "./hub-nav";
import { DEFAULT_NAVIGATION_PLACEMENT, confirmNavigationHubScope, getNavigationPreferences, onNavigationPreferencesChange, setNavigationPreferences } from "./navigation-preferences";

export type TabChangeListener = (tab: TouchTab, previous: TouchTab) => void;

const listeners = new Set<TabChangeListener>();

let barElement: HTMLElement | null = null;
let tabButtons: HTMLButtonElement[] = [];
let ready = false;
let resetIdle = () => {};
let revealOverlay = () => {};
let refreshReadiness = () => {};
/** Return reveals navigation without choosing a surface or moving focus. */
export function revealWorkspaceNavigation() { if (workspaceForeground()) revealOverlay(); }
const boundsListeners = new Set<() => void>();

export function navigationWorkspaceReady(): void {
  ready = true;
  refreshReadiness();
  resetIdle();
}

export function navigationOverlayBounds(): DOMRect | null {
  if (!workspaceForeground() || uiMode() !== "touch" || !barElement || !barElement.hasAttribute("data-navigation-ready") || barElement.hidden || !barElement.getClientRects().length) return null;
  return barElement.getBoundingClientRect();
}

export function onNavigationOverlayBoundsChange(listener: () => void): () => void {
  boundsListeners.add(listener);
  return () => { boundsListeners.delete(listener); };
}

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
  document.dispatchEvent(new Event("uatu:before-surface-change"));
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
 *  (tree row, search result), a commit click. In
 *  touch mode that intent includes SEEING it, so the Preview surface comes
 *  forward; in desktop mode the preview is already visible and this is a
 *  no-op. Programmatic updates (follow Rules C/D, file events) must never
 *  call this. */
export function revealPreviewSurface(): void {
  if (uiMode() === "touch") {
    setActiveTab("preview");
  }
}

/** The Files counterpart: a user action is about to act on something in the
 *  sidebar pane stack, so the stack has to be on screen. Project search is the
 *  case that needs it — `⇧⌘F` focused its query input while
 *  `html[data-ui-mode="touch"] .sidebar { display: none }` kept the whole
 *  sidebar hidden, so the shortcut was consumed and looked dead (#192). A
 *  no-op in desktop mode, where the sidebar is part of the layout. */
export function revealFilesSurface(): void {
  if (uiMode() === "touch") {
    setActiveTab("files");
  }
}

/** Navigation overlays never reserve workspace space. */
export function tabBarBottomInset(): number {
  return 0;
}

/** Backend-off sessions keep the four-surface navigation stable but disable
 *  Terminal, and an active Terminal tab falls back to Preview. Called by
 *  setupTerminalPanel once the backend state is known. */
export function setTerminalTabAvailable(available: boolean): void {
  const terminalButton = tabButtons.find(button => button.dataset.tab === "terminal");
  if (terminalButton) {
    terminalButton.hidden = false;
    terminalButton.disabled = !available;
    terminalButton.setAttribute("aria-disabled", String(!available));
    terminalButton.title = available ? "Terminal" : "Terminal is unavailable in this workspace";
  }
  if (!available && appState.activeTab === "terminal") {
    setActiveTab("preview");
  }
}

/** Show or clear the Terminal tab's unseen-output dot. Cleared implicitly on
 *  activation by the caller (terminal/panel.ts). */
export function setTerminalTabBadge(on: boolean): void {
  const terminalButton = tabButtons.find(button => button.dataset.tab === "terminal");
  terminalButton?.toggleAttribute("data-badge", on);
  terminalButton?.setAttribute("aria-label", on ? "Terminal, unseen output" : "Terminal");
}

function initNavigationOverlay(bar: HTMLElement): void {
  const handle = document.getElementById("navigation-handle") as HTMLButtonElement | null;
  const close = document.getElementById("navigation-close");
  const hub = document.getElementById("navigation-hub") as HTMLAnchorElement | null;
  const dialog = document.getElementById("navigation-preferences-dialog") as HTMLDialogElement | null;
  if (!handle || !close || !hub || !dialog) return;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let open = true;
  let initialized = false;
  let geometryValid = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  const pointers = new Set<number>();
  const keys = new Set<string>();
  let pointerFocus = false;
  let pointerTarget: EventTarget | null = null;
  let drag: { id: number; x: number; y: number; moved: boolean; side: "left" | "right"; position: number } | null = null;
  let suppressClick = false;
  let longPressTimer: ReturnType<typeof setTimeout> | undefined;
  let openPreferences = () => {};
  // The bar floats over the surfaces and reserves no layout gutter, so the
  // strip it covers has to be published for scroll reveals to avoid. Layout is
  // untouched; only `scroll-padding-bottom` consumes this.
  const publishOcclusion = () => {
    const covered = workspaceForeground() && bar.hasAttribute("data-navigation-ready") && open && !bar.hidden && uiMode() === "touch"
      ? Math.max(0, innerHeight - bar.getBoundingClientRect().top)
      : 0;
    document.documentElement.style.setProperty("--navigation-occluded", `${covered}px`);
  };
  const boundsChanged = () => { publishOcclusion(); for (const listener of boundsListeners) listener(); };
  const inside = (target: EventTarget | null) => target instanceof Node && (bar.contains(target) || handle.contains(target));
  const related = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest("#preview-file-navigation"));
  const modalOpen = () => Array.from(document.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"]'))
    .some(element => !element.hidden && element.getClientRects().length > 0);

  const finishDismissal = () => {
    if (open) return;
    bar.hidden = true;
    boundsChanged();
  };
  const show = (visible: boolean, focus = false) => {
    if (!ready || !initialized || !geometryValid) return;
    clearTimeout(fadeTimer);
    open = visible;
    if (visible) {
      // Keep a rendered start frame; CSS reverses an in-flight fade at its current opacity.
      bar.hidden = false;
      void bar.offsetHeight;
    }
    bar.dataset.open = String(visible);
    bar.inert = !visible;
    bar.setAttribute("aria-hidden", String(!visible));
    handle.setAttribute("aria-expanded", String(visible));
    handle.dataset.expanded = String(visible);
    if (!visible) {
      if (focus) handle.focus({ preventScroll: true });
      else if (bar.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      if (reducedMotion.matches) finishDismissal();
      else fadeTimer = setTimeout(finishDismissal, 280);
    } else if (focus) {
      (tabButtons.find(button => button.dataset.tab === activeTab() && !button.disabled) ?? close).focus({ preventScroll: true });
    }
    resetIdle();
    boundsChanged();
  };
  resetIdle = () => {
    clearTimeout(idleTimer);
    const focusProtected = bar.contains(document.activeElement) && !pointerFocus;
    if (!workspaceForeground() || !ready || !open || uiMode() !== "touch" || !getNavigationPreferences().autoHide
      || pointers.size || keys.size || focusProtected || modalOpen()) return;
    idleTimer = setTimeout(() => { if (modalOpen()) resetIdle(); else show(false); }, 7000);
  };

  const viewport = () => {
    const view = window.visualViewport;
    const style = getComputedStyle(handle);
    const top = (view?.offsetTop ?? 0) + parseFloat(style.paddingTop) + 8;
    const left = (view?.offsetLeft ?? 0) + parseFloat(style.paddingLeft);
    const right = (view?.offsetLeft ?? 0) + (view?.width ?? innerWidth) - parseFloat(style.paddingRight);
    const bottom = (view?.offsetTop ?? 0) + (view?.height ?? innerHeight) - parseFloat(style.paddingBottom) - 8;
    return { top, left, right, bottom, travel: Math.max(0, bottom - top - handle.offsetHeight) };
  };
  const place = () => {
    const value = drag ?? getNavigationPreferences();
    const view = viewport();
    handle.dataset.side = value.side;
    handle.style.left = `${value.side === "left" ? view.left : Math.max(view.left, view.right - handle.offsetWidth)}px`;
    handle.style.top = `${view.top + view.travel * value.position}px`;
    const visual = window.visualViewport;
    bar.style.left = `${(visual?.offsetLeft ?? 0) + 8}px`;
    bar.style.width = `${Math.max(0, (visual?.width ?? innerWidth) - 16)}px`;
    bar.style.bottom = `${Math.max(0, innerHeight - (visual?.offsetTop ?? 0) - (visual?.height ?? innerHeight)) + 8}px`;
    bar.style.maxHeight = `${Math.max(44, (visual?.height ?? innerHeight) - 16)}px`;
    geometryValid = [view.top, view.left, view.right, view.bottom, view.travel].every(Number.isFinite)
      && view.right > view.left && view.bottom > view.top && handle.offsetWidth > 0 && handle.offsetHeight > 0;
    const presented = ready && initialized && geometryValid;
    for (const element of [bar, handle]) element.toggleAttribute("data-navigation-ready", presented);
    handle.inert = !presented;
    bar.inert = !presented || !open;
    boundsChanged();
  };
  const endDrag = (cancelled: boolean) => {
    clearTimeout(longPressTimer);
    if (!drag) return;
    const completed = drag;
    drag = null;
    suppressClick = cancelled || completed.moved;
    if (handle.hasPointerCapture(completed.id)) handle.releasePointerCapture(completed.id);
    if (!cancelled && completed.moved) setNavigationPreferences({ side: completed.side, position: completed.position });
    // Remote placement was retained by the preference owner while the local draft was visible.
    place();
  };
  handle.addEventListener("pointerdown", event => {
    if (event.button !== 0 || drag) return;
    const value = getNavigationPreferences();
    suppressClick = false;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, side: value.side, position: value.position };
    handle.setPointerCapture(event.pointerId);
    // A press held in place opens the preferences sheet. The bar carries no
    // Preferences button (the design's bar is close + Hub + the four
    // surfaces), and standalone has no Hub Settings page to host it.
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      if (!drag || drag.id !== event.pointerId || drag.moved) return;
      endDrag(true);
      openPreferences();
    }, 500);
  });
  handle.addEventListener("pointermove", event => {
    if (!drag || drag.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 8) { drag.moved = true; clearTimeout(longPressTimer); }
    if (!drag.moved) return;
    const view = viewport();
    drag.side = event.clientX < (view.left + view.right) / 2 ? "left" : "right";
    drag.position = view.travel ? Math.max(0, Math.min(1, (event.clientY - view.top - handle.offsetHeight / 2) / view.travel)) : 0;
    place();
  });
  handle.addEventListener("pointerup", () => endDrag(false));
  handle.addEventListener("pointercancel", () => endDrag(true));
  handle.addEventListener("lostpointercapture", () => endDrag(true));
  handle.addEventListener("click", event => {
    if (suppressClick && event.detail !== 0) { suppressClick = false; return; }
    show(true, event.detail === 0);
  });
  handle.addEventListener("contextmenu", event => {
    event.preventDefault();
    endDrag(true);
    openPreferences();
  });
  handle.addEventListener("keydown", event => {
    const value = getNavigationPreferences();
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      openPreferences();
      return;
    }
    if (event.key === "ArrowLeft") setNavigationPreferences({ side: "left" });
    else if (event.key === "ArrowRight") setNavigationPreferences({ side: "right" });
    else if (event.key === "ArrowUp") setNavigationPreferences({ position: value.position - 0.05 });
    else if (event.key === "ArrowDown") setNavigationPreferences({ position: value.position + 0.05 });
    else if (event.key === "Home") setNavigationPreferences(DEFAULT_NAVIGATION_PLACEMENT);
    else return;
    event.preventDefault();
  });
  close.addEventListener("click", () => show(false, true));
  document.addEventListener("pointerdown", event => {
    if (!workspaceForeground()) return;
    pointerTarget = event.target;
    if (inside(event.target) || related(event.target)) { pointers.add(event.pointerId); pointerFocus = inside(event.target); resetIdle(); }
    else if (open && getNavigationPreferences().autoHide && !related(event.target) && !modalOpen()) show(false);
  }, true);
  const release = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    pointerTarget = null;
    resetIdle();
  };
  document.addEventListener("pointerup", release, true);
  document.addEventListener("pointercancel", release, true);
  document.addEventListener("focusin", event => {
    if (!workspaceForeground()) return;
    pointerFocus = pointerTarget instanceof Node && event.target instanceof Node
      && (pointerTarget === event.target || (event.target instanceof Element && event.target.contains(pointerTarget)));
    resetIdle();
  });
  document.addEventListener("focusout", () => queueMicrotask(resetIdle));
  document.addEventListener("close", resetIdle, true);
  document.addEventListener("beforeinput", event => {
    if (!workspaceForeground()) return;
    if (uiMode() === "touch" && open && getNavigationPreferences().autoHide
      && !inside(event.target) && !related(event.target) && !modalOpen()) show(false);
  }, true);
  document.addEventListener("keydown", event => {
    if (!workspaceForeground()) return;
    if (uiMode() !== "touch" || modalOpen()) return;
    if (event.key === "Escape" && open && inside(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      show(false, true);
      return;
    }
    if (inside(event.target)) {
      pointerFocus = false;
      keys.add(event.code);
      resetIdle();
    } else if (open && getNavigationPreferences().autoHide && !related(event.target)
      && !event.metaKey && !event.ctrlKey && !event.altKey && (event.key.length === 1 || event.key === "Backspace" || event.key === "Enter")) show(false);
  }, true);
  document.addEventListener("keyup", event => { keys.delete(event.code); resetIdle(); }, true);
  window.addEventListener("blur", () => { pointers.clear(); keys.clear(); endDrag(true); resetIdle(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { pointers.clear(); keys.clear(); endDrag(true); }
    resetIdle();
  });
  window.addEventListener("pageshow", event => { if (event.persisted) { endDrag(true); place(); show(true); } });
  window.addEventListener("resize", place);
  window.visualViewport?.addEventListener("resize", place);
  window.visualViewport?.addEventListener("scroll", place);
  new ResizeObserver(boundsChanged).observe(bar);
  revealOverlay = () => { place(); show(true); };
  refreshReadiness = () => { place(); show(true); };
  onWorkspaceForegroundChange(() => {
    pointers.clear(); keys.clear(); endDrag(true); resetIdle(); boundsChanged();
  });
  reducedMotion.addEventListener("change", () => { if (!open && reducedMotion.matches) finishDismissal(); });
  onUiModeChange(mode => {
    endDrag(true);
    if (dialog.open) dialog.close();
    place();
    show(mode === "touch");
  });

  const keepOpen = dialog.querySelector<HTMLInputElement>("#navigation-keep-open")!;
  const side = dialog.querySelector<HTMLSelectElement>("#navigation-side")!;
  const position = dialog.querySelector<HTMLInputElement>("#navigation-position")!;
  const previewSide = dialog.querySelector<HTMLSelectElement>("#navigation-preview-side")!;
  const syncPreferences = () => {
    const value = getNavigationPreferences();
    keepOpen.checked = !value.autoHide;
    side.value = value.side;
    position.value = String(value.position * 100);
    previewSide.value = value.previewSide;
    place();
    resetIdle();
  };
  openPreferences = () => { syncPreferences(); if (!dialog.open) dialog.showModal(); resetIdle(); };
  // Native dialog close restores its invoker synchronously; the queued close
  // event must not steal focus from a subsequent content interaction.
  dialog.addEventListener("close", resetIdle);
  keepOpen.addEventListener("change", () => setNavigationPreferences({ autoHide: !keepOpen.checked }));
  side.addEventListener("change", () => setNavigationPreferences({ side: side.value as "left" | "right" }));
  position.addEventListener("input", () => setNavigationPreferences({ position: Number(position.value) / 100 }));
  previewSide.addEventListener("change", () => setNavigationPreferences({ previewSide: previewSide.value as "left" | "right" }));
  onNavigationPreferencesChange(syncPreferences);
  const syncHub = (available: boolean) => {
    hub.hidden = !available;
    if (available) {
      confirmNavigationHubScope();
      hub.href = new URL("/", window.location.origin).href;
    }
    boundsChanged();
  };
  onHubAvailabilityChange(syncHub);
  syncHub(isHubAvailable());
  const syncAttention = () => {
    const attention = tabButtons.filter(button => button.hasAttribute("data-badge") || button.hasAttribute("data-chat-inventory-attention"));
    const chat = tabButtons.find(button => button.dataset.tab === "chat");
    if (chat?.hasAttribute("data-badge")) chat.setAttribute("aria-describedby", "navigation-chat-attention");
    else chat?.removeAttribute("aria-describedby");
    handle.toggleAttribute("data-attention", attention.length > 0);
    handle.setAttribute("aria-label", attention.length
      ? `Open workspace navigation, pending attention: ${attention.map(button => [button.getAttribute("aria-label") ?? button.dataset.tab, button.getAttribute("aria-description")].filter(Boolean).join(", ")).join("; ")}`
      : "Open workspace navigation");
  };
  new MutationObserver(syncAttention).observe(bar, { subtree: true, attributes: true, attributeFilter: ["data-badge", "data-chat-inventory-attention", "aria-label", "aria-description"] });
  syncAttention();
  syncPreferences();
  // The bar starts expanded, and CSS hides the handle behind
  // `[data-expanded="true"]`. Only `show()` writes that flag, and it does not
  // run at registration (`onUiModeChange` fires on change, not on subscribe),
  // so without this the collapsed handle paints on top of the expanded bar on
  // first frame.
  handle.dataset.expanded = String(open);
  handle.setAttribute("aria-expanded", String(open));
  initialized = true;
  place();
}

export function initTabBar(): void {
  barElement = document.getElementById("touch-tab-bar");
  if (!barElement) return;
  tabButtons = Array.from(barElement.querySelectorAll<HTMLButtonElement>("[data-tab]"));
  initNavigationOverlay(barElement);

  for (const button of tabButtons) {
    button.addEventListener("click", () => {
      const tab = button.dataset.tab;
      if (tab === "files" || tab === "preview" || tab === "chat" || tab === "terminal") {
        setActiveTab(tab);
        resetIdle();
      }
    });
    button.addEventListener("keydown", event => {
      const enabled = tabButtons.filter(candidate => !candidate.disabled);
      const index = enabled.indexOf(button);
      let target: HTMLButtonElement | undefined;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") target = enabled[(index + 1) % enabled.length];
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") target = enabled[(index - 1 + enabled.length) % enabled.length];
      else if (event.key === "Home") target = enabled[0];
      else if (event.key === "End") target = enabled.at(-1);
      if (!target) return;
      event.preventDefault();
      target.focus();
      target.click();
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
  // Mode-switch normalization, desktop→touch half: touch presents one
  // surface at a time, so entering it lands on Chat only when the user was
  // last working in an open Chat panel; otherwise Preview. The touch→desktop
  // half (Chat tab opens the panel) lives in chat/surface.ts.
  onUiModeChange(mode => {
    if (mode === "touch") {
      setActiveTab(appState.activeSurface === "chat" && isChatPanelOpen() ? "chat" : "preview");
    }
  });
  syncModeToggleLabels();

  // appState.activeTab was restored from storage at state-module init;
  // stamp it so the first paint lands on the persisted surface.
  applyActiveTabToDom();
}
