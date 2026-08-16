import { appState, MAIN_SURFACE_KEY, safeLocalStorage, type MainSurface } from "../shell/state";
import { onUiModeChange, uiMode } from "../shell/ui-mode";

// Set once the switch is mounted, so every surface change — a segment click,
// a touch tab, a find-bar reveal — repaints the control's selected state.
let syncSegments: (() => void) | null = null;

export function setMainSurface(surface: MainSurface): void {
  appState.mainSurface = surface;
  document.documentElement.setAttribute("data-main-surface", surface);
  try { safeLocalStorage()?.setItem(MAIN_SURFACE_KEY, surface); } catch { /* storage is best effort */ }
  syncSegments?.();
}

export function initMainSurfaceSwitch(): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-main-surface]"));
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
