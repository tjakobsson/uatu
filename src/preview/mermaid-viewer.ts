// Fullscreen Mermaid diagram viewer.
// Mouse: drag-pan, cursor-anchored wheel zoom, double-click to fit.
// Touch: one-finger pan, two-finger midpoint-anchored pinch, double-tap to fit.
// Mounted once on document.body so it survives preview re-renders.

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
const WHEEL_ZOOM_RATE = 0.001;

// How much of the scaled diagram must stay inside the viewer after a pan.
// Not "fully contained" — at high zoom the diagram is deliberately larger
// than the screen and has to be pannable past its edges. Only the state where
// nothing at all is on screen is disallowed, because its only recovery was
// the fit button, which on a phone was itself off-screen.
const PAN_KEEP_VISIBLE = 48;

// Tap classification. A press that moves further than the slop or lasts
// longer than the timeout is a pan, not a tap.
const TAP_MOVE_LIMIT = 12;
const TAP_MAX_MS = 400;
const DOUBLE_TAP_MAX_GAP_MS = 300;
const DOUBLE_TAP_SLOP = 40;

type Transform = { tx: number; ty: number; scale: number };

type ViewerInternals = {
  dialog: HTMLDialogElement;
  viewport: HTMLDivElement;
  stage: HTMLDivElement;
  closeButton: HTMLButtonElement;
  transform: Transform;
  returnFocusTo: HTMLElement | null;
};

let viewer: ViewerInternals | null = null;
let cloneCounter = 0;

export type OpenViewerOptions = {
  svg: SVGElement;
  title?: string;
  returnFocusTo: HTMLElement;
};

export function ensureMermaidViewer(): { open: (options: OpenViewerOptions) => void } {
  if (typeof document === "undefined") {
    return { open: () => {} };
  }
  if (!viewer) {
    viewer = createViewer();
  }
  return {
    open: options => openViewer(viewer!, options),
  };
}

export function closeMermaidViewer(): void {
  if (!viewer) {
    return;
  }
  if (viewer.dialog.open) {
    viewer.dialog.close();
  }
}

