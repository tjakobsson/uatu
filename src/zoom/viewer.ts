// The shared fullscreen media viewer: Mermaid diagrams, raster images and
// SVG images from every surface.
// Mouse: drag-pan, cursor-anchored wheel zoom, double-click to fit.
// Touch: one-finger pan, two-finger midpoint-anchored pinch, double-tap to fit.
// Closes on Escape, the close control, or a tap/click on the empty backdrop —
// never on a drag, a pinch, or a tap on the media.
// Mounted once on document.body so it survives preview re-renders.
//
// Rendering commits at rest: while input runs the stage moves only through
// `transform`; about COMMIT_DELAY_MS after input stops the stage's layout
// size is set to the scaled size and only `translate()` is kept, so SVG and
// Mermaid are redrawn at the displayed scale. The committed state is exposed
// as `data-zoom-state` on the stage, and `data-zoom-pending` marks a commit
// still to come.
//
// Surfaces pass in what they know (the real image source, an enclosing link,
// where to return focus); this module imports nothing from them.

import { createVisualViewportSizer, type VisualViewportSizer } from "../shared/visual-viewport";
import { classifyPress, GestureTracker, pointerPoint } from "./gestures";
import { devicePixelScale, naturalSize, rasterEnlarged, sameAspectRatio, type MediaKind } from "./media";
import { gestureZoom, RestCommit } from "./motion";
import {
  actualPixelsScale,
  boundKeepVisible,
  fitTransform,
  viewerScaleLimits,
  WHEEL_ZOOM_RATE,
  ZOOM_STEP,
  zoomAt,
  zoomTo,
  type ScaleLimits,
  type Size,
  type ZoomTransform,
} from "./transform";

export type { MediaKind } from "./media";

export type ViewerMedia =
  | { kind: "mermaid"; svg: SVGElement }
  | {
      kind: "raster" | "svg-image";
      // The real source to load — never a deferred-loading placeholder.
      src: string;
      alt?: string;
      // Used when the loaded image reports no intrinsic size (an SVG with
      // only a viewBox): the size the surface laid the media out at.
      fallbackSize?: Size;
    };

export type ViewerDescriptor = ViewerMedia & {
  // The link enclosing the media, if any. "Open link" closes the viewer and
  // calls its own `click()`, so the surface's usual link handling applies.
  link?: HTMLAnchorElement | null;
  // A visible caption, as text (chat shows the attachment's name). Optional:
  // the preview passes none, so the viewer adds no text of its own there.
  caption?: string;
};

export type ViewerOpenOptions = {
  returnFocusTo?: HTMLElement | null;
  // Runs after the viewer has closed and focus has been returned.
  afterClose?: () => void;
};

// One open of the viewer, as returned to the surface that opened it. Every
// method is a no-op once this open has ended (closed, or replaced by another
// open), so a surface can never act on media it did not open.
export type MediaViewerSession = {
  isOpen(): boolean;
  // Show a re-rendered copy of the same media. A zoom carries over, keeping
  // the media's displayed size within the new content's zoom range, when its
  // aspect ratio matches the current content's (see `sameAspectRatio`);
  // otherwise, or at fit, it fits. An image is loaded before it is swapped
  // in, so nothing blanks, and an unchanged source is kept as it is.
  replace(descriptor: ViewerDescriptor, options?: Pick<ViewerOpenOptions, "returnFocusTo">): void;
  // The media is gone from its surface: keep showing it, at fit, drop its
  // "Open link" action, whose link left the page with it, and abandon a
  // replacement still loading. Content still loading for the open itself is
  // what the viewer shows, so it finishes loading and fits.
  orphan(): void;
  close(): void;
};

const DEFAULT_SIZE: Size = { width: 300, height: 150 };

type CommitMode = "now" | "settle";

// A replacement image loading before it is swapped in. The one in
// `ViewerInternals.pending` is the latest request; any other is stale.
type PendingImage = { src: string };

