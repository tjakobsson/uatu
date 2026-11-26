// Reading and comparing the media viewer's stage transform, and the inline
// zoom of a frame in the page.
//
// The viewer exposes its committed state as `data-zoom-state` on the stage
// (`{"tx":…,"ty":…,"scale":…}`), written when the stage's layout size is
// committed about 120ms after input stops; `data-zoom-pending` marks a commit
// still to come. While a gesture runs `style.transform` carries a scale
// RELATIVE to the committed layout size, so it is not a reading of the state;
// these helpers wait for the commit and read the attribute instead.
//
// Comparing transforms as STRINGS is what these tests did first, and it is
// wrong for any assertion of the form "we are back at the fitted view".
// Re-fitting from a different current scale — after a pinch, a wheel zoom,
// a `+` press — can go round the floating-point houses differently and land
// one ULP away, and whether the last digit matches depends on the machine,
// so a string comparison passes locally and fails on CI. Compare numerically,
// with a tolerance far below anything a person could see and far above float
// noise.

import { expect, type Locator, type Page } from "@playwright/test";

export type StageTransform = { tx: number; ty: number; scale: number };

const POSITION_TOLERANCE = 0.5; // px — half a device pixel
const SCALE_TOLERANCE = 0.001;

export function parseStageTransform(value: string | null): StageTransform | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Partial<StageTransform>;
    const { tx, ty, scale } = parsed;
    if ([tx, ty, scale].every(n => typeof n === "number" && Number.isFinite(n))) {
      return { tx: tx!, ty: ty!, scale: scale! };
    }
  } catch {
    // Not a committed state.
  }
  return null;
}

// The committed state of an element carrying `data-zoom-state`, once no
// commit is pending.
async function readCommitted(element: Locator): Promise<StageTransform | null> {
  await expect(element).not.toHaveAttribute("data-zoom-pending");
  return parseStageTransform(await element.getAttribute("data-zoom-state"));
}

// The viewer's committed transform.
export function readStageTransform(page: Page): Promise<StageTransform | null> {
  return readCommitted(page.locator(".media-viewer-stage"));
}

// The committed inline zoom of a `.media-zoom-frame`, relative to its fit box
// (fit is `{tx: 0, ty: 0, scale: 1}`).
export const readInlineTransform = readCommitted;

// A one-off reading matches `expected` within the precision a test of zoom
// gestures can promise (pointer positions are whole pixels).
export function expectTransformClose(actual: StageTransform | null, expected: StageTransform): void {
  expect(actual).not.toBeNull();
  expect(actual!.scale).toBeCloseTo(expected.scale, 3);
  expect(actual!.tx).toBeCloseTo(expected.tx, 1);
  expect(actual!.ty).toBeCloseTo(expected.ty, 1);
}

// The committed scale, or NaN when there is none.
export async function readStageScale(page: Page): Promise<number> {
  return (await readStageTransform(page))?.scale ?? Number.NaN;
}

export function transformsClose(a: StageTransform | null, b: StageTransform | null): boolean {
  if (!a || !b) return false;
  return (
    Math.abs(a.tx - b.tx) <= POSITION_TOLERANCE &&
    Math.abs(a.ty - b.ty) <= POSITION_TOLERANCE &&
    Math.abs(a.scale - b.scale) <= SCALE_TOLERANCE
  );
}

// Polls `read` until the transform it returns matches `expected` within
// tolerance. On failure the message carries both transforms rather than a
// bare `true !== false`.
export async function expectTransformMatches(read: () => Promise<StageTransform | null>, expected: StageTransform): Promise<void> {
  await expect
    .poll(async () => {
      const actual = await read();
      return transformsClose(actual, expected)
        ? "matches"
        : `got ${JSON.stringify(actual)}, expected ~${JSON.stringify(expected)}`;
    })
    .toBe("matches");
}

// The viewer's stage transform; see expectTransformMatches.
export async function expectStageTransform(page: Page, expected: StageTransform): Promise<void> {
  await expectTransformMatches(() => readStageTransform(page), expected);
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
