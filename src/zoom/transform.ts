// Pure transform math for media zoom, shared by the fullscreen viewer and the
// inline controller. A transform places unscaled content of a known base size
// at `(tx, ty)` with a uniform `scale`, in the coordinates of the box that
// clips it (the viewer's viewport, or the inline frame). Nothing here touches
// the DOM, so every rule is unit-testable.

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 8;
export const WHEEL_ZOOM_RATE = 0.001;
// Toolbar and keyboard zoom step.
export const ZOOM_STEP = 1.25;
// Space left around content fitted into the viewer.
export const FIT_MARGIN = 32;

// How much of the scaled content must stay inside the viewer after a pan.
// Not "fully contained" — at high zoom the content is deliberately larger
// than the screen and has to be pannable past its edges. Only the state where
// nothing at all is on screen is disallowed, because its only recovery was
// the fit button, which on a phone was itself off-screen.
export const PAN_KEEP_VISIBLE = 48;

// Rendering commits at rest: about this long after input stops, a zoomed
// stage is laid out at its scaled size so vector content is redrawn sharp.
export const COMMIT_DELAY_MS = 120;

export type ZoomTransform = { tx: number; ty: number; scale: number };
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type ScaleLimits = { min: number; max: number };

const VIEWER_LIMITS: ScaleLimits = { min: MIN_SCALE, max: MAX_SCALE };

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// Scale by `factor`, keeping the content point under `anchor` (box
// coordinates) where it is: new_t = anchor - (anchor - t) * ratio.
// A relative zoom never moves against its direction (see `limitsIncludingScale`).
export function zoomAt(
  t: ZoomTransform,
  factor: number,
  anchor: Point,
  limits: ScaleLimits = VIEWER_LIMITS,
): ZoomTransform {
  return zoomTo(t, t.scale * factor, anchor, limitsIncludingScale(limits, t.scale));
}

// The range a relative zoom from `scale` is clamped to: `limits`, stretched to
// include `scale`. A scale can be left outside the range when the range moves
// under it (the viewer's minimum rises when its viewport grows, while zoomed
// media keeps its scale); clamping into the range from there would make zoom
// out enlarge the media, or zoom in shrink it. Stretched, the step moves the
// way it was asked or stays put, and the range takes over once it is entered.
function limitsIncludingScale(limits: ScaleLimits, scale: number): ScaleLimits {
  return { min: Math.min(limits.min, scale), max: Math.max(limits.max, scale) };
}

// Move to an absolute scale, anchored like `zoomAt`.
export function zoomTo(
  t: ZoomTransform,
  scale: number,
  anchor: Point,
  limits: ScaleLimits = VIEWER_LIMITS,
): ZoomTransform {
  const nextScale = clamp(scale, limits.min, limits.max);
  const ratio = nextScale / t.scale;
  return {
    tx: anchor.x - (anchor.x - t.tx) * ratio,
    ty: anchor.y - (anchor.y - t.ty) * ratio,
    scale: nextScale,
  };
}

// A pinch from `start`, which began with the fingers' midpoint at
// `startAnchor`: the scale follows `ratio`, and the content point that was
// under the starting midpoint stays under the current one, so moving the
// fingers together pans as well as zooms. Computed from the start rather than
// accumulated per move, like the ratio itself. Like `zoomAt`, it never moves
// against the fingers from a start outside the range.
export function pinchTransform(
  start: ZoomTransform,
  startAnchor: Point,
  anchor: Point,
  ratio: number,
  limits: ScaleLimits = VIEWER_LIMITS,
): ZoomTransform {
  const range = limitsIncludingScale(limits, start.scale);
  const scale = clamp(start.scale * ratio, range.min, range.max);
  const u = (startAnchor.x - start.tx) / start.scale;
  const v = (startAnchor.y - start.ty) / start.scale;
  return { tx: anchor.x - u * scale, ty: anchor.y - v * scale, scale };
}

// The largest scale that shows the whole content inside the box less
// `FIT_MARGIN`, centred. Capped at the maximum scale, but never raised to the
// minimum: content too large to fit at the minimum still fits whole.
export function fitTransform(content: Size, box: Size): ZoomTransform {
  if (content.width <= 0 || content.height <= 0 || box.width <= 0 || box.height <= 0) {
    return { tx: 0, ty: 0, scale: 1 };
  }
  const scale = Math.min(
    (box.width - FIT_MARGIN) / content.width,
    (box.height - FIT_MARGIN) / content.height,
    MAX_SCALE,
  );
  return {
    tx: (box.width - content.width * scale) / 2,
    ty: (box.height - content.height * scale) / 2,
    scale,
  };
}

// The viewer's zoom range for this content in this box: MIN_SCALE to
// MAX_SCALE, except that the minimum reaches down to every scale the viewer
// itself offers: fit, for content that only fits below MIN_SCALE, so zooming
// out never moves away from fit; and `offered` (actual pixels, which on a
// dense screen of a pinch-zoomed page can be well under MIN_SCALE).
export function viewerScaleLimits(content: Size, box: Size, offered: number[] = []): ScaleLimits {
  const usable = offered.filter(scale => Number.isFinite(scale) && scale > 0);
  return { min: Math.min(MIN_SCALE, fitTransform(content, box).scale, ...usable), max: MAX_SCALE };
}

// The viewer's pan bound: keep at least `PAN_KEEP_VISIBLE` of the scaled
// content inside the box on each axis. Content smaller than the margin can
// only ever keep its whole self visible, so the margin shrinks to it rather
// than producing an empty range.
export function boundKeepVisible(t: ZoomTransform, content: Size, box: Size): ZoomTransform {
  if (box.width <= 0 || box.height <= 0 || content.width <= 0 || content.height <= 0) {
    return t;
  }
  const scaledWidth = content.width * t.scale;
  const scaledHeight = content.height * t.scale;
  const marginX = Math.min(PAN_KEEP_VISIBLE, scaledWidth, box.width);
  const marginY = Math.min(PAN_KEEP_VISIBLE, scaledHeight, box.height);
  return {
    tx: clamp(t.tx, marginX - scaledWidth, box.width - marginX),
    ty: clamp(t.ty, marginY - scaledHeight, box.height - marginY),
    scale: t.scale,
  };
}

// The inline pan bound: the scale never drops below `fitScale` (the at-fit
// floor) nor exceeds `maxScale`, and on every axis where the scaled content
// is at least as large as the box it covers the box, so no empty area shows.
// An axis still smaller than the box is centred.
export function boundCover(
  t: ZoomTransform,
  content: Size,
  box: Size,
  fitScale: number,
  maxScale: number = MAX_SCALE,
): ZoomTransform {
  const scale = clamp(t.scale, fitScale, Math.max(fitScale, maxScale));
  return {
    tx: coverAxis(t.tx, content.width * scale, box.width),
    ty: coverAxis(t.ty, content.height * scale, box.height),
    scale,
  };
}

function coverAxis(offset: number, scaled: number, box: number): number {
  if (scaled <= box) {
    return (box - scaled) / 2;
  }
  return clamp(offset, box - scaled, 0);
}

// The scale at which one natural pixel of a raster image covers one device
// pixel. `scale` multiplies the content's base size, so a base other than the
// natural size is folded in; with the base at the natural size this is
// `1 / devicePixelRatio`.
export function actualPixelsScale(
  devicePixelRatio: number,
  naturalWidth?: number,
  baseWidth?: number,
): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const ratio =
    naturalWidth && baseWidth && naturalWidth > 0 && baseWidth > 0 ? naturalWidth / baseWidth : 1;
  return ratio / dpr;
}
