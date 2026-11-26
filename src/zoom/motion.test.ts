import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { GestureTracker, type GestureIntent, type GesturePoint } from "./gestures";
import { gestureZoom, RestCommit, type GestureSurface, type Timers } from "./motion";
import { COMMIT_DELAY_MS, type ZoomTransform } from "./transform";

const touch = (id: number, x: number, y: number, time = 0): GesturePoint => ({ id, x, y, time, type: "touch" });

// A surface that applies every move unbounded, in a box offset (10, 20) from
// the client origin.
function surface(options: { canPan?: () => boolean } = {}) {
  let current: ZoomTransform = { tx: 0, ty: 0, scale: 1 };
  const events: string[] = [];
  const taps: GestureIntent[] = [];
  const target: GestureSurface = {
    transform: () => current,
    toBox: point => ({ x: point.x - 10, y: point.y - 20 }),
    limits: () => ({ min: 0.5, max: 4 }),
    move: next => {
      current = next;
    },
    canPan: options.canPan ?? (() => true),
    panning: active => events.push(active ? "panning" : "still"),
    tap: intent => taps.push(intent),
    doubleTap: intent => taps.push(intent),
  };
  const tracker = new GestureTracker(gestureZoom(target));
  return {
    tracker,
    events,
    taps,
    transform: () => current,
    set: (t: ZoomTransform) => {
      current = t;
    },
  };
}

describe("gestureZoom", () => {
  test("a drag pans from the transform at its start by the pointer's whole offset", () => {
    const s = surface();
    s.set({ tx: 5, ty: 7, scale: 2 });
    s.tracker.down(touch(1, 100, 100));
    s.tracker.move(touch(1, 140, 130, 16));
    expect(s.transform()).toEqual({ tx: 45, ty: 37, scale: 2 });
    s.tracker.up(touch(1, 140, 130, 32));
    expect(s.events).toEqual(["panning", "still"]);
  });

  test("what a pan asks for beyond the surface's bound is reported, so the page can scroll it", () => {
    let current: ZoomTransform = { tx: 0, ty: -50, scale: 2 };
    const overflow: [number, number][] = [];
    const tracker = new GestureTracker(
      gestureZoom({
        transform: () => current,
        toBox: point => point,
        limits: () => ({ min: 1, max: 4 }),
        // The media's bottom edge is reached at ty -100.
        move: next => {
          current = { ...next, ty: Math.max(next.ty, -100) };
        },
        canPan: () => true,
        panning: () => {},
        panOverflow: (dx, dy) => overflow.push([dx, dy]),
      }),
    );
    tracker.down(touch(1, 100, 300));
    tracker.move(touch(1, 100, 260, 16));
    tracker.move(touch(1, 100, 180, 32));
    tracker.move(touch(1, 100, 230, 48));
    // Within the bound nothing is left over; past it, all that the bound held back.
    expect(overflow).toEqual([[0, 0], [0, -70], [0, -20]]);
    expect(current.ty).toBe(-100);
  });

  test("a surface that cannot pan now leaves a drag alone", () => {
    const s = surface({ canPan: () => false });
    s.tracker.down(touch(1, 100, 100));
    s.tracker.move(touch(1, 140, 130, 16));
    expect(s.transform()).toEqual({ tx: 0, ty: 0, scale: 1 });
    expect(s.events).not.toContain("panning");
  });

  test("a pinch scales from its start, in box coordinates, within the surface's limits", () => {
    const s = surface();
    // 100px apart around client (110, 120), the box point (100, 100).
    s.tracker.down(touch(1, 60, 120));
    s.tracker.down(touch(2, 160, 120));
    s.tracker.move(touch(2, 260, 120, 16));
    const t = s.transform();
    expect(t.scale).toBeCloseTo(2, 9);
    // The box point under the starting midpoint (100, 100) is now under the
    // current midpoint, client (160, 120): box (150, 100).
    expect((150 - t.tx) / t.scale).toBeCloseTo(100, 9);
    expect((100 - t.ty) / t.scale).toBeCloseTo(100, 9);

    s.tracker.move(touch(2, 1060, 120, 32));
    expect(s.transform().scale).toBe(4);
  });

  test("a finger lifting out of a pinch resumes panning from where the media is", () => {
    const s = surface();
    s.tracker.down(touch(1, 60, 120));
    s.tracker.down(touch(2, 160, 120));
    s.tracker.move(touch(2, 260, 120, 16));
    s.tracker.up(touch(2, 260, 120, 32));
    const after = s.transform();
    s.tracker.move(touch(1, 70, 125, 48));
    expect(s.transform()).toEqual({ tx: after.tx + 10, ty: after.ty + 5, scale: after.scale });
  });

  test("taps and double-taps go to the surface", () => {
    const s = surface();
    s.tracker.down(touch(1, 50, 50, 0));
    s.tracker.up(touch(1, 50, 50, 30));
    s.tracker.down(touch(2, 50, 50, 100));
    s.tracker.up(touch(2, 50, 50, 130));
    expect(s.taps.map(tap => tap.type)).toEqual(["tap", "double-tap"]);
  });
});

