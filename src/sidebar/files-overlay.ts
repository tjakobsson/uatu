// Phone-class file browser: promotes the Files pane to a full-viewport
// overlay (CSS geometry keyed off `data-overlay="open"`, see styles.css).
// It is the SAME pane DOM — tree expansion, selection, filter chip, and
// follow-mode highlighting are continuous — so there is no second tree to
// keep in sync. Picking a document (the follow-mode Rule A user-click path,
// via tree-mount's selection handler) dismisses the overlay and brings the
// preview into view; directory taps and programmatic tree updates leave it
// open because they never travel through that handler.

import { isPhoneClassViewport } from "../terminal/pane-state";

const filesPane = document.querySelector<HTMLElement>('[data-pane-id="files"]');
const openButton = document.getElementById("files-browse-open");
const closeButton = document.getElementById("files-browse-close");

function phoneClassNow(): boolean {
  const coarse =
    typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return isPhoneClassViewport(coarse, window.innerWidth);
}

export function isFilesOverlayOpen(): boolean {
  return filesPane?.dataset.overlay === "open";
}

function openFilesOverlay(): void {
  if (!filesPane || !phoneClassNow()) return;
  filesPane.dataset.overlay = "open";
}

export function closeFilesOverlay(): void {
  if (!filesPane) return;
  delete filesPane.dataset.overlay;
}

// Called from the tree's user-click selection path (Rule A). Programmatic
// selections (follow Rules C/D, file events) never reach that path, so they
// can never yank the browser shut mid-use.
export function dismissFilesOverlayAfterPick(): void {
  if (!isFilesOverlayOpen()) return;
  closeFilesOverlay();
  // The stacked layout scrolls the page; land the user on the document they
  // just picked instead of wherever the Files pane happened to sit.
  document.getElementById("preview")?.scrollIntoView({ block: "start" });
}

export function initFilesOverlay(): void {
  if (!filesPane) return;
  openButton?.addEventListener("click", openFilesOverlay);
  closeButton?.addEventListener("click", closeFilesOverlay);

  // Tapping the pane header's inert surface (not its buttons/controls) also
  // opens the browser — a bigger target than the Browse button alone.
  filesPane.querySelector<HTMLElement>(".pane-header")?.addEventListener("click", event => {
    if (isFilesOverlayOpen() || !phoneClassNow()) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, select, input, [role='radiogroup']")) return;
    openFilesOverlay();
  });

  // Leaving phone-class (rotation, resize) demotes the overlay — the
  // stacked/desktop layouts must never render a fixed full-viewport pane.
  window.addEventListener("resize", () => {
    if (isFilesOverlayOpen() && !phoneClassNow()) closeFilesOverlay();
  });
}
