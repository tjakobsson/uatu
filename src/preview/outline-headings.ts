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
