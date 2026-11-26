// Inline zoom: scale and pan media inside the box it occupies at fit, with an
// overlay toolbar (zoom out, zoom in, fit, expand) beside its activator.
//
// Markup, built by `createInlineFrame`:
//
//   span.media-zoom-frame          the clipping box; takes the media's at-fit
//     <activator>                  layout, and is locked to it while zoomed
//       … .media-zoom-stage        the element that is transformed
//     span.media-zoom-toolbar      a sibling of the activator, never inside it
//
// The activator is the one focusable, named element for the media: a diagram's
// button, an image's enclosing link, or the image itself made a button.
//
// Input follows the input type, not the UI mode. Mouse and pen: the toolbar,
// and dragging once zoomed past fit. Touch: a pinch zooms; at fit one finger
// scrolls the page (`touch-action: pan-x pan-y`, plus a non-passive listener
// that claims a second finger before the browser can turn it into a page
// pinch), and once zoomed `touch-action: none` gives one finger the pan. There
// is deliberately no `wheel` listener, so inline media can never hold up a
// scroll or react to a trackpad pinch.
//
// Rendering commits at rest, as in the viewer: while input runs the stage
// moves through `transform`; COMMIT_DELAY_MS after it stops the stage is laid
// out at its scaled size. The committed state is `data-zoom-state` on the
// frame, relative to the fit box (fit is `{"tx":0,"ty":0,"scale":1}`), and
// `data-zoom-pending` marks a commit still to come.

import { GestureTracker, pointerPoint, touchPoint } from "./gestures";
import { devicePixelScale, isMermaidIdentity, isSmallMedia, naturalSize, rasterEnlarged, sameAspectRatio, type MediaKind } from "./media";
import { gestureZoom, RestCommit } from "./motion";
import { boundCover, MAX_SCALE, ZOOM_STEP, zoomAt, type Size, type ZoomTransform } from "./transform";

export const FRAME_CLASS = "media-zoom-frame";
export const ACTIVATOR_CLASS = "media-zoom-activator";
export const STAGE_CLASS = "media-zoom-stage";
const TOOLBAR_CLASS = "media-zoom-toolbar";
// No inline controls: media under SMALL_MEDIA_PX on a side, and every frame
// until its controller has measured it. Built in, so hover can never show a
// toolbar before the media is known to be large enough for one.
const SMALL_CLASS = "is-small";

// Inline zoom runs from fit (1, relative to the fit box) to the viewer's maximum.
const INLINE_LIMITS = { min: 1, max: MAX_SCALE };
const FIT_EPSILON = 1e-3;
const FIT: ZoomTransform = { tx: 0, ty: 0, scale: 1 };
const TOUCH_AT_FIT = "pan-x pan-y";

type ToolbarAction = "zoom-out" | "zoom-in" | "fit" | "expand";
// The tracker calls a pointer's or a touch's later events make alike.
type TrackPhase = "move" | "up" | "cancel";

const TOOLBAR: [ToolbarAction, string][] = [
  ["zoom-out", "Zoom out"],
  ["zoom-in", "Zoom in"],
  ["fit", "Fit"],
  ["expand", "Open fullscreen viewer"],
];

// The toolbar's one markup, for frames built in the DOM and frames rendered
// as HTML alike. The glyphs are CSS-generated: the frame adds no text for
// Find to index.
const TOOLBAR_HTML =
  `<span class="${TOOLBAR_CLASS}" role="group" aria-label="Zoom controls">` +
  TOOLBAR.map(
    ([action, label]) =>
      `<button type="button" class="media-zoom-button media-zoom-${action}" data-zoom-action="${action}" aria-label="${label}" title="${label}"></button>`,
  ).join("") +
  "</span>";

export type InlineZoomOptions = {
  // Read each time it matters, so a getter can follow media whose format is
  // known only once it loads (a <picture> picks its source then).
  kind: MediaKind;
  // Open the fullscreen viewer on this media, at fit. `opener` is the control
  // used: the activator, or the expand control (see `viewerFocusReturn`).
  open: (opener: HTMLElement) => void;
  // Whether the media may zoom now, read on each input; omitted, always. A
  // surface that leaves media on screen after it stopped presenting it (the
  // preview, while the next file loads) refuses zoom there.
  active?: () => boolean;
};

