import type { TimelineAnchorController, AnchorGeometry, TimelinePosition } from "./anchor";

/** Shell line anchors can supply the same operations without depending on DOM rows. */
export type CoordinatedScrollAnchor = Pick<TimelineAnchorController,
  "isPinned" | "afterMutation" | "beforeMutation" | "jumpToLatest" | "pause" | "observe">;

export interface CoordinatedScrollOptions {
  anchor: CoordinatedScrollAnchor;
  /** Timeline lifecycle capability; shell adapters keep their own positions. */
  position?: Pick<TimelineAnchorController, "capturePosition" | "restorePosition">;
  /** Include semantic items when requested, even if pinned. Preserve the
   * retained reading location by default; false captures fresh reader intent. */
  measure: (includeItems: boolean, preserveAnchor?: boolean, preferredItemId?: string) => AnchorGeometry;
  active?: () => boolean;
  onChange?: () => void;
  /** Defaults to instant. Read each frame so reduced-motion changes finish an in-flight follow. */
  followMotion?: () => "smooth" | "instant";
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
}

/** How a reveal places its target inside the visible band. */
export interface RevealOptions {
  /**
   * A second element that has to land in the band with the target. A request's
   * answer field is answered with the row that carries its submit and cancel
   * controls, so the two are placed as one block: revealing the field alone
   * would be free to leave the buttons under the keyboard.
   */
  extent?: HTMLElement;
  /**
   * `nearest` — the minimal move that puts the target inside the band, which
   * is what an ordinary reveal wants: it disturbs the reader least.
   * `end` — the target's extent sits at the bottom of the band. A held answer
   * field needs this: `nearest` asks for no move at all when the platform's
   * own focus scroll already left the field high in the band, which is how a
   * strip of empty conversation ends up between the answer controls and the
   * keyboard's edge.
   * `center` — center an explicitly selected request in the visible band.
   * Targets taller than the band keep their top visible in every mode.
   */
  align?: "nearest" | "end" | "center";
}

const owners = new WeakMap<HTMLElement, CoordinatedScrollOwner>();

