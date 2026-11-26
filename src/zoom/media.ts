// The media descriptor: what the zoom code needs to know about one piece of
// zoomable media, computed from what the surface supplies (the real source,
// which the surface knows and this folder does not, and the media's box).
//
// Identity is what survives a re-render: an image is the resolved URL without
// its `revision` parameter, so two revisions of one file are the same media
// (a surface showing copies of one image tells them apart with
// `occurrenceIdentities`); a Mermaid diagram is its position among the
// document's diagrams.

import type { Size } from "./transform";

export type MediaKind = "raster" | "svg-image" | "mermaid";

export type MediaDescriptor = {
  kind: MediaKind;
  // The resolved real source of an image; null for a diagram.
  source: string | null;
  identity: string;
  link: HTMLAnchorElement | null;
  // Width over height, or null while the size is unknown.
  aspectRatio: number | null;
};

// Media with either rendered side below this many CSS px (badges, icons,
// thumbnails) gets no inline zoom; activating it opens the viewer.
export const SMALL_MEDIA_PX = 96;

export function isSmallMedia(size: Size): boolean {
  return size.width < SMALL_MEDIA_PX || size.height < SMALL_MEDIA_PX;
}

// The resolved URL with `revision` removed. Every other parameter, and any
// `#` or `?` encoded into the file name, is kept. A source that is no URL at
// all is its own identity.
export function imageIdentity(source: string, base: string): string {
  try {
    const url = new URL(source, base);
    url.searchParams.delete("revision");
    return url.href;
  } catch {
    return source;
  }
}

export function isSvgSource(source: string, base: string): boolean {
  if (/^data:image\/svg\+xml[;,]/i.test(source)) return true;
  try {
    return filePath(new URL(source, base)).toLowerCase().endsWith(".svg");
  } catch {
    return false;
  }
}

// A URL's path as the server reads it, decoded (`figure%2Esvg` is served as
// `figure.svg`); a malformed encoding is read as written.
function filePath(url: URL): string {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return url.pathname;
  }
}

// Raster formats a browser shows in an <img>, by file extension and by
// `data:` MIME subtype.
const RASTER_EXTENSION = /\.(apng|avif|bmp|gif|ico|jpe?g|png|webp)$/i;
const RASTER_DATA = /^data:image\/(apng|avif|bmp|gif|x-icon|vnd\.microsoft\.icon|jpeg|png|webp)[;,]/i;

// How zoom treats an image: "raster" gets 1:1 actual pixels and pixelated
// enlargement, "svg-image" is vector (smooth scaling, no 1:1). SVG is vector
// wherever it comes from. A workspace file (same origin) is served with the
// type its extension gives it, so anything not SVG is raster. A cross-origin
// image is raster only when its URL names a raster format: otherwise (a
// shields.io badge, a GitHub attachment) its format cannot be told, since a
// cross-origin response's type is not readable, and it is treated as vector,
// so no raster-only action is offered for what may be an SVG.
export function imageKind(source: string, base: string): "raster" | "svg-image" {
  if (isSvgSource(source, base)) return "svg-image";
  if (RASTER_DATA.test(source)) return "raster";
  try {
    const url = new URL(source, base);
    if (url.protocol === "data:") return "svg-image";
    if (url.origin === new URL(base).origin) return "raster";
    return RASTER_EXTENSION.test(filePath(url)) ? "raster" : "svg-image";
  } catch {
    return "svg-image";
  }
}

export function enclosingLink(element: Element): HTMLAnchorElement | null {
  return element.closest<HTMLAnchorElement>("a[href]");
}

const MERMAID_PREFIX = "mermaid:";

export function mermaidIdentity(node: Element, root: ParentNode): string {
  return mermaidIdentityAt(Array.from(root.querySelectorAll(".mermaid")).indexOf(node));
}

// The identity of the diagram at `index` in document order, for a surface
// that walks every diagram (one query, not one per diagram).
export function mermaidIdentityAt(index: number): string {
  return `${MERMAID_PREFIX}${index}`;
}

// Identities for media in document order, each given by a key that says
// what it is (an image's source and link): copies sharing a key are told
// apart by their order among that key's copies alone, so removing media
// under another key shifts no identity. As JSON, never a diagram's form.
export function occurrenceIdentities(keys: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return keys.map(key => {
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return JSON.stringify([key, occurrence]);
  });
}

// Diagrams are identified by position, which only holds while their number
// does; image identities (occurrenceIdentities) never take this form.
export function isMermaidIdentity(identity: string): boolean {
  return identity.startsWith(MERMAID_PREFIX);
}

// Re-rendered media keeps its zoom only while its shape holds: two aspect
// ratios this close, relatively, are the same.
export const ASPECT_TOLERANCE = 0.01;

export function sameAspectRatio(a: Size, b: Size): boolean {
  const ra = aspectRatio(a);
  const rb = aspectRatio(b);
  return ra !== null && rb !== null && Math.abs(ra - rb) <= ASPECT_TOLERANCE * rb;
}

export function describeImage(image: HTMLImageElement, source: string, base: string, size: Size): MediaDescriptor {
  return {
    kind: imageKind(source, base),
    source: new URL(source, base).href,
    identity: imageIdentity(source, base),
    link: enclosingLink(image),
    aspectRatio: aspectRatio(size),
  };
}

// An image's intrinsic size once it has loaded; null before that, and for an
// image that reports none (an SVG with only a viewBox).
export function naturalSize(image: HTMLImageElement): Size | null {
  return image.naturalWidth > 0 && image.naturalHeight > 0 ? { width: image.naturalWidth, height: image.naturalHeight } : null;
}

function aspectRatio(size: Size): number | null {
  return size.width > 0 && size.height > 0 ? size.width / size.height : null;
}

// Whether raster pixels each cover more than one device pixel: the image is
// shown `displayedWidth` CSS px wide, at `deviceScale` device pixels per CSS
// px (see `devicePixelScale`). The viewer and inline zoom both ask this, only
// once the reader has zoomed in past fit, to render sharp blocks; at fit, and
// below native size, the browser's smoothing stays.
export function rasterEnlarged(naturalWidth: number, displayedWidth: number, deviceScale: number): boolean {
  return naturalWidth > 0 && displayedWidth * deviceScale > naturalWidth + 0.5;
}

// Device pixels per CSS pixel as drawn on screen: the device pixel ratio
// (which browser zoom changes) times the page's pinch zoom (which it does
// not). Actual pixels and the pixelation threshold are measured against it.
export function devicePixelScale(view: { devicePixelRatio?: number; visualViewport?: { scale: number } | null } | null | undefined): number {
  const positive = (value: number | undefined) => (value !== undefined && Number.isFinite(value) && value > 0 ? value : 1);
  return positive(view?.devicePixelRatio) * positive(view?.visualViewport?.scale);
}
