// Inline zoom and the fullscreen viewer for media in `#preview`: images in
// rendered documents, the standalone image file preview, and Mermaid diagrams
// as they render. The preview supplies what `src/zoom/` cannot know: the real
// source of an image (never the off-screen SVG placeholder), the link around
// it, and where focus returns.
//
// A linked image opens the viewer instead of following its link; the viewer's
// "Open link" calls the link's own `click()`, so `anchors.ts` and the browser
// apply their usual rules. Modifier clicks keep the browser's link behaviour.
//
// Zoom session: one presentation of one file, identified by (selected id, view
// mode, layout). Every mount path begins one (`beginPreviewZoom`), or ends the
// last (`releasePreviewZoom`) when it replaces the body with nothing zoomable.
// Selecting another file ends it at once (`discardPreviewZoom`), before that
// file has loaded; the old body stays on screen until then, but its media no
// longer opens the viewer. Re-rendering the
// same session (a watched-file edit) saves each media's zoom before the body is
// replaced (`savePreviewZoom`) and restores it once the new copy knows its
// size: an image on its first load of the real source, a diagram when it
// renders. An open viewer follows its media to the new copy, whether or not
// that copy is on screen: an image's real source as soon as it is known (the
// viewer loads it itself), a diagram rendered ahead of the lazy queue. When
// its media is gone it stays on what it shows, at fit, without a link. A
// different session closes the viewer and forgets all zoom. A theme change
// re-renders diagrams in place and keeps their zoom. Nothing here is persisted.

import { onMermaidDiagramRendered, setMermaidRenderPriority } from "../render/preview";
import {
  ACTIVATOR_CLASS,
  attachInlineZoom,
  createInlineFrame,
  createZoomCarry,
  FRAME_CLASS,
  inlineZoomOf,
  STAGE_CLASS,
  viewerFocusReturn,
  type InlineZoom,
} from "../zoom/inline";
import {
  describeImage,
  enclosingLink,
  imageIdentity,
  imageKind,
  isMermaidIdentity,
  mermaidIdentity,
  mermaidIdentityAt,
  occurrenceIdentities,
} from "../zoom/media";
import { openMediaViewer, type MediaViewerSession, type ViewerDescriptor } from "../zoom/viewer";
import { previewImageSource } from "./svg-images";

const carry = createZoomCarry();
// The viewer, while it shows preview media; its identity becomes null once
// that media can no longer be matched, so it never switches media on its own.
// Focus returns to the media's current copy: its activator, then its expand
// control when that opened the viewer (`viewerFocusReturn`).
let viewer: { session: MediaViewerSession; identity: string | null } | null = null;
// The last controller each diagram node had: a theme re-render replaces a
// diagram's frame inside the same node.
const diagramZoom = new WeakMap<HTMLElement, InlineZoom>();
// Each framed image's identity, assigned when its render mounts: what it is
// (see imageKey), and its occurrence among the images that share that.
const imageIdentities = new WeakMap<HTMLImageElement, string>();
// Images that have loaded their real source, and so hold the zoom carried to
// them. Until then (an off-screen SVG on its placeholder, a source still
// loading) an image's controller is at fit only because the carried zoom has
// not been applied, so it must not overwrite what is saved for it.
const settledImages = new WeakSet<HTMLImageElement>();
// Whether the media on screen belongs to the session being presented. It
// stops belonging when that session ends, while the body stays on screen
// until the next presentation replaces it (another file selected, still
// loading); its media then opens no viewer on content no longer selected.
// A mount makes it current again, as does adopting a body kept in place.
let shownIsCurrent = false;
// Media no longer current neither zooms nor opens the viewer.
const shownMediaIsCurrent = () => shownIsCurrent;

export function previewZoomSession(documentId: string, viewMode: string, layout: string): string {
  return JSON.stringify([documentId, viewMode, layout]);
}

// Begin presenting `session`. A session other than the one on screen closes
// the viewer and forgets all inline zoom.
export function beginPreviewZoom(session: string): void {
  if (!carry.begin(session)) dropShownZoom();
}

// End the session on screen while its body stays mounted: another file has
// been selected and is still loading. That media returns to fit and stops
// opening the viewer; an image file kept in place when it is selected again
// starts at fit (see adoptPreviewMedia).
export function discardPreviewZoom(): void {
  carry.clear();
  dropShownZoom();
}

