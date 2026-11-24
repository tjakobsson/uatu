import { describe, expect, test } from "bun:test";

import { previewPlan, submitShortcutLabel, tabKeyIndex } from "./pr-composer";

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

describe("previewPlan", () => {
  test("says at once, with no render request, when there is nothing to render or too much", () => {
    expect(previewPlan("  ")).toEqual({ kind: "empty", message: "Nothing to preview." });
    const over = previewPlan("x".repeat(65_537));
    expect(over.kind).toBe("too-long");
    expect(over.kind === "too-long" && over.message).toContain("Too long by 1 character");
    expect(previewPlan("**hi**")).toEqual({ kind: "render" });
  });
});
