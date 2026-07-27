// Revealing a match that came from somewhere other than the find bar.
//
// Project search needs to highlight and scroll to a hit it found server-side,
// in source text, and it must not grow its own highlighting to do it — one
// painting path, or the two drift. This is that entry point: it reuses the
// same text index and the same `CSS.highlights` registry the find bar uses,
// without opening the bar or setting a query.

import { clearHighlights, ensureShadowHighlightStyles, paintMatches, revealRange } from "./highlight";
import { buildTextIndex, locateSpan, toRange } from "./text-index";

const previewElementMaybe = document.querySelector<HTMLElement>("#preview");
const previewShellElementMaybe = document.querySelector<HTMLElement>(".preview-shell");

if (!previewElementMaybe || !previewShellElementMaybe) {
  throw new Error("uatu UI failed to initialize (find/reveal)");
}

const previewElement: HTMLElement = previewElementMaybe;
const previewShellElement: HTMLElement = previewShellElementMaybe;

// Highlight and scroll to the first occurrence of `text` in the current view.
//
// Returns false when the text is not present — which is the signal callers
// need, not an error: a match found in source frequently does not exist in the
// rendered DOM, and the caller decides what to do about that. Nothing is
// painted and nothing is scrolled in that case, so the reader is never left
// staring at an arbitrary position.
export function revealExternalMatch(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  const index = buildTextIndex(previewElement);
  const at = index.text.indexOf(text);
  if (at === -1) {
    clearHighlights();
    return false;
  }
  const located = locateSpan(index, { start: at, end: at + text.length });
  if (!located) {
    clearHighlights();
    return false;
  }
  ensureShadowHighlightStyles(index.shadowRoots);
  const range = toRange(located, previewElement.ownerDocument);
  // Painted as the current match: there is exactly one, and it is the one the
  // reader asked for.
  paintMatches([range], 0);
  revealRange(range, previewShellElement);
  // Focus the document so it is immediately scrollable — the reader came here
  // to read, not to go back to the sidebar for arrow keys.
  previewShellElement.focus({ preventScroll: true });
  return true;
}

export function clearExternalMatch(): void {
  clearHighlights();
}
