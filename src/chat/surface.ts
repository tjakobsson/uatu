import { appState, MAIN_SURFACE_KEY, safeLocalStorage, type MainSurface } from "../shell/state";
import { onUiModeChange, uiMode } from "../shell/ui-mode";

// Set once the switch is mounted, so every surface change — a segment click,
// a touch tab, a find-bar reveal — repaints the control's selected state.
let syncSegments: (() => void) | null = null;

// Subscribers to committed main-surface changes. Registered as a callback
// (rather than importing consumers here) because the natural consumer —
// active-surface tracking — reaches this module only through a cycle.
const surfaceListeners = new Set<(surface: MainSurface) => void>();

export function onMainSurfaceChange(listener: (surface: MainSurface) => void): void {
  surfaceListeners.add(listener);
}

export function setMainSurface(surface: MainSurface): void {
  appState.mainSurface = surface;
  document.documentElement.setAttribute("data-main-surface", surface);
  try { safeLocalStorage()?.setItem(MAIN_SURFACE_KEY, surface); } catch { /* storage is best effort */ }
  syncSegments?.();
  for (const listener of surfaceListeners) listener(surface);
}

export function initMainSurfaceSwitch(): void {
  // Scoped to buttons: <html> carries data-main-surface as the layout
  // attribute, and the bare selector used to catch it — registering the whole
  // page as a segment whose bubbled clicks re-asserted the current surface.
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-main-surface]"));
  const sync = () => {
    document.documentElement.setAttribute("data-main-surface", appState.mainSurface);
    for (const button of buttons) {
      const active = button.dataset.mainSurface === appState.mainSurface;
      button.setAttribute("aria-checked", String(active));
      button.classList.toggle("is-active", active);
    }
  };
  syncSegments = sync;
  for (const button of buttons) button.addEventListener("click", () => {
    const surface = button.dataset.mainSurface;
    if (surface === "preview" || surface === "chat") setMainSurface(surface);
  });
  onUiModeChange(() => {
    if (uiMode() === "touch" && (appState.activeTab === "preview" || appState.activeTab === "chat")) {
      setMainSurface(appState.activeTab);
    }
    sync();
  });
  sync();
}
