import { describe, expect, test } from "bun:test";
import { TimelineAnchorController, type AnchorGeometry } from "./anchor";

const geometry = (scrollTop: number, scrollHeight = 600, tops = [0, 100, 200]): AnchorGeometry => ({
  scrollTop, clientHeight: 300, scrollHeight,
  items: tops.map((top, index) => ({ id: `i${index}`, top, bottom: top + 100 })),
});

describe("semantic timeline anchoring", () => {
  test("captures only the item box when every visible block key is ambiguous", () => {
    const controller = new TimelineAnchorController();
    controller.pause({
      scrollTop: 100, clientHeight: 300, scrollHeight: 1400,
      items: [{ id: "message", top: -100, bottom: 900, content: [
        { key: "duplicate", top: 40, bottom: 100 },
        { key: "duplicate", top: 120, bottom: 180 },
      ] }],
    });
    expect(controller.currentAnchor()).toEqual({ itemId: "message", offset: -100 });
  });
  test("an explicitly preferred activity anchors its box rather than its visible interior block", () => {
    const controller = new TimelineAnchorController();
    const before = {
      scrollTop: 100, clientHeight: 300, scrollHeight: 1400,
      items: [{ id: "message", top: -100, bottom: 900,
        content: [{ key: "block-12", top: 40, bottom: 100 }] }],
    };
    controller.pause(before);
    controller.beforeMutation(before, "message");
    expect(controller.currentAnchor()).toEqual({ itemId: "message", offset: -100 });
    expect(controller.afterMutation({
      ...before, scrollHeight: 1680,
      items: [{ id: "message", top: -50, bottom: 1180,
        content: [{ key: "block-12", top: 320, bottom: 380 }] }],
    })).toBe(150);
  });
  test("a missing saved block or omitted block measurement falls back to the item offset", () => {
    for (const content of [undefined, [{ key: "other", top: 320, bottom: 380 }]]) {
      const controller = new TimelineAnchorController();
      controller.restore({ itemId: "message", offset: -100, content: { key: "removed", offset: 40 } });
      expect(controller.afterMutation({
        scrollTop: 100, clientHeight: 300, scrollHeight: 1400,
        items: [{ id: "message", top: -60, bottom: 1000, content }],
      })).toBe(140);
      expect(controller.isPinned()).toBe(false);
    }
  });
  test("captures the first visible unambiguous block, skipping duplicates even outside the viewport", () => {
    const controller = new TimelineAnchorController();
    controller.pause({
      scrollTop: 100, clientHeight: 300, scrollHeight: 1400,
      items: [{ id: "message", top: -100, bottom: 900, content: [
        { key: "above", top: -100, bottom: -20 },
        { key: "duplicate", top: 40, bottom: 100 },
        { key: "unique", top: 120, bottom: 180 },
        { key: "duplicate", top: 400, bottom: 460 },
      ] }],
    });
    expect(controller.currentAnchor()).toEqual({
      itemId: "message", offset: -100, content: { key: "unique", offset: 120 },
    });
  });
  test("an ambiguous saved block key falls back to its item rather than either duplicate", () => {
    const controller = new TimelineAnchorController();
    controller.restore({ itemId: "message", offset: -100, content: { key: "duplicate", offset: 40 } });
    expect(controller.afterMutation({
      scrollTop: 100, clientHeight: 300, scrollHeight: 1400,
      items: [{ id: "message", top: -60, bottom: 1000, content: [
        { key: "duplicate", top: 320, bottom: 380 },
        { key: "duplicate", top: 600, bottom: 660 },
      ] }],
    })).toBe(140);
    expect(controller.isPinned()).toBe(false);
  });
  test("legacy restored item anchors remain coarse even when block geometry is available", () => {
    const controller = new TimelineAnchorController();
    controller.restore({ itemId: "message", offset: -100 });
    expect(controller.afterMutation({
      scrollTop: 100, clientHeight: 300, scrollHeight: 1400,
      items: [{ id: "message", top: -60, bottom: 1000,
        content: [{ key: "block-12", top: 320, bottom: 380 }] }],
    })).toBe(140);
    expect(controller.isPinned()).toBe(false);
  });
  test("preserves the visible block when content grows above it inside the same message", () => {
    const controller = new TimelineAnchorController();
    const before = {
      scrollTop: 100, clientHeight: 300, scrollHeight: 1400,
      items: [{ id: "message", top: -100, bottom: 900,
        content: [{ key: "block-12", top: 40, bottom: 100 }] }],
    };
    controller.pause(before);
    controller.beforeMutation(before);
    const after = {
      ...before, scrollHeight: 1680,
      items: [{ id: "message", top: -100, bottom: 1180,
        content: [{ key: "block-12", top: 320, bottom: 380 }] }],
    };
    expect(controller.afterMutation(after, true)).toBe(380);
    expect(controller.currentAnchor()).toEqual({
      itemId: "message", offset: -100, content: { key: "block-12", offset: 40 },
    });
    expect(controller.isPinned()).toBe(false);
  });
  test("downward timeline arrival resumes inclusively within 48px", () => {
    for (const gap of [49, 48, 47.9, 20, 0.4, 0]) {
      const controller = new TimelineAnchorController();
      controller.pause(geometry(200));
      controller.observe(geometry(300 - gap), "down");
      expect(controller.isPinned()).toBe(gap <= 48);
    }
  });
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

  test("any upward step unpins, while arriving at the bottom pins", () => {
    const controller = new TimelineAnchorController();
    controller.observe(geometry(300));
    expect(controller.isPinned()).toBe(true);
    // Twelve pixels up is inside the near-end threshold, but it is the reader
    // leaving: the next streamed frame must not pull them back.
    controller.observe(geometry(288), "up");
    expect(controller.isPinned()).toBe(false);
    expect(controller.afterMutation(geometry(288, 700), true)).toBe(288);
    expect(controller.hasUnseen()).toBe(true);
    // Coming back down within 48px resumes following.
    controller.observe(geometry(360, 700), "down");
    expect(controller.isPinned()).toBe(true);
    controller.observe(geometry(400, 700), "down");
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

  test("fractional downward arrival after a restored-position echo is reader movement", () => {
    const controller = new TimelineAnchorController();
    controller.restore({ itemId: "i0", offset: 0 });
    const restored = geometry(251.8, 600, [0]);
    expect(controller.afterMutation(restored)).toBe(251.8);
    controller.observe(restored, "none");
    controller.observe(restored, "none");
    expect(controller.isPinned()).toBe(false);
    controller.observe(geometry(252.1, 600, [-0.3]), "down");
    expect(controller.isPinned()).toBe(true);
  });

  test("a clamped decrease that keeps the end in view stays pinned", () => {
    const controller = new TimelineAnchorController();
    controller.observe(geometry(300));
    // Content above the viewport shrank and the browser clamped scrollTop to
    // the new maximum: the end is still in view, so nobody left.
    controller.observe(geometry(250, 550), "up");
    expect(controller.isPinned()).toBe(true);
  });

  test("a paused reader remains paused when shrink clamps them to the end", () => {
    const controller = new TimelineAnchorController();
    controller.observe(geometry(300));
    controller.observe(geometry(296), "up");
    controller.observe(geometry(250, 550), "up");
    controller.observe(geometry(250, 550), "none");
    expect(controller.isPinned()).toBe(false);
  });

  test("repeated clamped programmatic echoes preserve paused intent", () => {
    const controller = new TimelineAnchorController();
    controller.restore({ itemId: "i1", offset: -50 });
    controller.afterMutation(geometry(280, 600, [-100, 0, 100]));
    controller.observe(geometry(300), "down");
    controller.observe(geometry(300), "down");
    expect(controller.isPinned()).toBe(false);
  });

  test("removing a live reading anchor does not resume following", () => {
    const controller = new TimelineAnchorController();
    controller.pause(geometry(100));
    expect(controller.afterMutation({ ...geometry(20, 400), items: [{ id: "replacement", top: 0, bottom: 100 }] })).toBe(20);
    expect(controller.isPinned()).toBe(false);
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
    // A real downward reader step inside the band resumes following.
    controller.observe(geometry(372, 700, [-82, 18, 118]));
    expect(controller.isPinned()).toBe(true);
    controller.observe(geometry(400, 700, [-110, -10, 90]));
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
