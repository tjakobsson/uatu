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

// Highlight and scroll to an occurrence of `text` in the current view.
//
// `occurrence` is which one, counted from zero in document order. Project
// search reports several hits of the same string in one file, and revealing
// the first for every row would land the reader in the wrong place for all but
// the first — the row knows which occurrence it is, so it says.
//
// Returns false when that occurrence is not present — which is the signal
// callers need, not an error: a match found in source frequently does not exist
// in the rendered DOM, and the caller decides what to do about that. Nothing is
// painted and nothing is scrolled in that case, so the reader is never left
// staring at an arbitrary position.
//
// `sourceTotal`, when given, is how many occurrences the *source* document
// holds. The occurrence ordinal counts in source order, and it only maps onto
// this view when the view holds every occurrence the source does. When
// rendering dropped one — a match inside a link URL, say — the nth visible
// occurrence is some *other* occurrence, and landing there would silently
// highlight the wrong place. A count mismatch therefore refuses the reveal so
// the caller falls back to Source, where the ordinal is exact.
export function revealExternalMatch(text: string, occurrence = 0, sourceTotal?: number): boolean {
  if (text.length === 0) {
    return false;
  }
  const index = buildTextIndex(previewElement);
  if (sourceTotal !== undefined && countOccurrences(index.text, text) !== sourceTotal) {
    clearHighlights();
    return false;
  }
  const at = nthIndexOf(index.text, text, occurrence);
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

// The offset of the `n`th occurrence (0-based), or -1 when there are fewer
// than `n + 1`. Occurrences are counted non-overlapping, matching how both the
// server sweep and the in-document matcher enumerate.
function nthIndexOf(haystack: string, needle: string, n: number): number {
  let at = haystack.indexOf(needle);
  for (let seen = 0; seen < n && at !== -1; seen += 1) {
    at = haystack.indexOf(needle, at + needle.length);
  }
  return at;
}

// Non-overlapping, the same way `nthIndexOf` steps and the server sweep
// counts — the comparison against `sourceTotal` is only meaningful when both
// sides count identically.
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

export function clearExternalMatch(): void {
  clearHighlights();
}
