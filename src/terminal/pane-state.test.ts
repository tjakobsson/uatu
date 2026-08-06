import { beforeEach, describe, expect, it } from "bun:test";

import {
  TERMINAL_DEFAULT_BOTTOM_HEIGHT,
  TERMINAL_DEFAULT_RIGHT_WIDTH,
  TERMINAL_HEIGHT_KEY,
  TERMINAL_HEIGHT_MIN,
  TERMINAL_STATE_KEY,
  TERMINAL_VISIBLE_KEY,
  TERMINAL_WIDTH_MIN,
  clampTerminalHeight,
  clampTerminalWidth,
  defaultTerminalPanelState,
  TERMINAL_PANES_KEY,
  readOwnPaneRecords,
  readTerminalHeightPreference,
  readTerminalPanelState,
  readTerminalVisiblePreference,
  resolveBootPaneRecords,
  writeOwnPaneRecords,
  writeTerminalHeightPreference,
  writeTerminalPanelState,
  writeTerminalVisiblePreference,
  PHONE_CLASS_VIEWPORT_MAX,
  TERMINAL_FONT_SIZE_KEY,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  clampTerminalFontSize,
  isPhoneClassViewport,
  readTerminalFontSizeOverride,
  resolveEffectiveDisplayMode,
  resolveTerminalFontSize,
  writeTerminalFontSizeOverride,
  type StorageLike,
} from "./pane-state";

function createMemoryStorage(): StorageLike & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key, value) {
      map.set(key, value);
    },
    removeItem(key) {
      map.delete(key);
    },
    dump() {
      return Object.fromEntries(map);
    },
  };
}

// Storage that throws on every operation — simulates browsers in private
// mode or storage-quota-exceeded states. The helpers must swallow these
// errors so a transient storage failure doesn't take down the panel.
function createFailingStorage(): StorageLike {
  return {
    getItem() {
      throw new DOMException("storage disabled", "SecurityError");
    },
    setItem() {
      throw new DOMException("storage disabled", "SecurityError");
    },
    removeItem() {
      throw new DOMException("storage disabled", "SecurityError");
    },
  };
}

let storage: ReturnType<typeof createMemoryStorage>;

beforeEach(() => {
  storage = createMemoryStorage();
});

describe("readTerminalVisiblePreference", () => {
  it("returns false when no preference is stored", () => {
    expect(readTerminalVisiblePreference(storage)).toBe(false);
  });

  it("returns true after a `true` write", () => {
    writeTerminalVisiblePreference(storage, true);
    expect(readTerminalVisiblePreference(storage)).toBe(true);
  });

  it("returns false after a `false` write (key is removed)", () => {
    writeTerminalVisiblePreference(storage, true);
    writeTerminalVisiblePreference(storage, false);
    expect(readTerminalVisiblePreference(storage)).toBe(false);
    expect(storage.dump()[TERMINAL_VISIBLE_KEY]).toBeUndefined();
  });

  it("does not consider arbitrary truthy strings as visible", () => {
    storage.setItem(TERMINAL_VISIBLE_KEY, "yes");
    expect(readTerminalVisiblePreference(storage)).toBe(false);
  });

  it("swallows storage failures and returns false", () => {
    expect(readTerminalVisiblePreference(createFailingStorage())).toBe(false);
  });
});

describe("writeTerminalVisiblePreference", () => {
  it("never throws on storage failures", () => {
    expect(() => writeTerminalVisiblePreference(createFailingStorage(), true)).not.toThrow();
    expect(() => writeTerminalVisiblePreference(createFailingStorage(), false)).not.toThrow();
  });
});

