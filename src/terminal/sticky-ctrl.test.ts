import { describe, expect, test } from "bun:test";

import { composeStickyCtrl, createStickyCtrl } from "./sticky-ctrl";

describe("composeStickyCtrl", () => {
  test("is an identity pass-through when unarmed", () => {
    for (const data of ["a", "R", "hello", "\x1b[A", "", "å"]) {
      expect(composeStickyCtrl(false, data)).toEqual({ output: data, composed: false });
    }
  });

  test("composes a single letter to its control byte and reports composed", () => {
    expect(composeStickyCtrl(true, "r")).toEqual({ output: "\x12", composed: true });
    expect(composeStickyCtrl(true, "c")).toEqual({ output: "\x03", composed: true });
    expect(composeStickyCtrl(true, "A")).toEqual({ output: "\x01", composed: true });
    expect(composeStickyCtrl(true, "l")).toEqual({ output: "\x0c", composed: true });
  });

  test("composes the non-letter C0 range too (Ctrl+[ = Esc)", () => {
    expect(composeStickyCtrl(true, "[")).toEqual({ output: "\x1b", composed: true });
    expect(composeStickyCtrl(true, "_")).toEqual({ output: "\x1f", composed: true });
  });

  test("passes multi-character chunks (paste, sequences) through unchanged while staying armed", () => {
    expect(composeStickyCtrl(true, "pasted text")).toEqual({ output: "pasted text", composed: false });
    expect(composeStickyCtrl(true, "\x1b[A")).toEqual({ output: "\x1b[A", composed: false });
  });

  test("passes non-composable single characters through", () => {
    expect(composeStickyCtrl(true, "1")).toEqual({ output: "1", composed: false });
    expect(composeStickyCtrl(true, " ")).toEqual({ output: " ", composed: false });
  });
});

describe("createStickyCtrl", () => {
  test("toggle arms, toggle again cancels, and the listener sees both", () => {
    const ctrl = createStickyCtrl();
    const seen: boolean[] = [];
    ctrl.onChange(armed => seen.push(armed));

    expect(ctrl.isArmed()).toBe(false);
    ctrl.toggle();
    expect(ctrl.isArmed()).toBe(true);
    ctrl.toggle();
    expect(ctrl.isArmed()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  test("disarm is a no-op when idle and releases when armed", () => {
    const ctrl = createStickyCtrl();
    const seen: boolean[] = [];
    ctrl.onChange(armed => seen.push(armed));

    ctrl.disarm();
    expect(seen).toEqual([]);
    ctrl.toggle();
    ctrl.disarm();
    expect(seen).toEqual([true, false]);
  });
});
