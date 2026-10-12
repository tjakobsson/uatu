// Cache-busting for images shown in the preview. The static-file fallback
// serves an image at the same URL however often it changes on disk, and a
// browser reuses an image it has already decoded for that URL within the
// page — `cache-control: no-cache` does not stop it. So every <img> in the
// preview that resolves to a watched file carries that file's change
// revision (`documentRevisionKey`) as a `revision` query parameter; the
// server matches on the path and ignores the query. The opened image and the
// images a document embeds use the same parameter. When the index reports a
// new revision for the file, the URL changes and the browser fetches the new
// bytes; when it does not, the URL is stable and nothing is refetched.
// Freshness follows the revision, never the modification time. Images on
// other hosts, data URLs, and paths that are not watched files are left
// exactly as authored.

import { stripBasePath } from "../shared/base-path";
import type { RootGroup } from "../shared/types";

const REVISION_PARAM = "revision";

// `src` (absolute or relative) with its revision parameter set to
// `revision`, replacing any earlier one.
export function withImageRevision(src: string, revision: string): string {
  const hashIndex = src.indexOf("#");
  const hash = hashIndex === -1 ? "" : src.slice(hashIndex);
  const beforeHash = hashIndex === -1 ? src : src.slice(0, hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  const path = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? "" : beforeHash.slice(queryIndex + 1));
  params.set(REVISION_PARAM, revision);
  return `${path}?${params}${hash}`;
}

// The watched file an image `src` resolved against `baseUrl` points at, with
// its resolved URL, or null when it is not a watched file this session serves.
function resolveWatchedImage(
  src: string,
  baseUrl: string,
  basePath: string,
  roots: readonly RootGroup[],
): { url: URL; id: string } | null {
  let url: URL;
  try {
    url = new URL(src, baseUrl);
  } catch {
    return null;
  }
  if (url.origin !== new URL(baseUrl).origin) return null;
  const rootRelative = stripBasePath(url.pathname, basePath);
  if (rootRelative === null) return null;
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(rootRelative).replace(/^\/+/, "");
  } catch {
    return null;
  }
  // First root wins, as in the static-file fallback's entry order.
  for (const root of roots) {
    const doc = root.docs.find(candidate => candidate.relativePath === relativePath);
    if (doc) return { url, id: doc.id };
  }
  return null;
}

// The id of the watched file an image `src` resolved against `baseUrl` shows,
// or null when it is not a watched file this session serves.
export function imageDocumentId(
  src: string,
  baseUrl: string,
  basePath: string,
  roots: readonly RootGroup[],
): string | null {
  return resolveWatchedImage(src, baseUrl, basePath, roots)?.id ?? null;
}

// The absolute URL an image `src` resolved against `baseUrl` should load:
// its watched file's current revision applied, or null when the image is not
// a watched file this session serves.
export function revisionedImageUrl(
  src: string,
  baseUrl: string,
  basePath: string,
  roots: readonly RootGroup[],
  revisionOf: (id: string) => string,
): string | null {
  const resolved = resolveWatchedImage(src, baseUrl, basePath, roots);
  if (!resolved) return null;
  resolved.url.searchParams.set(REVISION_PARAM, revisionOf(resolved.id));
  return resolved.url.href;
}

// The `src` of every image under `root`, as authored.
export function imageSources(root: ParentNode): string[] {
  return [...root.querySelectorAll("img[src]")].map(image => image.getAttribute("src") ?? "");
}

// Points every image under `container` at its file's current revision. Cheap
// and idempotent: an image whose file has not changed keeps its URL and is
// not refetched, so this runs on every mount and every state update. Updating
// `src` in place keeps the element (and the old bitmap until the new one has
// loaded), so a refresh neither re-renders the document nor moves the scroll
// position.
export function refreshImageRevisions(
  container: ParentNode,
  basePath: string,
  roots: readonly RootGroup[],
  revisionOf: (id: string) => string,
): void {
  for (const image of container.querySelectorAll<HTMLImageElement>("img[src]")) {
    const next = revisionedImageUrl(image.getAttribute("src") ?? "", image.baseURI, basePath, roots, revisionOf);
    if (next && next !== image.src) image.src = next;
  }
}
