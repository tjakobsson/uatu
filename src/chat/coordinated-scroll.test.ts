import { afterEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { TimelineAnchorController } from "./anchor";
import { CoordinatedScrollOwner } from "./coordinated-scroll";

const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose(); });

function fixture() {
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
  const anchor = new TimelineAnchorController();
  const options = {
    anchor, active: () => active,
    measure: () => ({ scrollTop: top, scrollHeight: extent, clientHeight: viewport,
      items: [{ id: "line", top: itemTop - top, bottom: itemTop - top + 1000 }] }),
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
    flush: () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(sequence); },
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
    f.flush(); expect(f.element.scrollTop).toBe(400);
  });
});