// End the session on screen just before its body is replaced by content with
// no zoomable media (a binary notice, a commit, a diff, an empty state, a
// media player): its controllers are released along with the media.
export function releasePreviewZoom(): void {
  carry.clear();
  closePreviewViewer();
  shownIsCurrent = false;
  const root = previewRoot();
  if (root) disposeShownZoom(root);
}

// The body on screen is kept, not re-rendered, for the session just begun (an
// image file selected again before another file replaced it): its media is
// the current presentation's again.
export function adoptPreviewMedia(): void {
  shownIsCurrent = true;
}

function dropShownZoom(): void {
  closePreviewViewer();
  shownIsCurrent = false;
  const root = previewRoot();
  if (!root) return;
  for (const [, zoom] of previewMedia(root)) zoom?.fit();
}

// Call just before the preview body is replaced by a re-render. Every
// controller in it is then released: what it carries has been saved, and its
// observers would otherwise keep the replaced media alive (a frame watches
// its container, which can outlive the body).
export function savePreviewZoom(): void {
  const root = previewRoot();
  if (!root) return;
  carry.save(previewMedia(root));
  disposeShownZoom(root);
}

// Every controller of the body about to go: each frame's, and the last one a
// diagram had while it waits, frameless, to render again (a theme change).
function disposeShownZoom(root: HTMLElement): void {
  for (const frame of Array.from(root.querySelectorAll<HTMLElement>(`.${FRAME_CLASS}`))) inlineZoomOf(frame)?.dispose();
  for (const node of Array.from(root.querySelectorAll<HTMLElement>(".mermaid"))) diagramZoom.get(node)?.dispose();
}

// Attach inline zoom to every image in a freshly mounted container. Call it
// after `preparePreviewHtml` and `observePreviewSvgImages`. Styles are read for
// every image before any is wrapped, so the batch costs one style pass.
export function attachPreviewMediaZoom(container: ParentNode): void {
  shownIsCurrent = true;
  const candidates: ImageCandidate[] = [];
  for (const image of Array.from(container.querySelectorAll<HTMLImageElement>("img"))) {
    const activator = activatorFor(image);
    if (!activator) continue;
    // Computed styles are live: read the values now, before any wrapping.
    const { verticalAlign, float } = getComputedStyle(image);
    candidates.push({ image, activator, verticalAlign, float });
  }
  const loaded = candidates.map(attachImage);
  const root = previewRoot();
  if (!root) return;
  assignImageIdentities(root);
  const matched = carry.mounted(previewMedia(root).map(([identity]) => identity));
  if (viewer?.identity && !matched.has(viewer.identity)) {
    viewer.identity = null;
    viewer.session.orphan();
  }
  syncPreviewViewer();
  // Images already loaded (from the cache) get no load event to wait for.
  for (const onLoad of loaded) onLoad();
}

// Point an open viewer on a preview image at that image's current copy: its
// real source and its link. Call whenever image sources may have changed (a
// mount, a revision refreshed in place). Off-screen images hold a placeholder
// and never load, so the viewer cannot wait for the inline copy to. A
// responsive image is the exception: until the browser has picked its source
// the only one known is the fallback it may never show, so its load syncs the
// viewer instead (see attachImage).
export function syncPreviewViewer(): void {
  const root = previewRoot();
  const identity = viewer?.identity;
  if (!root || !identity || !viewer?.session.isOpen()) return;
  const image = framedImages(root).find(candidate => identityOf(candidate) === identity);
  const frame = image?.closest<HTMLElement>(`.${FRAME_CLASS}`);
  const activator = frame && activatorOf(frame);
  if (!image || !frame || !activator || (pictureOf(image) && !image.currentSrc)) return;
  viewer.session.replace(imageDescriptor(image, frame), { returnFocusTo: activator });
}

export function initPreviewMediaZoom(): void {
  onMermaidDiagramRendered(attachDiagram);
  // The diagram an open viewer shows renders without waiting to come near the
  // viewport, so the viewer gets its re-render even when an edit moved it away.
  setMermaidRenderPriority(node => {
    const root = previewRoot();
    const identity = viewer?.identity;
    return Boolean(identity && isMermaidIdentity(identity) && viewer?.session.isOpen() && root?.contains(node) && mermaidIdentity(node, root) === identity);
  });
}

function previewRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#preview");
}

function framedImages(root: HTMLElement): HTMLImageElement[] {
  return Array.from(root.querySelectorAll<HTMLImageElement>(`.${FRAME_CLASS} img.${STAGE_CLASS}`));
}

// What an image is, for matching it across re-renders: its source (media.ts)
// and the link it opens. A responsive image is everything that picks what it
// shows (each <source>'s `srcset`, descriptors included, and `media`, as
// authored; sanitizing keeps no other) and its fallback, because the one the
// browser picks is known only once it loads, after its zoom has to be
// matched: an edit to any of them makes it another image.
function imageKey(image: HTMLImageElement): string {
  const picture = pictureOf(image);
  const candidates = picture
    ? Array.from(picture.querySelectorAll(":scope > source"), source => [source.getAttribute("srcset") ?? "", source.getAttribute("media") ?? ""])
    : [];
  const link = enclosingLink(picture ?? image)?.href ?? null;
  return JSON.stringify([imageIdentity(previewImageSource(image), image.baseURI), candidates, link]);
}

// Copies of one image (the same source behind the same link) are told apart
// by their order among those copies alone: removing another image, or a copy
// with another link, shifts nothing.
function assignImageIdentities(root: HTMLElement): void {
  const images = framedImages(root);
  occurrenceIdentities(images.map(imageKey)).forEach((identity, index) => imageIdentities.set(images[index]!, identity));
}

function identityOf(image: HTMLImageElement): string {
  return imageIdentities.get(image) ?? occurrenceIdentities([imageKey(image)])[0]!;
}

// Every zoomable media in the preview, by identity, with its controller:
// diagrams in document order, then framed images (null until they have
// loaded their real source). A diagram waiting to render again in place (a
// theme change queued it, and it is far from the viewport) has no frame but
// still has the zoom its last frame held; one never rendered is null.
function previewMedia(root: HTMLElement): [string, InlineZoom | null][] {
  const media: [string, InlineZoom | null][] = [];
  root.querySelectorAll<HTMLElement>(".mermaid").forEach((node, index) => {
    const frame = node.querySelector<HTMLElement>(`:scope > .${FRAME_CLASS}`);
    media.push([mermaidIdentityAt(index), frame ? inlineZoomOf(frame) : diagramZoom.get(node) ?? null]);
  });
  for (const image of framedImages(root)) {
    const frame = image.closest<HTMLElement>(`.${FRAME_CLASS}`);
    media.push([identityOf(image), frame && settledImages.has(image) ? inlineZoomOf(frame) : null]);
  }
  return media;
}

// Focus returns to the activator of the media's current copy (re-renders
// update it through `replace`), then to expand when that opened the viewer.
function openPreviewViewer(descriptor: ViewerDescriptor, identity: string, opener: HTMLElement): void {
  if (!shownIsCurrent) return;
  const focus = viewerFocusReturn(opener);
  const session = openMediaViewer(descriptor, {
    returnFocusTo: focus.returnFocusTo,
    afterClose: () => {
      if (viewer?.session === session) viewer = null;
      focus.afterReturn();
    },
  });
  viewer = { session, identity };
}

function activatorOf(frame: HTMLElement): HTMLElement | null {
  return frame.querySelector<HTMLElement>(`:scope > .${ACTIVATOR_CLASS}`);
}

function closePreviewViewer(): void {
  viewer?.session.close();
  viewer = null;
}

// The image's link when the image is all it holds, else the image itself;
// null when the image is not zoomable here. A responsive image is its whole
// <picture>, which needs its <img> as a direct child to pick a source: the
// <picture> is framed, and activates, in the image's place.
function activatorFor(image: HTMLImageElement): HTMLElement | null {
  if (image.closest(`.${FRAME_CLASS}`)) return null;
  const media = pictureOf(image) ?? image;
  const link = enclosingLink(media);
  if (!link) return media;
  // A link that holds more than the image stays a plain link: framing the
  // image inside it would nest a control in a link.
  return isOnlyContent(link, media) ? link : null;
}

function pictureOf(image: HTMLImageElement): HTMLElement | null {
  const parent = image.parentElement;
  return parent?.tagName === "PICTURE" ? parent : null;
}

