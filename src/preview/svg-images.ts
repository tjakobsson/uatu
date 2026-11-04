// An SVG loaded through <img> has its own animation timeline. CSS hiding and
// native lazy loading do not release an already loaded image. Keep the real
// source only while it intersects the viewport and the page is visible.
type SvgImage = {
  source: string;
  dimensionsKey: string;
  placeholder: string;
  intersecting: boolean;
  active: boolean;
};

const images = new WeakMap<HTMLImageElement, SvgImage>();
// Dimensions outlive individual elements so a live document remount does not
// collapse off-screen SVGs and clamp the reader's scroll position. Revisions
// share the previous size until the replacement loads its own dimensions.
const knownDimensions = new Map<string, { width: number; height: number }>();
const MAX_KNOWN_DIMENSIONS = 256;
let stopObserving: (() => void) | null = null;

function placeholder(width: number, height: number): string {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`)}`;
}

function isSvgSource(source: string): boolean {
  if (/^data:image\/svg\+xml[;,]/i.test(source)) return true;
  try {
    return new URL(source, document.baseURI).pathname.toLowerCase().endsWith(".svg");
  } catch {
    return false;
  }
}

function dimensionsKey(source: string): string {
  const url = new URL(source, document.baseURI);
  url.searchParams.delete("revision");
  return url.href;
}

// Parse before mounting. Even a detached div with innerHTML fetches images;
// a template is inert, so off-screen SVGs never acquire a live source first.
export function preparePreviewHtml(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  if (typeof IntersectionObserver === "function") {
    for (const image of template.content.querySelectorAll<HTMLImageElement>("img[src]")) {
      const source = image.getAttribute("src")!;
      if (!isSvgSource(source)) continue;
      const key = dimensionsKey(source);
      const size = knownDimensions.get(key) ?? { width: 300, height: 150 };
      const state: SvgImage = { source, dimensionsKey: key, placeholder: placeholder(size.width, size.height), intersecting: false, active: false };
      images.set(image, state);
      image.addEventListener("load", () => {
        if (state.active) rememberDimensions(image, state);
      });
      image.src = state.placeholder;
    }
  }
  return template.content;
}

export function previewImageSource(image: HTMLImageElement): string {
  return images.get(image)?.source ?? image.getAttribute("src") ?? "";
}

// Revision changes must update the saved source without reactivating a hidden
// image. Visible images still refresh in place and keep the old bitmap until
// the replacement has loaded.
export function setPreviewImageSource(image: HTMLImageElement, source: string): void {
  const state = images.get(image);
  if (!state) {
    if (image.src !== source) image.src = source;
    return;
  }
  if (state.source === source) return;
  state.source = source;
  if (state.active) {
    rememberDimensions(image, state);
    image.src = source;
  }
}

function rememberDimensions(image: HTMLImageElement, state: SvgImage): void {
  // Preserve intrinsic dimensions without changing authored width, height or
  // styles. A static, empty SVG has no animation work and keeps scroll stable.
  if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
    state.placeholder = placeholder(image.naturalWidth, image.naturalHeight);
    knownDimensions.delete(state.dimensionsKey);
    knownDimensions.set(state.dimensionsKey, { width: image.naturalWidth, height: image.naturalHeight });
    if (knownDimensions.size > MAX_KNOWN_DIMENSIONS) {
      knownDimensions.delete(knownDimensions.keys().next().value!);
    }
  }
}

function suspend(image: HTMLImageElement, state: SvgImage): void {
  if (!state.active) return;
  rememberDimensions(image, state);
  state.active = false;
  image.src = state.placeholder;
}

export function observePreviewSvgImages(container: HTMLElement): void {
  stopObserving?.();
  stopObserving = null;
  const tracked = new Set([...container.querySelectorAll<HTMLImageElement>("img")].filter(image => images.has(image)));
  if (tracked.size === 0) return;
  let pageActive = true;
  const sync = (image: HTMLImageElement): void => {
    const state = images.get(image)!;
    const active = pageActive && !document.hidden && state.intersecting && container.contains(image);
    if (!active) {
      suspend(image, state);
    } else if (!state.active) {
      state.active = true;
      image.src = state.source;
    }
  };
  const syncAll = (): void => { for (const image of tracked) sync(image); };
  // The implicit viewport also clips against every overflow ancestor, so this
  // works for the shell, split panes and page scrolling without rebinding roots.
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const image = entry.target as HTMLImageElement;
      if (!tracked.has(image)) continue;
      // At threshold zero, an edge-touching image is already intersecting.
      // Moving farther inside need not notify again, so accept that first hit.
      images.get(image)!.intersecting = entry.isIntersecting;
      sync(image);
    }
  });
  const onHide = (): void => { pageActive = false; syncAll(); };
  const onShow = (): void => { pageActive = true; syncAll(); };
  const stop = (): void => {
    observer.disconnect();
    mutations.disconnect();
    document.removeEventListener("visibilitychange", syncAll);
    window.removeEventListener("pagehide", onHide);
    window.removeEventListener("pageshow", onShow);
    for (const image of tracked) suspend(image, images.get(image)!);
    tracked.clear();
    if (stopObserving === stop) stopObserving = null;
  };
  // Other preview types replace the body themselves. Release removed images
  // promptly, including ones already off screen that get no new intersection.
  const mutations = new MutationObserver(() => {
    for (const image of tracked) {
      if (container.contains(image)) continue;
      suspend(image, images.get(image)!);
      observer.unobserve(image);
      tracked.delete(image);
    }
    if (tracked.size === 0) stop();
  });
  mutations.observe(container, { childList: true, subtree: true });
  document.addEventListener("visibilitychange", syncAll);
  window.addEventListener("pagehide", onHide);
  window.addEventListener("pageshow", onShow);
  for (const image of tracked) observer.observe(image);
  stopObserving = stop;
}