type ViewerInternals = {
  dialog: HTMLDialogElement;
  viewport: HTMLDivElement;
  stage: HTMLDivElement;
  toolbar: HTMLDivElement;
  caption: HTMLParagraphElement;
  buttons: {
    zoomOut: HTMLButtonElement;
    zoomIn: HTMLButtonElement;
    fit: HTMLButtonElement;
    actualPixels: HTMLButtonElement;
    openLink: HTMLButtonElement;
    close: HTMLButtonElement;
  };
  tracker: GestureTracker;
  // Pins the open dialog to the visible viewport (see fitDialogToVisible).
  visible: VisualViewportSizer;
  transform: ZoomTransform;
  // The transform is the fit, not a zoom the reader chose: a new viewport
  // size fits again rather than keeping it.
  fitted: boolean;
  // Commit at rest (motion.ts) for the stage.
  rest: RestCommit;
  // Unscaled content size; null until known (an image still loading).
  base: Size | null;
  // Intrinsic pixel size of raster media.
  natural: Size | null;
  kind: MediaKind | null;
  // The image source on the stage; null for a diagram.
  src: string | null;
  // Two loads can be in flight, and each is owned by what it would show:
  // - The content on the stage, which an image only has a size for once it
  //   has loaded. `contentGeneration` identifies it: bumped on every open,
  //   close and swap, so a late load of content that has since been replaced
  //   is ignored. Only those end it; a replacement request never does.
  // - At most one replacement (`pending`), the latest one requested. Any new
  //   request supersedes it, including one for the source already shown, and
  //   so does the media leaving its surface (`orphan`).
  contentGeneration: number;
  pending: PendingImage | null;
  link: HTMLAnchorElement | null;
  returnFocusTo: HTMLElement | null;
  afterClose: (() => void) | null;
  // Bumped on every open: identifies the open a MediaViewerSession belongs to.
  session: number;
};

let viewer: ViewerInternals | null = null;
let cloneCounter = 0;

export function openMediaViewer(descriptor: ViewerDescriptor, options: ViewerOpenOptions = {}): MediaViewerSession {
  if (typeof document === "undefined") {
    return { isOpen: () => false, replace: () => {}, orphan: () => {}, close: () => {} };
  }
  const internals = (viewer ??= createViewer());
  openViewer(internals, descriptor, options);
  const session = internals.session;
  const current = () => internals.session === session && internals.dialog.open;
  return {
    isOpen: current,
    replace: (next, replaceOptions = {}) => {
      if (current()) replaceContent(internals, next, replaceOptions);
    },
    orphan: () => {
      if (!current()) return;
      // A replacement still loading belonged to the media that went; the
      // content on the stage, loaded or not, stays.
      internals.pending = null;
      internals.link = null;
      syncToolbar(internals);
      fitToViewport(internals);
    },
    close: () => {
      if (current()) internals.dialog.close();
    },
  };
}

