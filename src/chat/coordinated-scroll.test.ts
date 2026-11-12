import { afterEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { TimelineAnchorController } from "./anchor";
import { CoordinatedScrollOwner } from "./coordinated-scroll";

const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose(); });

function fixture(followMotion?: () => "smooth" | "instant", endThreshold?: number) {
  const { document, window } = parseHTML("<html><body><div></div></body></html>");
  const element = document.querySelector("div")! as unknown as HTMLElement;
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  let top = 300;
  let extent = 600;
  let viewport = 300;
  let itemTop = 0;
  let active = true;
  const writes: number[] = [];
  Object.defineProperties(element, {
    scrollTop: { get: () => top, set: value => { top = Math.max(0, Math.min(value, extent - viewport)); writes.push(top); } },
    scrollHeight: { get: () => extent }, clientHeight: { get: () => viewport },
  });
  const anchor = new TimelineAnchorController(endThreshold);
  const options = {
    followMotion,
    anchor, active: () => active,
    measure: (includeItems: boolean, _preserveAnchor?: boolean) => ({ scrollTop: top, scrollHeight: extent, clientHeight: viewport,
      items: includeItems ? [{ id: "line", top: itemTop - top, bottom: itemTop - top + 1000 }] : [] }),
    requestFrame: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; },
    cancelFrame: (id: number) => { frames.delete(id); },
  };
  const owner = new CoordinatedScrollOwner(element, options);
  disposals.push(() => owner.dispose());
  return { element, owner, anchor, frames, writes, options, document,
    grow: (height: number) => { extent = height; top = Math.min(top, extent - viewport); },
    resize: (height: number) => { viewport = height; },
    move: (value: number) => { top = value; },
    shift: (value: number) => { itemTop = value; },
    hide: () => { active = false; },
    show: () => { active = true; },
    event: (name: string, fields = {}) => { element.dispatchEvent(Object.assign(new window.Event(name, { bubbles: true }), fields) as unknown as Event); },
    eventAt: (target: { dispatchEvent(event: Event): boolean }, name: string, fields = {}) => {
      target.dispatchEvent(Object.assign(new window.Event(name, { bubbles: true }), fields) as unknown as Event);
    },
    flush: (timestamp?: number) => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(timestamp ?? sequence); },
  };
}

function stubRect(element: object, rect: () => { top: number; bottom: number }): void {
  Object.defineProperty(element, "getBoundingClientRect", { configurable: true, value: rect });
}

/** The band the platform leaves above the software keyboard. While a request
 *  is answered the scroller keeps its full height and the keyboard covers its
 *  lower part, so this is the only thing that says where the reader can see. */
function withVisibleBand(band: { height: number; offsetTop: number }, run: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { visualViewport: band } });
  try { run(); } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