// The source an image shows: in a <picture>, the <source> the browser picked
// once it differs from the image's own `src`; otherwise, and until then, the
// image's real source (never the off-screen SVG placeholder).
function shownSource(image: HTMLImageElement): string {
  if (pictureOf(image) && image.currentSrc && image.currentSrc !== image.src) return image.currentSrc;
  return previewImageSource(image);
}

// An image to frame, with the layout it had before it was wrapped.
type ImageCandidate = { image: HTMLImageElement; activator: HTMLElement; verticalAlign: string; float: string };

// Frame one image and wire its zoom; returns its load handler.
function attachImage({ image, activator, verticalAlign, float }: ImageCandidate): () => void {
  const frame = createInlineFrame(activator, image);
  // The frame takes the image's place in the line, so it takes its alignment.
  frame.style.verticalAlign = verticalAlign;
  if (float !== "none") {
    frame.style.float = float;
    image.style.float = "none";
  }
  const identity = () => identityOf(image);
  const zoom = attachInlineZoom(frame, {
    // Read when needed: a <picture> picks its source only as it loads.
    get kind() {
      return imageKind(shownSource(image), image.baseURI);
    },
    open: opener => openPreviewViewer(imageDescriptor(image, frame), identity(), opener),
    active: shownMediaIsCurrent,
  });

  // Each load of the real source (not the off-screen SVG placeholder) is a new
  // copy of the media: a re-render's first load takes the saved zoom, and a
  // source swapped in place keeps the zoom it has. Only while this image is
  // still the one on screen. (An open viewer follows through
  // `syncPreviewViewer`, which waits for a load only for a responsive image.)
  const loaded = () => {
    if (!image.isConnected || image.naturalWidth === 0) return;
    // The browser picked the fallback, and that holds the placeholder. A
    // <source> it picked is real even while the fallback holds one.
    if (image.currentSrc === image.src && image.getAttribute("src") !== previewImageSource(image)) return;
    settledImages.add(image);
    if (!carry.restore(identity(), zoom)) zoom.refit();
    // A responsive image's source is known now (see syncPreviewViewer).
    if (pictureOf(image) && viewer?.identity === identity()) syncPreviewViewer();
  };
  image.addEventListener("load", loaded);
  return () => {
    if (image.complete) loaded();
  };
}

function imageDescriptor(image: HTMLImageElement, frame: HTMLElement): ViewerDescriptor {
  const rect = frame.getBoundingClientRect();
  const media = describeImage(image, shownSource(image), image.baseURI, { width: rect.width, height: rect.height });
  return {
    kind: media.kind === "svg-image" ? "svg-image" : "raster",
    src: media.source ?? "",
    alt: image.alt,
    fallbackSize: { width: rect.width, height: rect.height },
    link: media.link,
  };
}

function attachDiagram(node: HTMLElement): void {
  const frame = node.querySelector<HTMLElement>(`:scope > .${FRAME_CLASS}`);
  const trigger = frame?.querySelector<HTMLButtonElement>(":scope > button.mermaid-trigger");
  const svg = trigger?.querySelector<SVGElement>(":scope > svg");
  const root = previewRoot();
  if (!frame || !trigger || !svg || !root?.contains(node)) return;
  const identity = mermaidIdentity(node, root);
  const zoom = attachInlineZoom(frame, {
    kind: "mermaid",
    open: opener => openPreviewViewer({ kind: "mermaid", svg }, mermaidIdentity(node, root), opener),
    active: shownMediaIsCurrent,
  });
  // The same node rendered again (a theme change) keeps the zoom its last
  // frame had, and lets that frame go; a new node takes what the re-render
  // saved.
  const replaced = diagramZoom.get(node);
  const previous = replaced === zoom ? null : replaced?.snapshot();
  if (replaced !== zoom) replaced?.dispose();
  diagramZoom.set(node, zoom);
  if (previous) zoom.restore(previous);
  else carry.restore(identity, zoom);
  if (viewer?.identity === identity) viewer.session.replace({ kind: "mermaid", svg }, { returnFocusTo: trigger });
}

function isOnlyContent(link: HTMLAnchorElement, media: HTMLElement): boolean {
  return Array.from(link.childNodes).every(
    node => node === media || (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()),
  );
}
