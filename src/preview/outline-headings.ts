// Pure heading-enumeration helpers for the outline overlay. Split out from
// `outline.ts` (which queries live DOM and imports header chrome at module
// load) so these can be unit-tested in isolation against a parsed fragment —
// the same testability split used by `anchor-url.ts` vs `anchors.ts`.

export type OutlineHeading = {
  level: number;
  text: string;
  id: string | null;
  element: HTMLElement;
};

// Enumerate the heading elements (h1–h6) under `root` into a flat, ordered
// list carrying each heading's level, cleaned label, id, and live element
// reference. DOM-only and side-effect-free so it works for either renderer's
// output and is unit-testable. Headings whose text is empty after cleaning
// (e.g. an icon-only heading) are skipped — they would be unlabelable rows.
export function collectHeadings(root: ParentNode): OutlineHeading[] {
  const nodes = root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6");
  const headings: OutlineHeading[] = [];
  nodes.forEach(element => {
    const text = cleanHeadingText(element);
    if (!text) {
      return;
    }
    const level = Number(element.tagName.slice(1));
    headings.push({ level, text, id: element.id || null, element });
  });
  return headings;
}

// Derive a clean label from a heading's text content: collapse whitespace and
// strip a leading pilcrow / hash that some anchor-link affordances inject.
export function cleanHeadingText(element: HTMLElement): string {
  return (element.textContent ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[#¶]\s*/, "")
    .trim();
}

// Where the scroll-spy's trigger line sits, in px below the top of the
// scrollport: a heading counts as reached once its top crosses it. It sits
// just under whatever covers the top of the scrollport (the sticky header),
// and never above the scroller's `scroll-padding-top` — the line every
// navigation (outline click, anchor, cross-reference) lands its target on.
// A trigger above that line would leave a just-navigated heading short of
// it, and the highlight would settle on the heading before the one chosen.
export function spyTriggerOffset(headerOverlap: number, scrollPaddingTop: number): number {
  const padding = Number.isFinite(scrollPaddingTop) ? scrollPaddingTop : 0;
  return Math.max(headerOverlap + 8, padding);
}
