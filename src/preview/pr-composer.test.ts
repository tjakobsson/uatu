import { describe, expect, test } from "bun:test";

import { submitShortcutLabel, tabKeyIndex } from "./pr-composer";

describe("submitShortcutLabel", () => {
  test("names the platform's submit shortcut", () => {
    expect(submitShortcutLabel(true)).toBe("⌘↵");
    expect(submitShortcutLabel(false)).toBe("Ctrl+Enter");
  });
});

describe("tabKeyIndex", () => {
  test("Left / Right wrap, Home and End jump, other keys are not ours", () => {
    expect(tabKeyIndex(0, "ArrowRight", 2)).toBe(1);
    expect(tabKeyIndex(1, "ArrowRight", 2)).toBe(0);
    expect(tabKeyIndex(0, "ArrowLeft", 2)).toBe(1);
    expect(tabKeyIndex(1, "Home", 2)).toBe(0);
    expect(tabKeyIndex(0, "End", 2)).toBe(1);
    expect(tabKeyIndex(0, "Enter", 2)).toBeNull();
    expect(tabKeyIndex(-1, "ArrowRight", 2)).toBeNull();
  });
});
