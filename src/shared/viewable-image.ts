// File extensions that uatu can render directly in the preview pane as an
// inline image. Kept conservative — formats that browsers reliably display
// via `<img>` without polyfills. SVGs are included; they're served as
// `image/svg+xml` by the static-file fallback and the browser sandboxes any
// `<script>` inside an SVG loaded through `<img>`, so no XSS risk.
//
// Shared rather than owned by preview/image.ts: the server's follow
// nomination and the client's follow rules decide with the same list which
// binary files the preview can show (see `isFollowableFile`).
export const VIEWABLE_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".avif",
  ".bmp",
]);

export function isViewableImageName(name: string): boolean {
  const lower = name.toLowerCase();
  for (const ext of VIEWABLE_IMAGE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}
