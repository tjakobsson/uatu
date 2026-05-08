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
  readTerminalHeightPreference,
  readTerminalPanelState,
  readTerminalVisiblePreference,
  writeTerminalHeightPreference,
  writeTerminalPanelState,
  writeTerminalVisiblePreference,
  type StorageLike,
} from "./terminal-pane-state";

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
        { id: "a-pane", createdAt: 100 },
        { id: "b-pane", createdAt: 200 },
      ],
    };
    writeTerminalPanelState(storage, state);
    expect(readTerminalPanelState(storage)).toEqual(state);
  });

  it("ignores invalid dock values and falls back to default", () => {
    storage.setItem(
      TERMINAL_STATE_KEY,
      JSON.stringify({ dock: "left", displayMode: "normal", bottomHeight: 200, rightWidth: 360, panes: [] }),
    );
    expect(readTerminalPanelState(storage).dock).toBe("bottom");
  });

  it("filters out malformed pane entries", () => {
    storage.setItem(
      TERMINAL_STATE_KEY,
      JSON.stringify({
        dock: "bottom",
        displayMode: "normal",
        bottomHeight: 200,
        rightWidth: 360,
        panes: [
          { id: "valid", createdAt: 1 },
          { id: 42 },
          { createdAt: 1 },
          null,
        ],
      }),
    );
    expect(readTerminalPanelState(storage).panes).toEqual([{ id: "valid", createdAt: 1 }]);
  });

  it("treats corrupt JSON as missing and falls back to defaults", () => {
    storage.setItem(TERMINAL_STATE_KEY, "{not json");
    expect(readTerminalPanelState(storage)).toEqual(defaultTerminalPanelState());
  });
});

describe("readTerminalPanelState — legacy migration", () => {
  it("migrates a legacy height into the new shape and persists it", () => {
    storage.setItem(TERMINAL_HEIGHT_KEY, "320");
    const state = readTerminalPanelState(storage);
    expect(state.bottomHeight).toBe(320);
    expect(state.dock).toBe("bottom");
    // Persisted to the new key so subsequent reads are O(parse) rather than
    // re-running the migration branch.
    expect(storage.dump()[TERMINAL_STATE_KEY]).toBeDefined();
    expect(JSON.parse(storage.dump()[TERMINAL_STATE_KEY]!)).toEqual(state);
  });

  it("does not delete the legacy key (forward-only writes)", () => {
    storage.setItem(TERMINAL_HEIGHT_KEY, "320");
    readTerminalPanelState(storage);
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

  it("can opt out of migration writes for inspection", () => {
    storage.setItem(TERMINAL_HEIGHT_KEY, "320");
    const state = readTerminalPanelState(storage, { writeOnMigrate: false });
    expect(state.bottomHeight).toBe(320);
    expect(storage.dump()[TERMINAL_STATE_KEY]).toBeUndefined();
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
