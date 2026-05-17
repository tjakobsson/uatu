// Split-pane layout chooser and runtime — owns the inline Single / Side by
// side / Stacked toolbar, the per-orientation ratio persistence, the split
// resizer drag handler, and the narrow-width auto-stack fallback. Extracted
// from `app.ts` so all of the layout-related DOM lives together.

import {
  writeSplitRatioPreference,
  writeViewLayoutPreference,
  type ViewLayout,
} from "../shared/types";
import { appState, safeLocalStorage } from "../shell/state";
import { applyDocumentPayload, documentViewCache, loadDocument, type RenderedDocument } from "./mount";
import { syncViewToggle } from "./view-mode";

const previewElementMaybe = document.querySelector<HTMLElement>("#preview");
const previewShellElementMaybe = document.querySelector<HTMLElement>(".preview-shell");

if (!previewElementMaybe || !previewShellElementMaybe) {
  throw new Error("uatu UI failed to initialize (preview/layout)");
}

const previewElement: HTMLElement = previewElementMaybe;
const previewShellElement: HTMLElement = previewShellElementMaybe;

// Reflect the persisted layout preference on the layout chooser. The chooser
// is hidden when the active document has no separate rendered representation,
// The layout chooser lives inline inside `#preview` now (see
// `renderLayoutToolbar`), so there's no header element to keep in sync —
// it's rebuilt every render to reflect `appState.viewLayout`. The
// function is kept as a no-op so existing call sites stay valid.
export function syncLayoutChooser(_payload: RenderedDocument | null): void {
  // Intentional no-op: layout toolbar is rendered as part of #preview.
}

// Ensure a layout toolbar exists (or doesn't) as a sibling above #preview
// inside .preview-shell. Builds fresh each call so the active-segment
// state always matches `appState.viewLayout` without a separate sync pass.
export function mountLayoutToolbar(show: boolean): void {
  const previousToolbar = previewShellElement.querySelector<HTMLElement>(".uatu-layout-toolbar");
  if (previousToolbar) {
    previousToolbar.remove();
  }
  if (!show) return;
  const toolbar = renderLayoutToolbar();
  previewShellElement.insertBefore(toolbar, previewElement);
}

// Build the inline layout chooser that sits above the document body for
// Markdown / AsciiDoc. Mirrors the .uatu-diff-toolbar pattern: small
// segmented pill with text labels, an "is-active" segment, and a click
// handler that defers to applyViewLayout.
export function renderLayoutToolbar(): HTMLElement {
  const toolbar = document.createElement("div");
  toolbar.className = "uatu-layout-toolbar";
  toolbar.setAttribute("role", "radiogroup");
  toolbar.setAttribute("aria-label", "Layout");

  const segments: Array<{ value: ViewLayout; label: string; title: string }> = [
    { value: "single", label: "Single", title: "Single pane" },
    { value: "split-h", label: "Side by side", title: "Side-by-side split" },
    { value: "split-v", label: "Stacked", title: "Stacked (top / bottom) split" },
  ];

  for (const segment of segments) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "uatu-layout-toolbar-segment";
    button.setAttribute("role", "radio");
    button.setAttribute("data-layout-value", segment.value);
    button.setAttribute("aria-checked", String(segment.value === appState.viewLayout));
    if (segment.value === appState.viewLayout) {
      button.classList.add("is-active");
    }
    button.title = segment.title;
    button.textContent = segment.label;
    button.addEventListener("click", () => applyViewLayout(segment.value));
    toolbar.appendChild(button);
  }

  return toolbar;
}

export function applyViewLayout(next: ViewLayout): void {
  if (appState.viewLayout === next) {
    return;
  }
  appState.viewLayout = next;
  writeViewLayoutPreference(safeLocalStorage(), next);
  // Reflect the new state on both controls before re-rendering so the chooser
  // visually responds even if the re-render is async.
  syncLayoutChooser(currentRenderedPayload());
  syncViewToggle(currentRenderedPayload());
  if (appState.previewMode.kind !== "document" || !appState.selectedId) {
    return;
  }
  // Re-render the active document into the new layout. For single layout
  // we use the cached payload of the current viewMode; for split we let
  // applyDocumentPayload fetch any missing view without flashing an empty
  // state. If neither view is cached (rare — only when navigating away
  // and back faster than the cache survives), fall back to loadDocument.
  const cache = documentViewCache.get(appState.selectedId);
  if (next === "single") {
    const cached = cache?.[appState.viewMode];
    if (cached) {
      void applyDocumentPayload(cached);
      return;
    }
  } else {
    const seed = cache?.[appState.viewMode] ?? cache?.source ?? cache?.rendered;
    if (seed) {
      void applyDocumentPayload(seed);
      return;
    }
  }
  void loadDocument(appState.selectedId);
}

// Return the payload that's currently driving the preview header, if any.
// Used by sync helpers that need a payload-shaped argument when re-rendering
// state changes (layout, toggle) without a fresh fetch.
export function currentRenderedPayload(): RenderedDocument | null {
  if (appState.previewMode.kind !== "document" || !appState.selectedId) {
    return null;
  }
  const cache = documentViewCache.get(appState.selectedId);
  return cache?.[appState.viewMode] ?? cache?.rendered ?? cache?.source ?? null;
}

