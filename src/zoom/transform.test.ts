import { describe, expect, test } from "bun:test";
import {
  actualPixelsScale,
  boundCover,
  boundKeepVisible,
  clamp,
  fitTransform,
  MAX_SCALE,
  MIN_SCALE,
  PAN_KEEP_VISIBLE,
  pinchTransform,
  viewerScaleLimits,
  zoomAt,
  type ZoomTransform,
} from "./transform";

const VIEWPORT = { width: 1000, height: 800 };

// The content point (in unscaled content coordinates) shown at a viewport point.
function contentPointAt(t: ZoomTransform, x: number, y: number): { u: number; v: number } {
  return { u: (x - t.tx) / t.scale, v: (y - t.ty) / t.scale };
}

describe("clamp", () => {
  test("keeps values inside the range and pins them at either end", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe("zoomAt", () => {
  test("keeps the content point under the anchor in place", () => {
    const start: ZoomTransform = { tx: 37, ty: -12, scale: 1.3 };
    const anchor = { x: 412, y: 233 };
    const before = contentPointAt(start, anchor.x, anchor.y);
    for (const factor of [1.25, 1 / 1.25, 3, 0.5]) {
      const next = zoomAt(start, factor, anchor);
      const after = contentPointAt(next, anchor.x, anchor.y);
      expect(after.u).toBeCloseTo(before.u, 9);
      expect(after.v).toBeCloseTo(before.v, 9);
    }
  });

  test("clamps to the viewer's limits and keeps the anchor at the clamped scale", () => {
    const start: ZoomTransform = { tx: 0, ty: 0, scale: 7 };
    const anchor = { x: 300, y: 200 };
    const before = contentPointAt(start, anchor.x, anchor.y);
    const zoomedIn = zoomAt(start, 10, anchor);
    expect(zoomedIn.scale).toBe(MAX_SCALE);
    const after = contentPointAt(zoomedIn, anchor.x, anchor.y);
    expect(after.u).toBeCloseTo(before.u, 9);
    expect(after.v).toBeCloseTo(before.v, 9);

    expect(zoomAt({ tx: 0, ty: 0, scale: 0.3 }, 0.01, anchor).scale).toBe(MIN_SCALE);
  });

  test("never moves against its direction from a scale outside the range", () => {
    // Below the minimum (a viewport that grew under a kept scale): zooming
    // out stays put rather than jumping up to the minimum; zooming in moves up.
    const below: ZoomTransform = { tx: 0, ty: 0, scale: 0.15 };
    expect(zoomAt(below, 1 / 1.25, { x: 0, y: 0 }).scale).toBe(0.15);
    expect(zoomAt(below, 1.25, { x: 0, y: 0 }).scale).toBeCloseTo(0.1875, 9);
    const above: ZoomTransform = { tx: 0, ty: 0, scale: 5 };
    expect(zoomAt(above, 1.25, { x: 0, y: 0 }, { min: 1, max: 4 }).scale).toBe(5);
    expect(zoomAt(above, 1 / 1.25, { x: 0, y: 0 }, { min: 1, max: 4 }).scale).toBe(4);
  });

  test("honours custom limits", () => {
    const next = zoomAt({ tx: 0, ty: 0, scale: 1 }, 0.5, { x: 0, y: 0 }, { min: 1, max: 4 });
    expect(next.scale).toBe(1);
  });
});

describe("fitTransform between bands", () => {
  test("fits into the box less a band at the top and one at the bottom, centred between them", () => {
    const fit = fitTransform({ width: 300, height: 3000 }, VIEWPORT, { top: 40, bottom: 100 });
    expect(fit.scale).toBeCloseTo((800 - 140 - 32) / 3000, 9);
    expect(fit.tx).toBeCloseTo((1000 - 300 * fit.scale) / 2, 9);
    expect(fit.ty).toBeCloseTo(40 + (660 - 3000 * fit.scale) / 2, 9);
  });

  test("the viewer's minimum reaches down to the fit between its bands", () => {
    const bands = { top: 0, bottom: 300 };
    const limits = viewerScaleLimits({ width: 300, height: 3000 }, VIEWPORT, [], bands);
    expect(limits.min).toBeCloseTo(fitTransform({ width: 300, height: 3000 }, VIEWPORT, bands).scale, 9);
  });
});

describe("fitTransform", () => {
  test("fits wide content to the width and centres it vertically", () => {
    const fit = fitTransform({ width: 2000, height: 400 }, VIEWPORT);
    expect(fit.scale).toBeCloseTo((1000 - 32) / 2000, 9);
    expect(fit.tx).toBeCloseTo((1000 - 2000 * fit.scale) / 2, 9);
    expect(fit.ty).toBeCloseTo((800 - 400 * fit.scale) / 2, 9);
  });

  test("fits tall content to the height and centres it horizontally", () => {
    const fit = fitTransform({ width: 300, height: 3000 }, VIEWPORT);
    expect(fit.scale).toBeCloseTo((800 - 32) / 3000, 9);
    expect(fit.tx).toBeCloseTo((1000 - 300 * fit.scale) / 2, 9);
    expect(fit.ty).toBeCloseTo((800 - 3000 * fit.scale) / 2, 9);
  });

  test("tiny content enlarges only up to the maximum scale, centred", () => {
    const fit = fitTransform({ width: 16, height: 16 }, VIEWPORT);
    expect(fit.scale).toBe(MAX_SCALE);
    expect(fit.tx).toBeCloseTo((1000 - 16 * MAX_SCALE) / 2, 9);
    expect(fit.ty).toBeCloseTo((800 - 16 * MAX_SCALE) / 2, 9);
  });

  test("content too large for the minimum scale still fits whole", () => {
    // A 3000×2000 screenshot on a 390px phone: fit is below the viewer's
    // usual minimum, and fit must still show all of it.
    const phone = { width: 390, height: 844 };
    const fit = fitTransform({ width: 3000, height: 2000 }, phone);
    expect(fit.scale).toBeCloseTo((390 - 32) / 3000, 9);
    expect(fit.scale).toBeLessThan(MIN_SCALE);
    expect(fit.tx).toBeGreaterThanOrEqual(0);
    expect(fit.tx + 3000 * fit.scale).toBeLessThanOrEqual(phone.width);
  });

  test("empty content or viewport yields the identity", () => {
    expect(fitTransform({ width: 0, height: 10 }, VIEWPORT)).toEqual({ tx: 0, ty: 0, scale: 1 });
    expect(fitTransform({ width: 10, height: 10 }, { width: 0, height: 0 })).toEqual({ tx: 0, ty: 0, scale: 1 });
  });
});

describe("viewerScaleLimits", () => {
  test("are the viewer's range when fit lies inside it", () => {
    expect(viewerScaleLimits({ width: 400, height: 300 }, VIEWPORT)).toEqual({ min: MIN_SCALE, max: MAX_SCALE });
  });

  test("reach down to fit for content that only fits below the minimum", () => {
    const content = { width: 3000, height: 2000 };
    const box = { width: 390, height: 844 };
    const limits = viewerScaleLimits(content, box);
    expect(limits.min).toBeCloseTo(fitTransform(content, box).scale, 9);
    expect(limits.max).toBe(MAX_SCALE);
    // Zooming out from fit therefore stays at fit rather than jumping up.
    const fit = fitTransform(content, box);
    expect(zoomAt(fit, 1 / 1.25, { x: 195, y: 422 }, limits).scale).toBeCloseTo(fit.scale, 9);
  });

  test("reach down to every scale the viewer offers, such as actual pixels", () => {
    const content = { width: 640, height: 480 };
    expect(viewerScaleLimits(content, VIEWPORT, [1 / 6]).min).toBeCloseTo(1 / 6, 9);
    // An offered scale inside the range leaves it alone; an unusable one is ignored.
    expect(viewerScaleLimits(content, VIEWPORT, [0.5, Number.NaN, 0]).min).toBe(MIN_SCALE);
  });
});

describe("pinchTransform", () => {
  const start: ZoomTransform = { tx: 40, ty: -20, scale: 1.5 };
  const startMid = { x: 300, y: 200 };

  test("the content point under the starting midpoint follows the midpoint as it moves", () => {
    const under = contentPointAt(start, startMid.x, startMid.y);
    for (const [mid, ratio] of [
      [{ x: 360, y: 260 }, 1],
      [{ x: 250, y: 150 }, 2],
      [{ x: 420, y: 180 }, 0.75],
    ] as const) {
      const next = pinchTransform(start, startMid, mid, ratio);
      expect(next.scale).toBeCloseTo(start.scale * ratio, 9);
      const after = contentPointAt(next, mid.x, mid.y);
      expect(after.u).toBeCloseTo(under.u, 9);
      expect(after.v).toBeCloseTo(under.v, 9);
    }
  });

  test("a midpoint that only moves pans by the same distance", () => {
    const next = pinchTransform(start, startMid, { x: startMid.x + 30, y: startMid.y - 10 }, 1);
    expect(next).toEqual({ tx: start.tx + 30, ty: start.ty - 10, scale: start.scale });
  });

  test("never moves against the fingers from a starting scale outside the range", () => {
    const below: ZoomTransform = { tx: 0, ty: 0, scale: 0.15 };
    expect(pinchTransform(below, startMid, startMid, 0.9).scale).toBe(0.15);
    expect(pinchTransform(below, startMid, startMid, 1.1).scale).toBeCloseTo(0.165, 9);
  });

  test("clamps the scale and keeps the point under the midpoint at the clamped scale", () => {
    const under = contentPointAt(start, startMid.x, startMid.y);
    const mid = { x: 310, y: 190 };
    const next = pinchTransform(start, startMid, mid, 100, { min: 1, max: 4 });
    expect(next.scale).toBe(4);
    const after = contentPointAt(next, mid.x, mid.y);
    expect(after.u).toBeCloseTo(under.u, 9);
    expect(after.v).toBeCloseTo(under.v, 9);
  });
});

describe("boundKeepVisible", () => {
  const content = { width: 400, height: 300 };

  test("leaves an in-range transform alone", () => {
    const t = { tx: 100, ty: 50, scale: 1 };
    expect(boundKeepVisible(t, content, VIEWPORT)).toEqual(t);
  });

  test("stops at the right and bottom edges with the margin still visible", () => {
    const t = boundKeepVisible({ tx: 5000, ty: 5000, scale: 2 }, content, VIEWPORT);
    expect(t.tx).toBe(VIEWPORT.width - PAN_KEEP_VISIBLE);
    expect(t.ty).toBe(VIEWPORT.height - PAN_KEEP_VISIBLE);
    expect(t.scale).toBe(2);
  });

  test("stops at the left and top edges with the margin still visible", () => {
    const t = boundKeepVisible({ tx: -5000, ty: -5000, scale: 2 }, content, VIEWPORT);
    expect(t.tx).toBe(PAN_KEEP_VISIBLE - content.width * 2);
    expect(t.ty).toBe(PAN_KEEP_VISIBLE - content.height * 2);
  });

  test("content smaller than the margin keeps its whole self visible", () => {
    const tiny = { width: 10, height: 10 };
    const right = boundKeepVisible({ tx: 5000, ty: 5000, scale: 1 }, tiny, VIEWPORT);
    expect(right.tx).toBe(VIEWPORT.width - 10);
    expect(right.ty).toBe(VIEWPORT.height - 10);
    const left = boundKeepVisible({ tx: -5000, ty: -5000, scale: 1 }, tiny, VIEWPORT);
    expect(left.tx).toBe(0);
    expect(left.ty).toBe(0);
  });
});

describe("boundCover", () => {
  // Inline zoom: the box is the media's at-fit box, the content is the media
  // at its at-fit size, so fit is scale 1 at the origin.
  const box = { width: 400, height: 200 };

  test("never goes below the at-fit floor", () => {
    expect(boundCover({ tx: 30, ty: 30, scale: 0.5 }, box, box, 1)).toEqual({ tx: 0, ty: 0, scale: 1 });
  });

  test("never exceeds the maximum scale", () => {
    expect(boundCover({ tx: 0, ty: 0, scale: 50 }, box, box, 1).scale).toBe(MAX_SCALE);
  });

  test("aligns the left and top edges with the box when dragged past them", () => {
    const t = boundCover({ tx: 120, ty: 80, scale: 3 }, box, box, 1);
    expect(t).toEqual({ tx: 0, ty: 0, scale: 3 });
  });

  test("aligns the right and bottom edges with the box when dragged past them", () => {
    const t = boundCover({ tx: -5000, ty: -5000, scale: 3 }, box, box, 1);
    expect(t.tx).toBe(box.width - box.width * 3);
    expect(t.ty).toBe(box.height - box.height * 3);
  });

  test("an axis smaller than the box at the floor is centred rather than pinned", () => {
    // Content letterboxed in its box: fit scale 0.5 makes it 300×200 in 400×200.
    const content = { width: 600, height: 400 };
    const t = boundCover({ tx: -90, ty: 0, scale: 0.5 }, content, box, 0.5);
    expect(t.tx).toBe((400 - 300) / 2);
    expect(t.ty).toBe(0);
  });
});

describe("actualPixelsScale", () => {
  test("one natural pixel per device pixel", () => {
    expect(actualPixelsScale(1)).toBe(1);
    expect(actualPixelsScale(2)).toBe(0.5);
    expect(actualPixelsScale(3)).toBeCloseTo(1 / 3, 9);
  });

  test("relative to a base size other than the natural size", () => {
    // A 3000px-wide image laid out at a 1500px base needs scale 2 at DPR 1.
    expect(actualPixelsScale(1, 3000, 1500)).toBe(2);
    expect(actualPixelsScale(2, 3000, 1500)).toBe(1);
  });

  test("a missing or invalid device pixel ratio counts as 1", () => {
    expect(actualPixelsScale(0)).toBe(1);
    expect(actualPixelsScale(Number.NaN)).toBe(1);
  });
});
