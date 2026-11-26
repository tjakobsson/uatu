// The gesture state machine shared by the fullscreen viewer and inline zoom.
// It turns input points into pan, pinch, tap and double-tap intents. Points
// are plain records, so Pointer Events and Touch Events can both feed it and
// it can be unit-tested without a DOM. Applying an intent to a transform is
// the caller's job.
//
// One map of live pointers rather than a single id/origin pair. The pair was
// written for a mouse, where a second pointer cannot exist; on touch, an
// arriving or departing finger overwrote the pan origin without re-seeding it
// and the content jumped by the distance between the fingers.
//
// The pointer COUNT selects the gesture — 1 pans, 2 pinches, 3+ are ignored —
// and every transition between counts re-seeds, which is what makes the
// transitions invisible. `sync` is deliberately the only place that seeds
// anything, so there is no path that changes the count without re-seeding.

// Tap classification. A press that moves further than the slop, or (for
// touch and pen) lasts longer than the timeout, is a pan, not a tap. The same
// test gates panning: a press pans only once it can no longer be a tap, so a
// press never both moves the content and ends as a tap (which on the
// viewer's backdrop closes it). Crossing the slop pans by the whole offset
// since the press, so the content catches up with the pointer.
//
// A finger lands imprecisely and wobbles, so its slop is wide. A mouse holds
// still while clicking, so anything past a click's few pixels was meant as a
// drag, however slow (the mouse has no timeout: a slow click is a click).
export const TAP_MOVE_LIMIT = 12;
export const MOUSE_TAP_MOVE_LIMIT = 4;
export const TAP_MAX_MS = 400;
export const DOUBLE_TAP_MAX_GAP_MS = 300;
export const DOUBLE_TAP_SLOP = 40;

export type GesturePoint = {
  id: number;
  x: number;
  y: number;
  // Event time in ms (`event.timeStamp`).
  time: number;
  // `PointerEvent.pointerType`: "mouse", "touch" or "pen".
  type: string;
};

export type GestureIntent =
  // A one-pointer pan (re)starts at this point; capture the transform now.
  | { type: "pan-start"; x: number; y: number }
  // Total offset of the panning pointer since the last `pan-start`.
  | { type: "pan"; dx: number; dy: number; x: number; y: number }
  // A two-pointer pinch (re)starts; capture the scale now.
  | { type: "pinch-start"; x: number; y: number }
  // Current separation over the separation at `pinch-start`, around the
  // midpoint between the two pointers.
  | { type: "pinch"; ratio: number; x: number; y: number }
  // No pointer is down any more.
  | { type: "idle" }
  // `target` is where the whole press was (see GestureOptions.tapTarget).
  | { type: "tap"; x: number; y: number; pointerType: string; target: TapTarget }
  | { type: "double-tap"; x: number; y: number };

export type TapTarget = "media" | "backdrop";

// A press, from where it landed to where it was released.
export type Press = { start: { x: number; y: number }; end: { x: number; y: number } };

export type GestureOptions = {
  // Where a tap was: decided from its whole press, before it can pair with an
  // earlier tap, so a tap on the media and a tap on the backdrop never make a
  // double-tap together. Without it every tap is on the media.
  tapTarget?: (press: Press) => TapTarget;
};

// `maxMoved` is the FURTHEST this pointer has been from where it landed, not
// its current distance. A drag that wanders off and returns near its origin
// before release has the release-point distance of a tap while being nothing
// of the sort — panning out and back twice would otherwise read as a
// double-tap and snap the content to fit, discarding the user's position.
// Tap eligibility is lost the moment the limit is crossed and is never
// regained.
type ActivePointer = {
  x: number;
  y: number;
  downX: number;
  downY: number;
  downTime: number;
  maxMoved: number;
};

export class GestureTracker {
  private readonly pointers = new Map<number, ActivePointer>();
  private panOrigin: { x: number; y: number } | null = null;
  private pinchStartDistance: number | null = null;
  // A tap that was ever part of a multi-pointer gesture is not a tap.
  private wasMultiTouch = false;
  private lastTap: { x: number; y: number; time: number; target: TapTarget } | null = null;