function createViewer(): ViewerInternals {
  const dialog = document.createElement("dialog");
  dialog.className = "media-viewer";

  const stage = document.createElement("div");
  stage.className = "media-viewer-stage";

  const viewport = document.createElement("div");
  viewport.className = "media-viewer-viewport";
  viewport.appendChild(stage);

  const toolbar = document.createElement("div");
  toolbar.className = "media-viewer-toolbar";

  const caption = document.createElement("p");
  caption.className = "media-viewer-caption";
  caption.id = "media-viewer-caption";
  caption.hidden = true;

  const buttons = {
    zoomOut: makeToolbarButton("Zoom out", "−"),
    zoomIn: makeToolbarButton("Zoom in", "+"),
    fit: makeToolbarButton("Fit to screen", "⛶"),
    actualPixels: makeToolbarButton("1:1 actual pixels", "1:1", "media-viewer-actual-pixels"),
    openLink: makeToolbarButton("Open link", "↗", "media-viewer-open-link"),
    close: makeToolbarButton("Close viewer", "×", "media-viewer-close"),
  };

  dialog.append(viewport, caption, toolbar);

  const internals: ViewerInternals = {
    dialog,
    viewport,
    stage,
    toolbar,
    caption,
    buttons,
    tracker: new GestureTracker(intent => handleIntent(intent), {
      // Before an image has a size nothing is on show, so the whole
      // viewport is empty backdrop.
      tapTarget: press => {
        const rect = mediaRect(internals);
        return rect ? classifyPress(press, rect) : "backdrop";
      },
    }),
    visible: createVisualViewportSizer({
      viewport: window.visualViewport ?? null,
      onMetrics: metrics => fitDialogToVisible(dialog, metrics !== null),
    }),
    transform: { tx: 0, ty: 0, scale: 1 },
    fitted: true,
    rest: new RestCommit({
      element: stage,
      setTransform: css => {
        stage.style.transform = css;
      },
      setLayoutScale: scale => {
        if (!internals.base) return;
        stage.style.width = `${internals.base.width * scale}px`;
        stage.style.height = `${internals.base.height * scale}px`;
        stage.style.removeProperty("visibility");
      },
    }),
    base: null,
    natural: null,
    kind: null,
    src: null,
    contentGeneration: 0,
    pending: null,
    link: null,
    returnFocusTo: null,
    afterClose: null,
    session: 0,
  };

  // Drag pans, pinch zooms about the fingers, a tap on the empty backdrop
  // closes, and a double-tap fits. The pan bound and zoom range are applied
  // in `apply` and `scaleLimits`.
  const handleIntent = gestureZoom({
    transform: () => internals.transform,
    toBox: point => toViewport(internals, point),
    limits: () => scaleLimits(internals),
    move: next => apply(internals, next, "settle"),
    canPan: () => true,
    panning: active => viewport.classList.toggle("is-panning", active),
    tap: intent => {
      if (intent.target === "backdrop") dialog.close();
    },
    doubleTap: () => fitToViewport(internals),
  });

  buttons.close.addEventListener("click", () => dialog.close());
  buttons.zoomIn.addEventListener("click", () => zoomByStep(internals, ZOOM_STEP));
  buttons.zoomOut.addEventListener("click", () => zoomByStep(internals, 1 / ZOOM_STEP));
  buttons.fit.addEventListener("click", () => fitToViewport(internals));
  buttons.actualPixels.addEventListener("click", () => showActualPixels(internals));
  buttons.openLink.addEventListener("click", () => {
    const link = internals.link;
    dialog.close();
    link?.click();
  });

  dialog.addEventListener("close", () => {
    // The viewer is reused for every open, so gesture state is dropped here
    // or it carries into the next one: a pointer whose `pointerup` never
    // arrived would leave a phantom finger, and a trailing single tap would
    // pair with the first tap of the next session into a double-tap.
    internals.tracker.reset();
    internals.visible.detach();
    internals.rest.reset();
    internals.contentGeneration += 1;
    internals.pending = null;
    stage.replaceChildren();
    stage.removeAttribute("data-zoom-state");
    stage.removeAttribute("data-zoom-pending");
    const target = internals.returnFocusTo;
    const afterClose = internals.afterClose;
    internals.returnFocusTo = null;
    internals.afterClose = null;
    internals.link = null;
    if (target && document.body.contains(target)) {
      target.focus();
    }
    afterClose?.();
  });

  dialog.addEventListener("keydown", event => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomByStep(internals, ZOOM_STEP);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomByStep(internals, 1 / ZOOM_STEP);
    } else if (event.key === "0" || event.key.toLowerCase() === "f") {
      event.preventDefault();
      fitToViewport(internals);
    }
  });

  viewport.addEventListener("pointerdown", event => {
    if (event.button !== 0) {
      return;
    }
    // Third and later fingers are ignored rather than given a meaning; they
    // are not captured, so their moves never reach the handlers either.
    if (internals.tracker.down(pointerPoint(event))) {
      capturePointer(viewport, event.pointerId);
    }
  });
  viewport.addEventListener("pointermove", event => internals.tracker.move(pointerPoint(event)));
  viewport.addEventListener("pointerup", event => {
    internals.tracker.up(pointerPoint(event));
    releasePointer(viewport, event.pointerId);
  });
  viewport.addEventListener("pointercancel", event => {
    internals.tracker.cancel(pointerPoint(event));
    releasePointer(viewport, event.pointerId);
  });

  viewport.addEventListener(
    "wheel",
    event => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_RATE);
      apply(internals, zoomAt(internals.transform, factor, toViewport(internals, event), scaleLimits(internals)), "settle");
    },
    { passive: false },
  );

  // The mouse fits on the native `dblclick`; touch uses tap timing (see
  // gestures.ts), because `dblclick` synthesis on touch is unreliable and
  // `touch-action: none` — which the pan surface needs — interferes with it.
  viewport.addEventListener("dblclick", event => {
    event.preventDefault();
    fitToViewport(internals);
  });

  // A rotation, a window resize or the visible viewport changing size moves
  // the viewport's edges: fitted media fits again, and zoomed media keeps its
  // scale and is brought back within the pan bound.
  const Observer = window.ResizeObserver;
  if (Observer) {
    new Observer(() => {
      if (!dialog.open || !internals.base) return;
      if (internals.fitted) fitToViewport(internals);
      else apply(internals, internals.transform, "now");
    }).observe(viewport);
  }

  document.body.appendChild(dialog);
  return internals;
}

