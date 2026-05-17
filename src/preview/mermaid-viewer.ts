// Fullscreen Mermaid diagram viewer with pan + wheel-zoom.
// Mounted once on document.body so it survives preview re-renders.

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
const WHEEL_ZOOM_RATE = 0.001;

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

  // Pan + wheel-zoom on the viewport.
  let pointerId: number | null = null;
  let panStart = { x: 0, y: 0, tx: 0, ty: 0 };

  viewport.addEventListener("pointerdown", event => {
    if (event.button !== 0) {
      return;
    }
    pointerId = event.pointerId;
    panStart = { x: event.clientX, y: event.clientY, tx: internals.transform.tx, ty: internals.transform.ty };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add("is-panning");
  });

  viewport.addEventListener("pointermove", event => {
    if (pointerId !== event.pointerId) {
      return;
    }
    internals.transform.tx = panStart.tx + (event.clientX - panStart.x);
    internals.transform.ty = panStart.ty + (event.clientY - panStart.y);
    applyTransform(internals);
  });

  const endPan = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) {
      return;
    }
    pointerId = null;
    if (viewport.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId);
    }
    viewport.classList.remove("is-panning");
  };
  viewport.addEventListener("pointerup", endPan);
  viewport.addEventListener("pointercancel", endPan);

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
  const { tx, ty, scale } = internals.transform;
  internals.stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
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
