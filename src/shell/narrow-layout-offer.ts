// A desktop-layout window narrowed to phone width while a preview is open
// (a resized browser, a split screen): the stacked layout puts the sidebar
// above the preview, so what was being read ends up a screen or more down.
// The window keeps the preview in view (its top scrolled to the viewport's)
// and offers touch layout with one small, non-blocking bar: "Switch to touch
// layout?" with Switch and Not now. An explicit desktop choice (the layout
// toggle) is respected: no offer then. Not now holds for the page.

import { appState } from "./state";
import { presentationLocalStorage } from "./presentation-storage";
import { onUiModeChange, readUiModeOverride, setUiMode, uiMode } from "./ui-mode";

// Phone width: the same breakpoint as styles.css's `(max-width: 640px)`.
export const NARROW_QUERY = "(max-width: 640px)";

export function shouldOfferTouchLayout(input: {
  mode: "touch" | "desktop";
  override: "touch" | "desktop" | null;
  narrow: boolean;
  previewShown: boolean;
  dismissed: boolean;
}): boolean {
  return input.mode === "desktop" && input.override !== "desktop" && input.narrow && input.previewShown && !input.dismissed;
}

let dismissed = false;
let bar: HTMLElement | null = null;

const previewShown = () => appState.previewMode.kind !== "empty" && !document.querySelector(".preview")?.classList.contains("empty");

function hideOffer(): void {
  bar?.remove();
  bar = null;
}

function showOffer(): void {
  if (bar?.isConnected) return;
  bar = document.createElement("div");
  bar.className = "layout-offer";
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", "Layout suggestion");
  bar.innerHTML = `<span class="layout-offer-text">Narrow window: switch to touch layout?</span>
    <button type="button" class="layout-offer-switch" data-layout-offer-switch>Switch</button>
    <button type="button" class="layout-offer-dismiss" data-layout-offer-dismiss>Not now</button>`;
  bar.querySelector("[data-layout-offer-switch]")!.addEventListener("click", () => {
    hideOffer();
    setUiMode("touch");
  });
  bar.querySelector("[data-layout-offer-dismiss]")!.addEventListener("click", () => {
    dismissed = true;
    hideOffer();
  });
  document.body.append(bar);
}

// The preview's top to the viewport's top, as opening a preview in the
// stacked layout does.
function keepPreviewInView(): void {
  const shell = document.querySelector<HTMLElement>(".preview-shell");
  if (!shell) return;
  const top = shell.getBoundingClientRect().top;
  if (top <= window.innerHeight / 2) return;
  const root = document.scrollingElement ?? document.documentElement;
  root.scrollTop += top;
}

export function initNarrowLayoutOffer(): void {
  if (typeof matchMedia !== "function") return;
  const narrow = matchMedia(NARROW_QUERY);
  const sync = (entered: boolean) => {
    const offer = shouldOfferTouchLayout({
      mode: uiMode(),
      override: readUiModeOverride(presentationLocalStorage()),
      narrow: narrow.matches,
      previewShown: previewShown(),
      dismissed,
    });
    if (!offer) { hideOffer(); return; }
    // Only on the way into phone width: a page loaded narrow is laid out
    // for it from the start.
    if (!entered) return;
    requestAnimationFrame(() => requestAnimationFrame(keepPreviewInView));
    showOffer();
  };
  narrow.addEventListener("change", event => sync(event.matches));
  onUiModeChange(() => sync(false));
}
