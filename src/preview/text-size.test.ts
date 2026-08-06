import { describe, expect, test } from "bun:test";

import {
  PREVIEW_TEXT_DEFAULT_STEP,
  PREVIEW_TEXT_SCALES,
  clampPreviewTextStep,
  readPreviewTextStep,
} from "./text-size";

describe("preview text-size steps", () => {
  test("the ladder is bounded roughly 85% to 150% with 1.0 as the default", () => {
    expect(PREVIEW_TEXT_SCALES[0]).toBeCloseTo(0.85);
    expect(PREVIEW_TEXT_SCALES.at(-1)).toBeCloseTo(1.5);
    expect(PREVIEW_TEXT_SCALES[PREVIEW_TEXT_DEFAULT_STEP]).toBe(1);
  });

  test("clamp holds steps inside the ladder", () => {
    expect(clampPreviewTextStep(-3)).toBe(0);
    expect(clampPreviewTextStep(99)).toBe(PREVIEW_TEXT_SCALES.length - 1);
    expect(clampPreviewTextStep(3)).toBe(3);
    expect(clampPreviewTextStep(Number.NaN)).toBe(PREVIEW_TEXT_DEFAULT_STEP);
  });

  test("read falls back to the default on missing, garbage, or failing storage", () => {
    expect(readPreviewTextStep(null)).toBe(PREVIEW_TEXT_DEFAULT_STEP);
    expect(readPreviewTextStep({ getItem: () => null })).toBe(PREVIEW_TEXT_DEFAULT_STEP);
    expect(readPreviewTextStep({ getItem: () => "junk" })).toBe(PREVIEW_TEXT_DEFAULT_STEP);
    expect(
      readPreviewTextStep({
        getItem: () => {
          throw new Error("storage disabled");
        },
      }),
    ).toBe(PREVIEW_TEXT_DEFAULT_STEP);
  });

  test("read clamps stored out-of-range steps", () => {
    expect(readPreviewTextStep({ getItem: () => "42" })).toBe(PREVIEW_TEXT_SCALES.length - 1);
    expect(readPreviewTextStep({ getItem: () => "5" })).toBe(5);
  });
});
