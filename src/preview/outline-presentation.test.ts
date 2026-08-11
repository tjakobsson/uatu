// The presentation rule, exercised against the device shapes that motivated it.
//
// Only the rule is unit-testable here, for the reason stated in
// `outline-presentation.ts`: measuring the real preview area needs a real
// cascade. That the rule is wired to one is an E2E question.

import { describe, expect, test } from "bun:test";

import {
  pickPresentation,
  RAIL_MIN_HEIGHT,
  RAIL_MIN_WIDTH,
  type PreviewArea,
} from "./outline-presentation";

// Measured viewports. Widths are the full viewport; the preview area is
// slightly narrower once shell padding is taken off, which is why the phone
// cases sit far from the boundary rather than near it.
const IPHONE_PORTRAIT: PreviewArea = { width: 390, height: 844 };
const IPHONE_LANDSCAPE: PreviewArea = { width: 844, height: 390 };
const IPAD_PORTRAIT: PreviewArea = { width: 834, height: 1112 };
const IPAD_LANDSCAPE: PreviewArea = { width: 1112, height: 834 };
const IPAD_SPLIT_THIRD: PreviewArea = { width: 320, height: 1112 };
const DESKTOP: PreviewArea = { width: 1280, height: 800 };

describe("pickPresentation", () => {
  test("iPhone portrait gets the sheet", () => {
    // The case that motivated the change: the rail's gutter leaves a 114px
    // text column here and the document renders 2.5x taller.
    expect(pickPresentation(IPHONE_PORTRAIT)).toBe("sheet");
  });

  test("iPad portrait keeps the rail", () => {
    // 288px rail beside a 470px prose column — measured, and good.
    expect(pickPresentation(IPAD_PORTRAIT)).toBe("rail");
  });

  test("iPad landscape keeps the rail", () => {
    expect(pickPresentation(IPAD_LANDSCAPE)).toBe("rail");
  });

  test("desktop keeps the rail", () => {
    // The presentation every existing outline test asserts against.
    expect(pickPresentation(DESKTOP)).toBe("rail");
  });

  test("iPad Split View at a third gets the sheet", () => {
    // Width the mode attribute cannot distinguish from full-screen iPad.
    expect(pickPresentation(IPAD_SPLIT_THIRD)).toBe("sheet");
  });

  test("iPhone landscape gets the sheet despite clearing the width floor", () => {
    // 844px wide clears RAIL_MIN_WIDTH outright. Only the height floor sends
    // this to the sheet — delete RAIL_MIN_HEIGHT and this is the case that
    // regresses, which is the whole reason the floor exists.
    expect(IPHONE_LANDSCAPE.width).toBeGreaterThan(RAIL_MIN_WIDTH);
    expect(pickPresentation(IPHONE_LANDSCAPE)).toBe("sheet");
  });

  test("both floors are inclusive at the boundary", () => {
    expect(pickPresentation({ width: RAIL_MIN_WIDTH, height: RAIL_MIN_HEIGHT })).toBe("rail");
  });

  test("one pixel under either floor falls to the sheet", () => {
    expect(pickPresentation({ width: RAIL_MIN_WIDTH - 1, height: RAIL_MIN_HEIGHT })).toBe("sheet");
    expect(pickPresentation({ width: RAIL_MIN_WIDTH, height: RAIL_MIN_HEIGHT - 1 })).toBe("sheet");
  });

  test("the rule reads width and height only, never a mode", () => {
    // The same area resolves the same way regardless of anything else about
    // the device — the property that makes one rule cover touch mode, the
    // stacked layout, and a narrow desktop window alike.
    const area: PreviewArea = { width: 700, height: 600 };
    expect(pickPresentation(area)).toBe(pickPresentation({ ...area }));
    expect(pickPresentation(area)).toBe("rail");
  });
});