describe("legacy readTerminalHeightPreference", () => {
  it("returns null when nothing is stored", () => {
    expect(readTerminalHeightPreference(storage)).toBeNull();
  });

  it("round-trips a positive integer", () => {
    writeTerminalHeightPreference(storage, 380);
    expect(readTerminalHeightPreference(storage)).toBe(380);
  });

  it("rounds when writing a fractional height", () => {
    writeTerminalHeightPreference(storage, 240.7);
    expect(storage.dump()[TERMINAL_HEIGHT_KEY]).toBe("241");
  });

  it("returns null for a non-numeric value", () => {
    storage.setItem(TERMINAL_HEIGHT_KEY, "tall");
    expect(readTerminalHeightPreference(storage)).toBeNull();
  });

  it("returns null for a non-positive value", () => {
    storage.setItem(TERMINAL_HEIGHT_KEY, "0");
    expect(readTerminalHeightPreference(storage)).toBeNull();
    storage.setItem(TERMINAL_HEIGHT_KEY, "-50");
    expect(readTerminalHeightPreference(storage)).toBeNull();
  });

  it("swallows storage failures and returns null", () => {
    expect(readTerminalHeightPreference(createFailingStorage())).toBeNull();
  });
});

describe("clampTerminalHeight", () => {
  // 70% of 1000 = 700, the ceiling for a 1000px viewport.
  const viewport = 1000;

  it("returns the value unchanged when within bounds", () => {
    expect(clampTerminalHeight(300, viewport)).toBe(300);
  });

  it("clamps below the floor up to the floor", () => {
    expect(clampTerminalHeight(50, viewport)).toBe(TERMINAL_HEIGHT_MIN);
  });

  it("clamps above the viewport ceiling", () => {
    expect(clampTerminalHeight(900, viewport)).toBe(700);
  });

  it("rounds non-integer inputs", () => {
    expect(clampTerminalHeight(241.4, viewport)).toBe(241);
  });

  it("never falls below the floor even for tiny viewports", () => {
    // For a 100px viewport, 70% would be 70 — but the floor wins.
    expect(clampTerminalHeight(50, 100)).toBe(TERMINAL_HEIGHT_MIN);
  });
});

describe("clampTerminalWidth", () => {
  it("returns the value unchanged within bounds", () => {
    // 60% of 1600 = 960; 360 is well below the ceiling and above the floor.
    expect(clampTerminalWidth(360, 1600)).toBe(360);
  });

  it("clamps below the floor up to the floor", () => {
    expect(clampTerminalWidth(100, 1600)).toBe(TERMINAL_WIDTH_MIN);
  });

  it("clamps above the viewport ceiling", () => {
    expect(clampTerminalWidth(2000, 1000)).toBe(600);
  });
});

describe("readTerminalPanelState — defaults", () => {
  it("returns defaults when no keys are present", () => {
    const state = readTerminalPanelState(storage);
    expect(state).toEqual(defaultTerminalPanelState());
  });

  it("does not write any key when reading defaults", () => {
    readTerminalPanelState(storage);
    expect(storage.dump()).toEqual({});
  });

  it("swallows storage failures and returns defaults", () => {
    const state = readTerminalPanelState(createFailingStorage());
    expect(state).toEqual(defaultTerminalPanelState());
  });
});

describe("readTerminalPanelState — round-trip via new key", () => {
  it("reads back what writeTerminalPanelState wrote", () => {
    const state = {
      dock: "right" as const,
      displayMode: "fullscreen" as const,
      bottomHeight: 280,
      rightWidth: 420,
      panes: [
        { id: crypto.randomUUID(), sessionId: crypto.randomUUID(), createdAt: 100 },
        { id: crypto.randomUUID(), sessionId: crypto.randomUUID(), createdAt: 200 },
      ],
    };
    writeTerminalPanelState(storage, state);
    expect(readTerminalPanelState(storage)).toEqual({ ...state, panes: [] });
  });

  it("ignores invalid dock values and falls back to default", () => {
    storage.setItem(
      TERMINAL_STATE_KEY,
      JSON.stringify({ dock: "left", displayMode: "normal", bottomHeight: 200, rightWidth: 360, panes: [] }),
    );
    expect(readTerminalPanelState(storage).dock).toBe("bottom");
  });

  it("ignores pane entries because attachment records are window-local", () => {
    const validId = crypto.randomUUID();
    storage.setItem(
      TERMINAL_STATE_KEY,
      JSON.stringify({
        dock: "bottom",
        displayMode: "normal",
        bottomHeight: 200,
        rightWidth: 360,
        panes: [
          { id: validId, createdAt: 1 },
          { id: 42 },
          { createdAt: 1 },
          { id: "not-a-uuid", createdAt: 1 },
          null,
        ],
      }),
    );
    expect(readTerminalPanelState(storage).panes).toEqual([]);
  });

  it("treats corrupt JSON as missing and falls back to defaults", () => {
    storage.setItem(TERMINAL_STATE_KEY, "{not json");
    expect(readTerminalPanelState(storage)).toEqual(defaultTerminalPanelState());
  });
});

