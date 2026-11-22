import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TimelineAnchorController } from "../chat/anchor";
import { CoordinatedScrollOwner } from "../chat/coordinated-scroll";
import { revealChatRange } from "./chat-reveal";

type FakeScroller = HTMLElement & {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  id: string;
};

function createScroller(options: { id?: string; scrollTop?: number; clientHeight?: number; scrollHeight?: number } = {}): FakeScroller {
  const clientHeight = options.clientHeight ?? 300;
  const scrollHeight = options.scrollHeight ?? 1600;
  const scroller = {
    id: options.id ?? "chat-timeline",
    scrollTop: options.scrollTop ?? 0,
    clientHeight,
    scrollHeight,
    style: {
      getPropertyValue: () => "",
      setProperty: () => {},
      removeProperty: () => {},
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    contains: () => false,
    getBoundingClientRect: () => ({ top: 0, bottom: clientHeight, height: clientHeight, width: 400 }),
    ownerDocument: {
      scrollingElement: {},
      documentElement: { clientHeight },
      activeElement: null,
    },
  };
  return scroller as unknown as FakeScroller;
}

function attachOwner(scroller: FakeScroller, options: { active?: () => boolean; smooth?: boolean } = {}) {
  const anchor = new TimelineAnchorController(0);
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  const owner = new CoordinatedScrollOwner(scroller, {
    anchor,
    active: options.active,
    followMotion: options.smooth ? () => "smooth" : () => "instant",
    measure: () => ({
      scrollTop: scroller.scrollTop,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
      items: [],
    }),
    requestFrame: cb => {
      const id = nextId++;
      frames.set(id, cb);
      return id;
    },
    cancelFrame: id => {
      frames.delete(id);
    },
  });
  const flush = (timestamp = 16) => {
    const entries = [...frames.entries()];
    frames.clear();
    for (const [, cb] of entries) cb(timestamp);
  };
  return { anchor, owner, frames, flush };
}

function rangeAt(top: number, height = 20): Range {
  return {
    getBoundingClientRect: () => ({ top, bottom: top + height, height, width: 80 }),
  } as unknown as Range;
}

const originalGetComputedStyle = (globalThis as Record<string, unknown>).getComputedStyle;

beforeAll(() => {
  (globalThis as Record<string, unknown>).getComputedStyle = () => ({ scrollPaddingTop: "0px" });
});

afterAll(() => {
  (globalThis as Record<string, unknown>).getComputedStyle = originalGetComputedStyle;
});

describe("revealChatRange", () => {
  test("routes active parent and drilldown timeline owners through revealBy and stops catch-up", () => {
    for (const id of ["chat-timeline", "chat-drilldown-timeline"]) {
      const scroller = createScroller({ id, scrollTop: 300, clientHeight: 300, scrollHeight: 600 });
      const { anchor, owner, frames, flush } = attachOwner(scroller, { smooth: true });
      owner.request();
      flush(0);
      expect(scroller.scrollTop).toBe(300);

      scroller.scrollHeight = 1600;
      owner.request(true);
      flush(16);
      flush(64);
      const midCatchup = scroller.scrollTop;
      expect(midCatchup).toBeGreaterThan(300);
      expect(midCatchup).toBeLessThan(1300);
      expect(frames.size).toBe(1);

      // Range sits below the viewport (top: 520 in a 300px viewport).
      revealChatRange(rangeAt(520), scroller);
      expect(scroller.scrollTop).toBeGreaterThan(midCatchup);
      expect(anchor.isPinned()).toBe(false);
      expect(frames.size).toBe(0);
      owner.dispose();
    }
  });

  test("falls back to revealRange when the owner exists but is inactive", () => {
    let active = false;
    const scroller = createScroller({ id: "chat-drilldown-timeline", scrollTop: 100 });
    const { anchor, owner } = attachOwner(scroller, { active: () => active });
    expect(anchor.isPinned()).toBe(true);

    revealChatRange(rangeAt(600), scroller);
    expect(scroller.scrollTop).toBeGreaterThan(100);
    // Inactive owner did not claim or mutate anchor state; direct scroll moved the container.
    expect(anchor.isPinned()).toBe(true);

    active = true;
    owner.dispose();
  });

  test("falls back to revealRange when the container has no coordinated owner", () => {
    const scroller = createScroller({ scrollTop: 50 });
    revealChatRange(rangeAt(600), scroller);
    expect(scroller.scrollTop).toBeGreaterThan(50);
  });

  test("ignores collapsed ranges (null delta) without pausing or scrolling", () => {
    const scroller = createScroller({ scrollTop: 300, clientHeight: 300, scrollHeight: 1600 });
    const { anchor, owner, frames, flush } = attachOwner(scroller, { smooth: true });
    owner.request();
    flush(0);
    scroller.scrollHeight = 2000;
    owner.request(true);
    flush(16);
    const before = scroller.scrollTop;

    const collapsed = { getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0, width: 0 }) } as unknown as Range;
    revealChatRange(collapsed, scroller);
    expect(scroller.scrollTop).toBe(before);
    expect(anchor.isPinned()).toBe(true);
    expect(frames.size).toBe(1);
    owner.dispose();
  });

  test("preserves parent following when an already-visible inline shell viewport is revealed while settled", () => {
    const scroller = createScroller({ scrollTop: 1300, clientHeight: 300, scrollHeight: 1600 });
    const { anchor, owner, flush } = attachOwner(scroller, { smooth: true });
    owner.request();
    flush(0);
    expect(anchor.isPinned()).toBe(true);

    // Inline shell viewport sits completely inside [0, 300].
    revealChatRange(rangeAt(80, 120), scroller);
    expect(anchor.isPinned()).toBe(true);
    expect(scroller.scrollTop).toBe(1300);
    owner.dispose();
  });
});