function createViewer(): ViewerInternals {
  const dialog = document.createElement("dialog");
  dialog.className = "mermaid-viewer";
  dialog.setAttribute("aria-label", "Diagram viewer");

  const stage = document.createElement("div");
  stage.className = "mermaid-viewer-stage";

  const viewport = document.createElement("div");
  viewport.className = "mermaid-viewer-viewport";
  viewport.appendChild(stage);

  const toolbar = document.createElement("div");
  toolbar.className = "mermaid-viewer-toolbar";

  const closeButton = makeToolbarButton("Close diagram viewer", "×", "mermaid-viewer-close");
  const zoomInButton = makeToolbarButton("Zoom in", "+");
  const zoomOutButton = makeToolbarButton("Zoom out", "−");
  const fitButton = makeToolbarButton("Fit to screen", "⛶");

  toolbar.append(zoomOutButton, zoomInButton, fitButton, closeButton);

  dialog.append(viewport, toolbar);

  const internals: ViewerInternals = {
    dialog,
    viewport,
    stage,
    closeButton,
    transform: { tx: 0, ty: 0, scale: 1 },
    returnFocusTo: null,
  };

  closeButton.addEventListener("click", () => dialog.close());
  zoomInButton.addEventListener("click", () => zoomBy(internals, 1.25));
  zoomOutButton.addEventListener("click", () => zoomBy(internals, 1 / 1.25));
  fitButton.addEventListener("click", () => fitToViewport(internals));

  dialog.addEventListener("close", () => {
    const target = internals.returnFocusTo;
    internals.returnFocusTo = null;
    stage.replaceChildren();
    if (target && document.body.contains(target)) {
      target.focus();
    }
  });

  dialog.addEventListener("keydown", event => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomBy(internals, 1.25);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomBy(internals, 1 / 1.25);
    } else if (event.key === "0" || event.key.toLowerCase() === "f") {
      event.preventDefault();
      fitToViewport(internals);
    }
  });

  // --- Pointer gestures ---------------------------------------------------
  //
  // One map of live pointers rather than the single id/origin pair this
  // started as. The pair was written for a mouse, where a second pointer
  // cannot exist; on touch, an arriving or departing finger overwrote the pan
  // origin without re-seeding it and the diagram jumped by the distance
  // between the fingers.
  //
  // The pointer COUNT selects the gesture — 1 pans, 2 pinches, 3+ are ignored
  // — and every transition between counts re-seeds, which is what makes the
  // transitions invisible. `syncGesture` is deliberately the only place that
  // seeds anything, so there is no path that changes the count without
  // re-seeding.
  // `maxMoved` is the FURTHEST this pointer has been from where it landed, not
  // its current distance. A drag that wanders off and returns near its origin
  // before release has the release-point distance of a tap while being nothing
  // of the sort — panning out and back twice would otherwise read as a
  // double-tap and snap the diagram to fit, discarding the user's position.
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
  const pointers = new Map<number, ActivePointer>();
  let panOrigin: { x: number; y: number; tx: number; ty: number } | null = null;
  let pinch: { startDistance: number; startScale: number } | null = null;
  // A tap that was ever part of a two-finger gesture is not a tap.
  let gestureWasMultiTouch = false;
  let lastTap: { x: number; y: number; time: number } | null = null;

  const livePointers = () => Array.from(pointers.values());

  function syncGesture(): void {
    const active = livePointers();
    if (active.length === 2) {
      // Entering (or continuing) a pinch. Capture the baseline separation and
      // the scale it starts from, so the gesture is measured against where
      // the fingers began rather than accumulating per-move rounding.
      panOrigin = null;
      gestureWasMultiTouch = true;
      pinch = {
        startDistance: Math.max(distanceBetween(active[0]!, active[1]!), 1),
        startScale: internals.transform.scale,
      };
      viewport.classList.remove("is-panning");
      return;
    }
    pinch = null;
    if (active.length === 1) {
      // Seeds on 0→1 (a pan beginning) and equally on 2→1 (a finger lifting
      // out of a pinch). The second case is the one that used to jump: the
      // survivor resumes from wherever it is now, against the transform as it
      // now stands, so nothing moves at the transition.
      const only = active[0]!;
      panOrigin = { x: only.x, y: only.y, tx: internals.transform.tx, ty: internals.transform.ty };
      viewport.classList.add("is-panning");
      return;
    }
    panOrigin = null;
    viewport.classList.remove("is-panning");
  }

  viewport.addEventListener("pointerdown", event => {
    if (event.button !== 0) {
      return;
    }
    // Third and subsequent fingers are ignored rather than given a meaning.
    // They are not captured, so their moves never reach the handlers either.
    if (pointers.size >= 2) {
      gestureWasMultiTouch = true;
      return;
    }
    pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      downX: event.clientX,
      downY: event.clientY,
      downTime: event.timeStamp,
      maxMoved: 0,
    });
    capturePointer(event.pointerId);
    syncGesture();
  });

  // Capture is an optimization — it keeps moves coming to this element once a
  // finger leaves its bounds — not a precondition. It throws NotFoundError
  // when the id is no longer an active pointer, which a release racing the
  // handler can produce, so a failure here must not abandon the gesture
  // bookkeeping that follows it.
  function capturePointer(pointerId: number): void {
    try {
      viewport.setPointerCapture(pointerId);
    } catch {
      // Uncaptured is still workable; moves arrive while the finger is over
      // the viewport, which covers the whole dialog.
    }
  }

  function releasePointer(pointerId: number): void {
    try {
      if (viewport.hasPointerCapture(pointerId)) {
        viewport.releasePointerCapture(pointerId);
      }
    } catch {
      // Already gone; nothing to release.
    }
  }

  viewport.addEventListener("pointermove", event => {
    const pointer = pointers.get(event.pointerId);
    if (!pointer) {
      return;
    }
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.maxMoved = Math.max(
      pointer.maxMoved,
      Math.hypot(pointer.x - pointer.downX, pointer.y - pointer.downY),
    );

    const active = livePointers();
    if (active.length === 2 && pinch) {
      const [a, b] = active as [ActivePointer, ActivePointer];
      const distance = Math.max(distanceBetween(a, b), 1);
      // Scale tracks the ratio of current to initial separation, anchored on
      // the midpoint between the fingers — the touch counterpart of
      // cursor-anchored wheel zoom, and the same anchoring math. Anchoring on
      // the viewport centre instead would slide the content away from the
      // gesture.
      const target = clamp(pinch.startScale * (distance / pinch.startDistance), MIN_SCALE, MAX_SCALE);
      zoomAtPoint(internals, target / internals.transform.scale, (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    if (active.length === 1 && panOrigin) {
      internals.transform.tx = panOrigin.tx + (pointer.x - panOrigin.x);
      internals.transform.ty = panOrigin.ty + (pointer.y - panOrigin.y);
      applyTransform(internals);
    }
  });

  const endPointer = (event: PointerEvent, cancelled: boolean) => {
    const pointer = pointers.get(event.pointerId);
    if (!pointer) {
      return;
    }
    if (!cancelled) {
      handlePossibleTap(event, pointer);
    }
    pointers.delete(event.pointerId);
    releasePointer(event.pointerId);
    if (pointers.size === 0) {
      gestureWasMultiTouch = false;
    }
    syncGesture();
  };
  viewport.addEventListener("pointerup", event => endPointer(event, false));
  viewport.addEventListener("pointercancel", event => endPointer(event, true));

  // The viewer is mounted once and reused for every diagram, so gesture state
  // has to be dropped at close or it carries into the next open: a pointer
  // whose `pointerup` never arrived would leave a phantom finger in the map,
  // and a trailing single tap would pair with the first tap of the next
  // session into a spurious double-tap.
  dialog.addEventListener("close", () => {
    pointers.clear();
    lastTap = null;
    gestureWasMultiTouch = false;
    syncGesture();
  });

  // Double-tap to fit, detected from tap timing rather than `dblclick`.
  // `dblclick` synthesis on touch is inconsistent and `touch-action: none` —
  // which the pan surface needs — interferes with it. Mouse input keeps the
  // native `dblclick` listener below; two detectors, each reliable for its own
  // input mode, beat one that is unreliable for half of them.
  function handlePossibleTap(event: PointerEvent, pointer: ActivePointer): void {
    if (event.pointerType === "mouse") {
      return;
    }
    if (gestureWasMultiTouch || pointers.size > 1) {
      return;
    }
    const moved = Math.max(
      pointer.maxMoved,
      Math.hypot(event.clientX - pointer.downX, event.clientY - pointer.downY),
    );
    if (moved > TAP_MOVE_LIMIT || event.timeStamp - pointer.downTime > TAP_MAX_MS) {
      return;
    }
    const previous = lastTap;
    if (
      previous &&
      event.timeStamp - previous.time <= DOUBLE_TAP_MAX_GAP_MS &&
      Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= DOUBLE_TAP_SLOP
    ) {
      lastTap = null;
      fitToViewport(internals);
      return;
    }
    lastTap = { x: event.clientX, y: event.clientY, time: event.timeStamp };
  }

  viewport.addEventListener(
    "wheel",
    event => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_RATE);
      zoomAtPoint(internals, factor, event.clientX, event.clientY);
    },
    { passive: false },
  );

  viewport.addEventListener("dblclick", event => {
    event.preventDefault();
    fitToViewport(internals);
  });

  document.body.appendChild(dialog);
  return internals;
}

