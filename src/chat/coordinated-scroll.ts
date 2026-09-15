import type { TimelineAnchorController, AnchorGeometry } from "./anchor";

/** Shell line anchors can supply the same operations without depending on DOM rows. */
export type CoordinatedScrollAnchor = Pick<TimelineAnchorController,
  "isPinned" | "afterMutation" | "beforeMutation" | "jumpToLatest" | "pause" | "observe">;

export interface CoordinatedScrollOptions {
  anchor: CoordinatedScrollAnchor;
  /** Include semantic items when requested, even if the anchor is still pinned. */
  measure: (includeItems: boolean) => AnchorGeometry;
  active?: () => boolean;
  onChange?: () => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
}

const owners = new WeakMap<HTMLElement, CoordinatedScrollOwner>();

/** The only automatic position writer for a managed scroller. */
export class CoordinatedScrollOwner {
  private frame: number | null = null;
  private newContent = false;
  private disposed = false;
  private previous: AnchorGeometry;
  private touchY: number | null = null;
  private upwardPending = false;
  private lastCorrectionFrame = -Infinity;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (id: number) => void;
  private readonly previousAnchoring: string;
  private readonly previousBehavior: string;

  constructor(readonly scroller: HTMLElement, private readonly options: CoordinatedScrollOptions) {
    if (owners.has(scroller)) throw new Error("Scroller already has a coordinated owner");
    owners.set(scroller, this);
    this.requestFrame = options.requestFrame ?? (callback => requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame ?? (id => cancelAnimationFrame(id));
    this.previous = options.measure(false);
    this.previousAnchoring = scroller.style.getPropertyValue("overflow-anchor");
    this.previousBehavior = scroller.style.getPropertyValue("scroll-behavior");
    scroller.style.setProperty("overflow-anchor", "none");
    scroller.style.setProperty("scroll-behavior", "auto");
    scroller.addEventListener("scroll", this.observe, { passive: true });
    scroller.addEventListener("wheel", this.wheel, { passive: true });
    scroller.addEventListener("touchstart", this.touchStart, { passive: true });
    scroller.addEventListener("touchmove", this.touchMove, { passive: true });
    scroller.addEventListener("keydown", this.keyDown);
  }

  private active(): boolean { return !this.disposed && (this.options.active?.() ?? true); }
  private measure(): AnchorGeometry { return this.options.measure(!this.options.anchor.isPinned()); }

  /** Coalesces render, resize, toggle and viewport work. Reads geometry at execution. */
  request(hasNewContent = false): void {
    if (!this.active()) return;
    this.newContent ||= hasNewContent;
    if (this.frame !== null) return;
    this.frame = this.requestFrame(timestamp => {
      this.frame = null;
      this.flush(timestamp);
    });
  }

  /** Finish a render in its existing rAF, using that callback's timestamp.
   * All callers in the same browser frame share a single correction budget.
   */
  flush(timestamp: number): void {
    if (!this.active()) { this.cancel(); return; }
    if (this.lastCorrectionFrame === timestamp) { this.request(); return; }
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    const geometry = this.measure();
    const target = this.options.anchor.afterMutation(geometry, this.newContent);
    this.newContent = false;
    const top = Math.max(0, Math.min(target, geometry.scrollHeight - geometry.clientHeight));
    if (Math.abs(this.scroller.scrollTop - top) > 0.5) {
      this.lastCorrectionFrame = timestamp;
      this.scroller.scrollTop = top;
    }
    this.previous = { ...geometry, scrollTop: this.scroller.scrollTop };
    // Any later scroll echo belongs to this correction, not an earlier
    // wheel/key gesture whose native movement never arrived.
    this.upwardPending = false;
    this.options.onChange?.();
  }

  beforeMutation(preferredItemId?: string): void {
    if (this.active() && !this.options.anchor.isPinned()) {
      // Do not overwrite the pre-mutation anchor while a correction is waiting.
      if (this.frame === null) this.options.anchor.beforeMutation(this.measure(), preferredItemId);
    }
  }

  /** Immediate positioning, on the next coordinated frame, never a smooth animation. */
  latest(): void {
    if (!this.active()) return;
    this.upwardPending = false;
    this.options.anchor.jumpToLatest(this.options.measure(false));
    this.request();
    this.options.onChange?.();
  }

  /** Cancel pending work and transient input, retaining the anchor's follow choice. */
  cancel(): void {
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    this.newContent = false;
    this.upwardPending = false;
    this.touchY = null;
  }

  pause(): void {
    if (!this.active()) return;
    this.cancel();
    const geometry = this.options.measure(true);
    this.options.anchor.pause(geometry);
    this.upwardPending = true;
    this.previous = geometry;
    this.options.onChange?.();
  }

  private observe = (): void => {
    if (!this.active()) return;
    const geometry = this.measure();
    const previous = this.previous;
    const changedExtent = geometry.scrollHeight !== previous.scrollHeight || geometry.clientHeight !== previous.clientHeight;
    const movement = geometry.scrollTop < previous.scrollTop - 0.5 ? "up"
      : geometry.scrollTop > previous.scrollTop + 0.5 ? "down" : "none";
    const bottom = Math.max(0, geometry.scrollHeight - geometry.clientHeight);
    const clamped = changedExtent && bottom < previous.scrollTop - 0.5 && Math.abs(geometry.scrollTop - bottom) <= 1;
    if (clamped) {
      // A pending upward gesture can have no native movement at a boundary.
      // It must not turn a later maximize/layout clamp into a new anchor.
      this.upwardPending = false;
      this.request();
    } else if (this.upwardPending && movement !== "none") {
      this.upwardPending = false;
      this.options.anchor.pause(this.options.measure(true));
    } else if (changedExtent && movement !== "up") {
      // Extent growth alone cannot speak for the reader. An unaccounted
      // upward movement can reveal intrinsic-size content at the same time;
      // it still pauses following. Actual clamps were handled above, and our
      // own assignments already updated `previous` in flush().
      this.request();
    } else {
      this.options.anchor.observe(movement === "up" ? this.options.measure(true) : geometry, movement);
      if (this.options.anchor.isPinned()) this.request();
    }
    this.previous = geometry;
    this.options.onChange?.();
  };

  private ownsInput(event: Event): boolean {
    for (const target of event.composedPath()) {
      if (target === this.scroller) return true;
      if (owners.has(target as HTMLElement)) return false;
    }
    return false;
  }
  private wheel = (event: WheelEvent): void => { if (event.deltaY < 0 && this.ownsInput(event)) this.pause(); };
  private touchStart = (event: TouchEvent): void => { this.touchY = this.ownsInput(event) ? event.touches[0]?.clientY ?? null : null; };
  private touchMove = (event: TouchEvent): void => {
    const y = event.touches[0]?.clientY;
    if (y !== undefined && this.touchY !== null && y > this.touchY && this.ownsInput(event)) this.pause();
    this.touchY = y ?? null;
  };
  private keyDown = (event: KeyboardEvent): void => {
    if (!this.ownsInput(event) || (event.target as Element).closest("input, textarea, select, [contenteditable=true]")) return;
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) this.pause();
  };

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    this.scroller.removeEventListener("scroll", this.observe);
    this.scroller.removeEventListener("wheel", this.wheel);
    this.scroller.removeEventListener("touchstart", this.touchStart);
    this.scroller.removeEventListener("touchmove", this.touchMove);
    this.scroller.removeEventListener("keydown", this.keyDown);
    this.scroller.style.setProperty("overflow-anchor", this.previousAnchoring);
    this.scroller.style.setProperty("scroll-behavior", this.previousBehavior);
    owners.delete(this.scroller);
  }
}