// A zoom away from fit, with the fit box it was taken against and the media's
// own intrinsic size then (null for media without one: a diagram, an SVG with
// only a viewBox). The box scales the pan; the intrinsic size is the media's
// shape, which the box alone does not show when the page fixes the box (an
// image with explicit width and height).
export type InlineZoomState = { transform: ZoomTransform; box: Size; intrinsic: Size | null };

export type InlineZoom = {
  readonly frame: HTMLElement;
  transform(): ZoomTransform;
  fit(): void;
  // The zoom to carry to a re-rendered copy of this media; null at fit.
  snapshot(): InlineZoomState | null;
  // Apply a carried zoom against this media's fit box, scaling the pan to
  // it. False, leaving the media at fit, when its shape changed (the box's
  // or the intrinsic aspect ratio is not the saved one's, see
  // `sameAspectRatio`) or it is now small media, which never zooms inline.
  restore(state: InlineZoomState): boolean;
  // The media's source was swapped in place and has loaded: lay it out at
  // fit again and keep the zoom if its shape held.
  refit(): void;
  // This frame has been replaced (a re-render of the body, a diagram
  // re-rendered in place): stop observing it and its container, which would
  // otherwise keep it alive. `snapshot` still answers, for the copy that
  // replaces it.
  dispose(): void;
};

const controllers = new WeakMap<HTMLElement, InlineZoom>();

// Wrap `activator` in a frame with a toolbar beside it. `stage` is the
// element to transform: the activator itself, or media inside it.
// Idempotent: an activator already framed returns its frame.
export function createInlineFrame(activator: HTMLElement, stage: Element): HTMLElement {
  const existing = activator.parentElement;
  if (existing?.classList.contains(FRAME_CLASS)) {
    return existing;
  }
  const document = activator.ownerDocument;
  activator.classList.add(ACTIVATOR_CLASS);
  stage.classList.add(STAGE_CLASS);
  if (activator.tagName !== "BUTTON" && activator.tagName !== "A") {
    activator.setAttribute("tabindex", "0");
    activator.setAttribute("role", "button");
  } else if (Number.parseInt(activator.getAttribute("tabindex") ?? "", 10) < 0) {
    // The media's one control stays in the tab order, even where its author
    // took the link out of it: the keyboard must reach what a click opens.
    activator.removeAttribute("tabindex");
  }
  // The activator is the media's one named control. A name the author gave
  // it (its own label, a title, an image's alt, a linked image's alt) stays.
  if (!hasAuthoredName(activator)) activator.setAttribute("aria-label", "Open image in fullscreen viewer");

  const frame = document.createElement("span");
  frame.className = `${FRAME_CLASS} ${SMALL_CLASS}`;
  activator.replaceWith(frame);
  frame.append(activator);
  frame.insertAdjacentHTML("beforeend", TOOLBAR_HTML);
  return frame;
}

// The same frame as HTML, for surfaces that render markup as strings (chat).
// `activatorHtml` is the activator, already carrying ACTIVATOR_CLASS, with
// STAGE_CLASS on itself or on the media inside it; it must be a button or a
// link, since only `createInlineFrame` makes other elements focusable.
export function inlineFrameHtml(activatorHtml: string): string {
  return `<span class="${FRAME_CLASS} ${SMALL_CLASS}">${activatorHtml}${TOOLBAR_HTML}</span>`;
}

export function attachInlineZoom(frame: HTMLElement, options: InlineZoomOptions): InlineZoom {
  const existing = controllers.get(frame);
  if (existing) {
    return existing;
  }
  const controller = new InlineController(frame, options);
  controllers.set(frame, controller);
  return controller;
}

// The controller attached to a frame, if any.
export function inlineZoomOf(frame: HTMLElement): InlineZoom | null {
  return controllers.get(frame) ?? null;
}

