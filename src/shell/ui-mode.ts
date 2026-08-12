// Per-device UI mode (touch-tab-navigation change): `touch` renders the
// one-surface-at-a-time layout with the bottom tab bar; `desktop` renders
// the sidebar + preview + docked-terminal layout exactly as a desktop
// browser does. Layout CSS keys on the `data-ui-mode` attribute this module
// stamps on <html>; input affordances (keybar, size steppers) deliberately
// stay keyed on `(pointer: coarse)` so an iPad in desktop mode keeps them.
//
// Resolution: a stored per-device override wins; otherwise coarse-pointer
// devices (iPhone AND iPad) default to touch, fine-pointer to desktop.
// Switching modes is live — an attribute re-stamp plus listener dispatch,
// no reload.

import { presentationLocalStorage } from "./presentation-storage";

export type UiMode = "touch" | "desktop";

export const UI_MODE_KEY = "uatu:ui-mode";

export type UiModeListener = (mode: UiMode) => void;

// Subset of the Web Storage API this module touches; tests pass a stub.
export type UiModeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isUiMode(value: unknown): value is UiMode {
  return value === "touch" || value === "desktop";
}

// Pure resolution over raw inputs so tests need no matchMedia: the stored
// override wins when valid; otherwise the pointer type decides.
export function resolveUiMode(storedOverride: string | null, coarsePointer: boolean): UiMode {
  if (isUiMode(storedOverride)) return storedOverride;
  return coarsePointer ? "touch" : "desktop";
}

export function readUiModeOverride(storage: UiModeStorage | null): UiMode | null {
  try {
    const raw = storage?.getItem(UI_MODE_KEY) ?? null;
    return isUiMode(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeUiModeOverride(storage: UiModeStorage | null, mode: UiMode | null): void {
  try {
    if (mode === null) {
      storage?.removeItem(UI_MODE_KEY);
    } else {
      storage?.setItem(UI_MODE_KEY, mode);
    }
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}

const listeners = new Set<UiModeListener>();

let currentMode: UiMode | null = null;

function coarsePointerNow(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

/** Whether the device's primary pointer is coarse — a finger rather than a
 *  cursor. Deliberately NOT the same question as `uiMode()`: an iPad in
 *  desktop mode still has no cursor, which is why input affordances (target
 *  sizes, the keybar, size steppers) key on this while layout keys on the
 *  mode. Exported from here because this module already owns the distinction. */
export function coarsePointer(): boolean {
  return coarsePointerNow();
}

function stamp(mode: UiMode): void {
  document.documentElement.setAttribute("data-ui-mode", mode);
}

/** The mode the UI currently renders. Resolves lazily so callers that run
 *  before initUiMode still get a correct answer. */
export function uiMode(): UiMode {
  if (currentMode === null) {
    currentMode = resolveUiMode(readUiModeOverride(presentationLocalStorage()), coarsePointerNow());
  }
  return currentMode;
}

/** Switch modes live: re-stamp <html>, persist the per-device override, and
 *  notify listeners (terminal panel, tab bar) so they normalize their
 *  surface state without a reload. */
export function setUiMode(mode: UiMode): void {
  if (uiMode() === mode) return;
  currentMode = mode;
  writeUiModeOverride(presentationLocalStorage(), mode);
  stamp(mode);
  for (const listener of listeners) {
    listener(mode);
  }
  // A mode flip reshapes every surface at once. Fire a resize on the next
  // frame (after the new layout has been computed) so consumers that size
  // themselves from resize events — pane height normalization, split
  // ratios, the terminal's dock fallback — settle without needing their
  // own mode subscription.
  requestAnimationFrame(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

/** Subscribe to live mode changes. Returns an unsubscribe function. */
export function onUiModeChange(listener: UiModeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Boot-time stamping. Runs first in app.ts so mode-keyed layout applies
 *  before anything else renders. */
export function initUiMode(): void {
  stamp(uiMode());
}