describe("readTerminalPanelState — clean reset", () => {
  it("ignores a legacy height without writing the new key", () => {
    storage.setItem(TERMINAL_HEIGHT_KEY, "320");
    const state = readTerminalPanelState(storage);
    expect(state.bottomHeight).toBe(TERMINAL_DEFAULT_BOTTOM_HEIGHT);
    expect(state.dock).toBe("bottom");
    expect(storage.dump()[TERMINAL_STATE_KEY]).toBeUndefined();
    expect(storage.dump()[TERMINAL_HEIGHT_KEY]).toBe("320");
  });

  it("prefers the new key over a present legacy key (no double migration)", () => {
    storage.setItem(TERMINAL_HEIGHT_KEY, "999");
    writeTerminalPanelState(storage, { ...defaultTerminalPanelState(), bottomHeight: 280 });
    expect(readTerminalPanelState(storage).bottomHeight).toBe(280);
  });

  it("returns defaults when both keys are absent", () => {
    expect(readTerminalPanelState(storage)).toEqual(defaultTerminalPanelState());
  });

});

describe("defaultTerminalPanelState", () => {
  it("uses the documented defaults", () => {
    const state = defaultTerminalPanelState();
    expect(state.dock).toBe("bottom");
    expect(state.displayMode).toBe("normal");
    expect(state.bottomHeight).toBe(TERMINAL_DEFAULT_BOTTOM_HEIGHT);
    expect(state.rightWidth).toBe(TERMINAL_DEFAULT_RIGHT_WIDTH);
    expect(state.panes).toEqual([]);
  });
});

describe("own pane records (sessionStorage)", () => {
  const paneA = {
    id: "11111111-1111-4111-8111-111111111111",
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    createdAt: 1000,
  };
  const paneB = {
    id: "22222222-2222-4222-8222-222222222222",
    sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    createdAt: 2000,
  };

  it("round-trips own records", () => {
    writeOwnPaneRecords(storage, { panes: [paneA, paneB] });
    expect(readOwnPaneRecords(storage)).toEqual({ panes: [paneA, paneB] });
    writeOwnPaneRecords(storage, { panes: [paneA] });
    expect(readOwnPaneRecords(storage)).toEqual({ panes: [paneA] });
  });

  it("an empty pane list clears the store and reads as absent", () => {
    writeOwnPaneRecords(storage, { panes: [paneA] });
    writeOwnPaneRecords(storage, { panes: [] });
    expect(readOwnPaneRecords(storage)).toBeNull();
    expect(storage.dump()[TERMINAL_PANES_KEY]).toBeUndefined();
  });

  it("rejects malformed records the server would reject", () => {
    storage.setItem(
      TERMINAL_PANES_KEY,
      JSON.stringify({ panes: [{ id: "not-a-uuid", sessionId: paneA.sessionId, createdAt: 1 }] }),
    );
    expect(readOwnPaneRecords(storage)).toBeNull();
    storage.setItem(TERMINAL_PANES_KEY, "{corrupt json");
    expect(readOwnPaneRecords(storage)).toBeNull();
  });

  it("tolerates a throwing storage", () => {
    const failing = createFailingStorage();
    expect(readOwnPaneRecords(failing)).toBeNull();
    expect(() => writeOwnPaneRecords(failing, { panes: [paneA] })).not.toThrow();
  });

  it("boot resolution prefers this window's own records", () => {
    const local = createMemoryStorage();
    writeTerminalPanelState(local, { ...defaultTerminalPanelState(), panes: [paneA] });
    writeOwnPaneRecords(storage, { panes: [paneB] });
    const resolved = resolveBootPaneRecords(storage, readTerminalPanelState(local));
    expect(resolved).toEqual({ panes: [paneB] });
  });

  it("boot resolution ignores shared local-storage hints", () => {
    const local = createMemoryStorage();
    writeTerminalPanelState(local, { ...defaultTerminalPanelState(), panes: [paneA] });
    const resolved = resolveBootPaneRecords(storage, readTerminalPanelState(local));
    expect(resolved).toEqual({ panes: [] });
  });

  it("boot resolution with neither store yields no panes", () => {
    const resolved = resolveBootPaneRecords(storage, defaultTerminalPanelState());
    expect(resolved).toEqual({ panes: [] });
  });
});