// The dialog's CSS fills the layout viewport (100dvw × 100dvh). After a page
// pinch-zoom the visible part of the page is smaller and offset within it, and
// a dialog that size would put its toolbar, close included, off-screen. While
// open it is therefore placed on the visual viewport, with the page's zoom in
// `--media-viewer-page-zoom` so the toolbar can keep its usual on-screen size
// (styles.css); on close it falls back to the CSS geometry.
function fitDialogToVisible(dialog: HTMLDialogElement, attached: boolean): void {
  const visible = window.visualViewport;
  if (!attached || !visible) {
    for (const property of ["left", "top", "width", "height", "--media-viewer-page-zoom"]) dialog.style.removeProperty(property);
    return;
  }
  dialog.style.left = `${visible.offsetLeft}px`;
  dialog.style.top = `${visible.offsetTop}px`;
  dialog.style.width = `${visible.width}px`;
  dialog.style.height = `${visible.height}px`;
  dialog.style.setProperty("--media-viewer-page-zoom", String(visible.scale > 0 ? visible.scale : 1));
}

// Capture is an optimization — it keeps moves coming to this element once a
// finger leaves its bounds — not a precondition. It throws NotFoundError when
// the id is no longer an active pointer, which a release racing the handler
// can produce, so a failure here must not abandon the gesture bookkeeping.
function capturePointer(viewport: HTMLElement, pointerId: number): void {
  try {
    viewport.setPointerCapture(pointerId);
  } catch {
    // Uncaptured is still workable; the viewport covers the whole dialog.
  }
}

function releasePointer(viewport: HTMLElement, pointerId: number): void {
  try {
    if (viewport.hasPointerCapture(pointerId)) {
      viewport.releasePointerCapture(pointerId);
    }
  } catch {
    // Already gone; nothing to release.
  }
}

function makeToolbarButton(label: string, glyph: string, extraClass?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = extraClass ? `media-viewer-button ${extraClass}` : "media-viewer-button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.textContent = glyph;
  return button;
}

function openViewer(internals: ViewerInternals, descriptor: ViewerDescriptor, options: ViewerOpenOptions): void {
  internals.session += 1;
  internals.contentGeneration += 1;
  const generation = internals.contentGeneration;
  internals.tracker.reset();
  internals.rest.reset();

  setKind(internals, descriptor.kind);
  internals.link = descriptor.link ?? null;
  internals.returnFocusTo = options.returnFocusTo ?? null;
  internals.afterClose = options.afterClose ?? null;
  internals.base = null;
  internals.natural = null;
  internals.pending = null;
  internals.transform = { tx: 0, ty: 0, scale: 1 };
  internals.fitted = true;

  syncToolbar(internals);
  syncCaption(internals, descriptor.caption);

  const { stage } = internals;
  stage.removeAttribute("data-zoom-state");
  stage.setAttribute("data-zoom-pending", "");
  stage.classList.remove("is-pixelated");
  stage.style.removeProperty("width");
  stage.style.removeProperty("height");
  stage.style.removeProperty("transform");
  // Hidden until the first fit, so the media never flashes at its natural
  // size in the corner.
  stage.style.visibility = "hidden";

  if (descriptor.kind === "mermaid") {
    const { clone, size } = cloneDiagram(descriptor.svg);
    stage.replaceChildren(clone);
    internals.base = size;
    internals.src = null;
  } else {
    internals.src = descriptor.src;
    const image = stageImage(descriptor);
    const settle = () => {
      if (generation !== internals.contentGeneration) return;
      const natural = naturalSize(image);
      internals.natural = natural;
      internals.base = natural ?? descriptor.fallbackSize ?? DEFAULT_SIZE;
      requestAnimationFrame(() => {
        if (generation === internals.contentGeneration) fitToViewport(internals);
      });
    };
    image.addEventListener("load", settle, { once: true });
    image.addEventListener("error", settle, { once: true });
    image.src = descriptor.src;
    stage.replaceChildren(image);
  }

  if (!internals.dialog.open) {
    internals.dialog.showModal();
  }
  internals.visible.attach();

  if (internals.base) {
    // Fit on the next frame, once the dialog has its full-size layout box.
    requestAnimationFrame(() => {
      if (generation === internals.contentGeneration) fitToViewport(internals);
    });
  }
  // The close button is a sensible initial keyboard target.
  internals.buttons.close.focus();
}