// Apply the persisted ratio for the active split orientation to the source
// pane's flex-basis. The rendered pane stretches via flex:1, so no explicit
// size is needed there. No-op when no split is mounted.
export function applySplitRatioToDom(): void {
  const sourcePane = previewElement.querySelector<HTMLElement>(".preview-pane-source");
  if (!sourcePane) return;
  // Auto-stack renders as a column even with the is-split-h class — pick the
  // ratio axis to match the visual orientation, not just the stored class.
  const isStackedVisually =
    previewElement.classList.contains("is-split-v") ||
    previewElement.getAttribute("data-auto-stack") === "true";
  const orientation: "h" | "v" = isStackedVisually ? "v" : "h";
  const ratio = appState.splitRatio[orientation];
  if (orientation === "h") {
    sourcePane.style.flexBasis = `${ratio * 100}%`;
    sourcePane.style.width = "auto";
    sourcePane.style.height = "";
  } else {
    sourcePane.style.flexBasis = `${ratio * 100}%`;
    sourcePane.style.height = "auto";
    sourcePane.style.width = "";
  }
}

// Pointer-drag handler for the split resizer between Source and Rendered
// panes. Modeled on the terminal-pane resizer pattern (setPointerCapture so
// drags that escape the visible bar keep tracking, locked min-pane size,
// orientation-aware delta math).
export const MIN_PANE_SIZE = 160; // CSS pixels

export function attachSplitResizer(resizer: HTMLElement): void {
  resizer.addEventListener("pointerdown", event => {
    const sourcePane = previewElement.querySelector<HTMLElement>(".preview-pane-source");
    const renderedPane = previewElement.querySelector<HTMLElement>(".preview-pane-rendered");
    if (!sourcePane || !renderedPane) return;
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add("is-dragging");
    // Auto-stack mode keeps the stored `is-split-h` class but renders as a
    // column visually; treat it as vertical for drag math so clientY drives
    // the resize instead of clientX.
    const isStackedVisually =
      previewElement.classList.contains("is-split-v") ||
      previewElement.getAttribute("data-auto-stack") === "true";
    const orientation: "h" | "v" = isStackedVisually ? "v" : "h";
    const containerRect = previewElement.getBoundingClientRect();
    const total = orientation === "h" ? containerRect.width : containerRect.height;
    // Available space for the panes (subtract resizer width / height).
    const resizerRect = resizer.getBoundingClientRect();
    const resizerExtent = orientation === "h" ? resizerRect.width : resizerRect.height;
    const usable = Math.max(1, total - resizerExtent);
    const startPos = orientation === "h" ? event.clientX : event.clientY;
    const startRatio = appState.splitRatio[orientation];
    const sourceStart = startRatio * usable;
    const minRatio = MIN_PANE_SIZE / usable;
    const maxRatio = 1 - minRatio;

    const onMove = (move: PointerEvent) => {
      const delta = (orientation === "h" ? move.clientX : move.clientY) - startPos;
      const nextSourceSize = sourceStart + delta;
      let ratio = nextSourceSize / usable;
      if (ratio < minRatio) ratio = minRatio;
      if (ratio > maxRatio) ratio = maxRatio;
      appState.splitRatio[orientation] = ratio;
      applySplitRatioToDom();
    };
    const onUp = (up: PointerEvent) => {
      resizer.releasePointerCapture(up.pointerId);
      resizer.classList.remove("is-dragging");
      resizer.removeEventListener("pointermove", onMove);
      resizer.removeEventListener("pointerup", onUp);
      resizer.removeEventListener("pointercancel", onUp);
      writeSplitRatioPreference(safeLocalStorage(), appState.splitRatio);
    };
    resizer.addEventListener("pointermove", onMove);
    resizer.addEventListener("pointerup", onUp);
    resizer.addEventListener("pointercancel", onUp);
  });
}

// Narrow-width auto-stack: when the stored preference is split-h but the
// preview body is too narrow to render two readable panes, render as stacked.
// The stored preference is unchanged. Threshold accounts for both panes at
// their minimum size plus the resizer width.
export const AUTO_STACK_THRESHOLD = 2 * MIN_PANE_SIZE + 8;

export function applyAutoStackIfNeeded(): void {
  if (!previewElement.classList.contains("is-split")) {
    previewElement.removeAttribute("data-auto-stack");
    return;
  }
  if (appState.viewLayout !== "split-h") {
    previewElement.removeAttribute("data-auto-stack");
    return;
  }
  const width = previewElement.getBoundingClientRect().width;
  const shouldStack = width > 0 && width < AUTO_STACK_THRESHOLD;
  if (shouldStack) {
    previewElement.setAttribute("data-auto-stack", "true");
  } else {
    previewElement.removeAttribute("data-auto-stack");
  }
  applySplitRatioToDom();
}

// Install once at boot: a ResizeObserver on the preview body that triggers
// the auto-stack fallback when the width crosses the threshold.
export function attachAutoStackObserver(): void {
  const observer = new ResizeObserver(() => {
    applyAutoStackIfNeeded();
  });
  observer.observe(previewElement);
}
