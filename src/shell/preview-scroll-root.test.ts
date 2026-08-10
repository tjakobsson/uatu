// The scroll-root resolution rule.
//
// Only the rule is unit-testable here: the unit suite's DOM (linkedom) has no
// `getComputedStyle`, no `scrollingElement` and no `clientHeight`, so a test
// that stood up a fake cascade would be asserting against its own fake. What
// the rule is wired to — the real touch-mode and ≤900px overrides — is an E2E
// question, covered in tests/e2e/touch-navigation.e2e.ts.

import { describe, expect, test } from "bun:test";

import { pickScrollRoot, scrollportRect } from "./preview-scroll-root";

// Stand-ins for the three candidates. Strings, because the rule never looks
// inside an element — it only asks the predicate.
const PANE = "rendered-pane";
const SHELL = "preview-shell";
const VIEWPORT = "viewport";

function pick(scrollers: string[], candidates?: { renderedPane?: string | null; shell?: string | null }) {
  return pickScrollRoot(
    {
      renderedPane: candidates?.renderedPane === undefined ? null : candidates.renderedPane,
      shell: candidates?.shell === undefined ? SHELL : candidates.shell,
      viewport: VIEWPORT,
    },
    element => scrollers.includes(element),
  );
}

describe("pickScrollRoot", () => {
  test("desktop single layout resolves to the shell", () => {
    // The shell scrolls, there is no split pane: the element every desktop
    // scroll path already targets, so nothing about desktop changes.
    expect(pick([SHELL])).toBe(SHELL);
  });

  test("split layout resolves to the rendered pane", () => {
    expect(pick([PANE, SHELL], { renderedPane: PANE })).toBe(PANE);
  });

  test("a non-scrolling shell resolves to the viewport", () => {
    // Both layouts that hand scrolling to the page reach the rule the same
    // way — `html[data-ui-mode="touch"] .preview-shell { overflow: visible }`
    // and `@media (max-width: 900px) .preview-shell { overflow: visible }`.
    // The rule cannot tell them apart and should not need to: that is what
    // makes it survive a third layout doing the same thing.
    expect(pick([])).toBe(VIEWPORT);
  });

  test("a split pane that does not scroll falls through to the shell", () => {
    expect(pick([SHELL], { renderedPane: PANE })).toBe(SHELL);
  });

  test("a split pane that does not scroll in touch mode falls through to the viewport", () => {
    expect(pick([], { renderedPane: PANE })).toBe(VIEWPORT);
  });

  test("a missing shell resolves to the viewport rather than throwing", () => {
    expect(pick([SHELL], { shell: null })).toBe(VIEWPORT);
  });

  test("the viewport terminates the search without being asked", () => {
    // It is always a scroller, so the predicate is never consulted for it —
    // which matters because `document.scrollingElement` has no meaningful
    // `overflow-y` of its own.
    const asked: string[] = [];
    const result = pickScrollRoot({ renderedPane: null, shell: SHELL, viewport: VIEWPORT }, element => {
      asked.push(element);
      return false;
    });
    expect(result).toBe(VIEWPORT);
    expect(asked).toEqual([SHELL]);
  });
});

// --- scrollportRect ---------------------------------------------------------
//
// The visible box of a container, which for the document scroller is NOT its
// bounding rect. Fakes rather than a DOM for the same reason as above: the
// unit suite has no layout, so a real element's rect is all zeroes and would
// assert nothing about the distinction being drawn.

const VIEWPORT_HEIGHT = 800;
const DOCUMENT_HEIGHT = 5000;

function viewportContainer(scrollTop = 0) {
  const container = {
    getBoundingClientRect: () => ({
      top: -scrollTop,
      bottom: DOCUMENT_HEIGHT - scrollTop,
      height: DOCUMENT_HEIGHT,
    }),
  } as unknown as HTMLElement;
  (container as unknown as { ownerDocument: unknown }).ownerDocument = {
    scrollingElement: container,
    documentElement: { clientHeight: VIEWPORT_HEIGHT },
  };
  return container;
}

function elementContainer(top: number, height: number) {
  const container = {
    getBoundingClientRect: () => ({ top, bottom: top + height, height }),
  } as unknown as HTMLElement;
  (container as unknown as { ownerDocument: unknown }).ownerDocument = {
    scrollingElement: { notThisElement: true },
    documentElement: { clientHeight: VIEWPORT_HEIGHT },
  };
  return container;
}

describe("scrollportRect", () => {
  test("reports the layout viewport for the document scroller, not the document box", () => {
    expect(scrollportRect(viewportContainer())).toEqual({
      top: 0,
      bottom: VIEWPORT_HEIGHT,
      height: VIEWPORT_HEIGHT,
    });
  });

  test("stays anchored at the origin however far the page is scrolled", () => {
    // The visible box does not move in viewport coordinates; only the content
    // does. A `top` of -scrollTop here is what would double-count the offset
    // in the outline's activation-point arithmetic.
    expect(scrollportRect(viewportContainer(2400))).toEqual({
      top: 0,
      bottom: VIEWPORT_HEIGHT,
      height: VIEWPORT_HEIGHT,
    });
  });

  test("reports the border box for an ordinary overflow container", () => {
    expect(scrollportRect(elementContainer(64, 600))).toEqual({ top: 64, bottom: 664, height: 600 });
  });
});