function setKind(internals: ViewerInternals, kind: MediaKind): void {
  internals.kind = kind;
  const isDiagram = kind === "mermaid";
  internals.dialog.setAttribute("aria-label", isDiagram ? "Diagram viewer" : "Image viewer");
  internals.dialog.dataset.mediaKind = kind;
  const closeLabel = isDiagram ? "Close diagram viewer" : "Close image viewer";
  internals.buttons.close.setAttribute("aria-label", closeLabel);
  internals.buttons.close.title = closeLabel;
}

// Show the actions this media has. A control that stays is never moved, since
// taking a focused element out of the document drops its focus, which a live
// edit would otherwise do to a keyboard user mid-task. A focused control that
// goes hands focus to close, the viewer's initial keyboard target.
function syncToolbar(internals: ViewerInternals): void {
  const { buttons, toolbar } = internals;
  const wanted: HTMLButtonElement[] = [
    buttons.zoomOut,
    buttons.zoomIn,
    buttons.fit,
    ...(internals.kind === "raster" ? [buttons.actualPixels] : []),
    ...(internals.link ? [buttons.openLink] : []),
    buttons.close,
  ];
  let lostFocus = false;
  for (const child of Array.from(toolbar.children)) {
    if (wanted.includes(child as HTMLButtonElement)) continue;
    lostFocus ||= child.contains(document.activeElement);
    child.remove();
  }
  // The controls kept are in order, so each missing one goes before the one
  // now at its position.
  wanted.forEach((button, index) => {
    const at = toolbar.children[index] ?? null;
    if (at !== button) toolbar.insertBefore(button, at);
  });
  if (lostFocus) buttons.close.focus();
}

// Text only, so a hostile file name stays inert.
function syncCaption(internals: ViewerInternals, caption: string | undefined): void {
  const text = caption?.trim() ?? "";
  internals.caption.textContent = text;
  internals.caption.hidden = text === "";
  if (text) internals.dialog.setAttribute("aria-describedby", internals.caption.id);
  else internals.dialog.removeAttribute("aria-describedby");
}

// See MediaViewerSession.replace.
function replaceContent(
  internals: ViewerInternals,
  descriptor: ViewerDescriptor,
  options: Pick<ViewerOpenOptions, "returnFocusTo">,
): void {
  internals.link = descriptor.link ?? null;
  if (options.returnFocusTo !== undefined) internals.returnFocusTo = options.returnFocusTo;
  syncToolbar(internals);
  syncCaption(internals, descriptor.caption);

  // The latest request wins: whatever it asks for, an earlier replacement
  // still loading no longer is the media's current copy.
  if (descriptor.kind === "mermaid") {
    internals.pending = null;
    const { clone, size } = cloneDiagram(descriptor.svg);
    swapContent(internals, descriptor.kind, clone, size, null, null);
    return;
  }
  if (descriptor.src === internals.src) {
    internals.pending = null;
    return;
  }
  if (internals.pending?.src === descriptor.src) return;
  const pending: PendingImage = { src: descriptor.src };
  internals.pending = pending;
  const image = stageImage(descriptor);
  image.addEventListener("load", () => {
    if (internals.pending !== pending) return;
    const natural = naturalSize(image);
    internals.pending = null;
    swapContent(internals, descriptor.kind, image, natural ?? descriptor.fallbackSize ?? DEFAULT_SIZE, natural, descriptor.src);
  }, { once: true });
  // A source that fails to load leaves the content shown, at fit.
  image.addEventListener("error", () => {
    if (internals.pending !== pending) return;
    internals.pending = null;
    fitToViewport(internals);
  }, { once: true });
  image.src = descriptor.src;
}