// Where focus goes when the viewer an inline frame's control opened closes.
// An inline toolbar is shown only while focus or the pointer is on its media,
// so expand can take focus only once its activator has it: focus returns to
// the activator (`returnFocusTo`), and `afterReturn` moves it on to expand
// when expand opened the viewer. Where expand stays hidden (touch, at fit)
// focus stays on the activator. An opener outside a frame is returned to.
export function viewerFocusReturn(opener: HTMLElement): { returnFocusTo: HTMLElement; afterReturn: () => void } {
  const frame = opener.closest<HTMLElement>(`.${FRAME_CLASS}`);
  const viaExpand = opener.matches(EXPAND_SELECTOR);
  return {
    returnFocusTo: (frame && childWithClass(frame, ACTIVATOR_CLASS)) ?? opener,
    afterReturn: () => {
      // The activator focus returned to: the one given, or a re-rendered
      // copy's that replaced it (see MediaViewerSession.replace).
      const returned = opener.ownerDocument.activeElement;
      if (!viaExpand || !returned?.classList.contains(ACTIVATOR_CLASS) || !returned.parentElement) return;
      childWithClass(returned.parentElement, TOOLBAR_CLASS)?.querySelector<HTMLElement>(EXPAND_SELECTOR)?.focus();
    },
  };
}

const EXPAND_SELECTOR = '[data-zoom-action="expand"]';

// Take a frame, and its media, out of the page for good: its controller is
// released first, or its observers would keep watching the frame's container.
export function removeInlineFrame(frame: HTMLElement): void {
  inlineZoomOf(frame)?.dispose();
  frame.remove();
}

function hasAuthoredName(element: HTMLElement): boolean {
  const named = (candidate: Element) =>
    Boolean(
      candidate.getAttribute("aria-label")?.trim() ||
        candidate.getAttribute("aria-labelledby")?.trim() ||
        candidate.getAttribute("title")?.trim() ||
        (candidate.tagName === "IMG" && candidate.getAttribute("alt")?.trim()),
    );
  if (named(element)) return true;
  if (element.tagName === "IMG") return false;
  return Boolean(element.textContent?.trim()) || Array.from(element.querySelectorAll("img, svg")).some(named);
}

// An element's laid-out content box: its border box less borders and padding.
function contentBox(element: Element): Size {
  const rect = element.getBoundingClientRect();
  const style = element.ownerDocument.defaultView?.getComputedStyle?.(element);
  const edges = (...sides: string[]) => sides.reduce((sum, side) => sum + (Number.parseFloat(style?.getPropertyValue(side) ?? "") || 0), 0);
  return {
    width: rect.width - edges("border-left-width", "border-right-width", "padding-left", "padding-right"),
    height: rect.height - edges("border-top-width", "border-bottom-width", "padding-top", "padding-bottom"),
  };
}

const SIDES = ["top", "right", "bottom", "left"] as const;

// An element's computed margins, in px.
function margins(element: Element): Record<(typeof SIDES)[number], number> {
  const style = element.ownerDocument.defaultView?.getComputedStyle?.(element);
  const side = (name: string) => Number.parseFloat(style?.getPropertyValue(`margin-${name}`) ?? "") || 0;
  return { top: side("top"), right: side("right"), bottom: side("bottom"), left: side("left") };
}

function childWithClass(parent: Element, className: string): HTMLElement | null {
  return (Array.from(parent.children).find(child => child.classList.contains(className)) as HTMLElement) ?? null;
}

