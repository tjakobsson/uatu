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
    controller.observe(geometry(288), true);
    expect(controller.isPinned()).toBe(false);
    expect(controller.afterMutation(geometry(288, 700), true)).toBe(288);
    expect(controller.hasUnseen()).toBe(true);
    // Coming back down to within the threshold follows the stream again.
    controller.observe(geometry(360, 700));
    expect(controller.isPinned()).toBe(true);
    expect(controller.hasUnseen()).toBe(false);
  });

  test("a clamped decrease that keeps the end in view stays pinned", () => {
    const controller = new TimelineAnchorController();
    controller.observe(geometry(300));
    // Content above the viewport shrank and the browser clamped scrollTop to
    // the new maximum: the end is still in view, so nobody left.
    controller.observe(geometry(250, 550), true);
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

  test("falls back to latest when a restored item is no longer in the page", () => {
    const controller = new TimelineAnchorController();
    controller.restore({ itemId: "missing", offset: 20 });
    expect(controller.afterMutation(geometry(75, 900))).toBe(600);
    expect(controller.isPinned()).toBe(true);
  });
});
