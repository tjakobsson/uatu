// Which presentation the outline uses: the docked rail, or a fullscreen sheet.
//
// The question is width, not UI mode. An iPad reports `data-ui-mode="touch"` at
// 834px, where the rail is good — a 288px panel beside a 470px prose column —
// and an iPhone reports the same at 390px, where the reserved gutter leaves the
// document a 114px column and breaks the `<h1>` mid-word. The mode attribute
// cannot tell those apart, and gating on it would also leave the ≤900px stacked
// desktop layout — which reproduces the identical squeeze — unfixed.
//
// This is the same shape of answer `shell/preview-scroll-root` gives to the
// same shape of question: ask what the layout can actually do, not which mode
// stamped it, so a layout nobody has thought of yet is handled without editing
// this file.
//
// Split pure-rule-from-DOM for the reason `outline-headings` was split out of
// `outline.ts`: that module reaches for header chrome at import time, so
// anything importing it is not unit-testable.

export type OutlinePresentation = "rail" | "sheet";

// What an open rail actually takes out of the preview's width: the width it
// opens at plus the margin between it and the document. Mirrored from
// `outline.ts` (DEFAULT_WIDTH 288 + EDGE_MARGIN 16) rather than imported,
// because importing `outline.ts` is what this module exists to avoid.
//
// The DEFAULT width, not the MIN. An earlier revision derived the threshold
// from MIN_WIDTH (200) — but nothing ever opens the rail at 200; the clamp in
// `layoutPanel` starts from the stored width and falls back to 288. Deriving
// from a width the rail never uses let a 596px preview qualify as "wide
// enough" while actually leaving ~245px of prose, not the 380 promised here.
const RAIL_FOOTPRINT = 304;

// A readable prose column beside the rail. At the preview's 16px base, ~45
// characters — the low end of a comfortable measure — is about 380px. Below
// this the rail is not "tight", it is the 114px column that motivated the
// change.
const READABLE_MEASURE = 380;

// A full-height rail in a short viewport is a different failure from a narrow
// one: an iPhone in landscape is 844px wide (clears the width floor outright)
// but 390px tall, which after the wrapped preview header and the tab bar seats
// about four 44px rows. Both floors must clear for the rail to be worth
// choosing.
export const RAIL_MIN_HEIGHT = 480;

/** The available preview area, in CSS pixels. */
export type PreviewArea = {
  /** The preview shell's border-box width. */
  width: number;
  /** The visible height of the preview's scrollport. */
  height: number;
  /**
   * Horizontal space inside `width` that is padding rather than prose — the
   * shell's own padding plus the document's. Varies by layout (the shell drops
   * from 1.75rem to 1rem at the ≤900px breakpoint), so it is measured rather
   * than assumed.
   */
  documentPadding: number;
};

/** The narrowest preview that can seat a default rail beside a readable
 *  column, for a given amount of padding. Exposed for tests and diagnostics. */
export function railMinWidth(documentPadding: number): number {
  return RAIL_FOOTPRINT + READABLE_MEASURE + documentPadding;
}

// The rule itself, separated from the DOM so it can be tested.
//
// Stated as "what would be left for prose", which is the question that actually
// matters, rather than a bare width constant that has to be re-derived by hand
// whenever the rail's own width or the layout's padding changes.
//
// Note it uses the rail's DEFAULT footprint, not the user's stored width. That
// keeps the answer stable: dragging the rail narrower or wider never flips the
// presentation out from under the drag.
//
// Both floors are inclusive: an area sitting exactly on a boundary keeps the
// rail, so the boundary is a documented value rather than an off-by-one.
export function pickPresentation(area: PreviewArea): OutlinePresentation {
  const proseColumn = area.width - area.documentPadding - RAIL_FOOTPRINT;
  return proseColumn >= READABLE_MEASURE && area.height >= RAIL_MIN_HEIGHT ? "rail" : "sheet";
}
