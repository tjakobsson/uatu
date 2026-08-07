import { describe, expect, test } from "bun:test";

import {
  UI_MODE_KEY,
  readUiModeOverride,
  resolveUiMode,
  writeUiModeOverride,
  type UiModeStorage,
} from "./ui-mode";

function memoryStorage(): UiModeStorage & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: key => {
      store.delete(key);
    },
  };
}

describe("resolveUiMode", () => {
  test("coarse pointer defaults to touch (iPhone AND iPad)", () => {
    expect(resolveUiMode(null, true)).toBe("touch");
  });

  test("fine pointer defaults to desktop", () => {
    expect(resolveUiMode(null, false)).toBe("desktop");
  });

  test("a stored override wins over the pointer default", () => {
    expect(resolveUiMode("desktop", true)).toBe("desktop");
    expect(resolveUiMode("touch", false)).toBe("touch");
  });

  test("an unrecognized stored value falls back to the pointer default", () => {
    expect(resolveUiMode("tablet", true)).toBe("touch");
    expect(resolveUiMode("", false)).toBe("desktop");
  });
});

describe("ui-mode persistence", () => {
  test("round-trips a mode override", () => {
    const storage = memoryStorage();
    writeUiModeOverride(storage, "desktop");
    expect(readUiModeOverride(storage)).toBe("desktop");
    writeUiModeOverride(storage, "touch");
    expect(readUiModeOverride(storage)).toBe("touch");
  });

  test("clearing the override removes the key entirely", () => {
    const storage = memoryStorage();
    writeUiModeOverride(storage, "touch");
    writeUiModeOverride(storage, null);
    expect(storage.store.has(UI_MODE_KEY)).toBe(false);
    expect(readUiModeOverride(storage)).toBeNull();
  });

  test("corrupt stored values read as no override", () => {
    const storage = memoryStorage();
    storage.setItem(UI_MODE_KEY, "phablet");
    expect(readUiModeOverride(storage)).toBeNull();
  });

  test("a throwing storage backend degrades to defaults", () => {
    const throwing: UiModeStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(readUiModeOverride(throwing)).toBeNull();
    expect(() => writeUiModeOverride(throwing, "touch")).not.toThrow();
  });
});