// An image for the stage. The caller sets its source after adding its
// listeners: a cached image can load as soon as it has one.
function stageImage(descriptor: { src: string; alt?: string }): HTMLImageElement {
  const image = document.createElement("img");
  image.alt = descriptor.alt ?? "";
  image.decoding = "async";
  image.draggable = false;
  return image;
}

// The new content can be another format (a <picture> picking an SVG where it
// showed a PNG): its actions come with it (see syncToolbar).
function swapContent(internals: ViewerInternals, kind: MediaKind, content: Element, base: Size, natural: Size | null, src: string | null): void {
  const previous = internals.base;
  const keep = previous !== null && !internals.fitted && sameAspectRatio(previous, base);
  const { tx, ty, scale } = internals.transform;
  internals.rest.reset();
  // What was on the stage, still loading or not, is replaced.
  internals.contentGeneration += 1;
  internals.stage.replaceChildren(content);
  internals.base = base;
  internals.natural = natural;
  internals.src = src;
  setKind(internals, kind);
  syncToolbar(internals);
  if (keep) {
    // Same displayed size: the scale is relative to the new content's size,
    // kept within the new content's zoom range.
    const carried = { tx, ty, scale: (scale * previous.width) / base.width };
    apply(internals, zoomTo(carried, carried.scale, viewportCentre(internals), scaleLimits(internals)), "now");
  } else {
    fitToViewport(internals);
  }
}