function makeToolbarButton(label: string, glyph: string, extraClass?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = extraClass ? `mermaid-viewer-button ${extraClass}` : "mermaid-viewer-button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.textContent = glyph;
  return button;
}

function openViewer(internals: ViewerInternals, options: OpenViewerOptions): void {
  const clone = options.svg.cloneNode(true) as SVGElement;
  // Re-namespace ids in the clone so internal `url(#x)` and `href="#x"`
  // references resolve to elements inside the clone, not to (possibly
  // identical) ids on the live inline SVG. Without this, browsers either
  // resolve the references to the wrong SVG or fail to find them at all,
  // and Mermaid diagrams render as flat black silhouettes (gradients,
  // arrowheads, clipPaths all break).
  remapSvgIds(clone);

  // Restore explicit dimensions from viewBox. The inline SVG has had its
  // width/height attributes stripped by normalizeMermaidSvg, so the clone
  // would otherwise render at the SVG default (300x150) and the inline-block
  // stage would shrink with it.
  const viewBox = clone.getAttribute("viewBox");
  if (viewBox) {
    const parts = viewBox.split(/\s+/).map(Number);
    if (parts.length === 4 && parts.every(n => Number.isFinite(n)) && parts[2] > 0 && parts[3] > 0) {
      clone.setAttribute("width", String(parts[2]));
      clone.setAttribute("height", String(parts[3]));
    }
  }
  clone.style.removeProperty("max-width");
  clone.style.removeProperty("max-height");
  clone.style.removeProperty("aspect-ratio");
  clone.style.removeProperty("width");
  clone.style.removeProperty("height");

  internals.stage.replaceChildren(clone);
  internals.returnFocusTo = options.returnFocusTo;
  if (options.title) {
    internals.dialog.setAttribute("aria-label", options.title);
  } else {
    internals.dialog.setAttribute("aria-label", "Diagram viewer");
  }

  if (!internals.dialog.open) {
    internals.dialog.showModal();
  }

  // Reset transform on open and fit once the dialog has its layout box.
  resetTransform(internals);
  // Defer fit so the viewport has been laid out at full size.
  requestAnimationFrame(() => fitToViewport(internals));
  // Focus close button as a sensible initial keyboard target.
  internals.closeButton.focus();
}

