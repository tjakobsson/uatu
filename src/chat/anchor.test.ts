import { describe, expect, test } from "bun:test";
import { TimelineAnchorController, type AnchorGeometry } from "./anchor";

const geometry = (scrollTop: number, scrollHeight = 600, tops = [0, 100, 200]): AnchorGeometry => ({
  scrollTop, clientHeight: 300, scrollHeight,
  items: tops.map((top, index) => ({ id: `i${index}`, top, bottom: top + 100 })),
});

describe("semantic timeline anchoring", () => {
  test("follows streaming only while pinned and reports unseen content otherwise", () => {
    const controller = new TimelineAnchorController();
    controller.observe(geometry(300));
    expect(controller.afterMutation(geometry(300, 700), true)).toBe(400);
    controller.observe(geometry(100, 700, [-100, 0, 100]));
    controller.beforeMutation(geometry(100, 700, [-100, 0, 100]));
    expect(controller.afterMutation(geometry(100, 800, [-100, 0, 100]), true)).toBe(100);
    expect(controller.hasUnseen()).toBe(true);
    expect(controller.jumpToLatest(geometry(100, 800))).toBe(500);
  });

  test("any upward step unpins, while arriving near the end pins", () => {
    const controller = new TimelineAnchorController();
    controller.observe(geometry(300));
    expect(controller.isPinned()).toBe(true);
    // Twelve pixels up is inside the near-end threshold, but it is the reader
    // leaving: the next streamed frame must not pull them back.
    controller.observe(geometry(288), "up");
    expect(controller.isPinned()).toBe(false);
    expect(controller.afterMutation(geometry(288, 700), true)).toBe(288);
    expect(controller.hasUnseen()).toBe(true);
    // Coming back down to within the threshold follows the stream again.
    controller.observe(geometry(360, 700), "down");
    expect(controller.isPinned()).toBe(true);
    expect(controller.hasUnseen()).toBe(false);
  });

  test("an event that moved nothing changes no pin state", () => {
    const controller = new TimelineAnchorController();
    controller.observe(geometry(300));
    controller.observe(geometry(288), "up");
    expect(controller.isPinned()).toBe(false);
    controller.observe(geometry(288), "none");
    expect(controller.isPinned()).toBe(false);
  });

  test("a clamped decrease that keeps the end in view stays pinned", () => {
    const controller = new TimelineAnchorController();
    controller.observe(geometry(300));
    // Content above the viewport shrank and the browser clamped scrollTop to
    // the new maximum: the end is still in view, so nobody left.
    controller.observe(geometry(250, 550), "up");
    expect(controller.isPinned()).toBe(true);
  });

  test("the echo of a restored near-end position does not re-pin", () => {
    const controller = new TimelineAnchorController();
    // A reader who left by 30px, saved, and came back after a reload: the
    // restore lands 30px above the end, inside the near-end threshold.
    controller.restore({ itemId: "i1", offset: 20 });
    const restored = geometry(370, 700, [-80, 20, 120]);
    expect(controller.afterMutation(restored)).toBe(370);
    // The assignment echoes as a scroll that is not upward relative to
    // whatever the handler last saw. It is not the reader arriving.
    controller.observe(restored);
    expect(controller.isPinned()).toBe(false);
    expect(controller.currentAnchor()).not.toBeNull();
    // A reader scroll to the same neighbourhood afterwards does pin.
    controller.observe(geometry(372, 700, [-82, 18, 118]));
    expect(controller.isPinned()).toBe(true);
  });

  test("restores a visible item offset across prepend and delayed resize", () => {
    const controller = new TimelineAnchorController();
    controller.observe(geometry(100, 700, [-20, 80, 180]));
    controller.beforeMutation(geometry(100, 700, [-20, 80, 180]));
    expect(controller.currentAnchor()).toEqual({ itemId: "i0", offset: -20 });
    expect(controller.afterMutation(geometry(100, 900, [130, 230, 330]))).toBe(250);
  });

  test("anchors the explicitly expanded activity", () => {
    const controller = new TimelineAnchorController();
    controller.observe(geometry(100, 700, [-80, 20, 120]));
    controller.beforeMutation(geometry(100, 700, [-80, 20, 120]), "i1");
    expect(controller.afterMutation(geometry(100, 800, [-80, 70, 220]))).toBe(150);
  });

  test("a blank measurement keeps a restored anchor waiting", () => {
    const controller = new TimelineAnchorController();
    controller.restore({ itemId: "i1", offset: 20 });
    // A render before the surface has a size measures nothing at all.
    expect(controller.afterMutation({ scrollTop: 0, clientHeight: 0, scrollHeight: 0, items: [] })).toBe(0);
    expect(controller.isPinned()).toBe(false);
    expect(controller.currentAnchor()).toEqual({ itemId: "i1", offset: 20 });
    // The first real measurement restores the position.
    expect(controller.afterMutation(geometry(0, 700, [-80, 20, 120]))).toBe(0);
    expect(controller.afterMutation(geometry(0, 700, [-40, 60, 160]))).toBe(40);
  });

  test("falls back to latest when a restored item is no longer in the page", () => {
    const controller = new TimelineAnchorController();
    controller.restore({ itemId: "missing", offset: 20 });
    expect(controller.afterMutation(geometry(75, 900))).toBe(600);
    expect(controller.isPinned()).toBe(true);
  });
});
