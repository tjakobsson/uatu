// Persistence helpers for the terminal panel's UI state. Pulled out of
// app.ts so they can be unit-tested with an in-memory storage stub instead
// of a full DOM harness. Pure functions over a `Storage`-shaped interface.

export const TERMINAL_VISIBLE_KEY = "uatu:terminal-visible";
export const TERMINAL_HEIGHT_KEY = "uatu:terminal-height";
export const TERMINAL_HEIGHT_MIN = 120;
export const TERMINAL_HEIGHT_MAX_FRACTION = 0.7;

// Subset of the Web Storage API we touch. Tests pass an in-memory stub;
// production passes `window.sessionStorage` / `window.localStorage`.
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

// Visible-state persistence. Stored in `sessionStorage` so a long-idle
// reload doesn't auto-attach a fresh PTY just because the user happened to
// have the panel open the day before.
export function readTerminalVisiblePreference(storage: StorageLike): boolean {
  try {
    return storage.getItem(TERMINAL_VISIBLE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeTerminalVisiblePreference(storage: StorageLike, visible: boolean): void {
  try {
    if (visible) {
      storage.setItem(TERMINAL_VISIBLE_KEY, "1");
    } else {
      storage.removeItem(TERMINAL_VISIBLE_KEY);
    }
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}

// Height-state persistence. Stored in `localStorage` because the user's
// preferred panel height is a long-lived preference, not a per-session
// setting.
export function readTerminalHeightPreference(storage: StorageLike): number | null {
  try {
    const raw = storage.getItem(TERMINAL_HEIGHT_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function writeTerminalHeightPreference(storage: StorageLike, height: number): void {
  try {
    storage.setItem(TERMINAL_HEIGHT_KEY, String(Math.round(height)));
  } catch {
    // Ignore storage failures.
  }
}

// Clamp a candidate panel height against the floor (`TERMINAL_HEIGHT_MIN`)
// and a ceiling derived from the viewport (`TERMINAL_HEIGHT_MAX_FRACTION`
// of the available height). The viewport height is passed in so tests
// don't need a real `window`.
export function clampTerminalHeight(value: number, viewportHeight: number): number {
  const max = Math.max(TERMINAL_HEIGHT_MIN, Math.floor(viewportHeight * TERMINAL_HEIGHT_MAX_FRACTION));
  return Math.max(TERMINAL_HEIGHT_MIN, Math.min(max, Math.round(value)));
}