  constructor(
    private readonly emit: (intent: GestureIntent) => void,
    private readonly options: GestureOptions = {},
  ) {}

  get size(): number {
    return this.pointers.size;
  }

  // Returns false when the point is ignored: a third or later pointer. Such
  // pointers are not tracked, so their moves and releases never reach the
  // state machine either; the caller should not capture them.
  down(point: GesturePoint): boolean {
    if (this.pointers.size >= 2) {
      this.wasMultiTouch = true;
      return false;
    }
    this.pointers.set(point.id, {
      x: point.x,
      y: point.y,
      downX: point.x,
      downY: point.y,
      downTime: point.time,
      maxMoved: 0,
    });
    this.sync();
    return true;
  }

  move(point: GesturePoint): void {
    const pointer = this.pointers.get(point.id);
    if (!pointer) {
      return;
    }
    pointer.x = point.x;
    pointer.y = point.y;
    pointer.maxMoved = Math.max(
      pointer.maxMoved,
      Math.hypot(pointer.x - pointer.downX, pointer.y - pointer.downY),
    );
    const active = Array.from(this.pointers.values());
    if (active.length === 2 && this.pinchStartDistance !== null) {
      const [a, b] = active as [ActivePointer, ActivePointer];
      // Measured against where the fingers began rather than accumulated per
      // move, so per-move rounding never drifts the scale.
      this.emit({
        type: "pinch",
        ratio: Math.max(distanceBetween(a, b), 1) / this.pinchStartDistance,
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
      });
      return;
    }
    // After a pinch no tap is possible, so the survivor pans at once.
    if (active.length === 1 && this.panOrigin && (this.wasMultiTouch || outgrewTap(pointer, point))) {
      this.emit({
        type: "pan",
        dx: pointer.x - this.panOrigin.x,
        dy: pointer.y - this.panOrigin.y,
        x: pointer.x,
        y: pointer.y,
      });
    }
  }

  up(point: GesturePoint): void {
    this.end(point, false);
  }

  // A cancelled pointer is not a tap either, and leaving a prior tap live
  // across it has the same stale-pairing consequence as any other non-tap.
  cancel(point: GesturePoint): void {
    this.end(point, true);
  }

  // Drop every live pointer and any pending tap. A surface that is reused
  // (the viewer across opens) calls this so a pointer whose release never
  // arrived does not leave a phantom finger, and a trailing tap does not pair
  // with the first tap of the next session into a spurious double-tap.
  reset(): void {
    this.pointers.clear();
    this.lastTap = null;
    this.wasMultiTouch = false;
    this.sync();
  }

  private end(point: GesturePoint, cancelled: boolean): void {
    const pointer = this.pointers.get(point.id);
    if (!pointer) {
      return;
    }
    if (cancelled) {
      this.lastTap = null;
    } else {
      this.classifyRelease(point, pointer);
    }
    this.pointers.delete(point.id);
    if (this.pointers.size === 0) {
      this.wasMultiTouch = false;
    }
    this.sync();
  }