class InlineController implements InlineZoom {
  private readonly activator: HTMLElement;
  private readonly stage: Element;
  // Drag pans once zoomed, pinch zooms about the fingers; taps do nothing
  // here (a click opens the viewer, see onClick). The cover bound and the
  // fit-to-maximum range are applied in `apply`.
  private readonly tracker = new GestureTracker(
    gestureZoom({
      transform: () => this.current,
      toBox: point => this.local(point),
      limits: () => INLINE_LIMITS,
      move: next => this.apply(next, "settle"),
      canPan: () => this.zoomed,
      panning: active => this.frame.classList.toggle("is-panning", active && this.zoomed),
    }),
  );
  private readonly rest: RestCommit;
  private current: ZoomTransform = FIT;
  // The at-fit box and the media's intrinsic size, taken when zooming starts
  // and held while zoomed (see InlineZoomState).
  private box: Size | null = null;
  private intrinsic: Size | null = null;
  // Small until measured (see SMALL_CLASS).
  private small = true;
  // A touch sequence this controller has claimed from the browser.
  private touchOwned = false;
  private sizeWatch: ResizeObserver | null = null;
  // The bitmap width of a source a `srcset` picked (see measureBitmap); null
  // for any other source, whose natural width is its bitmap's.
  private bitmap: { source: string; width: number } | null = null;
  private containerWatch: { observer: ResizeObserver; width: number | null } | null = null;

  constructor(readonly frame: HTMLElement, private readonly options: InlineZoomOptions) {
    const activator = childWithClass(frame, ACTIVATOR_CLASS);
    const stage = activator?.classList.contains(STAGE_CLASS) ? activator : activator?.querySelector(`.${STAGE_CLASS}`);
    if (!activator || !stage) {
      throw new Error("attachInlineZoom: frame has no activator or stage");
    }
    this.activator = activator;
    this.stage = stage;
    this.rest = new RestCommit({
      element: frame,
      setTransform: css => frame.style.setProperty("--media-zoom-transform", css),
      setLayoutScale: scale => {
        if (this.box) this.setStageSize(this.box, scale);
      },
    });
    this.writeState();
    this.syncTouchAction();
    this.syncFluid();
    // An image loaded before this controller (from the cache) has no load to come.
    this.measureBitmap();

    stage.addEventListener("load", () => {
      this.syncFluid();
      this.measureBitmap();
    });
    this.watchSize();
    childWithClass(frame, TOOLBAR_CLASS)?.addEventListener("click", event => this.onToolbarClick(event));

    activator.addEventListener("click", event => this.onClick(event as MouseEvent));
    activator.addEventListener("keydown", event => this.onKeyDown(event as KeyboardEvent));
    activator.addEventListener("dragstart", event => {
      if (this.zoomed) event.preventDefault();
    });
    activator.addEventListener("pointerdown", event => this.onPointerDown(event as PointerEvent));
    activator.addEventListener("pointermove", event => this.onPointer(event as PointerEvent, "move"));
    activator.addEventListener("pointerup", event => this.onPointer(event as PointerEvent, "up"));
    activator.addEventListener("pointercancel", event => this.onPointer(event as PointerEvent, "cancel"));
    // Non-passive: claiming a second finger has to be able to cancel it.
    const nonPassive = { passive: false };
    activator.addEventListener("touchstart", event => this.onTouchStart(event as TouchEvent), nonPassive);
    activator.addEventListener("touchmove", event => this.onTouch(event as TouchEvent, "move"), nonPassive);
    activator.addEventListener("touchend", event => this.onTouch(event as TouchEvent, "up"), nonPassive);
    activator.addEventListener("touchcancel", event => this.onTouch(event as TouchEvent, "cancel"), nonPassive);
  }

  transform(): ZoomTransform {
    return this.current;
  }

  fit(): void {
    this.reset();
  }

  snapshot(): InlineZoomState | null {
    if (!this.zoomed || !this.box) return null;
    return { transform: { ...this.current }, box: { ...this.box }, intrinsic: this.intrinsic && { ...this.intrinsic } };
  }

  restore(state: InlineZoomState): boolean {
    this.reset();
    const { width, height } = this.mediaBox();
    const box = { width, height };
    if (!sameAspectRatio(box, state.box)) return false;
    const intrinsic = this.intrinsicSize();
    if (intrinsic && state.intrinsic && !sameAspectRatio(intrinsic, state.intrinsic)) return false;
    const ratio = box.width / state.box.width;
    const { tx, ty, scale } = state.transform;
    // `apply` refuses small media, like any other way of zooming it.
    this.apply({ tx: tx * ratio, ty: ty * ratio, scale }, "now");
    return this.zoomed;
  }