describe("RestCommit", () => {
  function commit() {
    const { document } = parseHTML("<div></div>");
    const element = document.querySelector("div") as unknown as Element;
    const writes: string[] = [];
    const pending: (() => void)[] = [];
    const timers: Timers = {
      set: callback => {
        pending.push(callback);
        return pending.length - 1;
      },
      clear: handle => {
        pending[handle as number] = () => {};
      },
    };
    const rest = new RestCommit(
      {
        element,
        setTransform: css => writes.push(`transform ${css}`),
        setLayoutScale: scale => writes.push(`layout ${scale}`),
      },
      timers,
    );
    const runTimers = () => {
      for (const callback of pending.splice(0)) callback();
    };
    return { element, writes, rest, runTimers, scheduled: () => pending.length };
  }

  test("a settling move transforms relative to the committed layout and commits once input stops", () => {
    const c = commit();
    c.rest.show({ tx: 1, ty: 2, scale: 2 }, "now");
    expect(c.writes).toEqual(["layout 2", "transform translate(1px, 2px)"]);
    expect(c.element.getAttribute("data-zoom-state")).toBe(JSON.stringify({ tx: 1, ty: 2, scale: 2 }));

    c.writes.length = 0;
    c.rest.show({ tx: 3, ty: 4, scale: 3 }, "settle");
    c.rest.show({ tx: 5, ty: 6, scale: 4 }, "settle");
    expect(c.writes).toEqual(["transform translate(3px, 4px) scale(1.5)", "transform translate(5px, 6px) scale(2)"]);
    expect(c.element.hasAttribute("data-zoom-pending")).toBe(true);
    // The state reported is still the committed one.
    expect(JSON.parse(c.element.getAttribute("data-zoom-state")!).scale).toBe(2);

    c.writes.length = 0;
    c.runTimers();
    expect(c.writes).toEqual(["layout 4", "transform translate(5px, 6px)"]);
    expect(c.element.hasAttribute("data-zoom-pending")).toBe(false);
    expect(c.element.getAttribute("data-zoom-state")).toBe(JSON.stringify({ tx: 5, ty: 6, scale: 4 }));
  });

  test("reset drops a commit still to come and measures later moves from the given layout", () => {
    const c = commit();
    c.rest.show({ tx: 0, ty: 0, scale: 2 }, "now");
    c.rest.show({ tx: 0, ty: 0, scale: 3 }, "settle");
    c.rest.reset();
    c.writes.length = 0;
    c.runTimers();
    expect(c.writes).toEqual([]);
    c.rest.show({ tx: 0, ty: 0, scale: 3 }, "settle");
    expect(c.writes).toEqual(["transform translate(0px, 0px) scale(3)"]);
  });

  test("commits about COMMIT_DELAY_MS after the last move", () => {
    const delays: number[] = [];
    const { document } = parseHTML("<div></div>");
    const rest = new RestCommit(
      { element: document.querySelector("div") as unknown as Element, setTransform: () => {}, setLayoutScale: () => {} },
      { set: (_callback, ms) => delays.push(ms), clear: () => {} },
    );
    rest.show({ tx: 0, ty: 0, scale: 2 }, "settle");
    expect(delays).toEqual([COMMIT_DELAY_MS]);
  });
});