/** The only automatic position writer for a managed scroller. */
export class CoordinatedScrollOwner {
  private frame: number | null = null;
  private newContent = false;
  private revealTarget: HTMLElement | (() => HTMLElement | null | undefined) | null = null;
  private revealOptions: RevealOptions | undefined;
  private revealRevision = 0;
  private heldTarget: HTMLElement | null = null;
  private heldOptions: RevealOptions | undefined;
  private heldTop: number | null = null;
  private resumeFollowing = false;
  // Durable reading beneath answer placement, retained after blur until a new
  // reader choice or departure. The live anchor still owns focus placement.
  private heldPosition: TimelinePosition | undefined;
  private pendingPosition: { position: TimelinePosition; reader: boolean } | undefined;
  private disposed = false;
  private previous: AnchorGeometry;
  private touchY: number | null = null;
  // Reuse only the intent capture of this uninterrupted upward touch run.
  // Native scrolls still capture fresh positions; new coordinator work renews intent.
  private touchPaused = false;
  private upwardPending = false;
  // Only the native reveal belonging to this focus transition, until its next
  // frame. A focused control is not a standing request to pause following.
  private focusNavigation: { target: HTMLElement; top: number } | null = null;
  private lastCorrectionFrame = -Infinity;
  private positioned = false;
  private instantNext = false;
  private motion: { from: number; target: number; started: number; sampled: number; deadline: number } | null = null;
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
    scroller.addEventListener("pointerdown", this.pointerDown, { passive: true });
    scroller.addEventListener("focusin", this.focusIn);
  }

  private active(): boolean { return !this.disposed && (this.options.active?.() ?? true); }
  private measure(preferredItemId?: string): AnchorGeometry {
    return this.options.measure(!this.options.anchor.isPinned(), undefined, preferredItemId);
  }

  /** Durable intent, independent of loading geometry and temporary answer placement. */
  capturePosition(): TimelinePosition {
    if (!this.options.position) throw new Error("Timeline position adapter required");
    return this.pendingPosition?.position ?? this.heldPosition
      ?? this.options.position.capturePosition(this.scroller.scrollTop);
  }

  /** Stage navigation, without treating programmatic restoration as reader input. */
  restorePosition(position: TimelinePosition): void {
    if (!this.options.position) throw new Error("Timeline position adapter required");
    this.cancel();
    this.pendingPosition = { position, reader: false };
    this.options.position.restorePosition(position);
  }

  private readerChose(): void {
    this.cancelNavigationReveal();
    this.heldPosition = undefined;
    if (!this.pendingPosition || !this.options.position) return;
    // Until the incoming transcript renders, its semantic items are unavailable.
    // A genuine pause still chooses this offset, not an outgoing view's row.
    const position = this.options.position.capturePosition(this.scroller.scrollTop);
    this.pendingPosition = { reader: true, position: position.kind === "following" ? position
      : { kind: "paused", top: this.scroller.scrollTop } };
  }

  /** Coalesces render, resize, toggle and viewport work. Reads geometry at execution. */
  request(hasNewContent = false): void {
    if (!this.active()) return;
    this.touchPaused = false;
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
  flush(timestamp: number, options?: { rendered?: boolean }): void {
    if (!this.active()) { this.cancel(); return; }
    if (this.focusNavigation) this.adoptFocusNavigation(this.options.measure(false));
    this.focusNavigation = null;
    this.touchPaused = false;
    // Consume the actual-render handshake before the write-budget guard: an
    // earlier correction in this frame must not lose the incoming position.
    if (options?.rendered && this.pendingPosition) {
      const pending = this.pendingPosition;
      this.pendingPosition = undefined;
      this.options.position!.restorePosition(pending.position);
      if (!pending.reader && pending.position.kind === "following") {
        // Retire old callbacks, then cross the rendering layout boundary using
        // this same cancellable owner. Saved reading positions remain atomic.
        if (this.frame !== null) this.cancelFrame(this.frame);
        this.frame = null;
        this.motion = null;
        this.instantNext = true;
        this.request();
        return;
      }
    }
    if (this.pendingPosition) return;
    if (this.lastCorrectionFrame === timestamp) { this.request(); return; }
    if (typeof this.revealTarget === "function") {
      const resolve = this.revealTarget, placement = this.revealOptions, revision = this.revealRevision;
      // Focus performed by the resolver is part of this reveal, not newer
      // navigation. Reentrant cancellation or another reveal still wins.
      this.revealTarget = null;
      const target = resolve();
      if (!this.active() || revision !== this.revealRevision) return;
      this.revealTarget = target ?? null;
      this.revealOptions = placement;
      if (target === undefined) {
        this.revealTarget = resolve;
        this.request();
        return;
      }
      this.focusNavigation = null;
    }
    // Retire stale DOM ownership before the anchor chooses this frame's top.
    if (this.heldTarget && !this.scroller.contains(this.heldTarget)) this.release();
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    const geometry = this.measure();
    const following = this.options.anchor.isPinned();
    // WebKit exposes native rubber-banding beyond the bottom through scrollTop.
    // A follow correction there clamps the compositor's excursion and kills its
    // settling motion. Explicit placement and control reveals still take over.
    if (following && geometry.scrollTop > Math.max(0, geometry.scrollHeight - geometry.clientHeight)
      && this.positioned && !this.instantNext && !this.revealTarget && !this.heldTarget) {
      this.motion = null;
      this.newContent = false;
      this.previous = geometry;
      this.options.onChange?.();
      return;
    }
    const target = this.options.anchor.afterMutation(geometry, this.newContent);
    this.newContent = false;
    const limit = Math.max(0, geometry.scrollHeight - geometry.clientHeight);
    // A paused anchor can also be inside native rubber-banding. If layout
    // asks for no movement, clamping its unchanged position is still a write
    // that would interrupt the gesture. Actual corrections remain bounded.
    const unchangedElastic = this.positioned && !this.instantNext && !this.revealTarget && !this.heldTarget
      // Subtracting a fractional retained offset can introduce roundoff even
      // with unchanged geometry; a millionth of a CSS pixel is not movement.
      && Math.abs(target - geometry.scrollTop) < 1e-6 && (target < 0 || target > limit);
    const destination = unchangedElastic ? target : Math.max(0, Math.min(target, limit));
    const exactPlacement = !this.positioned || this.instantNext || this.motion !== null;
    let top = destination;
    if (this.positioned && !this.instantNext && !this.revealTarget && !this.heldTarget
      && following && this.options.followMotion?.() === "smooth"
      && Math.abs(destination - geometry.scrollTop) > 0.5) {
      if (this.motion?.target !== destination && Math.abs(destination - geometry.scrollTop) > 0.5) {
        // Spend the elapsed frame on the newest target instead of restarting
        // at zero every time the stream grows (which would starve motion).
        this.motion = { from: geometry.scrollTop, target: destination,
          started: this.motion?.sampled ?? timestamp, sampled: timestamp, deadline: timestamp + 240 };
      }
      if (this.motion) {
        // Retarget from the visible position, never from an obsolete origin.
        // A final layout change therefore settles within 240ms of its frame.
        const duration = Math.max(1, this.motion.deadline - this.motion.started);
        const progress = Math.min(1, Math.max(0, (timestamp - this.motion.started) / duration));
        top = this.motion.from + (destination - this.motion.from) * (1 - (1 - progress) ** 3);
        this.motion.sampled = timestamp;
        if (progress === 1) this.motion = null;
      }
    } else this.motion = null;
    this.positioned = true;
    this.instantNext = false;
    // Resolve the reveal against the proposed anchor position before writing:
    // the two sources share one correction, rather than visibly fighting.
    const reveal = this.resolveReveal(top);
    top = reveal.top;
    if (Math.abs(this.scroller.scrollTop - top) > 0.5
      || (exactPlacement && !this.motion && this.options.anchor.isPinned() && this.scroller.scrollTop !== top)) {
      this.lastCorrectionFrame = timestamp;
      this.scroller.scrollTop = top;
    }
    this.previous = { ...geometry, scrollTop: this.scroller.scrollTop };
    if (reveal.moved) {
      this.options.anchor.pause(this.options.measure(true, false));
      if (!this.heldTarget) this.readerChose();
      this.motion = null;
    }
    // Any later scroll echo belongs to this correction, not an earlier
    // wheel/key gesture whose native movement never arrived.
    this.upwardPending = false;
    // Whatever this frame settled on — the anchor's correction, the reveal's
    // refinement of it, or neither — is the position the hold now defends.
    if (this.heldTarget) this.heldTop = this.scroller.scrollTop;
    if (this.motion) this.request();
    this.options.onChange?.();
  }

  /**
   * Bring an element inside the scroller's client box on the next coordinated
   * frame. Focus is the caller here — a request's answer field under the
   * software keyboard — and this owner is the only automatic position writer,
   * so the alternative would be a raw `scrollIntoView` on a scroller it
   * manages, which the anchor would then correct straight back. A resolver
   * selects the current DOM node immediately before measurement: undefined
   * waits for rendering, null cancels. New reader input cancels a resolver.
   */
  reveal(element: HTMLElement | (() => HTMLElement | null | undefined), options?: RevealOptions): void {
    if (!this.active()) return;
    this.revealRevision++;
    this.revealTarget = element;
    this.revealOptions = options;
    this.request();
  }

  /**
   * Reveal the element and then keep it there: while a hold is in force, a
   * scroll this owner did not write is undone on the next coordinated frame.
   *
   * A standing mode rather than `reveal(element, { hold: true })`: a reveal is
   * consumed by the frame it is served in, a hold outlives it and has to be
   * ended by name, so an option on the one-shot call would give the mode a
   * beginning and no matching end. `overflow: hidden` or `touch-action: none`
   * would be the platform's way to say the same thing, and WebKit's selection
   * autoscroll honours neither — it moves the scroller while a caret is
   * dragged near its edge regardless. This owner is already the only
   * automatic position writer for the scroller, so defending a position it
   * wrote is its own job rather than a new one.
   */
  hold(element: HTMLElement, options?: RevealOptions): void {
    if (!this.active()) return;
    if (!this.heldTarget) {
      this.resumeFollowing = this.options.anchor.isPinned();
      if (this.options.position) this.heldPosition = this.capturePosition();
    }
    this.heldTarget = element;
    // A hold ends at the bottom of the band unless its caller says otherwise:
    // a held control is one the reader is typing into under a keyboard, and
    // the band's bottom is the only place that is stable whether the platform
    // scrolled the control too high or not at all.
    this.heldOptions = { align: "end", ...options };
    this.heldTop = null;
    this.reveal(element, this.heldOptions);
  }

  /** Whether this exact, still-contained control owns the standing hold. */
  isHolding(element: HTMLElement): boolean {
    return this.heldTarget === element && this.scroller.contains(element);
  }

  /** End the hold without undoing focus navigation. Keep a paused view's
   * durable reading for departure until a newer reader choice supersedes it.
   * Following resumes through a coordinated frame and its final geometry. */
  release(): void {
    const resume = this.resumeFollowing;
    const held = this.heldPosition;
    this.clearHold();
    if (held?.kind !== "following") this.heldPosition = held;
    if (resume) {
      // Ending a temporary control placement restores its prior follow intent;
      // it is not a new reader-requested animated journey through the transcript.
      this.motion = null;
      this.instantNext = true;
      this.options.anchor.jumpToLatest(this.options.measure(false));
      this.request();
      this.options.onChange?.();
    }
  }

  private clearHold(): void {
    this.resumeFollowing = false;
    this.heldPosition = undefined;
    this.heldTarget = null;
    this.heldOptions = undefined;
    this.heldTop = null;
    this.revealTarget = null;
    this.revealOptions = undefined;
  }

  /**
   * The minimal move that puts the target inside the client box, honouring
   * the scroller's own scroll padding so a revealed control does not park
   * under a floating overlay.
   *
   * A reveal that actually moves the scroller re-captures through the
   * anchor's `pause()`: the reader was deliberately given this position, and
   * an anchor left as it was — pinned to the end, or holding an item further
   * up — would snap off it on the very next correction. `pause()` rather than
   * `beforeMutation()` because unpinning is part of what must happen; it is
   * the same treatment an upward gesture gets. A reveal that needs no move
   * leaves the anchor alone, so following is not lost for nothing.
   */
  private resolveReveal(proposedTop: number): { top: number; moved: boolean } {
    const target = this.revealTarget;
    const options = this.revealOptions;
    this.revealTarget = null;
    this.revealOptions = undefined;
    if (!target || typeof target === "function" || !this.scroller.contains(target)) return { top: proposedTop, moved: false };
    const delta = this.revealDelta(target, options, proposedTop);
    if (Math.abs(delta) < 0.5) return { top: proposedTop, moved: false };
    const limit = Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight);
    const top = Math.max(0, Math.min(proposedTop + delta, limit));
    return { top, moved: Math.abs(top - proposedTop) > 0.5 };
  }

  private revealDelta(target: HTMLElement, options: RevealOptions | undefined, proposedTop: number): number {
    if (typeof target.getBoundingClientRect !== "function") return 0;
    const box = this.scroller.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    // The extent is placed with the target, as one block: for an answer field
    // that is the field plus the row holding its submit and cancel controls.
    let unionTop = rect.top;
    let unionBottom = rect.bottom;
    const extent = options?.extent;
    if (extent && typeof extent.getBoundingClientRect === "function" && this.scroller.contains(extent)) {
      const extra = extent.getBoundingClientRect();
      unionTop = Math.min(unionTop, extra.top);
      unionBottom = Math.max(unionBottom, extra.bottom);
    }
    const shift = proposedTop - this.scroller.scrollTop;
    unionTop -= shift;
    unionBottom -= shift;
    // No computed style (or none declared) means no reserved band: 0.
    const style = typeof getComputedStyle === "function" ? getComputedStyle(this.scroller) : null;
    const padTop = Number.parseFloat(style?.scrollPaddingTop ?? "") || 0;
    const padBottom = Number.parseFloat(style?.scrollPaddingBottom ?? "") || 0;
    // While a request is answered the software keyboard covers the lower part
    // of this scroller rather than shortening it, so its client box is not the
    // band the reader can see. Revealing into the box alone would park the
    // control under the keyboard — exactly where it must not be.
    const visual = typeof window !== "undefined" ? window.visualViewport : null;
    const visualBottom = visual ? visual.offsetTop + visual.height : Infinity;
    const top = Math.max(box.top, visual?.offsetTop ?? -Infinity) + padTop;
    const bottom = Math.min(box.top + this.scroller.clientHeight, visualBottom) - padBottom;
    if (bottom <= top) return 0;
    // A target taller than the band aligns to its top rather than scrolling
    // its own top out of view to chase its bottom — under either rule, since
    // showing the buttons by hiding the question answers nothing.
    const taller = unionBottom - unionTop > bottom - top;
    if (options?.align === "end") return taller ? unionTop - top : unionBottom - bottom;
    if (options?.align === "center") return taller ? unionTop - top : (unionTop + unionBottom - top - bottom) / 2;
    if (unionTop < top) return unionTop - top;
    if (unionBottom > bottom) return Math.min(unionBottom - bottom, unionTop - top);
    return 0;
  }

  beforeMutation(preferredItemId?: string): void {
    if (this.pendingPosition) return;
    if (this.active() && !this.options.anchor.isPinned()) {
      this.touchPaused = false;
      // Do not overwrite the pre-mutation anchor while a correction is waiting.
      if (this.frame === null) this.options.anchor.beforeMutation(this.measure(preferredItemId), preferredItemId);
      if (preferredItemId && !this.heldTarget) this.readerChose();
    }
  }

  /** Resume following. Initial views may opt out of motion for their first placement. */
  latest(options?: { motion?: "instant" }): void {
    if (!this.active()) return;
    this.revealRevision++;
    this.clearHold();
    this.motion = null;
    this.positioned = true;
    this.instantNext = options?.motion === "instant";
    this.upwardPending = false;
    // An explicit jump to the end outranks a reveal still waiting for a frame.
    this.revealTarget = null;
    this.revealOptions = undefined;
    this.options.anchor.jumpToLatest(this.options.measure(false));
    this.readerChose();
    this.request();
    this.options.onChange?.();
  }

  /** Cancel work and transient input, retaining the anchor's follow choice.
   * A passive snapshot keeps unconsumed instant placement and, after answer
   * blur, both live reading and the separate durable position for departure.
   * Active holds restore their original intent so callers can renew them.
   * This neither schedules work nor creates a new follow choice.
   */
  cancel(options?: { forSnapshot?: boolean }): void {
    this.revealRevision++;
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    this.motion = null;
    if (!options?.forSnapshot) this.instantNext = false;
    this.newContent = false;
    this.upwardPending = false;
    this.focusNavigation = null;
    this.revealTarget = null;
    this.revealOptions = undefined;
    // A hold is transient input too: the gestures and teardowns that cancel
    // pending work are the reader, or the surface, taking the scroller back.
    // Cancelling a temporary hold restores its follow choice, but schedules
    // nothing. pause() immediately replaces that choice with explicit intent.
    const resume = this.resumeFollowing;
    const held = this.heldPosition;
    const preserveReleasedPosition = options?.forSnapshot && !this.heldTarget;
    this.clearHold();
    if (preserveReleasedPosition) this.heldPosition = held;
    else if (held) this.options.position!.restorePosition(held);
    else if (resume) this.options.anchor.jumpToLatest(this.options.measure(false));
    this.touchY = null;
  }

  pause(): void {
    if (!this.active()) return;
    this.cancel();
    const geometry = this.options.measure(!this.pendingPosition, false);
    this.options.anchor.pause(geometry);
    this.upwardPending = true;
    this.previous = geometry;
    this.readerChose();
    this.options.onChange?.();
  }

  private observe = (): void => {
    if (!this.active()) return;
    // Classify native movement using extents only. Semantic geometry is read
    // once below, after deciding whether to retain or replace the reading anchor.
    const geometry = this.options.measure(false);
    if (this.adoptFocusNavigation(geometry)) return;
    const previous = this.previous;
    const changedExtent = geometry.scrollHeight !== previous.scrollHeight || geometry.clientHeight !== previous.clientHeight;
    const bottom = Math.max(0, geometry.scrollHeight - geometry.clientHeight);
    // Elastic rebound is not upward reader intent. Compare positions inside
    // their native ranges; explicit wheel/touch/key intent still pauses first.
    const currentTop = Math.max(0, Math.min(geometry.scrollTop, bottom));
    const previousTop = Math.max(0, Math.min(previous.scrollTop, previous.scrollHeight - previous.clientHeight));
    // Native fractional reader movement is still intent, not the animation's
    // half-pixel settling tolerance. Ignore only floating-point roundoff.
    const movement = currentTop < previousTop - 1e-6 ? "up"
      : currentTop > previousTop + 1e-6 ? "down" : "none";
    if (this.heldTarget) {
      // The held control's position is the one this scroller has. A scroll we
      // did not write — WebKit's autoscroll as the caret is dragged to the
      // edge of the field, a stray pan — is undone on the next coordinated
      // frame by re-running the reveal, which recomputes the minimal move for
      // the held control, so it lands in view even when the content above it
      // changed height in between. None of this speaks for the reader: a held
      // scroll must not pause following or re-anchor.
      const moved = this.heldTop === null || Math.abs(geometry.scrollTop - this.heldTop) > 0.5;
      if (moved || changedExtent) this.reveal(this.heldTarget, this.heldOptions);
      this.previous = geometry;
      return;
    }
    // A shrinking extent can leave WebKit beyond its new bottom until native
    // rebound finishes. Keep existing follow intent; explicit upward input has
    // already paused the anchor before this event.
    const clamped = this.isExtentClamp(geometry);
    if (clamped) {
      // A pending upward gesture can have no native movement at a boundary.
      // It must not turn a later maximize/layout clamp into a new anchor.
      this.upwardPending = false;
      this.request();
    } else if (this.upwardPending && (movement !== "none"
      // A not-yet-rendered child can still expose its outgoing raw offset
      // outside an empty extent. Explicit pause input owns this progress too.
      || (this.pendingPosition?.reader && !changedExtent && Math.abs(geometry.scrollTop - previous.scrollTop) > 1e-6))) {
      this.upwardPending = false;
      this.options.anchor.pause(this.options.measure(!this.pendingPosition, false));
      this.readerChose();
    } else if (geometry.clientHeight !== previous.clientHeight && this.options.anchor.isPinned()) {
      // Native caret positioning can move a pinned transcript upward when
      // composer/dock chrome resizes its viewport. That is layout, not reader
      // intent. Explicit upward input was handled above; intrinsic content
      // changes alone still take the ordinary movement path below.
      this.request();
    } else if (movement === "down" && this.options.anchor.isPinned()) {
      // Preserve follow intent during catch-up, but let adapters observe other
      // axes (shell horizontal scrolling) before the next correction restores them.
      this.options.anchor.observe(geometry, "none");
      if (!changedExtent) this.readerChose();
      // Catch-up leaves room for a reader to move toward latest themselves.
      // Only upward intent pauses following; rebase from their new position
      // so an older animation curve cannot pull their forward progress back.
      if (geometry.scrollTop >= bottom - 0.5) this.motion = null;
      else if (this.motion) {
        this.motion.from = geometry.scrollTop;
        this.motion.started = this.motion.sampled;
      }
      this.request();
    } else if (changedExtent && movement !== "up"
      && !(movement === "down" && geometry.scrollTop > previous.scrollTop + 1e-6 && !this.pendingPosition)) {
      // Extent growth alone cannot speak for the reader. An unaccounted
      // upward movement can reveal intrinsic-size content at the same time;
      // it still pauses following. Actual clamps were handled above, and our
      // own assignments already updated `previous` in flush(). A loaded reader's
      // raw downward progress still reaches the arrival rule during a resize;
      // normalized progress from an unchanged elastic offset does not.
      this.request();
    } else {
      if (!this.pendingPosition || movement !== "none") {
        this.options.anchor.observe(this.pendingPosition ? geometry
          : movement !== "none" ? this.options.measure(true, false) : this.measure(), movement);
        if (movement !== "none") this.readerChose();
      }
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
  /** A caret placement or selection drag inside a text control is not a request
   * to move the conversation. */
  private inTextControl(event: Event): boolean {
    const target = event.target as Element | null;
    const control = target?.closest?.("input, textarea, [contenteditable]");
    if (!control) return false;
    if (control.tagName === "TEXTAREA") return true;
    if (control.tagName === "INPUT") return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]
      .includes((control.getAttribute("type") ?? "text").toLowerCase());
    return (control as HTMLElement).isContentEditable || ["", "true", "plaintext-only"].includes(control.getAttribute("contenteditable") ?? "false");
  }
  private cancelNavigationReveal(): void {
    if (typeof this.revealTarget !== "function") return;
    this.revealRevision++;
    this.revealTarget = null;
    this.revealOptions = undefined;
  }
  private isExtentClamp(geometry: AnchorGeometry): boolean {
    const previous = this.previous;
    const changed = geometry.scrollHeight !== previous.scrollHeight || geometry.clientHeight !== previous.clientHeight;
    const bottom = Math.max(0, geometry.scrollHeight - geometry.clientHeight);
    return changed && bottom < previous.scrollTop - 0.5
      && (Math.abs(geometry.scrollTop - bottom) <= 1 || (this.options.anchor.isPinned() && geometry.scrollTop > bottom));
  }
  private focusIn = (event: FocusEvent): void => {
    this.cancelNavigationReveal();
    if (!this.active() || this.heldTarget || this.inTextControl(event)) return;
    this.focusNavigation = null;
    const target = event.target as HTMLElement;
    const geometry = this.options.measure(false);
    if (this.isExtentClamp(geometry) || this.previous.scrollTop < 0
      || this.previous.scrollTop > Math.max(0, this.previous.scrollHeight - this.previous.clientHeight)) return;
    // Focusing can scroll before focusin, but scroll delivery is asynchronous.
    // Growth can accompany that placement. Keep the pre-focus offset unless
    // viewport layout or a native range clamp explains the change instead.
    // Unlike gestures, focus may place several ancestor scrollports at once.
    const top = geometry.clientHeight === this.previous.clientHeight
      ? this.previous.scrollTop : geometry.scrollTop;
    if (Math.abs(this.revealDelta(target, undefined, top)) <= 0.5) return;
    this.focusNavigation = { target, top };
    this.request();
  };
  private adoptFocusNavigation(geometry: AnchorGeometry): boolean {
    const navigation = this.focusNavigation;
    // Layout has already explained this placement. Retire the observation
    // before advancing `previous`, or the next frame could adopt it as input.
    if (navigation && (this.isExtentClamp(geometry)
      || (geometry.clientHeight !== this.previous.clientHeight && this.options.anchor.isPinned()))) {
      this.focusNavigation = null;
      return false;
    }
    if (!navigation || this.heldTarget || !this.scroller.contains(navigation.target)
      || this.scroller.ownerDocument.activeElement !== navigation.target
      || geometry.scrollTop < 0
      || geometry.scrollTop > Math.max(0, geometry.scrollHeight - geometry.clientHeight)
      || Math.abs(geometry.scrollTop - navigation.top) <= 1e-6
      || Math.abs(this.revealDelta(navigation.target, undefined, geometry.scrollTop)) > 0.5) return false;
    this.pause();
    // This is a completed placement, not upward input awaiting native movement.
    this.upwardPending = false;
    return true;
  }
  private wheel = (event: WheelEvent): void => {
    if (!event.defaultPrevented && event.deltaY !== 0) this.cancelNavigationReveal();
    if (!this.ownsInput(event)) return;
    this.focusNavigation = null;
    if (event.deltaY < 0) this.pause();
  };
  private pointerDown = (event: PointerEvent): void => {
    if (!event.defaultPrevented) this.cancelNavigationReveal();
    if (this.ownsInput(event)) this.focusNavigation = null;
    if (event.pointerType !== "mouse" || event.target !== this.scroller || !this.ownsInput(event)
      || this.scroller.scrollHeight <= this.scroller.clientHeight) return;
    const box = this.scroller.getBoundingClientRect();
    const left = box.left + this.scroller.clientLeft;
    const right = left + this.scroller.clientWidth;
    // Native scrollbar input need not dispatch wheel/key events. Capture its
    // intent before a simultaneous resize can be mistaken for caret movement.
    if ((event.clientX >= box.left && event.clientX < left) || (event.clientX >= right && event.clientX < box.right)) this.pause();
  };
  private touchStart = (event: TouchEvent): void => {
    if (!event.defaultPrevented) this.cancelNavigationReveal();
    if (this.ownsInput(event)) this.focusNavigation = null;
    this.touchPaused = false;
    this.touchY = this.ownsInput(event) && !this.inTextControl(event) ? event.touches[0]?.clientY ?? null : null;
  };
  private touchMove = (event: TouchEvent): void => {
    const y = event.touches[0]?.clientY;
    if (y !== undefined && this.touchY !== null && this.ownsInput(event) && !this.inTextControl(event)) {
      if (y > this.touchY) {
        if (!this.touchPaused || this.options.anchor.isPinned()) {
          this.pause();
          this.touchPaused = true;
        }
      } else if (y < this.touchY) this.touchPaused = false;
    } else this.touchPaused = false;
    this.touchY = y ?? null;
  };
  private keyDown = (event: KeyboardEvent): void => {
    if (!event.defaultPrevented) this.cancelNavigationReveal();
    if (this.ownsInput(event)) this.focusNavigation = null;
    // Choice controls consume navigation keys too (e.g. radio ArrowUp).
    const target = event.target as Element | null;
    if (!this.ownsInput(event) || target?.closest?.("input, textarea, select") || this.inTextControl(event)) return;
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
    this.scroller.removeEventListener("pointerdown", this.pointerDown);
    this.scroller.removeEventListener("focusin", this.focusIn);
    this.scroller.style.setProperty("overflow-anchor", this.previousAnchoring);
    this.scroller.style.setProperty("scroll-behavior", this.previousBehavior);
    owners.delete(this.scroller);
  }
}
