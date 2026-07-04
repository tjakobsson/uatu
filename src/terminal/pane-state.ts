// Persistence helpers for the terminal panel's UI state. Pulled out of
// app.ts so they can be unit-tested with an in-memory storage stub instead
// of a full DOM harness. Pure functions over a `Storage`-shaped interface.
//
// Two storage backends are addressed here:
//   * `localStorage` — long-lived layout/preference state (dock, sizes,
//     pane list, display mode). Survives reloads AND tab close/reopen.
//   * `sessionStorage` — per-tab visibility flag, so a long-idle reload in
//     a different day doesn't auto-spawn a fresh PTY just because the user
//     happened to have the panel open the day before.

export const TERMINAL_VISIBLE_KEY = "uatu:terminal-visible";
// Legacy key holding only the bottom-dock height as a stringified integer.
// Read once for migration into TERMINAL_STATE_KEY, then ignored on writes.
export const TERMINAL_HEIGHT_KEY = "uatu:terminal-height";
export const TERMINAL_STATE_KEY = "uatu:terminal-state";
// Per-window pane records (`sessionStorage`). The `panes` list inside
// TERMINAL_STATE_KEY (localStorage) doubles as the shared *restart hints*:
// a window that has no records of its own (fresh window, browser restart)
// adopts the hints; a window that lost a sessionId collision keeps its own
// records here and never writes the hints, so it cannot clobber the
// claimant window's ability to reattach.
export const TERMINAL_PANES_KEY = "uatu:terminal-panes";

export const TERMINAL_HEIGHT_MIN = 120;
export const TERMINAL_HEIGHT_MAX_FRACTION = 0.7;
export const TERMINAL_WIDTH_MIN = 280;
export const TERMINAL_WIDTH_MAX_FRACTION = 0.6;
// Below this viewport width, right-dock collapses back to bottom-dock so the
// preview isn't squeezed unusable. Preference is preserved for restoration.
export const TERMINAL_RIGHT_DOCK_VIEWPORT_MIN = 720;
// Soft cap on splits. The drag-resizer's per-pane minimum (80px) is the real
// limit on a given viewport; this number is a sanity bound that prevents
// runaway pane spawning and keeps the persisted-state shape small.
export const TERMINAL_MAX_PANES = 8;

export const TERMINAL_DEFAULT_BOTTOM_HEIGHT = 240;
export const TERMINAL_DEFAULT_RIGHT_WIDTH = 360;

export type TerminalDock = "bottom" | "right";
export type TerminalDisplayMode = "normal" | "minimized" | "fullscreen";

export type TerminalPaneRecord = {
  // Per-pane sessionId. UUID. Reused across reload — and across browser
  // restarts — to reattach to the same still-running PTY.
  id: string;
  // Wall-clock millis when the pane was first opened in this tab; used
  // for stable ordering when restoring multiple panes.
  createdAt: number;
};

export type TerminalPanelState = {
  dock: TerminalDock;
  displayMode: TerminalDisplayMode;
  bottomHeight: number;
  rightWidth: number;
  panes: TerminalPaneRecord[];
};

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

// Legacy height reader. Kept only so the migration path can pull the user's
// pre-upgrade height into the new shape; production code reads heights via
// `readTerminalPanelState().bottomHeight`.
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

// Legacy height writer. Production code never calls this — state writes
// go through `writeTerminalPanelState`. Kept exported so the migration
// tests can plant a legacy value in storage to verify the upgrade path.
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

// Right-dock width clamp; analogous to clampTerminalHeight but on the
// horizontal axis with its own floor/ceiling derived from the viewport
// width.
export function clampTerminalWidth(value: number, viewportWidth: number): number {
  const max = Math.max(TERMINAL_WIDTH_MIN, Math.floor(viewportWidth * TERMINAL_WIDTH_MAX_FRACTION));
  return Math.max(TERMINAL_WIDTH_MIN, Math.min(max, Math.round(value)));
}

export function defaultTerminalPanelState(): TerminalPanelState {
  return {
    dock: "bottom",
    displayMode: "normal",
    bottomHeight: TERMINAL_DEFAULT_BOTTOM_HEIGHT,
    rightWidth: TERMINAL_DEFAULT_RIGHT_WIDTH,
    panes: [],
  };
}

function isDock(value: unknown): value is TerminalDock {
  return value === "bottom" || value === "right";
}

function isDisplayMode(value: unknown): value is TerminalDisplayMode {
  return value === "normal" || value === "minimized" || value === "fullscreen";
}

