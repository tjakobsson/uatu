import { describe, expect, test } from "bun:test";

import {
  createVisualViewportSizer,
  type VisualViewportLike,
  type VisualViewportMetrics,
} from "./visual-viewport";

function stubViewport(initialHeight: number, initialOffsetTop = 0) {
  const listeners = new Map<string, Set<() => void>>();
  const fire = (type: string) => {
    for (const listener of listeners.get(type) ?? []) listener();
  };
  const viewport: VisualViewportLike & {
    setHeight(h: number): void;
    pan(offsetTop: number): void;
    listenerCount(): number;
  } = {
    height: initialHeight,
    offsetTop: initialOffsetTop,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    setHeight(h: number) {
      (viewport as { height: number }).height = h;
      fire("resize");
    },
    pan(offsetTop: number) {
      (viewport as { offsetTop: number }).offsetTop = offsetTop;
      fire("scroll");
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
  test("attach emits current metrics immediately and tracks keyboard resizes", () => {
    const viewport = stubViewport(800);
    const seen: Array<VisualViewportMetrics | null> = [];
    const sizer = createVisualViewportSizer({ viewport, onMetrics: m => seen.push(m) });

    sizer.attach();
    expect(seen).toEqual([{ height: 800, offsetTop: 0 }]);

    viewport.setHeight(420); // software keyboard appeared
    expect(seen).toEqual([
      { height: 800, offsetTop: 0 },
      { height: 420, offsetTop: 0 },
    ]);
  });

  test("panning the visual viewport propagates offsetTop via the scroll event", () => {
    const viewport = stubViewport(420);
    const seen: Array<VisualViewportMetrics | null> = [];
    const sizer = createVisualViewportSizer({ viewport, onMetrics: m => seen.push(m) });

    sizer.attach();
    viewport.pan(124); // iOS scrolled a bottom-anchored input into view
    expect(seen.at(-1)).toEqual({ height: 420, offsetTop: 124 });
  });

  test("detach clears the override and removes listeners", () => {
    const viewport = stubViewport(800);
    const seen: Array<VisualViewportMetrics | null> = [];
    const sizer = createVisualViewportSizer({ viewport, onMetrics: m => seen.push(m) });

    sizer.attach();
    sizer.detach();
    expect(seen).toEqual([{ height: 800, offsetTop: 0 }, null]);
    expect(viewport.listenerCount()).toBe(0);

    viewport.setHeight(500);
    expect(seen).toEqual([{ height: 800, offsetTop: 0 }, null]);
  });

  test("attach and detach are idempotent", () => {
    const viewport = stubViewport(700);
    const seen: Array<VisualViewportMetrics | null> = [];
    const sizer = createVisualViewportSizer({ viewport, onMetrics: m => seen.push(m) });

    sizer.attach();
    sizer.attach();
    expect(seen).toEqual([{ height: 700, offsetTop: 0 }]);
    expect(sizer.isAttached()).toBe(true);

    sizer.detach();
    sizer.detach();
    expect(seen).toEqual([{ height: 700, offsetTop: 0 }, null]);
    expect(sizer.isAttached()).toBe(false);
  });

  test("a missing visualViewport (older browsers) is a no-op", () => {
    const seen: Array<VisualViewportMetrics | null> = [];
    const sizer = createVisualViewportSizer({ viewport: null, onMetrics: m => seen.push(m) });
    sizer.attach();
    sizer.detach();
    expect(seen).toEqual([]);
    expect(sizer.isAttached()).toBe(false);
  });
});
