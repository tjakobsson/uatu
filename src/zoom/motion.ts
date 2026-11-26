// How zoomed media moves, shared by the fullscreen viewer and inline zoom:
// gesture intents turned into transforms, and the commit-at-rest rendering
// protocol. Each surface keeps what is its own: its pan bound and zoom range,
// what a tap does, and where its layout is written.
//
// Neither part touches the DOM beyond the element a surface hands over for its
// committed state, so both are unit-testable without layout.

import type { GestureIntent } from "./gestures";
import { COMMIT_DELAY_MS, pinchTransform, type Point, type ScaleLimits, type ZoomTransform } from "./transform";

export type GestureSurface = {
  transform(): ZoomTransform;
  // A client point in the coordinates of the box that clips the media.
  toBox(point: Point): Point;
  limits(): ScaleLimits;
  // Move the media while input runs; the surface bounds it and commits at rest.
  move(next: ZoomTransform): void;
  // Whether a one-pointer drag moves the media now (inline: only once zoomed).
  canPan(): boolean;
  // A drag that moves the media began (true) or ended (false).
  panning(active: boolean): void;
  tap?(intent: Extract<GestureIntent, { type: "tap" }>): void;
  doubleTap?(intent: Extract<GestureIntent, { type: "double-tap" }>): void;
};

// The intent handler for one surface. A pan moves from the transform at its
// start by the pointer's whole offset; a pinch scales from the transform at
// its start, and the media point under the fingers' starting midpoint follows
// the midpoint as it moves. Both baselines are taken at the intent that
// (re)starts the gesture, which gestures.ts emits on every change in finger
// count, so no transition jumps.
export function gestureZoom(surface: GestureSurface): (intent: GestureIntent) => void {
  let panOrigin: { tx: number; ty: number } | null = null;
  let pinchStart: { transform: ZoomTransform; anchor: Point } | null = null;
  return intent => {
    switch (intent.type) {
      case "pan-start": {
        const { tx, ty } = surface.transform();
        panOrigin = { tx, ty };
        pinchStart = null;
        if (surface.canPan()) surface.panning(true);
        return;
      }
      case "pan":
        if (panOrigin && surface.canPan()) {
          surface.move({ tx: panOrigin.tx + intent.dx, ty: panOrigin.ty + intent.dy, scale: surface.transform().scale });
        }
        return;
      case "pinch-start":
        panOrigin = null;
        pinchStart = { transform: { ...surface.transform() }, anchor: surface.toBox(intent) };
        surface.panning(false);
        return;
      case "pinch":
        if (pinchStart) {
          surface.move(pinchTransform(pinchStart.transform, pinchStart.anchor, surface.toBox(intent), intent.ratio, surface.limits()));
        }
        return;
      case "idle":
        panOrigin = null;
        pinchStart = null;
        surface.panning(false);
        return;
      case "tap":
        surface.tap?.(intent);
        return;
      case "double-tap":
        surface.doubleTap?.(intent);
        return;
    }
  };
}

export type RestCommitTarget = {
  // Carries `data-zoom-state` (the committed transform) and
  // `data-zoom-pending` (a commit still to come).
  readonly element: Element;
  // The stage's transform, on top of its committed layout.
  setTransform(css: string): void;
  // Lay the stage out at `scale` times its unscaled size.
  setLayoutScale(scale: number): void;
};

export type Timers = {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

const browserTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// Commit at rest: while input runs the stage moves only through `transform`,
// scaled relative to the layout it was last committed at, which is cheap per
// frame; COMMIT_DELAY_MS after input stops the stage is laid out at the
// scaled size with only a `translate()` left, so vector content is redrawn at
// the displayed scale.
export class RestCommit {
  private committedScale = 1;
  private latest: ZoomTransform | null = null;
  private timer: unknown = null;

  constructor(
    private readonly target: RestCommitTarget,
    private readonly timers: Timers = browserTimers,
  ) {}

  // Show `t`: committed at once ("now": toolbar, keys, fit) or once input
  // stops ("settle": drag, pinch, wheel).
  show(t: ZoomTransform, mode: "now" | "settle"): void {
    this.latest = t;
    if (mode === "now") {
      this.commit();
      return;
    }
    this.target.setTransform(`translate(${t.tx}px, ${t.ty}px) scale(${t.scale / this.committedScale})`);
    this.target.element.setAttribute("data-zoom-pending", "");
    this.cancel();
    this.timer = this.timers.set(() => this.commit(), COMMIT_DELAY_MS);
  }

  // Drop any commit still to come and take the stage as laid out unscaled.
  // The surface writes its own state attributes for what it now shows.
  reset(): void {
    this.cancel();
    this.latest = null;
    this.committedScale = 1;
  }

  private commit(): void {
    this.cancel();
    const t = this.latest;
    if (!t) return;
    this.target.setLayoutScale(t.scale);
    this.target.setTransform(`translate(${t.tx}px, ${t.ty}px)`);
    this.committedScale = t.scale;
    this.target.element.setAttribute("data-zoom-state", JSON.stringify({ tx: t.tx, ty: t.ty, scale: t.scale }));
    this.target.element.removeAttribute("data-zoom-pending");
  }

  private cancel(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }
}