// UUID v1-v5 + the nil UUID, lower-case. Matches the server's validator in
// terminal-server.ts so a value that survives persistence is also one the
// server will accept on the WS upgrade.
const PANE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function coercePane(value: unknown): TerminalPaneRecord | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as { id?: unknown }).id;
  const createdAt = (value as { createdAt?: unknown }).createdAt;
  // Reject anything the server would reject with HTTP 400, otherwise a
  // malformed persisted record causes the pane to immediately fail its
  // WS upgrade and surface the (misleading) paste-token form.
  if (typeof id !== "string" || !PANE_ID_RE.test(id)) return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  return { id, createdAt };
}

// Read the canonical panel state from `localStorage`. Falls through three
// branches:
//   1. New key present → parse + validate; return defaults for any field
//      that's missing or unrecognised.
//   2. New key absent but legacy key present → migrate the legacy height
//      into the new shape and return it. Tests rely on this path returning
//      the migrated value WITHOUT calling write — callers do the write.
//   3. Both absent → return defaults.
//
// The `write` flag, when true, persists the result back so callers don't
// need to. Most callers should pass it; the `false` form is for tests.
export function readTerminalPanelState(
  storage: StorageLike,
  options: { writeOnMigrate?: boolean } = {},
): TerminalPanelState {
  const defaults = defaultTerminalPanelState();
  let raw: string | null = null;
  try {
    raw = storage.getItem(TERMINAL_STATE_KEY);
  } catch {
    return defaults;
  }

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        dock: isDock(parsed.dock) ? parsed.dock : defaults.dock,
        displayMode: isDisplayMode(parsed.displayMode) ? parsed.displayMode : defaults.displayMode,
        bottomHeight:
          typeof parsed.bottomHeight === "number" && parsed.bottomHeight > 0
            ? parsed.bottomHeight
            : defaults.bottomHeight,
        rightWidth:
          typeof parsed.rightWidth === "number" && parsed.rightWidth > 0
            ? parsed.rightWidth
            : defaults.rightWidth,
        panes: Array.isArray(parsed.panes)
          ? parsed.panes.map(coercePane).filter((p): p is TerminalPaneRecord => p !== null)
          : defaults.panes,
      };
    } catch {
      // Corrupt JSON: treat as missing and fall through to migration / defaults.
    }
  }

  // Migration: legacy key holds the bottom-dock height.
  const legacyHeight = readTerminalHeightPreference(storage);
  if (legacyHeight !== null) {
    const migrated: TerminalPanelState = { ...defaults, bottomHeight: legacyHeight };
    if (options.writeOnMigrate !== false) {
      writeTerminalPanelState(storage, migrated);
    }
    return migrated;
  }

  return defaults;
}

export function writeTerminalPanelState(storage: StorageLike, state: TerminalPanelState): void {
  try {
    storage.setItem(TERMINAL_STATE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures.
  }
}

// This window's own pane records plus its standing relative to the shared
// restart hints. `hintOwner` is sticky across reloads (it persists with the
// records): a window that adopted the hints — or created its panes when no
// hints existed — keeps publishing its records as the hints; a window that
// lost a sessionId collision is permanently a non-owner so its records can
// never overwrite the claimant's.
export type OwnPaneRecords = {
  panes: TerminalPaneRecord[];
  hintOwner: boolean;
};

export function readOwnPaneRecords(storage: StorageLike): OwnPaneRecords | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(TERMINAL_PANES_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const panes = Array.isArray(parsed.panes)
      ? parsed.panes.map(coercePane).filter((p): p is TerminalPaneRecord => p !== null)
      : [];
    if (panes.length === 0) return null;
    return { panes, hintOwner: parsed.hintOwner === true };
  } catch {
    return null;
  }
}

export function writeOwnPaneRecords(storage: StorageLike, records: OwnPaneRecords): void {
  try {
    if (records.panes.length === 0) {
      storage.removeItem(TERMINAL_PANES_KEY);
    } else {
      storage.setItem(TERMINAL_PANES_KEY, JSON.stringify(records));
    }
  } catch {
    // Ignore storage failures.
  }
}

// Boot-time resolution of which pane records this window should try to
// claim. Own records (this window reloaded) win; otherwise the shared hints
// from the localStorage panel state are adopted — the server's duplicate-
// sessionId rejection arbitrates whether the adoption sticks. A window that
// boots from hints (or from nothing) starts as the prospective hint owner;
// it is demoted on its first lost collision.
export function resolveBootPaneRecords(
  sessionStore: StorageLike,
  localState: TerminalPanelState,
): OwnPaneRecords {
  const own = readOwnPaneRecords(sessionStore);
  if (own) return own;
  return { panes: localState.panes, hintOwner: true };
}