  refit(): void {
    const state = this.snapshot();
    if (state) this.restore(state);
  }

  dispose(): void {
    this.rest.reset();
    this.sizeWatch?.disconnect();
    this.sizeWatch = null;
    this.unwatchContainer();
  }

  private get zoomed(): boolean {
    return this.frame.classList.contains("is-zoomed");
  }

  private get active(): boolean {
    return this.options.active?.() ?? true;
  }

  // The small-media test (see measure) runs whenever the frame's box changes
  // (an image's box is only known once it has loaded), so media
  // is classified before it can be hovered; and again on interaction.
  //
  // The container is watched too, for media that was not rendered when it
  // loaded (inside a hidden tab): `syncFluid` could not measure it then, and a
  // frame that collapsed has an empty box both hidden and shown, so only its
  // container's box changes when it is shown.
  private watchSize(): void {
    const Observer = this.frame.ownerDocument.defaultView?.ResizeObserver;
    if (!Observer) return;
    // The first notification, delivered on observe, is the first measurement.
    this.sizeWatch = new Observer(() => {
      this.measure();
      if (!this.frame.classList.contains("is-fluid")) this.syncFluid();
    });
    this.sizeWatch.observe(this.frame);
    if (this.frame.parentElement) this.sizeWatch.observe(this.frame.parentElement);
  }

  // The media itself is measured, not the frame, which also holds any margins
  // the media has (an image's `hspace`).
  private measure(): void {
    if (this.zoomed) return;
    this.small = isSmallMedia(contentBox(this.stage));
    this.frame.classList.toggle(SMALL_CLASS, this.small);
    this.syncTouchAction();
  }

  // The media's intrinsic size: an image's natural size once it has loaded,
  // else null (a diagram's box is its shape).
  private intrinsicSize(): Size | null {
    return this.stage.tagName === "IMG" ? naturalSize(this.stage as HTMLImageElement) : null;
  }

  // An image sized against its containing block cannot be sized against the
  // shrink-to-fit frame, which gives it none. Such a frame is marked
  // `is-fluid` and takes the containing block's width instead:
  // - An image with a percentage width (`width="50%"`, as README authors write
  //   it) would resolve against itself framed. The frame takes the percentage
  //   and the image fills the frame.
  // - An image with no natural width (an SVG with only a viewBox) fills its
  //   containing block unframed, but framed collapses to nothing. The frame
  //   takes the whole width; the measured aspect ratio lets a surface that also
  //   caps the media's height narrow it to match (the file preview). Checked on
  //   every load, since a placeholder or a new revision can change the answer,
  //   and on a resize while not fluid (see watchSize).
  private syncFluid(): void {
    if (this.zoomed || this.stage.tagName !== "IMG") return;
    const image = this.stage as HTMLImageElement;
    this.frame.classList.remove("is-fluid");
    this.frame.style.removeProperty("--media-zoom-ratio");
    this.frame.style.removeProperty("--media-zoom-fluid-width");
    const declared = image.getAttribute("width")?.trim() ?? "";
    if (declared.endsWith("%")) {
      this.frame.classList.add("is-fluid");
      this.frame.style.setProperty("--media-zoom-fluid-width", declared);
      return;
    }
    // Unrendered (no client rects), or laid out with a width: nothing to fix.
    if (!image.complete || image.naturalWidth === 0 || image.getClientRects().length === 0 || image.clientWidth > 0) return;
    this.frame.classList.add("is-fluid");
    const { width, height } = contentBox(image);
    if (width > 0 && height > 0) this.frame.style.setProperty("--media-zoom-ratio", String(width / height));
  }

  private syncTouchAction(): void {
    if (this.zoomed) {
      this.frame.style.touchAction = "none";
    } else if (this.small) {
      this.frame.style.removeProperty("touch-action");
    } else {
      this.frame.style.touchAction = TOUCH_AT_FIT;
    }
  }