describe("isPhoneClassViewport", () => {

  it("requires BOTH a coarse pointer and a narrow viewport", () => {
    expect(isPhoneClassViewport(true, 390)).toBe(true);
    expect(isPhoneClassViewport(true, PHONE_CLASS_VIEWPORT_MAX)).toBe(true);
    // iPad landscape: coarse but wide.
    expect(isPhoneClassViewport(true, 1180)).toBe(false);
    // Narrow desktop window: fine pointer.
    expect(isPhoneClassViewport(false, 390)).toBe(false);
  });
});

describe("resolveEffectiveDisplayMode", () => {

  it("promotes a stored normal to fullscreen on phone-class viewports only", () => {
    expect(resolveEffectiveDisplayMode("normal", true)).toBe("fullscreen");
    expect(resolveEffectiveDisplayMode("normal", false)).toBe("normal");
  });

  it("passes minimized and fullscreen through untouched", () => {
    expect(resolveEffectiveDisplayMode("minimized", true)).toBe("minimized");
    expect(resolveEffectiveDisplayMode("fullscreen", true)).toBe("fullscreen");
    expect(resolveEffectiveDisplayMode("minimized", false)).toBe("minimized");
    expect(resolveEffectiveDisplayMode("fullscreen", false)).toBe("fullscreen");
  });
});

describe("terminal font-size override", () => {

  it("clamps to the config loader's bounds", () => {
    expect(clampTerminalFontSize(2)).toBe(TERMINAL_FONT_SIZE_MIN);
    expect(clampTerminalFontSize(99)).toBe(TERMINAL_FONT_SIZE_MAX);
    expect(clampTerminalFontSize(14.6)).toBe(15);
  });

  it("round-trips through storage and clears on null", () => {
    const storage = createMemoryStorage();
    writeTerminalFontSizeOverride(storage, 16);
    expect(readTerminalFontSizeOverride(storage)).toBe(16);
    writeTerminalFontSizeOverride(storage, null);
    expect(readTerminalFontSizeOverride(storage)).toBe(null);
    expect(storage.dump()[TERMINAL_FONT_SIZE_KEY]).toBeUndefined();
  });

  it("rejects garbage and out-of-range stored values", () => {
    const storage = createMemoryStorage();
    storage.setItem(TERMINAL_FONT_SIZE_KEY, "enormous");
    expect(readTerminalFontSizeOverride(storage)).toBe(null);
    storage.setItem(TERMINAL_FONT_SIZE_KEY, "200");
    expect(readTerminalFontSizeOverride(storage)).toBe(null);
  });

  it("resolves override over config over the built-in default", () => {
    expect(resolveTerminalFontSize(16, 12)).toBe(16);
    expect(resolveTerminalFontSize(null, 12)).toBe(12);
    expect(resolveTerminalFontSize(null, undefined)).toBe(13);
  });

  it("swallows storage failures", () => {
    const failing = createFailingStorage();
    expect(readTerminalFontSizeOverride(failing)).toBe(null);
    expect(() => writeTerminalFontSizeOverride(failing, 15)).not.toThrow();
  });
});
