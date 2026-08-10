// Painting matches, and getting the reader to them.
//
// Highlighting goes through the CSS Custom Highlight API rather than wrapping
// matches in `<mark>` elements. That is the whole point: the preview is
// rendered output with mermaid diagrams, anchor targets, and code-block
// decorations layered onto it, and it is replaced wholesale on every live
// reload. Inserting nodes into it to show a search result would re-enter all
// of that. Ranges paint over the document without touching it.

import { scrollportRect } from "../shell/preview-scroll-root";

const ALL_MATCHES = "uatu-find-match";
const CURRENT_MATCH = "uatu-find-current";

// `Highlight` and `CSS.highlights` are recent enough that the ambient DOM
// types may not carry them. The runtime is Chrome/Safari-class in the browser
// and a macOS 26 WKWebView in the desktop app, so the capability is present;
// only the type is missing.
type HighlightRange = { readonly __brand?: never } & Range;
interface HighlightLike {
  add(range: HighlightRange): void;
  clear(): void;
  priority: number;
}
type HighlightRegistry = {
  set(name: string, highlight: HighlightLike): void;
  delete(name: string): void;
};

declare const Highlight: (new (...ranges: HighlightRange[]) => HighlightLike) | undefined;

function registry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return css?.highlights ?? null;
}

// Whether the runtime can paint highlights at all. Callers use this to decide
// whether to offer find, rather than opening a bar that silently marks
// nothing.
export function supportsHighlights(): boolean {
  return registry() !== null && typeof Highlight === "function";
}

// `::highlight()` styling is tree-scoped: the registry is per-document, but a
// rule in the document stylesheet does not paint text living inside a shadow
// tree. The Diff view renders into one, so any shadow root holding matches has
// to be taught the rules directly. Mirrors the document-scope copy in
// `styles.css` — keep the two in step. (`tree-view.ts` works around the same
// boundary for its reveal cue.)
const SHADOW_HIGHLIGHT_CSS = `
::highlight(${ALL_MATCHES}) {
  background-color: var(--find-match-bg, #fff8c5);
  color: var(--text-strong, inherit);
}
::highlight(${CURRENT_MATCH}) {
  background-color: var(--find-current-bg, #ffd33d);
  color: var(--text-strong, inherit);
}
`;

const STYLE_MARKER = "data-uatu-find-highlight";

// Inject the highlight rules into any shadow root that might hold matches.
// Idempotent — a root already carrying the marker is left alone.
export function ensureShadowHighlightStyles(roots: readonly ShadowRoot[]): void {
  for (const root of roots) {
    if (root.querySelector(`style[${STYLE_MARKER}]`)) {
      continue;
    }
    const style = root.ownerDocument.createElement("style");
    style.setAttribute(STYLE_MARKER, "");
    style.textContent = SHADOW_HIGHLIGHT_CSS;
    root.appendChild(style);
  }
}

let allMatches: HighlightLike | null = null;
let currentMatch: HighlightLike | null = null;

function ensureHighlights(): boolean {
  const highlights = registry();
  if (!highlights || typeof Highlight !== "function") {
    return false;
  }
  if (!allMatches || !currentMatch) {
    allMatches = new Highlight();
    currentMatch = new Highlight();
    // Explicit priorities rather than relying on registration order, so the
    // current match always paints over the general one no matter what order
    // these end up registered in.
    allMatches.priority = 1;
    currentMatch.priority = 2;
    highlights.set(ALL_MATCHES, allMatches);
    highlights.set(CURRENT_MATCH, currentMatch);
  }
  return true;
}

// Paint `ranges`, marking the one at `currentIndex` as current. Replaces any
// previous paint — there is no incremental update, because the ranges are
// rebuilt from scratch whenever the query or the document changes anyway.
export function paintMatches(ranges: Range[], currentIndex: number): void {
  if (!ensureHighlights()) {
    return;
  }
  allMatches!.clear();
  currentMatch!.clear();
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index] as HighlightRange;
    if (index === currentIndex) {
      currentMatch!.add(range);
    } else {
      allMatches!.add(range);
    }
  }
}

// Remove every highlight. Leaves no residue: the highlights stay registered
// but empty, so nothing is painted and no markup was ever added to undo.
export function clearHighlights(): void {
  allMatches?.clear();
  currentMatch?.clear();
}

// Fraction of the viewport to leave above a revealed match. Slightly above
// centre reads better than dead centre — the match keeps its following
// context in view, which is usually what you want to read next.
const REVEAL_BIAS = 0.4;

// Scroll `container` so `range` is comfortably in view, and do nothing when it
// already is. Ranges have no `scrollIntoView`, and scrolling the nearest
// element instead would land on the top of a long code block rather than on
// the match inside it — so the offset is computed from the rects directly.
//
// `container` is whatever actually scrolls for the current layout and UI mode
// (see shell/preview-scroll-root). It used to be `.preview-shell`
// unconditionally, which is right on desktop and a silent no-op in touch mode
// and the ≤900px stacked layout, where the page scrolls instead (#181).
export function revealRange(range: Range, container: HTMLElement): void {
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return;
  }
  const view = scrollportRect(container);
  // `scroll-padding-top` on the container reserves room for the sticky
  // preview header; honour it so a revealed match never lands underneath.
  const paddingTop = Number.parseFloat(
    getComputedStyle(container).scrollPaddingTop || "0",
  ) || 0;
  const topLimit = view.top + paddingTop;
  if (rect.top >= topLimit && rect.bottom <= view.bottom) {
    return;
  }
  const usable = view.height - paddingTop;
  const target = rect.top - topLimit - (usable - rect.height) * REVEAL_BIAS;
  container.scrollTop += target;
}
