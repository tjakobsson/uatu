// URL-construction helpers for in-page fragment navigation. Extracted from
// `anchors.ts` so the logic is unit-testable — `anchors.ts` itself transitively
// imports DOM-touching modules that throw at module load when there is no
// `#preview` in the document (i.e. outside the running app).

export function buildInPageAnchorUrl(
  location: { pathname: string; search: string },
  id: string,
): string {
  return location.pathname + location.search + "#" + encodeURIComponent(id);
}