  private onToolbarClick(event: Event): void {
    const button = (event.target as Element | null)?.closest<HTMLElement>("[data-zoom-action]");
    switch (button?.dataset.zoomAction) {
      case "zoom-in":
        this.zoomBy(ZOOM_STEP);
        return;
      case "zoom-out":
        this.zoomBy(1 / ZOOM_STEP);
        return;
      case "fit":
        this.reset();
        return;
      case "expand":
        this.options.open(button!);
        return;
    }
  }

  private onClick(event: MouseEvent): void {
    // A programmatic click is the surface itself following the link (the
    // viewer's "Open link"), not the reader activating the media.
    if (!event.isTrusted) return;
    const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    if (modified && this.activator.tagName === "A") return;
    event.preventDefault();
    // `detail` 0 is a keyboard activation of a button or link, which always
    // opens the viewer. A pointer click opens it only at fit; zoomed, a click
    // belongs to panning.
    if (event.detail !== 0 && this.zoomed) return;
    this.measure();
    this.options.open(this.activator);
  }

  // Buttons and links activate natively on Enter (and buttons on Space); the
  // rest is handled here.
  private onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    const tag = this.activator.tagName;
    if (tag === "BUTTON" || (tag === "A" && event.key === "Enter")) return;
    event.preventDefault();
    this.options.open(this.activator);
  }

  private onPointerDown(event: PointerEvent): void {
    // Touch input arrives as Touch Events (below), never twice.
    if (event.pointerType === "touch" || event.button !== 0 || !this.zoomed) return;
    event.preventDefault();
    if (this.tracker.down(pointerPoint(event))) {
      try {
        this.activator.setPointerCapture(event.pointerId);
      } catch {
        // Uncaptured still pans while the pointer stays over the media.
      }
    }
  }

  private onPointer(event: PointerEvent, phase: TrackPhase): void {
    if (event.pointerType === "touch") return;
    this.tracker[phase](pointerPoint(event));
  }

  // At fit a single finger is the browser's (it scrolls the page); a second
  // finger on the media claims the gesture. Once zoomed, every touch is ours.
  private onTouchStart(event: TouchEvent): void {
    const touches = Array.from(event.touches).filter(touch => this.activator.contains(touch.target as Node));
    if (!this.touchOwned) {
      this.measure();
      if (this.small || !this.active || (!this.zoomed && touches.length < 2)) return;
      this.touchOwned = true;
      for (const touch of touches) this.tracker.down(touchPoint(touch, event));
    } else {
      for (const touch of Array.from(event.changedTouches)) this.tracker.down(touchPoint(touch, event));
    }
    if (event.cancelable) event.preventDefault();
  }

  private onTouch(event: TouchEvent, phase: TrackPhase): void {
    if (!this.touchOwned) return;
    // Also suppresses the click a claimed gesture would otherwise end in.
    if (event.cancelable) event.preventDefault();
    for (const touch of Array.from(event.changedTouches)) this.tracker[phase](touchPoint(touch, event));
    if (this.tracker.size === 0) this.touchOwned = false;
  }

  private local(point: { x: number; y: number }) {
    const box = this.mediaBox();
    return { x: point.x - box.left, y: point.y - box.top };
  }

  // The box the media zooms in, in client coordinates: the frame's box less
  // the margins the media holds inside it at fit (an image's `hspace`).
  // Zoomed, the frame is that box, with those margins moved onto it (see lock).
  private mediaBox(): { left: number; top: number; width: number; height: number } {
    const rect = this.frame.getBoundingClientRect();
    const margin = this.zoomed ? { top: 0, right: 0, bottom: 0, left: 0 } : margins(this.stage);
    return {
      left: rect.left + margin.left,
      top: rect.top + margin.top,
      width: rect.width - margin.left - margin.right,
      height: rect.height - margin.top - margin.bottom,
    };
  }

  private zoomBy(factor: number): void {
    const box = this.zoomBox();
    if (box) this.apply(zoomAt(this.current, factor, { x: box.width / 2, y: box.height / 2 }, INLINE_LIMITS), "now");
  }

  // The box zooming starts from: the box held while zoomed, else the media's
  // box now, measured afresh. Null while there is none to zoom in, because
  // the media is not laid out, is small media, which never zooms inline, or
  // is not its surface's to zoom now (see InlineZoomOptions.active).
  private zoomBox(): Size | null {
    if (!this.active) return null;
    if (this.zoomed) return this.box;
    this.measure();
    const { width, height } = this.mediaBox();
    if (width <= 0 || height <= 0 || this.small) return null;
    return { width, height };
  }

  // The single choke point for moving the media: every route — toolbar,
  // drag, pinch, a carried zoom — is bounded by the cover rule here, so no
  // empty area ever shows inside the box, and none zooms small media.
  private apply(next: ZoomTransform, mode: "now" | "settle"): void {
    const box = this.zoomBox();
    if (!box) return;
    const bounded = boundCover(next, box, box, INLINE_LIMITS.min, INLINE_LIMITS.max);
    if (bounded.scale <= INLINE_LIMITS.min + FIT_EPSILON) {
      this.reset();
      return;
    }
    if (!this.zoomed) this.lock(box);
    this.current = bounded;
    this.updatePixelation();
    this.rest.show(bounded, mode);
  }

  // Hold the frame at the media's fit box, so the stage can leave the flow and
  // scale without anything around it moving. Margins the media holds inside
  // the frame move onto it: the frame is then the box the zoomed media
  // covers, from its origin, and its margin box is the one it had at fit.
  private lock(box: Size): void {
    this.box = box;
    this.intrinsic = this.intrinsicSize();
    const media = margins(this.stage);
    const own = margins(this.frame);
    for (const side of SIDES) this.frame.style.setProperty(`margin-${side}`, `${own[side] + media[side]}px`);
    this.frame.style.width = `${box.width}px`;
    this.frame.style.height = `${box.height}px`;
    this.frame.classList.remove(SMALL_CLASS);
    this.frame.classList.add("is-zoomed");
    this.rest.reset();
    this.setStageSize(box, 1);
    this.syncTouchAction();
    this.watchContainer();
  }

  private setStageSize(box: Size, scale: number): void {
    this.frame.style.setProperty("--media-zoom-width", `${box.width * scale}px`);
    this.frame.style.setProperty("--media-zoom-height", `${box.height * scale}px`);
  }

  private reset(): void {
    this.rest.reset();
    this.unwatchContainer();
    this.current = FIT;
    this.box = null;
    this.intrinsic = null;
    this.frame.classList.remove("is-zoomed", "is-panning", "is-pixelated");
    for (const property of ["width", "height", ...SIDES.map(side => `margin-${side}`), "--media-zoom-width", "--media-zoom-height", "--media-zoom-transform"]) {
      this.frame.style.removeProperty(property);
    }
    this.frame.removeAttribute("data-zoom-pending");
    this.writeState();
    this.syncTouchAction();
    this.syncFluid();
  }

  private writeState(): void {
    const { tx, ty, scale } = this.current;
    this.frame.setAttribute("data-zoom-state", JSON.stringify({ tx, ty, scale }));
  }

  // A source a `srcset` picked reports its width over its density descriptor
  // (an 800px "2x" candidate reports 400), so its bitmap is measured from a
  // copy loaded without one, as the viewer shows it. Until then it counts as
  // unknown: smooth.
  private measureBitmap(): void {
    const image = this.stage as HTMLImageElement;
    const source = this.stage.tagName === "IMG" ? image.currentSrc : "";
    if (!source || source === image.src) {
      this.bitmap = null;
      return;
    }
    if (this.bitmap?.source === source) return;
    const bitmap = { source, width: 0 };
    this.bitmap = bitmap;
    const probe = image.ownerDocument.createElement("img");
    probe.addEventListener("load", () => {
      if (this.bitmap !== bitmap) return;
      bitmap.width = probe.naturalWidth;
      this.updatePixelation();
    }, { once: true });
    probe.src = source;
  }

  // Only zoomed past fit (see `rasterEnlarged`); at fit the browser smooths,
  // and `reset` drops the class.
  private updatePixelation(): void {
    const natural = this.options.kind === "raster" && this.stage.tagName === "IMG"
      ? this.bitmap?.width ?? (this.stage as HTMLImageElement).naturalWidth
      : 0;
    const shown = this.zoomed && this.box ? this.box.width * this.current.scale : 0;
    const ratio = devicePixelScale(this.frame.ownerDocument.defaultView);
    this.frame.classList.toggle("is-pixelated", rasterEnlarged(natural, shown, ratio));
  }

  // The locked box is only right while the column keeps its width. When the
  // container is resized (a window resize, a rotation, a sidebar drag), the
  // media returns to fit and lays out again.
  private watchContainer(): void {
    const container = this.frame.parentElement;
    const Observer = this.frame.ownerDocument.defaultView?.ResizeObserver;
    if (!container || !Observer || this.containerWatch) return;
    // The first notification, delivered on observe, records the width.
    const observer = new Observer(entries => {
      const width = entries[0]?.contentRect.width;
      const watch = this.containerWatch;
      // A frame taken out of the page (a re-render) keeps its zoom for the
      // copy that replaces it.
      if (width === undefined || !watch || !this.frame.isConnected) return;
      if (watch.width === null) watch.width = width;
      else if (Math.abs(width - watch.width) > 0.5) this.reset();
    });
    this.containerWatch = { observer, width: null };
    observer.observe(container);
  }

  private unwatchContainer(): void {
    this.containerWatch?.observer.disconnect();
    this.containerWatch = null;
  }
}