// Clone a rendered diagram for the stage. Ids are re-namespaced so internal
// `url(#x)` and `href="#x"` references resolve inside the clone rather than
// to (possibly identical) ids on the live inline SVG. Without this, browsers
// either resolve the references to the wrong SVG or fail to find them at
// all, and Mermaid diagrams render as flat black silhouettes.
function cloneDiagram(svg: SVGElement): { clone: SVGElement; size: Size } {
  const clone = svg.cloneNode(true) as SVGElement;
  remapSvgIds(clone);
  // Restore explicit dimensions from viewBox. The inline SVG has had its
  // sizing stripped for the preview, so the clone would otherwise render at
  // the SVG default (300×150).
  let size: Size | null = null;
  const parts = (clone.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (parts.length === 4 && parts.every(n => Number.isFinite(n)) && parts[2]! > 0 && parts[3]! > 0) {
    size = { width: parts[2]!, height: parts[3]! };
    clone.setAttribute("width", String(size.width));
    clone.setAttribute("height", String(size.height));
  } else {
    const width = Number.parseFloat(clone.getAttribute("width") ?? "");
    const height = Number.parseFloat(clone.getAttribute("height") ?? "");
    if (width > 0 && height > 0) size = { width, height };
  }
  if (!size) {
    const rect = svg.getBoundingClientRect();
    size = rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : DEFAULT_SIZE;
  }
  for (const property of ["max-width", "max-height", "aspect-ratio", "width", "height"]) {
    clone.style.removeProperty(property);
  }
  return { clone, size };
}

function viewportSize(internals: ViewerInternals): Size {
  const rect = internals.viewport.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

function toViewport(internals: ViewerInternals, point: { clientX: number; clientY: number } | { x: number; y: number }) {
  const rect = internals.viewport.getBoundingClientRect();
  const x = "clientX" in point ? point.clientX : point.x;
  const y = "clientY" in point ? point.clientY : point.y;
  return { x: x - rect.left, y: y - rect.top };
}

// The media's displayed rectangle in client coordinates.
function mediaRect(internals: ViewerInternals) {
  if (!internals.base) return null;
  const rect = internals.viewport.getBoundingClientRect();
  const { tx, ty, scale } = internals.transform;
  return {
    left: rect.left + tx,
    top: rect.top + ty,
    width: internals.base.width * scale,
    height: internals.base.height * scale,
  };
}

// The single choke point for moving the media: every route — drag, pinch,
// wheel, toolbar, keyboard — is bounded here by construction, keeping at
// least PAN_KEEP_VISIBLE of it on screen, in both input modes.
function apply(internals: ViewerInternals, next: ZoomTransform, mode: CommitMode): void {
  if (!internals.base) {
    return;
  }
  const bounded = boundKeepVisible(next, internals.base, viewportSize(internals));
  internals.transform = bounded;
  internals.fitted = false;
  updatePixelation(internals);
  internals.rest.show(bounded, mode);
}

// See `rasterEnlarged`. Only once zoomed in past fit: at fit (including a
// small image the fit enlarges) and below it the browser smooths.
function updatePixelation(internals: ViewerInternals): void {
  const { natural, base } = internals;
  const scale = internals.transform.scale;
  const enlarged =
    internals.kind === "raster" &&
    natural !== null &&
    base !== null &&
    scale > fitTransform(base, viewportSize(internals)).scale * (1 + 1e-6) &&
    rasterEnlarged(natural.width, base.width * scale, devicePixelScale(window));
  internals.stage.classList.toggle("is-pixelated", enlarged);
}

// The zoom range for the media on show (see `viewerScaleLimits`).
function scaleLimits(internals: ViewerInternals): ScaleLimits {
  // Unknown content gets the plain range: an empty size fits at 1.
  const actual = actualPixels(internals);
  return viewerScaleLimits(internals.base ?? { width: 0, height: 0 }, viewportSize(internals), actual === null ? [] : [actual]);
}

// The scale "1:1 actual pixels" shows raster media at; null for other media.
function actualPixels(internals: ViewerInternals): number | null {
  if (internals.kind !== "raster" || !internals.base || !internals.natural) return null;
  return actualPixelsScale(devicePixelScale(window), internals.natural.width, internals.base.width);
}

function viewportCentre(internals: ViewerInternals) {
  const size = viewportSize(internals);
  return { x: size.width / 2, y: size.height / 2 };
}

function zoomByStep(internals: ViewerInternals, factor: number): void {
  apply(internals, zoomAt(internals.transform, factor, viewportCentre(internals), scaleLimits(internals)), "now");
}

function fitToViewport(internals: ViewerInternals): void {
  if (!internals.base) {
    return;
  }
  apply(internals, fitTransform(internals.base, viewportSize(internals)), "now");
  internals.fitted = true;
}

function showActualPixels(internals: ViewerInternals): void {
  const scale = actualPixels(internals);
  if (scale === null) return;
  apply(internals, zoomTo(internals.transform, scale, viewportCentre(internals), scaleLimits(internals)), "now");
}

function remapSvgIds(svg: SVGElement): void {
  cloneCounter += 1;
  const ns = `mv${cloneCounter}-`;
  const idMap = new Map<string, string>();

  for (const el of Array.from(svg.querySelectorAll("[id]"))) {
    const oldId = el.getAttribute("id");
    if (!oldId) continue;
    const newId = ns + oldId;
    idMap.set(oldId, newId);
    el.setAttribute("id", newId);
  }
  if (svg.hasAttribute("id")) {
    const oldId = svg.getAttribute("id") ?? "";
    const newId = ns + oldId;
    idMap.set(oldId, newId);
    svg.setAttribute("id", newId);
  }

  if (idMap.size === 0) {
    return;
  }

  const elements: Element[] = [svg, ...Array.from(svg.querySelectorAll("*"))];
  for (const el of elements) {
    for (const attr of Array.from(el.attributes)) {
      let value = attr.value;
      if (value.includes("url(#")) {
        value = value.replace(/url\(#([^)]+)\)/g, (_match, id: string) => {
          return `url(#${idMap.get(id) ?? id})`;
        });
      }
      if ((attr.name === "href" || attr.localName === "href") && value.startsWith("#")) {
        const oldId = value.slice(1);
        const newId = idMap.get(oldId);
        if (newId) value = "#" + newId;
      }
      if (value !== attr.value) {
        el.setAttribute(attr.name, value);
      }
    }
  }

  // Mermaid embeds a `<style>` block whose selectors are scoped by the SVG
  // root id (e.g. `#mermaid-12345 .node rect { fill: ... }`). When we remap
  // the root id, the embedded selectors no longer match and the diagram
  // renders without fills (boxes look solid black). Rewrite #oldId
  // references inside every <style> element to use the new id.
  const styleElements = Array.from(svg.querySelectorAll("style"));
  for (const styleEl of styleElements) {
    const original = styleEl.textContent ?? "";
    if (!original) continue;
    let updated = original;
    for (const [oldId, newId] of idMap) {
      const escaped = oldId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Replace `#oldId` not followed by another identifier character so we
      // don't match a prefix of a longer id.
      updated = updated.replace(new RegExp(`#${escaped}(?![\\w-])`, "g"), `#${newId}`);
    }
    if (updated !== original) {
      styleEl.textContent = updated;
    }
  }
}
