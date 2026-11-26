// Zoom levels for readers who cannot see them change: a polite status region
// that says the level a control or a key set. Gestures move through levels
// frame by frame, so they announce nothing.
//
// A level is relative to fit: 100% is the media fitted to its box, inline and
// in the viewer alike, since fit is where every zoom starts and returns to.

export function zoomLevelLabel(scaleOverFit: number): string {
  return `${Math.round(scaleOverFit * 100)}%`;
}

export function createZoomStatus(document: Document, className: string): HTMLElement {
  const region = document.createElement("div");
  region.className = `${className} media-zoom-visually-hidden`;
  region.setAttribute("role", "status");
  region.setAttribute("aria-live", "polite");
  region.setAttribute("aria-atomic", "true");
  return region;
}

export function announceZoom(region: HTMLElement, scaleOverFit: number): void {
  region.textContent = `Zoom ${zoomLevelLabel(scaleOverFit)}`;
}
