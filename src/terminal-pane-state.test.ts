import { beforeEach, describe, expect, it } from "bun:test";

import {
  TERMINAL_HEIGHT_KEY,
  TERMINAL_HEIGHT_MIN,
  TERMINAL_VISIBLE_KEY,
  clampTerminalHeight,
  readTerminalHeightPreference,
  readTerminalVisiblePreference,
  writeTerminalHeightPreference,
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

describe("readTerminalHeightPreference", () => {
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

describe("round-trip through real-shaped storage stub", () => {
  it("persists visibility + height independently across writes", () => {
    writeTerminalVisiblePreference(storage, true);
    writeTerminalHeightPreference(storage, 320);
    expect(readTerminalVisiblePreference(storage)).toBe(true);
    expect(readTerminalHeightPreference(storage)).toBe(320);

    writeTerminalVisiblePreference(storage, false);
    expect(readTerminalVisiblePreference(storage)).toBe(false);
    // Height preference is unaffected by a visibility change.
    expect(readTerminalHeightPreference(storage)).toBe(320);
  });
});