// Zoom carried across re-renders of one presentation (a session): saved from
// the media about to be replaced, and restored onto the copy that replaces it
// once that copy knows its size. Media is matched by identity (media.ts).
// Diagrams are matched by position, which only holds while their number does:
// a changed count drops every diagram's zoom. Starting a different session, or
// clearing, discards everything.
export type ZoomCarry = {
  // Begin a render of `session`; true when it continues the session on screen.
  begin(session: string): boolean;
  clear(): void;
  // Before the body is replaced: every media of the render on screen, by
  // identity, with its controller (null for a diagram not rendered yet).
  // Saves nothing unless the render on screen belongs to the session begun.
  save(media: Iterable<[string, InlineZoom | null]>): void;
  // After the new body is mounted: every media it holds, by identity. Forgets
  // what it no longer holds and returns the identities whose zoom may carry.
  mounted(identities: Iterable<string>): Set<string>;
  // Apply, and forget, the zoom saved for `identity`. False when there was
  // none or its shape changed; the media then stays at fit.
  restore(identity: string, zoom: InlineZoom): boolean;
};

export function createZoomCarry(): ZoomCarry {
  let session: string | null = null;
  // The session whose render is on screen.
  let mountedSession: string | null = null;
  // The number of diagrams in the render the saved zoom came from.
  let savedDiagrams: number | null = null;
  const saved = new Map<string, InlineZoomState>();
  const diagramCount = (identities: string[]) => identities.filter(isMermaidIdentity).length;

  const clear = () => {
    session = null;
    mountedSession = null;
    savedDiagrams = null;
    saved.clear();
  };

  return {
    begin(next) {
      if (next === session) return true;
      clear();
      session = next;
      return false;
    },
    clear,
    save(media) {
      if (session === null || mountedSession !== session) return;
      const entries = Array.from(media);
      savedDiagrams = diagramCount(entries.map(([identity]) => identity));
      for (const [identity, zoom] of entries) {
        if (!zoom) continue;
        const state = zoom.snapshot();
        if (state) saved.set(identity, state);
        else saved.delete(identity);
      }
    },
    mounted(identities) {
      const present = Array.from(identities);
      const matched = new Set(present);
      if (savedDiagrams !== null && savedDiagrams !== diagramCount(present)) {
        for (const identity of present) {
          if (isMermaidIdentity(identity)) matched.delete(identity);
        }
      }
      for (const identity of saved.keys()) {
        if (!matched.has(identity)) saved.delete(identity);
      }
      savedDiagrams = null;
      mountedSession = session;
      return matched;
    },
    restore(identity, zoom) {
      const state = saved.get(identity);
      if (!state) return false;
      saved.delete(identity);
      return zoom.restore(state);
    },
  };
}
