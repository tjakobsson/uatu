import { describe, expect, test } from "bun:test";

import { shouldOfferTouchLayout } from "./narrow-layout-offer";

describe("shouldOfferTouchLayout", () => {
  const base = { mode: "desktop" as const, override: null, narrow: true, previewShown: true, dismissed: false };
  test("offers touch layout to a desktop window narrowed to phone width over a preview", () => {
    expect(shouldOfferTouchLayout(base)).toBe(true);
    expect(shouldOfferTouchLayout({ ...base, override: "touch" })).toBe(true);
  });
  test("respects an explicit desktop choice, Not now, and windows that aren't narrow", () => {
    expect(shouldOfferTouchLayout({ ...base, override: "desktop" })).toBe(false);
    expect(shouldOfferTouchLayout({ ...base, dismissed: true })).toBe(false);
    expect(shouldOfferTouchLayout({ ...base, narrow: false })).toBe(false);
    expect(shouldOfferTouchLayout({ ...base, previewShown: false })).toBe(false);
    expect(shouldOfferTouchLayout({ ...base, mode: "touch" })).toBe(false);
  });
});
