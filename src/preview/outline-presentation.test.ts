// The presentation rule, exercised against the device shapes that motivated it.
//
// Only the rule is unit-testable here, for the reason stated in
// `outline-presentation.ts`: measuring the real preview area needs a real
// cascade. That the rule is wired to one is an E2E question.

import { describe, expect, test } from "bun:test";

import {
  maxRailWidth,
  pickPresentation,
  railMinWidth,
  RAIL_MIN_HEIGHT,
  type PreviewArea,
} from "./outline-presentation";

// Measured padding, by layout. The shell drops from 1.75rem to 1rem at the
// ≤900px breakpoint, and the document adds its own ~15px each side.
const NARROW_PADDING = 16 * 2 + 15 * 2; // 62 — at or below 900px wide
const WIDE_PADDING = 28 * 2 + 15 * 2; // 86 — above it

const area = (width: number, height: number, documentPadding: number): PreviewArea => ({
  width,
  height,
  documentPadding,
});

// Measured viewports.
const IPHONE_PORTRAIT = area(390, 844, NARROW_PADDING);
const IPHONE_LANDSCAPE = area(844, 390, NARROW_PADDING);
const IPAD_PORTRAIT = area(834, 1112, NARROW_PADDING);
const IPAD_LANDSCAPE = area(1112, 834, WIDE_PADDING);
const IPAD_SPLIT_THIRD = area(320, 1112, NARROW_PADDING);
const DESKTOP = area(1280, 800, WIDE_PADDING);

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
    // 844px wide clears the width floor outright. Only the height floor sends
    // this to the sheet — delete RAIL_MIN_HEIGHT and this is the case that
    // regresses, which is the whole reason the floor exists.
    expect(IPHONE_LANDSCAPE.width).toBeGreaterThan(railMinWidth(NARROW_PADDING));
    expect(pickPresentation(IPHONE_LANDSCAPE)).toBe("sheet");
  });

  test("the threshold accounts for the width the rail actually opens at", () => {
    // Regression guard for the arithmetic this rule shipped wrong once: the
    // threshold was derived from MIN_WIDTH (200), a width nothing ever opens
    // the rail at, so a 596px preview qualified as "wide enough" while leaving
    // ~245px of prose. The rail opens at 288 + a 16px margin.
    expect(pickPresentation(area(596, 900, NARROW_PADDING))).toBe("sheet");
    expect(railMinWidth(NARROW_PADDING)).toBe(304 + 380 + NARROW_PADDING);
  });

  test("a rail is only chosen when a readable column survives beside it", () => {
    const padding = NARROW_PADDING;
    const minimum = railMinWidth(padding);
    // Exactly enough: the prose column lands on the readable measure.
    expect(pickPresentation(area(minimum, 900, padding))).toBe("rail");
    expect(minimum - padding - 304).toBe(380);
    // One pixel less and it does not.
    expect(pickPresentation(area(minimum - 1, 900, padding))).toBe("sheet");
  });

  test("more padding raises the width the rail needs", () => {
    // The reason padding is measured rather than baked in: the same viewport
    // can be a rail in one layout and a sheet in another.
    const width = railMinWidth(NARROW_PADDING);
    expect(pickPresentation(area(width, 900, NARROW_PADDING))).toBe("rail");
    expect(pickPresentation(area(width, 900, WIDE_PADDING))).toBe("sheet");
  });

  test("both floors are inclusive at the boundary", () => {
    expect(
      pickPresentation(area(railMinWidth(NARROW_PADDING), RAIL_MIN_HEIGHT, NARROW_PADDING)),
    ).toBe("rail");
  });

  test("one pixel under the height floor falls to the sheet", () => {
    expect(
      pickPresentation(area(railMinWidth(NARROW_PADDING), RAIL_MIN_HEIGHT - 1, NARROW_PADDING)),
    ).toBe("sheet");
  });

  test("the drawn-width cap and the viability threshold meet at the boundary", () => {
    // The two questions differ on purpose — viability asks about the DEFAULT
    // footprint so dragging never flips the presentation — so they must at
    // least agree where they touch, or the rail would be viable at a width it
    // is not allowed to be drawn at.
    const padding = NARROW_PADDING;
    const minimum = railMinWidth(padding);
    expect(maxRailWidth(area(minimum, 900, padding))).toBe(288);
  });

  test("a stored width wider than the space allows is capped, not honoured", () => {
    // The back door the presentation rule leaves open: a 500px rail saved on a
    // large display, reapplied verbatim on an 834px tablet, leaves ~270px of
    // prose — the squeeze this whole rule exists to prevent.
    const tablet = area(834, 1112, NARROW_PADDING);
    expect(pickPresentation(tablet)).toBe("rail");
    const cap = maxRailWidth(tablet);
    expect(cap).toBeLessThan(500);
    // Whatever the cap is, the readable measure survives beside it.
    expect(tablet.width - tablet.documentPadding - (cap + 16)).toBeGreaterThanOrEqual(380);
  });

  test("the rule reads geometry only, never a mode", () => {
    // The same area resolves the same way regardless of anything else about
    // the device — the property that makes one rule cover touch mode, the
    // stacked layout, and a narrow desktop window alike.
    const subject = area(900, 600, NARROW_PADDING);
    expect(pickPresentation(subject)).toBe(pickPresentation({ ...subject }));
    expect(pickPresentation(subject)).toBe("rail");
  });
});
