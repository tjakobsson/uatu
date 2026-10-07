// Cache-busting for images shown in the preview. The static-file fallback
// serves an image at the same URL however often it changes on disk, and a
// browser reuses an image it has already decoded for that URL within the
// page — `cache-control: no-cache` does not stop it. So every <img> in the
// preview that resolves to a watched file carries the file's mtime as a `v`
// query parameter (the server matches on the path and ignores the query).
// When the watcher reports a new mtime, the URL changes and the browser
// fetches the new bytes; when it does not, the URL is stable and nothing is
// refetched. Images on other hosts, data URLs, and paths that are not
// watched files are left exactly as authored.

import { appBasePath } from "../shared/app-url";
import { stripBasePath } from "../shared/base-path";
import type { DocumentMeta, RootGroup } from "../shared/types";

const VERSION_PARAM = "v";

// `src` (absolute or relative) with its version parameter set to `mtimeMs`,
// replacing any earlier stamp. For a renderer that already knows the file's
// mtime, so its first request is the versioned one.
export function withImageVersion(src: string, mtimeMs: number): string {
  const hashIndex = src.indexOf("#");
  const hash = hashIndex === -1 ? "" : src.slice(hashIndex);
  const beforeHash = hashIndex === -1 ? src : src.slice(0, hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  const path = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? "" : beforeHash.slice(queryIndex + 1));
  params.set(VERSION_PARAM, String(mtimeMs));
  return `${path}?${params}${hash}`;
}

// The watched file an image `src` resolved against `baseUrl` points at, with
// its resolved URL, or null when it is not a watched file this session serves.
function resolveWatchedImage(
  src: string,
  baseUrl: string,
  basePath: string,
  roots: RootGroup[],
): { url: URL; doc: DocumentMeta } | null {
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
    if (doc) return { url, doc };
  }
  return null;
}

// The versioned absolute URL for an image `src` resolved against `baseUrl`,
// or null when the image is not a watched file this session serves.
export function versionedImageUrl(
  src: string,
  baseUrl: string,
  basePath: string,
  roots: RootGroup[],
): string | null {
  const resolved = resolveWatchedImage(src, baseUrl, basePath, roots);
  if (!resolved) return null;
  resolved.url.searchParams.set(VERSION_PARAM, String(resolved.doc.mtimeMs));
  return resolved.url.href;
}

// The id of the watched file an image `src` resolved against `baseUrl` shows,
// or null when it is not a watched file this session serves.
export function imageDocumentId(
  src: string,
  baseUrl: string,
  basePath: string,
  roots: RootGroup[],
): string | null {
  return resolveWatchedImage(src, baseUrl, basePath, roots)?.doc.id ?? null;
}

// Ids of the watched files the images under `container` show — the files
// whose change `refreshImageVersions` refreshes in place. Follow reads it to
// stay on a document whose own embedded image changed.
export function embeddedImageDocumentIds(container: ParentNode, roots: RootGroup[]): Set<string> {
  const basePath = appBasePath();
  const ids = new Set<string>();
  for (const image of container.querySelectorAll<HTMLImageElement>("img[src]")) {
    const id = imageDocumentId(image.getAttribute("src") ?? "", image.baseURI, basePath, roots);
    if (id) ids.add(id);
  }
  return ids;
}

// Re-stamps every image under `container` against the given roots. Cheap and
// idempotent: an image whose file has not changed keeps its URL and is not
// refetched, so this runs on every mount and every state update. Updating
// `src` in place keeps the element (and the old bitmap until the new one has
// loaded), so a refresh does not collapse layout or move the scroll position.
export function refreshImageVersions(container: ParentNode, roots: RootGroup[]): void {
  const basePath = appBasePath();
  for (const image of container.querySelectorAll<HTMLImageElement>("img[src]")) {
    const next = versionedImageUrl(image.getAttribute("src") ?? "", image.baseURI, basePath, roots);
    if (next && next !== image.src) image.src = next;
  }
}
