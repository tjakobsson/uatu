import { describe, expect, test } from "bun:test";
import { createDesktopViewportController, desktopViewportGeometry, type DesktopVisualViewport, type SafeAreaInsets } from "./desktop-viewport";
import type { UiMode } from "./ui-mode";

const layout = { width: 1194, height: 834 };
const safe = { top: 24, right: 0, bottom: 20, left: 0 };

describe("desktop visible work area", () => {
  test("reserves the iPad safe area at rest", () => {
    expect(desktopViewportGeometry({ ...layout, offsetTop: 0, offsetLeft: 0, scale: 1 }, layout, safe))
      .toEqual({ ...layout, top: 0, left: 0, safe, occluded: false });
  });

  test("even a small hardware-keyboard accessory resizes the workspace", () => {
    const geometry = desktopViewportGeometry({ height: 790, offsetTop: 0 }, layout, safe)!;
    expect(geometry.height).toBe(790);
    expect(geometry.occluded).toBe(true);
    expect(geometry.safe).toEqual({ ...safe, bottom: 0 });
  });

  test("panned visual viewport accounts for already-excluded unsafe edges once", () => {
    const geometry = desktopViewportGeometry({ height: 440, width: 1164, offsetTop: 12, offsetLeft: 10 }, layout, { ...safe, left: 18, right: 25 })!;
    expect(geometry).toEqual({ height: 440, width: 1164, top: 12, left: 10,
      safe: { top: 12, left: 8, right: 5, bottom: 0 }, occluded: true });
    expect(desktopViewportGeometry({ height: 440, offsetTop: 80 }, layout, safe)!.safe.top).toBe(0);
  });

  test("zero-inset desktops gain no artificial padding; missing API follows layout", () => {
    const zero = { top: 0, right: 0, bottom: 0, left: 0 };
    expect(desktopViewportGeometry(null, layout, zero)).toEqual({ ...layout, top: 0, left: 0, safe: zero, occluded: false });
  });

  test("pinch zoom does not produce a new desktop layout", () => {
    expect(desktopViewportGeometry({ height: 417, width: 597, offsetTop: 120, scale: 2 }, layout, safe)).toBeNull();
  });
});

function fixture(withViewport = true) {
  const viewport = Object.assign(new EventTarget(), { ...layout, offsetTop: 0, offsetLeft: 0, scale: 1 });
  const win = new EventTarget();
  const properties = new Map<string, string>();
  const attributes = new Set<string>();
  const frames = new Map<number, () => void>();
  const modes = new Set<() => void>();
  let mode: UiMode = "desktop";
  let nextFrame = 0;
  let writes = 0;
  let insets: SafeAreaInsets = safe;
  const controller = createDesktopViewportController({
    root: {
      style: { getPropertyValue: key => properties.get(key) ?? "", setProperty: (key, value) => { writes++; properties.set(key, value ?? ""); }, removeProperty: key => { const old = properties.get(key) ?? ""; properties.delete(key); return old; } },
      toggleAttribute(name, force) { if (force) attributes.add(name); else attributes.delete(name); return !!force; },
    },
    viewport: withViewport ? viewport as DesktopVisualViewport : null,
    window: win as unknown as Window,
    layout: () => layout,
    insets: () => insets,
    mode: () => mode,
    onModeChange: callback => { modes.add(callback); return () => { modes.delete(callback); }; },
    requestFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelFrame: id => { frames.delete(id); },
  });
  return { controller, properties, attributes, viewport, win, frames,
    writes: () => writes,
    flush() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); },
    mode(value: UiMode) { mode = value; for (const callback of modes) callback(); },
    insets(value: SafeAreaInsets) { insets = value; },
  };
}

describe("desktop viewport ownership", () => {
  test("boot measures synchronously and a burst writes only the latest frame", () => {
    const f = fixture(); f.controller.start();
    expect(f.properties.get("--desktop-visual-height")).toBe("834px");
    expect(f.frames.size).toBe(0);
    f.viewport.height = 790; f.viewport.dispatchEvent(new Event("resize"));
    f.viewport.height = 460; f.viewport.dispatchEvent(new Event("resize"));
    f.viewport.offsetTop = 40; f.viewport.dispatchEvent(new Event("scroll"));
    f.win.dispatchEvent(new Event("resize"));
    expect(f.frames.size).toBe(1);
    f.flush();
    expect(f.properties.get("--desktop-visual-height")).toBe("460px");
    expect(f.properties.get("--desktop-visual-top")).toBe("40px");
    expect(f.properties.get("--desktop-visual-safe-bottom")).toBe("0px");
    expect(f.attributes.has("data-desktop-occluded")).toBe(true);
    const writes = f.writes();
    f.viewport.dispatchEvent(new Event("resize")); f.flush();
    expect(f.writes()).toBe(writes);
    f.controller.stop();
  });

  test("switching to touch cancels pending geometry and leaves its panel owners in control", () => {
    const f = fixture(); f.controller.start();
    f.viewport.height = 460; f.viewport.dispatchEvent(new Event("resize"));
    f.mode("touch");
    expect(f.properties.size).toBe(0); expect(f.frames.size).toBe(0);
    f.viewport.dispatchEvent(new Event("scroll")); f.win.dispatchEvent(new Event("resize"));
    expect(f.frames.size).toBe(0);
    f.mode("desktop");
    expect(f.properties.get("--desktop-visual-height")).toBe("460px");
    f.controller.stop();
    f.mode("desktop"); f.viewport.dispatchEvent(new Event("resize"));
    expect(f.properties.size).toBe(0); expect(f.frames.size).toBe(0);
  });

  test("zoom freezes the last normal geometry and returning to normal scale reconciles", () => {
    const f = fixture(); f.controller.start();
    const initial = [...f.properties];
    f.viewport.scale = 2; f.viewport.height = 417; f.viewport.offsetTop = 100;
    f.viewport.dispatchEvent(new Event("scroll")); f.flush();
    expect([...f.properties]).toEqual(initial);
    f.viewport.scale = 1; f.viewport.height = 790; f.viewport.offsetTop = 0;
    f.viewport.dispatchEvent(new Event("resize")); f.flush();
    expect(f.properties.get("--desktop-visual-height")).toBe("790px");
    f.controller.stop();
  });

  test("no visual-viewport API still reserves safe areas and clears them on mode change", () => {
    const f = fixture(false); f.controller.start();
    expect(f.properties.get("--desktop-visual-height")).toBe("834px");
    f.insets({ ...safe, top: 0, left: 24 });
    f.win.dispatchEvent(new Event("resize")); f.flush();
    expect(f.properties.get("--desktop-visual-safe-top")).toBe("0px");
    expect(f.properties.get("--desktop-visual-safe-left")).toBe("24px");
    f.mode("touch"); expect(f.properties.size).toBe(0);
    f.controller.stop();
  });
});
