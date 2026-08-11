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

// The rail's own footprint, mirrored from `outline.ts` (MIN_WIDTH 200 +
// EDGE_MARGIN 16). Duplicated as a derivation input rather than imported,
// because importing `outline.ts` is what this module exists to avoid.
const RAIL_FOOTPRINT = 216;

// A readable prose column beside the rail. At the preview's 16px base, ~45
// characters — the low end of a comfortable measure — is about 380px. Below
// this the rail is not "tight", it is the 114px column that motivated the
// change.
const READABLE_MEASURE = 380;

/** Minimum preview width that can seat the rail AND a readable column. */
export const RAIL_MIN_WIDTH = RAIL_FOOTPRINT + READABLE_MEASURE; // 596

// A full-height rail in a short viewport is a different failure from a narrow
// one: an iPhone in landscape is 844px wide (clears RAIL_MIN_WIDTH) but 390px
// tall, which after the wrapped preview header and the tab bar seats about four
// 44px rows. Both floors must clear for the rail to be worth choosing.
export const RAIL_MIN_HEIGHT = 480;

/** The available preview area, in CSS pixels. */
export type PreviewArea = { width: number; height: number };

// The rule itself, separated from the DOM so it can be tested. Both floors are
// inclusive: a viewport sitting exactly on a boundary keeps the rail, so the
// boundary is a documented value rather than an off-by-one.
export function pickPresentation(area: PreviewArea): OutlinePresentation {
  return area.width >= RAIL_MIN_WIDTH && area.height >= RAIL_MIN_HEIGHT ? "rail" : "sheet";
}
