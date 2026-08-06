import { describe, expect, test } from "bun:test";

import { createVisualViewportSizer, type VisualViewportLike } from "./visual-viewport";

function stubViewport(initialHeight: number) {
  const listeners = new Map<string, Set<() => void>>();
  const viewport: VisualViewportLike & { setHeight(h: number): void; listenerCount(): number } = {
    height: initialHeight,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    setHeight(h: number) {
      (viewport as { height: number }).height = h;
      for (const listener of listeners.get("resize") ?? []) listener();
    },
    listenerCount() {
      let count = 0;
      for (const set of listeners.values()) count += set.size;
      return count;
    },
  };
  return viewport;
}

describe("createVisualViewportSizer", () => {
  test("attach emits the current height immediately and tracks resizes", () => {
    const viewport = stubViewport(800);
    const heights: Array<number | null> = [];
    const sizer = createVisualViewportSizer({ viewport, onHeight: h => heights.push(h) });

    sizer.attach();
    expect(heights).toEqual([800]);

    viewport.setHeight(420); // software keyboard appeared
    expect(heights).toEqual([800, 420]);
  });

  test("detach clears the override and removes listeners", () => {
    const viewport = stubViewport(800);
    const heights: Array<number | null> = [];
    const sizer = createVisualViewportSizer({ viewport, onHeight: h => heights.push(h) });

    sizer.attach();
    sizer.detach();
    expect(heights).toEqual([800, null]);
    expect(viewport.listenerCount()).toBe(0);

    viewport.setHeight(500);
    expect(heights).toEqual([800, null]);
  });

  test("attach and detach are idempotent", () => {
    const viewport = stubViewport(700);
    const heights: Array<number | null> = [];
    const sizer = createVisualViewportSizer({ viewport, onHeight: h => heights.push(h) });

    sizer.attach();
    sizer.attach();
    expect(heights).toEqual([700]);
    expect(sizer.isAttached()).toBe(true);

    sizer.detach();
    sizer.detach();
    expect(heights).toEqual([700, null]);
    expect(sizer.isAttached()).toBe(false);
  });

  test("a missing visualViewport (older browsers) is a no-op", () => {
    const heights: Array<number | null> = [];
    const sizer = createVisualViewportSizer({ viewport: null, onHeight: h => heights.push(h) });
    sizer.attach();
    sizer.detach();
    expect(heights).toEqual([]);
    expect(sizer.isAttached()).toBe(false);
  });
});
