// Project identity — makes one uatu instance distinguishable from another
// when several run side by side (issues #101/#102). Everything derives from
// the StatePayload roots the client already receives: a human label for the
// tab title and sidebar marker, and a stable hue (hashed from root PATHS,
// not labels, so two projects both named "docs" still get different colors)
// tinting the favicon and the marker alike — the color learned in the tab
// strip is the color seen inside the app.
//
// Pure helpers are exported for unit tests; only applyProjectIdentity
// touches the DOM. It is called from applyServerSnapshot on every state
// payload (boot + SSE refresh), so re-derivation must stay idempotent.

import type { RootGroup } from "../shared/types";

// First root's label, "+N" for the rest. Joining every label reads as noise
// at tab-strip width; the marker tooltip carries the full paths instead.
export function projectLabel(roots: RootGroup[]): string | null {
  if (roots.length === 0) return null;
  const first = roots[0]!.label;
  return roots.length === 1 ? first : `${first} +${roots.length - 1}`;
}

// FNV-1a: five lines, no dependency, good spread for short path strings.
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// Hashes `root.id` — the watched entry's absolute path — NOT `root.path`:
// for single-file sessions (`uatu serve README.md`) the server sets `path`
// to the parent directory, so two file sessions in the same directory would
// collide on `path` while their `id`s (the files themselves) differ. For
// directory roots the two are identical. Sorted so CLI argument order
// doesn't change a project's color.
export function identityHue(roots: RootGroup[]): number {
  const key = roots
    .map(root => root.id)
    .sort()
    .join("\n");
  return fnv1a(key) % 360;
}

export function pageTitle(label: string | null): string {
  return label === null ? "uatu" : `${label} — uatu`;
}

// Fixed saturation/lightness keep every hue legible on light and dark tab
// strips; only the hue varies per project.
export function identityColor(hue: number): string {
  return `hsl(${hue}, 60%, 45%)`;
}

// Rounded square + the label's first character: color alone fails for
// color-blind users and adjacent hues; the letter covers both.
export function faviconSvg(label: string, hue: number): string {
  const initial = escapeXml(label.slice(0, 1));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="14" fill="${identityColor(hue)}"/>` +
    `<text x="32" y="34" dominant-baseline="central" text-anchor="middle" ` +
    `font-family="system-ui, sans-serif" font-size="38" font-weight="700" fill="#ffffff">` +
    initial +
    `</text></svg>`
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const FAVICON_ID = "project-favicon";

// Title + favicon only. The in-app marker renders inside the Change
// Overview pane (sidebar/change-overview.ts), which already names each
// repository — it reuses identityHue/identityColor so a single-repo
// session's badge matches the favicon exactly.
export function applyProjectIdentity(roots: RootGroup[]): void {
  if (typeof document === "undefined") return;

  const label = projectLabel(roots);
  document.title = pageTitle(label);

  let favicon = document.getElementById(FAVICON_ID) as HTMLLinkElement | null;

  if (label === null) {
    // No roots: plain branding, no dynamic favicon.
    favicon?.remove();
    return;
  }

  if (!favicon) {
    favicon = document.createElement("link");
    favicon.id = FAVICON_ID;
    favicon.rel = "icon";
    favicon.type = "image/svg+xml";
    document.head.appendChild(favicon);
  }
  favicon.href = `data:image/svg+xml,${encodeURIComponent(faviconSvg(label, identityHue(roots)))}`;
}
