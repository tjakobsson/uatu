import { appBasePath } from "../shared/app-url";

export type NavigationPreferences = {
  side: "left" | "right";
  position: number;
  autoHide: boolean;
  previewSide: "left" | "right";
};

/** Fresh/reset placement only. At390×844 the existing clamped-travel mapping
 * places the40px visual face at≈588px. Stored ratios keep their old meaning. */
// Express the ratio through its native range percentage so Reset's percentage
// round trip and Home produce the same IEEE-754 value, not adjacent doubles.
export const DEFAULT_NAVIGATION_PLACEMENT = Object.freeze({ side: "left" as const, position: 73.73 / 100 });
const defaults: NavigationPreferences = { ...DEFAULT_NAVIGATION_PLACEMENT, autoHide: true, previewSide: "left" };
const listeners = new Set<(preferences: NavigationPreferences) => void>();
let hubScope = false;
let preferences: NavigationPreferences | undefined;
let listening = false;

function storageKey(): string {
  return hubScope ? "uatu:navigation:v1:hub" : `uatu:presentation:v1:${encodeURIComponent(appBasePath())}:navigation`;
}

function validated(value: unknown, fallback = defaults): NavigationPreferences {
  const input = value && typeof value === "object" ? value as Partial<NavigationPreferences> : {};
  return {
    side: input.side === "left" || input.side === "right" ? input.side : fallback.side,
    position: typeof input.position === "number" && Number.isFinite(input.position)
      ? Math.max(0, Math.min(1, input.position)) : fallback.position,
    autoHide: typeof input.autoHide === "boolean" ? input.autoHide : fallback.autoHide,
    previewSide: input.previewSide === "left" || input.previewSide === "right" ? input.previewSide : fallback.previewSide,
  };
}

function read(): NavigationPreferences {
  try { return validated(JSON.parse(window.localStorage.getItem(storageKey()) ?? "null")); }
  catch { return { ...defaults }; }
}

function notify(): void {
  for (const listener of listeners) listener(getNavigationPreferences());
}

export function getNavigationPreferences(): NavigationPreferences {
  preferences ??= read();
  if (!listening && typeof window !== "undefined") {
    listening = true;
    window.addEventListener("storage", event => {
      if (event.key !== null && event.key !== storageKey()) return;
      try { if (event.storageArea && event.storageArea !== window.localStorage) return; } catch { return; }
      preferences = read();
      notify();
    });
  }
  return { ...preferences };
}

export function setNavigationPreferences(partial: Partial<NavigationPreferences>): void {
  preferences = validated(partial, getNavigationPreferences());
  try { window.localStorage.setItem(storageKey(), JSON.stringify(preferences)); } catch { /* In-memory preferences remain usable. */ }
  notify();
}

export function onNavigationPreferencesChange(listener: (preferences: NavigationPreferences) => void): () => void {
  getNavigationPreferences();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Only the authenticated Hub owner may promote the default workspace scope. */
export function confirmNavigationHubScope(): void {
  if (hubScope) return;
  hubScope = true;
  preferences = read();
  notify();
}