function applyTransform(internals: ViewerInternals): void {
  clampTranslation(internals);
  const { tx, ty, scale } = internals.transform;
  internals.stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
}

// Keep at least `PAN_KEEP_VISIBLE` of the scaled stage inside the viewer on
// each axis. The single choke point for it is `applyTransform`, so every route
// that moves the diagram — drag, pinch, wheel, toolbar, keyboard — is bounded
// by construction rather than by remembering to call this.
//
// Applies in both input modes on purpose. Two pan models in one viewer would
// be worse than one slightly stricter one, and on desktop the effect is a
// small forgiveness improvement rather than a behavior change anyone will
// notice: a fling that used to lose the diagram now stops at the edge.
function clampTranslation(internals: ViewerInternals): void {
  const viewportRect = internals.viewport.getBoundingClientRect();
  if (viewportRect.width === 0 || viewportRect.height === 0) {
    return;
  }
  // `offsetWidth`/`offsetHeight` are layout dimensions and ignore the
  // transform, so they give the unscaled stage size without having to divide
  // the visual rect back out by a scale that is mid-update.
  const baseWidth = internals.stage.offsetWidth;
  const baseHeight = internals.stage.offsetHeight;
  if (baseWidth === 0 || baseHeight === 0) {
    return;
  }
  const scaledWidth = baseWidth * internals.transform.scale;
  const scaledHeight = baseHeight * internals.transform.scale;
  // A diagram smaller than the margin can only ever keep its whole self
  // visible, so the margin shrinks to it rather than producing an empty range.
  const marginX = Math.min(PAN_KEEP_VISIBLE, scaledWidth, viewportRect.width);
  const marginY = Math.min(PAN_KEEP_VISIBLE, scaledHeight, viewportRect.height);
  internals.transform.tx = clamp(internals.transform.tx, marginX - scaledWidth, viewportRect.width - marginX);
  internals.transform.ty = clamp(internals.transform.ty, marginY - scaledHeight, viewportRect.height - marginY);
}

function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function resetTransform(internals: ViewerInternals): void {
  internals.transform = { tx: 0, ty: 0, scale: 1 };
  applyTransform(internals);
}

function zoomBy(internals: ViewerInternals, factor: number): void {
  const rect = internals.viewport.getBoundingClientRect();
  zoomAtPoint(internals, factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function zoomAtPoint(internals: ViewerInternals, factor: number, clientX: number, clientY: number): void {
  const rect = internals.viewport.getBoundingClientRect();
  const cx = clientX - rect.left;
  const cy = clientY - rect.top;
  const prev = internals.transform;
  const nextScale = clamp(prev.scale * factor, MIN_SCALE, MAX_SCALE);
  const ratio = nextScale / prev.scale;
  // Keep the world-point under the cursor anchored: new_t = c - (c - t) * ratio
  internals.transform = {
    tx: cx - (cx - prev.tx) * ratio,
    ty: cy - (cy - prev.ty) * ratio,
    scale: nextScale,
  };
  applyTransform(internals);
}

function fitToViewport(internals: ViewerInternals): void {
  const viewportRect = internals.viewport.getBoundingClientRect();
  // baseWidth/Height are the stage's dimensions before any transform.
  const stageRect = internals.stage.getBoundingClientRect();
  const currentScale = internals.transform.scale || 1;
  const baseWidth = stageRect.width / currentScale;
  const baseHeight = stageRect.height / currentScale;
  if (baseWidth === 0 || baseHeight === 0) {
    return;
  }
  const margin = 32;
  const fitScale = clamp(
    Math.min(
      (viewportRect.width - margin) / baseWidth,
      (viewportRect.height - margin) / baseHeight,
    ),
    MIN_SCALE,
    MAX_SCALE,
  );
  // Center the stage in the viewport at the fit scale.
  internals.transform = {
    tx: (viewportRect.width - baseWidth * fitScale) / 2,
    ty: (viewportRect.height - baseHeight * fitScale) / 2,
    scale: fitScale,
  };
  applyTransform(internals);
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
