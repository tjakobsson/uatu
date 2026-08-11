// Reading and comparing the Mermaid viewer's stage transform.
//
// Comparing `style.transform` as a STRING is what these tests did first, and
// it is wrong for any assertion of the form "we are back at the fitted view".
// `fitToViewport` recovers the stage's unscaled size as
// `stageRect / currentScale`, so re-fitting from a different current scale —
// after a pinch, a wheel zoom, a `+` press — goes round the floating-point
// houses differently and lands one ULP away:
//
//     fitted at open      translate(16px, 48.3763px) scale(2.68794)
//     refit, same scale   translate(16px, 48.3763px) scale(2.68794)   ==
//     refit, after pinch  translate(16px, 48.3764px) scale(2.68794)   !=
//
// Whether the last digit matches depends on the machine, so a string
// comparison passes locally and fails on CI for a difference of one
// ten-thousandth of a pixel. Compare numerically, with a tolerance far below
// anything a person could see and far above float noise.

import { expect, type Page } from "@playwright/test";

export type StageTransform = { tx: number; ty: number; scale: number };

const POSITION_TOLERANCE = 0.5; // px — half a device pixel
const SCALE_TOLERANCE = 0.001;

export function parseStageTransform(value: string): StageTransform | null {
  const translate = value.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/);
  const scale = value.match(/scale\(([\d.]+)\)/);
  if (!translate || !scale) {
    return null;
  }
  return {
    tx: Number.parseFloat(translate[1]!),
    ty: Number.parseFloat(translate[2]!),
    scale: Number.parseFloat(scale[1]!),
  };
}

export async function readStageTransform(page: Page): Promise<StageTransform | null> {
  const raw = await page
    .locator(".mermaid-viewer-stage")
    .evaluate(el => (el as HTMLElement).style.transform);
  return parseStageTransform(raw);
}

export function transformsClose(a: StageTransform | null, b: StageTransform | null): boolean {
  if (!a || !b) return false;
  return (
    Math.abs(a.tx - b.tx) <= POSITION_TOLERANCE &&
    Math.abs(a.ty - b.ty) <= POSITION_TOLERANCE &&
    Math.abs(a.scale - b.scale) <= SCALE_TOLERANCE
  );
}

// Polls until the stage transform matches `expected` within tolerance. On
// failure the message carries both transforms rather than a bare
// `true !== false`.
export async function expectStageTransform(page: Page, expected: StageTransform): Promise<void> {
  await expect
    .poll(async () => {
      const actual = await readStageTransform(page);
      return transformsClose(actual, expected)
        ? "matches"
        : `got ${JSON.stringify(actual)}, expected ~${JSON.stringify(expected)}`;
    })
    .toBe("matches");
}

// The negative form. Deliberately NOT a poll: "still not fitted" has to hold
// at the moment we look, and polling a negative would pass on the first
// sample before an async fit had a chance to land.
export function expectStageTransformDiffers(
  actual: StageTransform | null,
  reference: StageTransform,
): void {
  expect(actual).not.toBeNull();
  expect(transformsClose(actual, reference)).toBe(false);
}
