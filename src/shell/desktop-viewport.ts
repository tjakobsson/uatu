import { createVisualViewportSizer, type VisualViewportLike } from "../shared/visual-viewport";
import { onUiModeChange, uiMode, type UiMode } from "./ui-mode";

export type SafeAreaInsets = { top: number; right: number; bottom: number; left: number };
export type LayoutSize = { width: number; height: number };
export type DesktopVisualViewport = VisualViewportLike & Partial<Pick<VisualViewport, "width" | "offsetLeft" | "scale">>;
export type DesktopViewportGeometry = LayoutSize & {
  top: number; left: number; safe: SafeAreaInsets; occluded: boolean;
};

// Insets describe the layout viewport's unsafe edges. A keyboard or viewport
// pan can already exclude an edge; only its remaining overlap needs padding.
// Pinch zoom is browser-owned: retain the last normal-scale layout, rather
// than reflowing the workspace to the magnified viewport on every pan.
export function desktopViewportGeometry(
  viewport: Pick<DesktopVisualViewport, "height" | "offsetTop" | "width" | "offsetLeft" | "scale"> | null,
  layout: LayoutSize,
  safe: SafeAreaInsets,
): DesktopViewportGeometry | null {
  if (viewport && Math.abs((viewport.scale ?? 1) - 1) > 0.01) return null;
  const top = Math.max(0, viewport?.offsetTop ?? 0);
  const left = Math.max(0, viewport?.offsetLeft ?? 0);
  const width = Math.max(0, viewport?.width ?? layout.width);
  const height = Math.max(0, viewport?.height ?? layout.height);
  const rightGap = Math.max(0, layout.width - left - width);
  const bottomGap = Math.max(0, layout.height - top - height);
  return {
    top, left, width, height,
    safe: {
      top: Math.max(0, safe.top - top), left: Math.max(0, safe.left - left),
      right: Math.max(0, safe.right - rightGap), bottom: Math.max(0, safe.bottom - bottomGap),
    },
    // This drives temporary dock sizing, not permission to resize the shell.
    // Even a one-row hardware-keyboard accessory must fit the measured box.
    occluded: layout.height - height > 1,
  };
}

type StyleTarget = { style: Pick<CSSStyleDeclaration, "getPropertyValue" | "setProperty" | "removeProperty">; toggleAttribute(name: string, force?: boolean): boolean };
const PROPERTIES = ["top", "left", "width", "height", "safe-top", "safe-right", "safe-bottom", "safe-left"] as const;

export function createDesktopViewportController(options: {
  root: StyleTarget;
  viewport: DesktopVisualViewport | null;
  window: Pick<Window, "addEventListener" | "removeEventListener">;
  layout: () => LayoutSize;
  insets: () => SafeAreaInsets;
  mode: () => UiMode;
  onModeChange: (listener: () => void) => () => void;
  requestFrame: (work: () => void) => number;
  cancelFrame: (id: number) => void;
}) {
  let active = false;
  let frame: number | null = null;
  let unsubscribe: (() => void) | null = null;

  const cancel = () => {
    if (frame !== null) options.cancelFrame(frame);
    frame = null;
  };
  const measure = () => {
    frame = null;
    if (!active) return;
    const geometry = desktopViewportGeometry(options.viewport, options.layout(), options.insets());
    if (!geometry) return;
    const values = [geometry.top, geometry.left, geometry.width, geometry.height,
      geometry.safe.top, geometry.safe.right, geometry.safe.bottom, geometry.safe.left];
    PROPERTIES.forEach((name, index) => {
      const property = `--desktop-visual-${name}`;
      const value = `${values[index]}px`;
      if (options.root.style.getPropertyValue(property) !== value) options.root.style.setProperty(property, value);
    });
    options.root.toggleAttribute("data-desktop-occluded", geometry.occluded);
  };
  const schedule = () => {
    if (active && frame === null) frame = options.requestFrame(measure);
  };
  const observer = createVisualViewportSizer({ viewport: options.viewport, onMetrics: metrics => { if (metrics) schedule(); } });
  const detach = () => {
    active = false;
    cancel();
    observer.detach();
    options.window.removeEventListener("resize", schedule);
    for (const name of PROPERTIES) options.root.style.removeProperty(`--desktop-visual-${name}`);
    options.root.toggleAttribute("data-desktop-occluded", false);
  };
  const syncMode = () => {
    if (options.mode() !== "desktop") { detach(); return; }
    if (!active) {
      active = true;
      options.window.addEventListener("resize", schedule);
      observer.attach();
    }
    cancel();
    measure();
  };
  return {
    start() {
      if (unsubscribe) return;
      unsubscribe = options.onModeChange(syncMode);
      syncMode();
    },
    stop() {
      unsubscribe?.(); unsubscribe = null;
      detach();
    },
  };
}

export function initDesktopViewport(): () => void {
  const probe = document.createElement("div");
  probe.className = "desktop-safe-area-probe";
  probe.setAttribute("aria-hidden", "true");
  document.body.append(probe);
  const controller = createDesktopViewportController({
    root: document.documentElement,
    viewport: window.visualViewport ?? null,
    window,
    layout: () => ({ width: window.innerWidth, height: window.innerHeight }),
    insets: () => {
      const style = getComputedStyle(probe);
      return { top: parseFloat(style.paddingTop) || 0, right: parseFloat(style.paddingRight) || 0,
        bottom: parseFloat(style.paddingBottom) || 0, left: parseFloat(style.paddingLeft) || 0 };
    },
    mode: uiMode,
    onModeChange: onUiModeChange,
    requestFrame: work => requestAnimationFrame(work),
    cancelFrame: id => cancelAnimationFrame(id),
  });
  controller.start();
  return () => { controller.stop(); probe.remove(); };
}
