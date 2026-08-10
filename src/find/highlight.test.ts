// Reveal arithmetic against a viewport-shaped scroll container.
//
// This is the one part of the scroll-root work that desktop can never
// exercise: on desktop the container is `.preview-shell`, an ordinary
// overflow box whose `getBoundingClientRect()` IS its visible box. When the
// page scrolls instead, the container is `<html>`, whose rect describes the
// whole document — feeding that to the same arithmetic makes every match look
// like it is already in view, so nothing scrolls and the highlight paints in
// place. That is #181, and it is invisible to every existing test.
//
// The containers here are fakes rather than a DOM, deliberately: the unit
// suite's DOM has no layout, so a "real" element would have a zero rect and
// assert nothing. What is under test is the geometry, and the geometry is
// exactly what the fakes supply.
//
// `scrollportRect` itself is covered in shell/preview-scroll-root.test.ts,
// where it lives.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { revealRange } from "./highlight";

const PADDING_TOP = 144; // 9rem at a 16px root — the sticky-header reservation.
const VIEWPORT_HEIGHT = 800;
const DOCUMENT_HEIGHT = 5000;

type Rect = { top: number; bottom: number; height: number; width: number };

function rect(top: number, height: number): Rect {
  return { top, bottom: top + height, height, width: 100 };
}

// A container that IS its document's scroller — the touch-mode / stacked case.
// Its bounding rect is the whole document, scrolled: precisely the value that
// must NOT be used as the visible box.
function viewportContainer(scrollTop = 0) {
  const container = {
    scrollTop,
    getBoundingClientRect: () => rect(-scrollTop, DOCUMENT_HEIGHT),
  } as unknown as HTMLElement & { scrollTop: number };
  (container as unknown as { ownerDocument: unknown }).ownerDocument = {
    scrollingElement: container,
    documentElement: { clientHeight: VIEWPORT_HEIGHT },
  };
  return container;
}

// An ordinary overflow container — the desktop `.preview-shell` case.
function elementContainer(top = 0, height = VIEWPORT_HEIGHT, scrollTop = 0) {
  const container = {
    scrollTop,
    getBoundingClientRect: () => rect(top, height),
  } as unknown as HTMLElement & { scrollTop: number };
  (container as unknown as { ownerDocument: unknown }).ownerDocument = {
    scrollingElement: { notThisElement: true },
    documentElement: { clientHeight: VIEWPORT_HEIGHT },
  };
  return container;
}

function rangeAt(top: number, height = 20): Range {
  return { getBoundingClientRect: () => rect(top, height) } as unknown as Range;
}

const originalGetComputedStyle = (globalThis as Record<string, unknown>).getComputedStyle;

beforeAll(() => {
  (globalThis as Record<string, unknown>).getComputedStyle = () => ({
    scrollPaddingTop: `${PADDING_TOP}px`,
  });
});

afterAll(() => {
  (globalThis as Record<string, unknown>).getComputedStyle = originalGetComputedStyle;
});

describe("revealRange", () => {
  test("scrolls a match below the fold when the page is the scroller", () => {
    // The regression this whole change exists for: with the document box as
    // the visible box, `rect.bottom (1220) <= view.bottom (5000)` reads as
    // "already visible" and this stays 0.
    const container = viewportContainer();
    revealRange(rangeAt(1200), container);
    expect(container.scrollTop).toBeGreaterThan(0);
  });

  test("lands the match at the same offset as an equivalent element scroller", () => {
    // Desktop and touch must land in the same place for the same geometry —
    // the point of resolving the container rather than branching on mode.
    const viewport = viewportContainer();
    const element = elementContainer(0, VIEWPORT_HEIGHT);
    revealRange(rangeAt(1200), viewport);
    revealRange(rangeAt(1200), element);
    expect(viewport.scrollTop).toBe(element.scrollTop);
  });

  test("honours the sticky-header reservation", () => {
    // usable = 800 - 144; target = 1200 - 144 - (656 - 20) * 0.4
    const container = viewportContainer();
    revealRange(rangeAt(1200), container);
    expect(container.scrollTop).toBeCloseTo(1200 - PADDING_TOP - (VIEWPORT_HEIGHT - PADDING_TOP - 20) * 0.4, 5);
  });

  test("leaves a match that is already comfortably in view alone", () => {
    const container = viewportContainer();
    revealRange(rangeAt(300), container);
    expect(container.scrollTop).toBe(0);
  });

  test("scrolls a match hiding under the sticky header", () => {
    // Inside the viewport by raw coordinates, but above the reservation — the
    // case `scroll-padding-top` exists for.
    const container = viewportContainer();
    revealRange(rangeAt(PADDING_TOP - 40), container);
    expect(container.scrollTop).toBeLessThan(0);
  });

  test("ignores a collapsed range rather than scrolling somewhere arbitrary", () => {
    const container = viewportContainer();
    const collapsed = { getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0, width: 0 }) } as unknown as Range;
    revealRange(collapsed, container);
    expect(container.scrollTop).toBe(0);
  });
});