  private sync(): void {
    const active = Array.from(this.pointers.values());
    if (active.length === 2) {
      // Entering (or continuing) a pinch.
      this.panOrigin = null;
      this.wasMultiTouch = true;
      const [a, b] = active as [ActivePointer, ActivePointer];
      this.pinchStartDistance = Math.max(distanceBetween(a, b), 1);
      this.emit({ type: "pinch-start", x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      return;
    }
    this.pinchStartDistance = null;
    if (active.length === 1) {
      // Seeds on 0→1 (a pan beginning) and equally on 2→1 (a finger lifting
      // out of a pinch). The second case is the one that used to jump: the
      // survivor resumes from wherever it is now, against the transform as it
      // now stands, so nothing moves at the transition.
      const only = active[0]!;
      this.panOrigin = { x: only.x, y: only.y };
      this.emit({ type: "pan-start", x: only.x, y: only.y });
      return;
    }
    this.panOrigin = null;
    this.emit({ type: "idle" });
  }

  // Anything that is not a tap BREAKS a tap sequence — it does not merely fail
  // to extend it. Returning early while leaving `lastTap` in place lets a tap,
  // then a pan or a pinch, then another tap read as a double-tap and snap the
  // content to fit, discarding exactly the position the intervening gesture
  // was used to reach. Every disqualifying path below therefore clears it.
  //
  // The mouse taps (a click, for backdrop dismissal) but never double-taps:
  // mouse surfaces use the native `dblclick`, which is reliable for the mouse,
  // while its synthesis on touch is not. A mouse click neither sets nor
  // invalidates a touch tap sequence, and a slow click is still a click.
  private classifyRelease(point: GesturePoint, pointer: ActivePointer): void {
    const isMouse = point.type === "mouse";
    if (this.wasMultiTouch || this.pointers.size > 1) {
      if (!isMouse) this.lastTap = null;
      return;
    }
    if (outgrewTap(pointer, point)) {
      if (!isMouse) this.lastTap = null;
      return;
    }
    const press = { start: { x: pointer.downX, y: pointer.downY }, end: { x: point.x, y: point.y } };
    const target = this.options.tapTarget?.(press) ?? "media";
    const tap = { type: "tap", x: point.x, y: point.y, pointerType: point.type, target } as const;
    if (isMouse) {
      this.emit(tap);
      return;
    }
    const previous = this.lastTap;
    if (
      previous &&
      previous.target === target &&
      point.time - previous.time <= DOUBLE_TAP_MAX_GAP_MS &&
      Math.hypot(point.x - previous.x, point.y - previous.y) <= DOUBLE_TAP_SLOP
    ) {
      this.lastTap = null;
      this.emit({ type: "double-tap", x: point.x, y: point.y });
      return;
    }
    this.lastTap = { x: point.x, y: point.y, time: point.time, target };
    this.emit(tap);
  }
}

// Whether a press, at `point`, can no longer be a tap: it has been further
// than the slop from where it landed, or (touch and pen) held too long.
function outgrewTap(pointer: ActivePointer, point: GesturePoint): boolean {
  const moved = Math.max(pointer.maxMoved, Math.hypot(point.x - pointer.downX, point.y - pointer.downY));
  const isMouse = point.type === "mouse";
  const tooLong = !isMouse && point.time - pointer.downTime > TAP_MAX_MS;
  return moved > (isMouse ? MOUSE_TAP_MOVE_LIMIT : TAP_MOVE_LIMIT) || tooLong;
}

// The gesture point of a pointer event: how both surfaces feed the tracker
// from Pointer Events (inline zoom also feeds it Touch Events, below).
export function pointerPoint(event: Pick<PointerEvent, "pointerId" | "clientX" | "clientY" | "timeStamp" | "pointerType">): GesturePoint {
  return { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp, type: event.pointerType };
}

export function touchPoint(touch: Pick<Touch, "identifier" | "clientX" | "clientY">, event: Pick<Event, "timeStamp">): GesturePoint {
  return { id: touch.identifier, x: touch.clientX, y: touch.clientY, time: event.timeStamp, type: "touch" };
}

// Whether a point is on the media (inside its displayed rectangle, edges
// included) or on the empty backdrop around it.
export function classifyTap(
  point: { x: number; y: number },
  media: { left: number; top: number; width: number; height: number },
): TapTarget {
  const inside =
    point.x >= media.left &&
    point.x <= media.left + media.width &&
    point.y >= media.top &&
    point.y <= media.top + media.height;
  return inside ? "media" : "backdrop";
}

// Where a press was: on the backdrop only when it both started and ended on
// it. A press that began on the media and slid off it, or the reverse, was
// aimed at the media, and dismissing on it would close the viewer mid-use.
export function classifyPress(press: Press, media: { left: number; top: number; width: number; height: number }): TapTarget {
  return classifyTap(press.start, media) === "backdrop" && classifyTap(press.end, media) === "backdrop" ? "backdrop" : "media";
}

function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