describe("coordinated scrolling", () => {
  test("reader-pause notification excludes layout, clamps and correction echoes", () => {
    const f = fixture();
    let pauses = 0;
    Object.assign(f.options, { onReaderPause: () => { pauses++; } });
    f.owner.request(); f.flush(0);
    f.move(200); f.anchor.pause(f.options.measure(true));
    f.shift(20); f.owner.request(); f.flush(20);
    f.event("scroll");
    expect(pauses).toBe(0);
    f.grow(450); f.event("scroll"); f.flush(40);
    expect(pauses).toBe(0);
    f.event("wheel", { deltaY: -1 });
    expect(pauses).toBe(1);
    f.owner.request(); f.flush(60);
    expect(pauses).toBe(1);
    f.hide(); f.event("wheel", { deltaY: -1 });
    expect(pauses).toBe(1);
  });

  test("reader-pause notification uses the owner's native, key and touch input classification", () => {
    const f = fixture();
    let pauses = 0;
    Object.assign(f.options, { onReaderPause: () => { pauses++; } });
    f.move(250); f.event("scroll");
    expect(pauses).toBe(1);
    f.event("scroll");
    expect(pauses).toBe(1);
    f.event("keydown", { key: "ArrowUp" });
    expect(pauses).toBe(2);
    f.event("touchstart", { touches: [{ clientY: 100 }] });
    f.event("touchmove", { touches: [{ clientY: 110 }] });
    expect(pauses).toBe(3);
  });

  test("native downward timeline arrival respects the 48px boundary", () => {
    for (const gap of [49, 48, 47.9, 20, 0.4, 0]) {
      const f = fixture(() => "smooth");
      f.move(200); f.owner.pause();
      f.move(199); f.event("scroll");
      f.move(300 - gap); f.event("scroll");
      expect(f.anchor.isPinned()).toBe(gap <= 48);
    }
  });
  test("tiny native downward steps resume at fractional bottom without rounding", () => {
    // Also exercise the old arrival policy so restoring 48px cannot hide a
    // native-movement classification regression.
    for (const threshold of [undefined, 0.5]) {
      const f = fixture(() => "smooth", threshold);
      f.owner.request(); f.flush(0);
      f.move(299.4); f.anchor.pause(f.options.measure(true));
      f.event("scroll");
      expect(f.anchor.isPinned()).toBe(false);
      f.move(299.6); f.event("scroll");
      expect(f.anchor.isPinned()).toBe(true);
      f.flush(16); f.flush(32);
      expect(f.writes).toEqual([]);
      expect(f.element.scrollTop).toBe(299.6);
      f.move(300); f.event("scroll"); f.flush(48);
      expect(f.writes).toEqual([]);
      expect(f.element.scrollTop).toBe(300);
    }
  });
  test("tiny native downward steps cross the inclusive timeline arrival band", () => {
    const f = fixture(() => "smooth");
    f.move(251.8); f.anchor.pause(f.options.measure(true)); f.event("scroll");
    expect(f.anchor.isPinned()).toBe(false);
    f.move(252.1); f.event("scroll");
    expect(f.anchor.isPinned()).toBe(true);
  });
  test("restored fractional position and correction echoes wait for a real downward arrival", () => {
    const f = fixture(() => "smooth");
    f.move(251.8);
    f.anchor.restore({ itemId: "line", offset: -251.8 });
    f.owner.request(); f.flush(0);
    f.event("scroll"); f.event("scroll");
    expect(f.anchor.isPinned()).toBe(false);
    expect(f.writes).toEqual([]);
    f.move(252.1); f.event("scroll");
    expect(f.anchor.isPinned()).toBe(true);
    f.event("wheel", { deltaY: -0.1 });
    expect(f.anchor.isPinned()).toBe(false);
    f.move(252); f.event("scroll");
    f.owner.request(true); f.flush(16); f.event("scroll");
    expect(f.anchor.isPinned()).toBe(false);
    expect(f.element.scrollTop).toBe(252);
  });
  test("native elastic scrolling beyond latest is not snapped back by follow frames", () => {
    const f = fixture(() => "smooth");
    f.owner.request(); f.flush(0);
    const before = f.writes.length;
    // Safari exposes the compositor's elastic excursion through scrollTop.
    // Native movement can exceed the range; a script assignment clamps it.
    f.move(330); f.event("scroll");
    f.flush(16); f.flush(32);
    expect(f.writes.slice(before)).toEqual([]);
    expect(f.element.scrollTop).toBe(330);
  });
  test("shrinking layout during bottom rebound preserves follow intent and explicit upward pauses", () => {
    for (const paused of [false, true]) {
      const f = fixture(() => "smooth");
      f.owner.request(); f.flush(0);
      f.move(330); f.event("scroll"); f.flush(16);
      if (paused) f.event("wheel", { deltaY: -1 });
      // The native excursion can outlive the extent that started it.
      f.grow(550); f.move(265); f.event("scroll"); f.flush(32);
      expect(f.anchor.isPinned()).toBe(!paused);
      expect(f.element.scrollTop).toBe(265);
      expect(f.writes).toEqual([]);
      f.move(250); f.event("scroll"); f.flush(48);
      expect(f.anchor.isPinned()).toBe(!paused);
      f.grow(650); f.owner.request(true); f.flush(64); f.flush(304);
      expect(f.element.scrollTop).toBe(paused ? 250 : 350);
    }
  });
  test("native bottom rebound keeps following until real upward input takes over", () => {
    const f = fixture(() => "smooth");
    f.owner.request(); f.flush(0);
    f.move(100); f.owner.pause();
    f.move(90); f.event("scroll");
    f.move(330); f.event("scroll"); f.flush(16);
    for (const top of [320, 305, 300]) {
      f.move(top); f.event("scroll"); f.flush(32 + top);
      expect(f.anchor.isPinned()).toBe(true);
      expect(f.element.scrollTop).toBe(top);
    }
    expect(f.writes).toEqual([]);
    f.grow(700); f.owner.request(true); f.flush(400); f.flush(640);
    expect(f.element.scrollTop).toBe(400);
    f.move(430); f.event("scroll"); f.flush(660);
    f.event("wheel", { deltaY: -1 });
    f.move(390); f.event("scroll");
    expect(f.anchor.isPinned()).toBe(false);
    f.grow(800); f.owner.request(true); f.flush(700);
    expect(f.element.scrollTop).toBe(390);
  });
  test("native fractional bottom arrival is not rounded by an automatic follow write", () => {
    const f = fixture(() => "smooth");
    f.owner.request(); f.flush(0);
    f.move(100); f.owner.pause(); f.move(90); f.event("scroll");
    f.move(299.75); f.event("scroll");
    expect(f.anchor.isPinned()).toBe(true);
    f.flush(16); f.flush(32);
    expect(f.writes).toEqual([]);
    expect(f.element.scrollTop).toBe(299.75);
    f.grow(700); f.owner.request(true); f.flush(48); f.flush(288);
    expect(f.element.scrollTop).toBe(400);
  });
  test("native fractional arrival also retires an in-flight catch-up without a final write", () => {
    const f = fixture(() => "smooth");
    f.owner.request(); f.flush(0);
    f.grow(900); f.owner.request(true); f.flush(16); f.flush(48);
    expect(f.element.scrollTop).toBeGreaterThan(300);
    const before = f.writes.length;
    f.move(599.75); f.event("scroll"); f.flush(64); f.flush(304);
    expect(f.writes.slice(before)).toEqual([]);
    expect(f.element.scrollTop).toBe(599.75);
    expect(f.anchor.isPinned()).toBe(true);
  });
  test("paused elastic excursions are not clamped by unchanged layout work", () => {
    for (const [excursion, rowOffset] of [[-30, 0], [330, 0], [-30.1, 200.3], [330.1, 200.3]] as const) {
      const f = fixture(() => "smooth");
      f.owner.request(); f.flush(0);
      f.shift(rowOffset);
      f.move(excursion); f.event("scroll");
      f.event("wheel", { deltaY: -1 });
      expect(f.anchor.isPinned()).toBe(false);
      const before = f.writes.length;
      f.owner.request(); f.flush(16);
      expect(f.writes.slice(before)).toEqual([]);
      expect(f.element.scrollTop).toBe(excursion);
      f.move(excursion < 0 ? 0 : 300); f.event("scroll");
      f.owner.request(); f.flush(32);
      expect(f.anchor.isPinned()).toBe(false);
      expect(f.writes.slice(before)).toEqual([]);
    }
  });
  test("a targeted geometry adapter keeps the explicitly activated row anchored", () => {
    const f = fixture();
    f.move(100); f.owner.pause();
    const measure = f.options.measure;
    f.options.measure = (includeItems, preserveAnchor, preferredItemId?: string) => {
      const geometry = measure(includeItems, preserveAnchor);
      if (includeItems && preferredItemId === "control") {
        geometry.items.push({ id: "control", top: 120, bottom: 150 });
      }
      return geometry;
    };
    f.owner.beforeMutation("control");
    expect(f.anchor.currentAnchor()).toEqual({ itemId: "control", offset: 120 });
  });
  test("renewed upward touch interrupts latest and holds and recaptures after bottom arrival or a new direction", () => {
    for (const renewal of ["queued latest", "moving latest", "hold", "bottom", "direction", "new touch"] as const) {
      const f = fixture(() => "smooth");
      f.grow(900); f.move(300); f.owner.pause(); f.owner.cancel();
      f.event("touchstart", { touches: [{ clientY: 100 }] });
      f.event("touchmove", { touches: [{ clientY: 110 }] });
      const field = f.document.createElement("input") as unknown as HTMLElement;
      f.element.append(field);
      if (renewal === "queued latest" || renewal === "moving latest") f.owner.latest();
      if (renewal === "moving latest") { f.flush(0); f.flush(32); expect(f.element.scrollTop).toBeGreaterThan(300); }
      if (renewal === "hold") f.owner.hold(field);
      if (renewal === "bottom") {
        f.move(280); f.event("scroll");
        f.move(600); f.event("scroll"); expect(f.anchor.isPinned()).toBe(true);
      }
      if (renewal === "direction") f.event("touchmove", { touches: [{ clientY: 90 }] });
      if (renewal === "new touch") f.event("touchstart", { touches: [{ clientY: 100 }] });
      const top = f.element.scrollTop;
      const calls: Array<[boolean, boolean | undefined]> = [];
      const measure = f.options.measure;
      f.options.measure = (items, preserve) => { calls.push([items, preserve]); return measure(items, preserve); };
      f.event("touchmove", { touches: [{ clientY: 120 }] });
      expect(calls.filter(([items]) => items)).toEqual([[true, false]]);
      expect(f.anchor.isPinned()).toBe(false);
      expect(f.owner.isHolding(field)).toBe(false);
      expect(f.frames.size).toBe(0);
      f.grow(1000); f.owner.request(true); f.flush(400);
      expect(f.element.scrollTop).toBe(top);
    }
  });

  test("new layout work or a correction renews upward touch intent within the same gesture", () => {
    for (const work of ["request", "correction", "beforeMutation"] as const) {
      const f = fixture();
      f.grow(2000); f.move(500); f.owner.pause(); f.owner.cancel();
      f.event("touchstart", { touches: [{ clientY: 100 }] });
      f.event("touchmove", { touches: [{ clientY: 110 }] });
      f.shift(100); f.grow(2100);
      if (work === "beforeMutation") f.owner.beforeMutation();
      else f.owner.request(true);
      if (work === "correction") f.flush(16);
      const top = f.element.scrollTop;
      const calls: Array<[boolean, boolean | undefined]> = [];
      const measure = f.options.measure;
      f.options.measure = (items, preserve) => { calls.push([items, preserve]); return measure(items, preserve); };
      f.event("touchmove", { touches: [{ clientY: 120 }] });
      expect(calls.filter(([items]) => items)).toEqual([[true, false]]);
      expect(f.frames.size).toBe(0);
      expect(f.anchor.currentAnchor()).toEqual({ itemId: "line", offset: 100 - top });
      f.owner.request(); f.flush(32);
      expect(f.element.scrollTop).toBe(top);
    }
  });

  test("continuous upward touch captures intent once while native movement and momentum keep capturing fresh positions", () => {
    const f = fixture();
    f.grow(2000); f.move(500); f.owner.pause(); f.owner.cancel();
    const calls: Array<[boolean, boolean | undefined]> = [];
    const measure = f.options.measure;
    f.options.measure = (includeItems, preserveAnchor) => {
      calls.push([includeItems, preserveAnchor]);
      return measure(includeItems, preserveAnchor);
    };
    let changes = 0;
    Object.assign(f.options, { onChange: () => changes++ });
    f.event("touchstart", { touches: [{ clientY: 100 }] });
    for (const y of [110, 110, 120, 130]) f.event("touchmove", { touches: [{ clientY: y }] });
    expect(calls.filter(([items]) => items)).toEqual([[true, false]]);
    expect(changes).toBe(1);
    expect(f.anchor.isPinned()).toBe(false);
    for (const [y, top] of [[140, 480], [150, 460]] as const) {
      calls.length = 0;
      f.event("touchmove", { touches: [{ clientY: y }] });
      f.move(top); f.event("scroll");
      expect(calls.filter(([items]) => items)).toEqual([[true, false]]);
      expect(f.anchor.currentAnchor()).toEqual({ itemId: "line", offset: -top });
    }
    f.event("touchend", { touches: [] });
    f.move(440); f.event("scroll");
    f.shift(100); f.grow(2100); f.owner.request(); f.flush(16);
    expect(f.element.scrollTop).toBe(540);
    expect(f.anchor.isPinned()).toBe(false);
  });

  test("paused native movement measures semantic items once and echoes retain the reading anchor", () => {
    for (const delta of [-20, 20]) {
      const f = fixture();
      f.grow(2000); f.move(500); f.owner.pause();
      const calls: Array<[boolean, boolean | undefined]> = [];
      const measure = f.options.measure;
      f.options.measure = (includeItems, preserveAnchor) => {
        calls.push([includeItems, preserveAnchor]);
        return measure(includeItems, preserveAnchor);
      };
      // First movement consumes pending input; the next is native momentum.
      for (const top of [500 + delta, 500 + delta * 2]) {
        calls.length = 0;
        f.move(top); f.event("scroll");
        expect(calls.filter(([includeItems]) => includeItems)).toEqual([[true, false]]);
        expect(f.anchor.currentAnchor()).toEqual({ itemId: "line", offset: -top });
        expect(f.anchor.isPinned()).toBe(false);
        expect(f.writes).toEqual([]);
      }
      f.owner.request(); f.flush(16);
      calls.length = 0;
      f.event("scroll");
      expect(calls.filter(([includeItems]) => includeItems)).toEqual([[true, undefined]]);
      expect(f.anchor.currentAnchor()).toEqual({ itemId: "line", offset: -(500 + delta * 2) });
      f.shift(100); f.grow(2100); f.owner.request(); f.flush(32);
      expect(f.element.scrollTop).toBe(600 + delta * 2);
      expect(f.anchor.isPinned()).toBe(false);
    }
  });

  for (const origin of ["outside", "textarea", "programmatic"] as const) test(`ordinary button focus navigation from ${origin} stays visible through a later render`, () => {
    const f = fixture();
    f.grow(2000); f.move(1000); f.owner.pause();
    f.move(920); f.event("scroll");
    const button = f.document.createElement("button"); f.element.append(button);
    const previous = f.document.createElement(origin === "textarea" ? "textarea" : "button");
    if (origin === "textarea") f.element.append(previous);
    else f.document.body.append(previous);
    let active = previous;
    Object.defineProperty(f.document, "activeElement", { configurable: true, get: () => active });
    stubRect(button, () => ({ top: 1292 - f.element.scrollTop, bottom: 1322 - f.element.scrollTop }));
    if (origin !== "programmatic") f.eventAt(previous, "keydown", { key: "Tab" });
    // LinkeDOM does not perform native focus scrolling; supply that external
    // browser transition, without routing it through a private owner method.
    active = button;
    button.dispatchEvent(new f.document.defaultView!.Event("focusin", { bubbles: true }));
    f.move(1272); f.event("scroll");
    expect(button.getBoundingClientRect().top).toBe(20);
    f.owner.beforeMutation(); f.owner.request(); f.flush(16);
    expect(f.element.scrollTop).toBe(1272);
    expect(button.getBoundingClientRect().bottom).toBeLessThanOrEqual(300);
  });

  // The diagnosed pre-click reveal was navigation to an offscreen control,
  // not a shell mutation. Unrelated input cannot change later focus policy.
  for (const input of ["Tab", "Space", "cancelled wheel"] as const) test(`non-scrolling ${input} does not prevent later legitimate button focus navigation`, () => {
    const f = fixture();
    f.grow(2000); f.move(1000); f.owner.pause();
    f.move(920); f.event("scroll");
    const button = f.document.createElement("button"); f.element.append(button);
    Object.defineProperty(f.document, "activeElement", { configurable: true, get: () => button });
    const event = Object.assign(new f.document.defaultView!.Event(input === "cancelled wheel" ? "wheel" : "keydown", { bubbles: true, cancelable: true }),
      input === "cancelled wheel" ? { deltaY: 20 } : { key: input === "Space" ? " " : "Tab" });
    if (input === "cancelled wheel") event.preventDefault();
    button.dispatchEvent(event);
    // No movement or scrollend follows the unrelated input. Focus navigation
    // must still be adopted rather than inferred from a latched input flag.
    f.move(1272); f.event("scroll");
    f.owner.beforeMutation();
    f.owner.request(); f.flush(16);
    expect(f.element.scrollTop).toBe(1272);
  });

  for (const input of ["wheel", "touch", "keyboard", "scrollbar"] as const) test(`${input} reading movement and subsequent button focus navigation remain authoritative`, () => {
    const f = fixture();
    f.grow(2000); f.move(1000); f.owner.pause();
    f.move(920); f.event("scroll");
    const button = f.document.createElement("button"); f.element.append(button);
    Object.defineProperty(f.document, "activeElement", { configurable: true, get: () => button });
    if (input === "wheel") f.event("wheel", { deltaY: 20 });
    else if (input === "touch") {
      f.event("touchstart", { touches: [{ clientY: 100 }] });
      f.event("touchmove", { touches: [{ clientY: 80 }] });
    } else if (input === "keyboard") f.event("keydown", { key: "ArrowDown" });
    else {
      stubRect(f.element, () => ({ top: 0, bottom: 300, left: 0, right: 116 }));
      Object.defineProperties(f.element, { clientLeft: { value: 0 }, clientWidth: { value: 100 } });
      f.event("pointerdown", { pointerType: "mouse", clientX: 108 });
    }
    f.move(940); f.event("scroll");
    f.owner.request(); f.flush(16);
    expect(f.element.scrollTop).toBe(940);
    // Momentum belongs to that gesture as well, not to the focused control.
    f.move(960); f.event("scroll");
    f.owner.request(); f.flush(32);
    expect(f.element.scrollTop).toBe(960);
    f.event("scrollend");
    f.move(1272); f.event("scroll");
    f.owner.beforeMutation();
    f.owner.request(); f.flush(48);
    expect(f.element.scrollTop).toBe(1272);
  });

  for (const delta of [-20, 4]) test(`${delta < 0 ? "upward" : "downward"} reader movement selects a fresh fine location while correction echoes retain it`, () => {
    const { document, window } = parseHTML("<html><body><div></div></body></html>");
    const element = document.querySelector("div")! as unknown as HTMLElement;
    let top = 1000, moved = false, rewrapped = false;
    Object.defineProperties(element, {
      scrollTop: { get: () => top, set: value => { top = value; } },
      clientHeight: { get: () => 400 }, scrollHeight: { get: () => 12000 },
    });
    const anchor = new TimelineAnchorController();
    anchor.restore({ itemId: "row", offset: -1000, content: { key: "old-character", offset: 0 } });
    const owner = new CoordinatedScrollOwner(element, {
      anchor,
      measure: (includeItems, preserveAnchor = true) => {
        const old = { key: "old-character", top: (rewrapped ? 900 : 1000) - top, bottom: (rewrapped ? 900 : 1000) - top + 20 };
        const fresh = { key: moved ? "new-character" : "old-character", top: rewrapped ? 900 - top : 0, bottom: rewrapped ? 920 - top : 20 };
        return { scrollTop: top, clientHeight: 400, scrollHeight: 12000,
          items: includeItems ? [{ id: "row", top: -top, bottom: 12000 - top,
            content: preserveAnchor && moved && anchor.currentAnchor()?.content?.key === old.key ? [old, fresh] : [fresh] }] : [] };
      },
      requestFrame: () => 1, cancelFrame() {},
    });
    disposals.push(() => owner.dispose());
    const scroll = () => element.dispatchEvent(new window.Event("scroll"));
    scroll();
    expect(anchor.currentAnchor()?.content?.key).toBe("old-character");
    if (delta < 0) element.dispatchEvent(Object.assign(new window.Event("wheel"), { deltaY: delta }));
    top += delta; moved = true; scroll();
    rewrapped = true;
    owner.request(); owner.flush(16);
    expect(top).toBe(900);
    scroll();
    expect(anchor.currentAnchor()?.content?.key).toBe("new-character");
  });

  test("forward reader progress does not restart the layout catch-up deadline", () => {
    const f = fixture(() => "smooth");
    f.owner.request(); f.flush(0);
    f.grow(1186); f.owner.request(true); f.flush(16); f.flush(128);
    f.event("wheel", { deltaY: 4 });
    f.move(f.element.scrollTop + 4); f.event("scroll");
    f.flush(160); f.flush(316);
    expect(f.anchor.isPinned()).toBe(true);
    expect(886 - f.element.scrollTop).toBeLessThanOrEqual(2);
    expect(f.frames.size).toBe(0);
  });
  for (const moving of [false, true]) test(`downward reader progress during ${moving ? "moving" : "pending"} catch-up keeps following without pulling backward`, () => {
    const f = fixture(() => "smooth");
    f.owner.request(); f.flush(0);
    f.grow(1186); f.owner.request(true);
    if (moving) {
      f.flush(16); f.flush(48);
      expect(f.element.scrollTop).toBeGreaterThan(300);
    }
    expect(f.element.scrollTop).toBeLessThan(800);
    f.event("wheel", { deltaY: 400 });
    f.move(800); f.event("scroll");
    expect(f.anchor.isPinned()).toBe(true);
    for (const timestamp of [64, 96, 160, 240, 304, 368]) {
      f.flush(timestamp);
      expect(f.element.scrollTop).toBeGreaterThanOrEqual(800);
    }
    expect(f.element.scrollTop).toBe(886);
    expect(f.anchor.isPinned()).toBe(true);
  });
  for (const end of ["release", "detach"] as const) test(`${end} restores a held follow position directly even when streaming motion is smooth`, () => {
    const f = fixture(() => "smooth");
    stubRect(f.element, () => ({ top: 0, bottom: 300 }));
    const field = f.document.createElement("input"); f.element.append(field);
    stubRect(field, () => ({ top: 450 - f.element.scrollTop, bottom: 470 - f.element.scrollTop }));
    f.owner.request(); f.flush(0);
    f.owner.hold(field as unknown as HTMLElement); f.flush(16);
    expect(f.element.scrollTop).toBe(170);
    const before = f.writes.length;
    if (end === "release") f.owner.release();
    else { field.remove(); f.owner.request(); }
    f.flush(32);
    expect(f.element.scrollTop).toBe(300);
    expect(f.writes.length - before).toBe(1);
    expect(f.frames.size).toBe(0);
  });
  test("restoring a missing reading anchor places its latest fallback immediately", () => {
    const f = fixture(() => "smooth");
    f.owner.request(); f.flush(0);
    f.grow(900); f.owner.request(true); f.flush(16); f.flush(48);
    f.anchor.restore({ itemId: "removed", offset: 0 });
    f.owner.request(); f.flush(64);
    expect(f.element.scrollTop).toBe(600);
    expect(f.frames.size).toBe(0);
    expect(f.anchor.isPinned()).toBe(true);
  });
  test("arriving at bottom during smooth following does not pull the reader backward", () => {
    const f = fixture(() => "smooth");
    f.owner.request(); f.flush(0);
    f.grow(1186); f.owner.request(true); f.flush(16); f.flush(48);
    f.move(886); f.event("scroll"); f.flush(64);
    expect(f.element.scrollTop).toBe(886);
    expect(f.anchor.isPinned()).toBe(true);
    expect(f.frames.size).toBe(0);
  });
  test("initial latest and restored reading positions are immediate without disabling later smooth following", () => {
    const f = fixture(() => "smooth");
    f.move(100); f.owner.latest({ motion: "instant" }); f.flush(0);
    expect(f.element.scrollTop).toBe(300);
    expect(f.frames.size).toBe(0);
    f.grow(1186); f.owner.request(true); f.flush(16); f.flush(48);
    expect(f.element.scrollTop).toBeGreaterThan(300);
    expect(f.element.scrollTop).toBeLessThan(886);
    f.anchor.restore({ itemId: "line", offset: -100 });
    f.owner.request(); f.flush(64);
    expect(f.element.scrollTop).toBe(100);
    expect(f.anchor.isPinned()).toBe(false);
    expect(f.frames.size).toBe(0);
  });
  test("snapshot cancellation retains only an unconsumed instant placement across replacements", () => {
    const f = fixture(() => "smooth");
    f.move(0); f.owner.latest({ motion: "instant" });
    f.owner.cancel({ preserveInstantPlacement: true });
    f.owner.cancel({ preserveInstantPlacement: true });
    expect(f.frames.size).toBe(0);
    expect(f.writes).toEqual([]);
    f.grow(900); f.owner.request(); f.flush(0);
    expect(f.element.scrollTop).toBe(600);
    expect(f.writes).toEqual([600]);
    // Once consumed, replacement cancellation must not invent another instant
    // placement: ordinary subsequent output still follows smoothly.
    f.grow(1200); f.owner.cancel({ preserveInstantPlacement: true });
    f.owner.request(true); f.flush(16); f.flush(48);
    expect(f.element.scrollTop).toBeGreaterThan(600);
    expect(f.element.scrollTop).toBeLessThan(900);
  });
  test("ordinary cancellation clears an unconsumed instant placement", () => {
    const f = fixture(() => "smooth");
    f.move(0); f.owner.latest({ motion: "instant" }); f.owner.cancel();
    f.owner.cancel({ preserveInstantPlacement: true });
    f.owner.request(); f.flush(0); f.flush(32);
    expect(f.element.scrollTop).toBeGreaterThan(0);
    expect(f.element.scrollTop).toBeLessThan(300);
  });
  test("reader pause cancels initial placement and snapshot cancellation cannot repin it", () => {
    const f = fixture(() => "smooth");
    f.move(100); f.owner.latest({ motion: "instant" }); f.owner.pause();
    f.owner.cancel({ preserveInstantPlacement: true });
    f.grow(900); f.owner.request(true); f.flush(0); f.flush(32);
    expect(f.anchor.isPinned()).toBe(false);
    expect(f.element.scrollTop).toBe(100);
    expect(f.writes).toEqual([]);
  });
  test("snapshot cancellation without pending placement does not invent instant following", () => {
    const f = fixture(() => "smooth");
    f.owner.request(); f.flush(0);
    f.grow(900);
    f.owner.cancel({ preserveInstantPlacement: true });
    f.owner.cancel({ preserveInstantPlacement: true });
    f.owner.request(true); f.flush(16); f.flush(48);
    expect(f.element.scrollTop).toBeGreaterThan(300);
    expect(f.element.scrollTop).toBeLessThan(600);
  });
  test("a held control interrupts smooth following with one immediate write", () => {
    const f = fixture(() => "smooth");
    stubRect(f.element, () => ({ top: 0, bottom: 300 }));
    const field = f.document.createElement("input"); f.element.append(field);
    stubRect(field, () => ({ top: 1000 - f.element.scrollTop, bottom: 1020 - f.element.scrollTop }));
    f.owner.request(); f.flush(0);
    f.grow(1186); f.owner.request(true); f.flush(16); f.flush(48);
    const writesBefore = f.writes.length;
    f.owner.hold(field as unknown as HTMLElement); f.flush(64);
    expect(f.element.scrollTop).toBe(720);
    expect(f.writes.length - writesBefore).toBe(1);
    expect(f.frames.size).toBe(0);
    f.owner.request(true); f.flush(80);
    expect(f.element.scrollTop).toBe(720);
  });
  test("disposing a moving follow retires its queued frames and future writes", () => {
    const f = fixture(() => "smooth");
    f.owner.request(); f.flush(0);
    f.grow(1186); f.owner.request(true); f.flush(16); f.flush(48);
    expect(f.element.scrollTop).toBeGreaterThan(300);
    expect(f.frames.size).toBe(1);
    const writesBefore = f.writes.length;
    f.owner.dispose();
    expect(f.frames.size).toBe(0);
    f.flush(400); f.owner.request(true); f.owner.latest(); f.owner.flush(416);
    expect(f.writes.length).toBe(writesBefore);
  });
  test("switching to instant motion finishes an active follow on its next frame", () => {
    let motion: "smooth" | "instant" = "smooth";
    const f = fixture(() => motion);
    f.owner.request(); f.flush(0);
    f.grow(1186); f.owner.request(true); f.flush(16); f.flush(48);
    expect(f.element.scrollTop).toBeGreaterThan(300);
    expect(f.element.scrollTop).toBeLessThan(886);
    motion = "instant";
    const writesBefore = f.writes.length;
    f.flush(64);
    expect(f.element.scrollTop).toBe(886);
    expect(f.writes.length - writesBefore).toBe(1);
    expect(f.frames.size).toBe(0);
    f.flush(400);
    expect(f.writes.length - writesBefore).toBe(1);
  });
  test("upward wheel, touch, and key input cancel both pending and moving smooth latest requests", () => {
    for (const gesture of ["wheel", "touch", "key"] as const) {
      for (const moving of [false, true]) {
        const f = fixture(() => "smooth");
        f.move(100); f.owner.pause(); f.owner.latest();
        if (moving) {
          f.flush(0); f.flush(32);
          expect(f.element.scrollTop).toBeGreaterThan(100);
          expect(f.element.scrollTop).toBeLessThan(300);
        }
        const stopped = f.element.scrollTop;
        if (gesture === "wheel") f.event("wheel", { deltaY: -4 });
        if (gesture === "touch") {
          f.event("touchstart", { touches: [{ clientY: 100 }] });
          f.event("touchmove", { touches: [{ clientY: 120 }] });
        }
        if (gesture === "key") f.event("keydown", { key: "PageUp" });
        expect(f.frames.size).toBe(0);
        expect(f.anchor.isPinned()).toBe(false);
        f.grow(900); f.owner.request(true); f.flush(400);
        expect(f.element.scrollTop).toBe(stopped);
        expect(f.anchor.isPinned()).toBe(false);
      }
    }
  });
  test("a growing stream retargets without reversing and settles within 300ms of its last layout update", () => {
    const f = fixture(() => "smooth");
    f.owner.request(); f.flush(0);
    let previous = 300;
    for (let timestamp = 16; timestamp <= 640; timestamp += 16) {
      if (timestamp <= 320) { f.grow(600 + timestamp * 2); f.owner.request(true); }
      const writesBefore = f.writes.length;
      f.flush(timestamp);
      expect(f.writes.length - writesBefore).toBeLessThanOrEqual(1);
      expect(f.element.scrollTop).toBeGreaterThanOrEqual(previous);
      if (timestamp === 320) {
        expect(f.element.scrollTop).toBeGreaterThan(300);
        expect(f.element.scrollTop).toBeLessThan(940);
      }
      if (timestamp === 608) expect(f.element.scrollTop).toBe(940);
      previous = f.element.scrollTop;
      f.event("scroll");
      expect(f.anchor.isPinned()).toBe(true);
    }
  });
  test("following a streamed append moves across frames and reaches bottom within 300ms", () => {
    const f = fixture(() => "smooth");
    f.owner.request(); f.flush(0);
    expect(f.element.scrollTop).toBe(300);

    // A streamed layout adds 586px below the reader. Sample the actual scroll
    // position, not animation state: following must not teleport to the end.
    f.grow(1186); f.owner.request(true);
    const positions: number[] = [];
    for (const timestamp of [...Array.from({ length: 18 }, (_, index) => (index + 1) * 16), 300]) {
      const writesBefore = f.writes.length;
      f.flush(timestamp);
      expect(f.writes.length - writesBefore).toBeLessThanOrEqual(1);
      positions.push(f.element.scrollTop);
      // Browsers report programmatic writes through the same public event seam.
      f.event("scroll");
    }

    expect(positions[0]).toBeLessThan(886);
    expect(new Set(positions.filter(top => top > 300 && top < 886)).size).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < positions.length; index++) {
      expect(positions[index]).toBeGreaterThanOrEqual(positions[index - 1]!);
    }
    expect(f.element.scrollTop).toBe(886);
  });
  for (const end of ["release", "cancel", "latest", "pause", "detach"] as const) test(`hold identity query after ${end}`, () => {
    const f = fixture();
    const field = f.document.createElement("input") as unknown as HTMLElement;
    const other = f.document.createElement("input") as unknown as HTMLElement;
    f.element.append(field, other);
    expect(f.owner.isHolding(field)).toBe(false);
    f.owner.hold(field);
    expect(f.owner.isHolding(field)).toBe(true);
    expect(f.owner.isHolding(other)).toBe(false);
    if (end === "detach") field.remove();
    else f.owner[end]();
    expect(f.owner.isHolding(field)).toBe(false);
  });
  for (const pinned of [true, false]) test(`answer release preserves original following=${pinned}`, () => {
    const f = fixture();
    if (!pinned) f.owner.pause();
    stubRect(f.element, () => ({ top: 0, bottom: 300 }));
    const field = f.document.createElement("input"); f.element.append(field);
    stubRect(field, () => ({ top: 450 - f.element.scrollTop, bottom: 470 - f.element.scrollTop }));
    f.owner.hold(field as unknown as HTMLElement); f.flush();
    expect(f.element.scrollTop).toBe(170);
    f.owner.release();
    f.grow(470); f.event("scroll"); f.owner.request(); f.flush();
    f.grow(800); f.owner.request(true); f.flush();
    expect(f.anchor.isPinned()).toBe(pinned);
    expect(f.element.scrollTop).toBe(pinned ? 500 : 170);
  });
  for (const type of ["radio", "checkbox"]) test(`${type} drags pause following`, () => {
    const f = fixture();
    const field = f.document.createElement("input"); field.setAttribute("type", type); f.element.append(field);
    f.owner.latest();
    f.eventAt(field, "touchstart", { touches: [{ clientY: 100 }] });
    f.eventAt(field, "touchmove", { touches: [{ clientY: 140 }] });
    expect(f.anchor.isPinned()).toBe(false);
    expect(f.frames.size).toBe(0);
  });
  for (const action of ["cancel", "pause"] as const) test(`${action} ends the hold without stale follow restoration`, () => {
    const f = fixture();
    stubRect(f.element, () => ({ top: 0, bottom: 300 }));
    const field = f.document.createElement("input"); f.element.append(field);
    stubRect(field, () => ({ top: 450 - f.element.scrollTop, bottom: 470 - f.element.scrollTop }));
    f.owner.hold(field as unknown as HTMLElement); f.flush();
    f.owner[action]();
    expect(f.frames.size).toBe(0);
    f.owner.beforeMutation("line");
    f.owner.release();
    f.grow(800); f.owner.request(true); f.flush();
    expect(f.anchor.isPinned()).toBe(action === "cancel");
    expect(f.element.scrollTop).toBe(action === "cancel" ? 500 : 170);
  });
  for (const end of ["latest", "detach", "release"] as const) test(`${end} retires the held target and pending reveal`, () => {
    const f = fixture();
    stubRect(f.element, () => ({ top: 0, bottom: 300 }));
    const field = f.document.createElement("input"); f.element.append(field);
    stubRect(field, () => ({ top: 450 - f.element.scrollTop, bottom: 470 - f.element.scrollTop }));
    f.owner.hold(field as unknown as HTMLElement); f.flush();
    f.move(100); f.event("scroll");
    if (end === "detach") field.remove();
    else f.owner[end]();
    f.flush();
    expect(f.element.scrollTop).toBe(300);
    f.move(80); f.event("scroll");
    expect(f.anchor.isPinned()).toBe(false);
    expect(f.frames.size).toBe(0);
    expect(f.element.scrollTop).toBe(80);
  });
  test("upward scrolling without a wheel event still pauses when revealing content changes the extent", () => {
    const f = fixture();
    f.grow(800);
    f.move(100);
    f.event("scroll");
    expect(f.anchor.isPinned()).toBe(false);
    f.owner.request(true);
    f.flush();
    expect(f.element.scrollTop).toBe(100);
    expect(f.anchor.hasUnseen()).toBe(true);
  });
  test("explicit latest survives native viewport-resize scrolling after composer submission", () => {
    const f = fixture();
    // Replay the browser's event ordering: Send has explicitly resumed
    // following, then its composer/dock resize moves the native scroll offset
    // upward without any wheel, touch, scrollbar or keyboard input.
    f.resize(606); f.grow(1608); f.owner.latest(); f.flush();
    expect(f.element.scrollTop).toBe(1002);
    f.resize(568); f.move(982); f.event("scroll");
    expect(f.anchor.isPinned()).toBe(true);
    expect(f.frames.size).toBe(1);
    f.flush();
    expect(f.element.scrollTop).toBe(1040);
    expect(f.writes).toEqual([1002, 1040]);
  });
  for (const gesture of ["wheel", "touch", "keyboard", "scrollbar"] as const) test(`${gesture} upward intent wins over a simultaneous viewport resize`, () => {
    const f = fixture();
    f.resize(606); f.grow(1608); f.owner.latest(); f.flush();
    if (gesture === "wheel") f.event("wheel", { deltaY: -20 });
    if (gesture === "touch") { f.event("touchstart", { touches: [{ clientY: 100 }] }); f.event("touchmove", { touches: [{ clientY: 120 }] }); }
    if (gesture === "keyboard") f.event("keydown", { key: "PageUp" });
    if (gesture === "scrollbar") {
      Object.defineProperties(f.element, { clientWidth: { value: 200 }, clientLeft: { value: 0 } });
      Object.defineProperty(f.element, "getBoundingClientRect", { value: () => ({ left: 0, right: 216 }) });
      f.event("pointerdown", { pointerType: "mouse", clientX: 208 });
    }
    f.resize(568); f.move(982); f.event("scroll"); f.owner.request(true); f.flush();
    expect(f.anchor.isPinned()).toBe(false);
    expect(f.element.scrollTop).toBe(982);
  });
  test("remote dock resizing preserves the paused semantic anchor instead of resuming following", () => {
    const f = fixture();
    f.resize(606); f.grow(1686); f.move(377); f.owner.pause(); f.owner.request(); f.flush();
    f.resize(568); f.grow(1608); f.owner.request(true); f.flush();
    expect(f.anchor.isPinned()).toBe(false);
    expect(f.anchor.hasUnseen()).toBe(true);
    expect(f.element.scrollTop).toBe(377);
  });
  test("only native scrollbar gutters, not content clicks, interrupt pinned resize following", () => {
    const f = fixture();
    Object.defineProperties(f.element, { clientWidth: { value: 200 }, clientLeft: { value: 16 } });
    Object.defineProperty(f.element, "getBoundingClientRect", { value: () => ({ left: 0, right: 216 }) });
    f.owner.latest(); f.flush();
    f.event("pointerdown", { pointerType: "mouse", clientX: 100 });
    expect(f.anchor.isPinned()).toBe(true);
    f.event("pointerdown", { pointerType: "touch", clientX: 8 });
    expect(f.anchor.isPinned()).toBe(true);
    // A native left-side scrollbar (e.g. RTL) owns the same explicit intent.
    f.event("pointerdown", { pointerType: "mouse", clientX: 8 });
    expect(f.anchor.isPinned()).toBe(false);
    f.owner.dispose(); f.owner.latest();
    f.anchor.jumpToLatest({ scrollTop: 300, clientHeight: 300, scrollHeight: 600, items: [] });
    f.event("pointerdown", { pointerType: "mouse", clientX: 8 });
    expect(f.anchor.isPinned()).toBe(true);
  });
  test("an unconsumed upward gesture cannot replace the reading anchor on a later clamp", () => {
    const f = fixture();
    f.move(240); f.owner.pause();
    f.grow(400); f.event("scroll"); f.owner.request(); f.flush();
    expect(f.element.scrollTop).toBe(100);
    expect(f.anchor.isPinned()).toBe(false);
    f.grow(600); f.owner.request(); f.flush();
    expect(f.element.scrollTop).toBe(240);
  });
  test("a correction retires earlier upward intent before a downward arrival", () => {
    const f = fixture();
    f.move(200); f.owner.pause(); f.owner.request(); f.flush();
    f.move(300); f.event("scroll");
    expect(f.anchor.isPinned()).toBe(true);
  });
  test("cancelling transient upward intent permits the first downward arrival after explicit positioning", () => {
    const f = fixture();
    f.event("keydown", { key: "Home" });
    f.owner.cancel();
    f.anchor.restore({ itemId: "line", offset: 0 });
    f.owner.request(); f.flush(); f.event("scroll");
    expect(f.anchor.isPinned()).toBe(false);
    f.event("wheel", { deltaY: 300 }); f.move(300); f.event("scroll");
    expect(f.anchor.isPinned()).toBe(true);
  });
  test("hide cancellation clears only transient intent, preserving the paused anchor on return", () => {
    const f = fixture();
    f.move(100); f.owner.pause(); f.owner.cancel(); f.hide();
    f.show(); f.owner.request(); f.flush();
    expect(f.anchor.isPinned()).toBe(false);
    f.event("wheel", { deltaY: 200 }); f.move(300); f.event("scroll");
    expect(f.anchor.isPinned()).toBe(true);
  });
  test("coalesces sources, reads final geometry, and preserves horizontal position", () => {
    const f = fixture();
    f.element.scrollLeft = 27;
    f.owner.request(true); f.owner.request(); f.grow(700); f.owner.request(); f.grow(800);
    expect(f.frames.size).toBe(1);
    f.flush();
    expect(f.writes).toEqual([500]);
    expect(f.element.scrollLeft).toBe(27);
    f.event("scroll"); f.owner.request(); f.flush();
    expect(f.writes).toEqual([500]);
  });
  test("an upward wheel cancels a latest correction before the default scroll", () => {
    const f = fixture();
    f.owner.pause(); f.move(200); f.event("scroll");
    f.owner.latest();
    f.event("wheel", { deltaY: -4 });
    expect(f.frames.size).toBe(0);
    expect(f.anchor.isPinned()).toBe(false);
    f.move(196); f.event("scroll"); f.grow(800); f.owner.request(true); f.flush();
    expect(f.element.scrollTop).toBe(196);
    expect(f.anchor.hasUnseen()).toBe(true);
  });
  test("touch and keyboard upward intent cancel pending frames", () => {
    const f = fixture();
    f.owner.latest();
    f.event("touchstart", { touches: [{ clientY: 100 }] });
    f.event("touchmove", { touches: [{ clientY: 104 }] });
    expect(f.anchor.isPinned()).toBe(false);
    expect(f.frames.size).toBe(0);
    f.owner.latest(); f.event("keydown", { key: "PageUp" });
    expect(f.anchor.isPinned()).toBe(false);
    expect(f.frames.size).toBe(0);
  });
  test("a touch gesture inside a text control does not move the conversation", () => {
    const f = fixture();
    const input = f.document.createElement("input");
    f.element.append(input);
    f.owner.latest();
    expect(f.anchor.isPinned()).toBe(true);
    f.eventAt(input as unknown as { dispatchEvent(event: Event): boolean }, "touchstart", { touches: [{ clientY: 100 }] });
    f.eventAt(input as unknown as { dispatchEvent(event: Event): boolean }, "touchmove", { touches: [{ clientY: 140 }] });
    expect(f.anchor.isPinned()).toBe(true);
    expect(f.frames.size).toBe(1);
    f.event("touchstart", { touches: [{ clientY: 100 }] });
    f.event("touchmove", { touches: [{ clientY: 140 }] });
    expect(f.anchor.isPinned()).toBe(false);
    expect(f.frames.size).toBe(0);
  });
  test("delayed and repeated programmatic echoes retain a paused near-end anchor", () => {
    const f = fixture();
    f.anchor.restore({ itemId: "line", offset: -280 });
    f.owner.request(); f.flush();
    f.event("scroll"); f.event("scroll");
    expect(f.anchor.isPinned()).toBe(false);
    f.grow(700); f.owner.request(true); f.flush();
    expect(f.element.scrollTop).toBe(280);
  });
  test("clamping a paused reader to bottom does not resume on delayed echoes or regrowth", () => {
    const f = fixture();
    f.owner.pause(); f.move(296); f.event("scroll");
    f.grow(400); f.event("scroll"); f.owner.request(); f.flush(); f.event("scroll");
    expect(f.anchor.isPinned()).toBe(false);
    f.grow(800); f.owner.beforeMutation(); f.owner.request(true); f.flush();
    expect(f.anchor.isPinned()).toBe(false);
    expect(f.element.scrollTop).toBeLessThan(500);
  });
  test("multiple prepends retain the original semantic offset until correction", () => {
    const f = fixture();
    f.owner.pause(); f.move(100); f.event("scroll");
    f.owner.beforeMutation(); f.shift(100); f.grow(700); f.owner.request();
    f.owner.beforeMutation(); f.shift(200); f.grow(800); f.owner.request(); f.flush();
    expect(f.element.scrollTop).toBe(300);
    expect(f.writes).toEqual([300]);
  });
  test("latest moves immediately in one frame and follows further appends", () => {
    const f = fixture();
    f.owner.pause(); f.move(100); f.event("scroll"); f.owner.latest(); f.grow(800); f.flush();
    expect(f.element.scrollTop).toBe(500);
    expect(f.anchor.isPinned()).toBe(true);
    f.grow(900); f.owner.request(true); f.flush();
    expect(f.writes).toEqual([500, 600]);
  });
  test("hidden, cancelled, and disposed owners do not write stale work", () => {
    const f = fixture();
    f.owner.request(); f.grow(700); f.owner.cancel(); f.flush();
    expect(f.writes).toEqual([]);
    f.owner.request(); f.hide(); f.flush();
    expect(f.writes).toEqual([]);
    f.owner.dispose(); f.owner.latest(); f.flush();
    expect(f.writes).toEqual([]);
  });
  test("one owner per element; disposal releases ownership", () => {
    const f = fixture();
    expect(() => new CoordinatedScrollOwner(f.element, f.options)).toThrow("already has");
    f.owner.dispose();
    const replacement = new CoordinatedScrollOwner(f.element, f.options);
    replacement.dispose();
  });
  test("nested owner input pauses only the scroller receiving it", () => {
    const parent = fixture();
    const child = fixture();
    parent.element.append(child.element);
    parent.owner.latest(); child.owner.latest();
    child.event("wheel", { deltaY: -4 });
    expect(child.anchor.isPinned()).toBe(false);
    expect(parent.anchor.isPinned()).toBe(true);
    expect(child.frames.size).toBe(0);
    expect(parent.frames.size).toBe(1);
  });
  test("render and resize callbacks sharing a frame cannot spend two corrections", () => {
    const f = fixture();
    f.grow(700); f.owner.request(); f.owner.flush(100);
    f.grow(800); f.owner.request(); f.owner.flush(100);
    expect(f.writes).toEqual([400]);
    expect(f.frames.size).toBe(1);
    f.owner.flush(116);
    expect(f.writes).toEqual([400, 500]);
  });
  test("revealing a focused control is one write, and the anchor then holds it", () => {
    const f = fixture();
    // linkedom lays nothing out, so the two rectangles this reveal reasons
    // about are stubbed: a 300px client box at the top of the page, and a
    // field sitting 60px below its bottom edge.
    stubRect(f.element, () => ({ top: 0, bottom: 300 }));
    const field = f.document.createElement("input");
    f.element.append(field);
    let fieldTop = 340;
    stubRect(field, () => ({ top: fieldTop, bottom: fieldTop + 20 }));
    // A reader parked mid-transcript: the anchor's own correction is a no-op,
    // so any write in this frame is the reveal's.
    f.grow(900); f.move(300); f.owner.pause();

    f.owner.reveal(field as unknown as HTMLElement);
    expect(f.frames.size).toBe(1);
    f.flush();
    expect(f.writes).toEqual([360]);

    // The reveal re-captured through the anchor, so the next correction holds
    // the revealed position instead of snapping back to where it was.
    f.owner.request(); f.flush();
    expect(f.writes).toEqual([360]);
    expect(f.element.scrollTop).toBe(360);
    expect(f.anchor.isPinned()).toBe(false);

    // Already inside the box: nothing to reveal, nothing written.
    fieldTop = 100;
    f.owner.reveal(field as unknown as HTMLElement);
    f.flush();
    expect(f.writes).toEqual([360]);
  });
  test("a reveal clears the software keyboard, not just the scroller's own box", () => {
    const f = fixture();
    // The same 300px client box as above, with the field 30px above its
    // bottom edge — inside the box, so the box alone asks for no move. The
    // keyboard covers everything below 200: that is where the field really is.
    stubRect(f.element, () => ({ top: 0, bottom: 300 }));
    const field = f.document.createElement("input");
    f.element.append(field);
    stubRect(field, () => ({ top: 250, bottom: 270 }));
    f.grow(900); f.move(300); f.owner.pause();

    f.owner.reveal(field as unknown as HTMLElement);
    f.flush();
    expect(f.writes).toEqual([]);

    withVisibleBand({ height: 200, offsetTop: 0 }, () => {
      f.owner.reveal(field as unknown as HTMLElement);
      f.flush();
    });
    expect(f.writes).toEqual([370]);
  });
  test("an end-aligned reveal puts the field and its answer controls at the bottom of the band", () => {
    const f = fixture();
    // The 300px client box again, with the keyboard covering everything below
    // 200. The field is already inside that band — high in it, where WebKit's
    // own focus scroll tends to leave it — so the minimal move has nothing to
    // do and the strip below the answer controls stays empty.
    stubRect(f.element, () => ({ top: 0, bottom: 300 }));
    const field = f.document.createElement("input");
    const actions = f.document.createElement("div");
    f.element.append(field, actions);
    stubRect(field, () => ({ top: 50, bottom: 70 }));
    stubRect(actions, () => ({ top: 80, bottom: 110 }));
    f.grow(900); f.move(300); f.owner.pause();

    withVisibleBand({ height: 200, offsetTop: 0 }, () => {
      f.owner.reveal(field as unknown as HTMLElement, { extent: actions as unknown as HTMLElement });
      f.flush();
      expect(f.writes).toEqual([]);

      // Held: field and answer controls are placed as one block, with the
      // block's bottom on the band's bottom, so the conversation fills
      // everything above it and nothing is left under the buttons.
      f.owner.hold(field as unknown as HTMLElement, { extent: actions as unknown as HTMLElement });
      f.flush();
      expect(f.writes).toEqual([210]);

      // Clamped by the scroller's own range: with only 40px of conversation
      // above it the scroller stops where it runs out rather than overscrolling.
      f.move(40); f.owner.pause();
      f.owner.hold(field as unknown as HTMLElement, { extent: actions as unknown as HTMLElement });
      f.flush();
      expect(f.writes).toEqual([210, 0]);
    });
  });
  test("an extent taller than the band aligns to its top instead", () => {
    const f = fixture();
    // A question whose field and answer controls together outrun the band:
    // putting the buttons on the band's bottom would scroll the question
    // itself out of view, so the block's top is what is aligned.
    stubRect(f.element, () => ({ top: 0, bottom: 300 }));
    const field = f.document.createElement("input");
    const actions = f.document.createElement("div");
    f.element.append(field, actions);
    stubRect(field, () => ({ top: 50, bottom: 70 }));
    stubRect(actions, () => ({ top: 80, bottom: 400 }));
    f.grow(900); f.move(300); f.owner.pause();

    withVisibleBand({ height: 200, offsetTop: 0 }, () => {
      f.owner.hold(field as unknown as HTMLElement, { extent: actions as unknown as HTMLElement });
      f.flush();
    });
    expect(f.writes).toEqual([350]);
  });
  test("a held control is put back after a scroll the owner did not write", () => {
    const f = fixture();
    // As in the reveal case above: a 300px client box at the top of the page.
    // This field's rectangle moves with the scroller, as a laid-out element
    // does — which is what makes the re-reveal after a foreign scroll a real
    // measurement rather than a replay of the first one.
    stubRect(f.element, () => ({ top: 0, bottom: 300 }));
    const field = f.document.createElement("input");
    f.element.append(field);
    stubRect(field, () => ({ top: 640 - f.element.scrollTop, bottom: 660 - f.element.scrollTop }));
    f.grow(900); f.move(300); f.owner.pause();

    f.owner.hold(field as unknown as HTMLElement);
    f.flush();
    expect(f.writes).toEqual([360]);
    // The echo of our own write: the held position is the one we are at, so
    // there is nothing to undo and no frame to spend.
    f.event("scroll");
    expect(f.frames.size).toBe(0);
    expect(f.writes).toEqual([360]);

    // WebKit autoscrolling the transcript while the caret is dragged: one
    // frame, one write, and the field is inside the box again.
    f.move(60);
    f.event("scroll");
    expect(f.frames.size).toBe(1);
    expect(f.anchor.isPinned()).toBe(false);
    f.flush();
    expect(f.writes).toEqual([360, 360]);
    expect(f.element.scrollTop).toBe(360);
    f.event("scroll");
    expect(f.frames.size).toBe(0);
    expect(f.writes).toEqual([360, 360]);

    // Released on blur: the scroller is left where it stands, and a foreign
    // scroll is the reader's again.
    f.owner.release();
    expect(f.element.scrollTop).toBe(360);
    f.move(60);
    f.event("scroll");
    expect(f.frames.size).toBe(0);
    expect(f.element.scrollTop).toBe(60);
    expect(f.writes).toEqual([360, 360]);
  });
  test("upward input with concurrent layout growth captures the actual reader position", () => {
    const f = fixture();
    f.event("wheel", { deltaY: -4 }); f.grow(700); f.move(296); f.event("scroll");
    f.owner.request(true); f.flush();
    expect(f.element.scrollTop).toBe(296);
    expect(f.anchor.isPinned()).toBe(false);
    f.move(390); f.event("scroll");
    expect(f.anchor.isPinned()).toBe(true);
    f.move(400); f.event("scroll");
    expect(f.anchor.isPinned()).toBe(true);
    f.flush(); expect(f.element.scrollTop).toBe(400);
  });
});
