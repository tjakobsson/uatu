import { describe, expect, test } from "bun:test";
import {
  classifyPress,
  classifyTap,
  GestureTracker,
  type GestureIntent,
  type GesturePoint,
} from "./gestures";

function touch(id: number, x: number, y: number, time: number): GesturePoint {
  return { id, x, y, time, type: "touch" };
}

function mouse(id: number, x: number, y: number, time: number): GesturePoint {
  return { id, x, y, time, type: "mouse" };
}

function recorder() {
  const intents: GestureIntent[] = [];
  const tracker = new GestureTracker(intent => intents.push(intent));
  return { tracker, intents, types: () => intents.map(intent => intent.type) };
}

describe("GestureTracker", () => {
  test("one pointer pans by its offset from where the pan started", () => {
    const { tracker, intents } = recorder();
    expect(tracker.down(touch(1, 100, 100, 0))).toBe(true);
    tracker.move(touch(1, 130, 120, 16));
    expect(intents).toEqual([
      { type: "pan-start", x: 100, y: 100 },
      { type: "pan", dx: 30, dy: 20, x: 130, y: 120 },
    ]);
  });

  test("two pointers pinch by separation ratio around their midpoint", () => {
    const { tracker, intents } = recorder();
    tracker.down(touch(1, 100, 100, 0));
    tracker.down(touch(2, 160, 100, 5));
    tracker.move(touch(1, 70, 100, 20));
    tracker.move(touch(2, 190, 100, 20));
    const pinches = intents.filter(intent => intent.type === "pinch");
    expect(pinches.at(-1)).toEqual({ type: "pinch", ratio: 2, x: 130, y: 100 });
    expect(intents.some(intent => intent.type === "pinch-start")).toBe(true);
  });

  // Content moves only through pan and pinch intents (applying them is
  // motion.ts's, see motion.test.ts): a transition emits only the start of
  // the next gesture, from where the fingers are.
  test("1→2→1 finger transitions do not move the content", () => {
    const { tracker, intents } = recorder();
    tracker.down(touch(1, 200, 400, 0));
    tracker.move(touch(1, 230, 430, 16));
    const since = (mark: number) => intents.slice(mark);

    // A second finger lands without either finger moving: only a pinch starts.
    let mark = intents.length;
    tracker.down(touch(2, 300, 500, 32));
    expect(since(mark)).toEqual([{ type: "pinch-start", x: 265, y: 465 }]);
    // …and lifts again: a pan starts where the survivor is.
    mark = intents.length;
    tracker.up(touch(2, 300, 500, 48));
    expect(since(mark)).toEqual([{ type: "pan-start", x: 230, y: 430 }]);

    // The survivor pans from where it is, not from where the first pan began.
    mark = intents.length;
    tracker.move(touch(1, 240, 440, 64));
    expect(since(mark)).toEqual([{ type: "pan", dx: 10, dy: 10, x: 240, y: 440 }]);
  });

  test("a finger lifting out of a pinch resumes panning without a jump", () => {
    const { tracker, intents } = recorder();
    tracker.down(touch(1, 100, 100, 0));
    tracker.down(touch(2, 200, 100, 0));
    tracker.move(touch(2, 300, 100, 16));
    expect(intents.at(-1)).toEqual({ type: "pinch", ratio: 2, x: 200, y: 100 });
    const mark = intents.length;
    tracker.up(touch(1, 100, 100, 32));
    tracker.move(touch(2, 305, 103, 48));
    expect(intents.slice(mark)).toEqual([
      { type: "pan-start", x: 300, y: 100 },
      { type: "pan", dx: 5, dy: 3, x: 305, y: 103 },
    ]);
  });

  test("a third finger is ignored", () => {
    const { tracker, intents } = recorder();
    tracker.down(touch(1, 100, 100, 0));
    tracker.down(touch(2, 200, 100, 0));
    const before = intents.length;
    expect(tracker.down(touch(3, 400, 400, 10))).toBe(false);
    tracker.move(touch(3, 500, 500, 20));
    tracker.up(touch(3, 500, 500, 30));
    expect(intents.length).toBe(before);
    expect(tracker.size).toBe(2);
    // The pinch itself still runs.
    tracker.move(touch(2, 300, 100, 40));
    expect(intents.at(-1)).toEqual({ type: "pinch", ratio: 2, x: 200, y: 100 });
  });

  test("a third finger disqualifies the gesture as a tap", () => {
    const { tracker, types } = recorder();
    tracker.down(touch(1, 100, 100, 0));
    tracker.down(touch(2, 120, 100, 0));
    tracker.down(touch(3, 140, 100, 0));
    tracker.up(touch(1, 100, 100, 50));
    tracker.up(touch(2, 120, 100, 50));
    expect(types()).not.toContain("tap");
  });

  test("a quick press and release is a tap", () => {
    const { tracker, intents } = recorder();
    tracker.down(touch(1, 50, 60, 0));
    tracker.up(touch(1, 52, 61, 80));
    expect(intents.at(-1)).toEqual({ type: "idle" });
    expect(intents).toContainEqual({ type: "tap", x: 52, y: 61, pointerType: "touch", target: "media" });
  });

  test("a press that stays within the tap slop never pans, so a tap never follows a pan", () => {
    for (const [make, dx, dy] of [[touch, 6, 5], [mouse, 2, 2]] as const) {
      const { tracker, types } = recorder();
      tracker.down(make(1, 100, 100, 0));
      tracker.move(make(1, 100 + dx, 100 + dy, 40));
      tracker.up(make(1, 100 + dx, 100 + dy, 80));
      expect(types()).not.toContain("pan");
      expect(types()).toContain("tap");
    }
  });

  test("a drag pans once it leaves the tap slop, by its whole offset", () => {
    for (const [make, within] of [[touch, 108], [mouse, 103]] as const) {
      const { tracker, intents } = recorder();
      tracker.down(make(1, 100, 100, 0));
      tracker.move(make(1, within, 100, 16));
      expect(intents.filter(intent => intent.type === "pan")).toEqual([]);
      tracker.move(make(1, 120, 100, 32));
      expect(intents.at(-1)).toEqual({ type: "pan", dx: 20, dy: 0, x: 120, y: 100 });
      tracker.up(make(1, 120, 100, 48));
      expect(intents.map(intent => intent.type)).not.toContain("tap");
    }
  });

  test("a slow, short mouse drag is a drag, not a click: the mouse's slop is a click's, not a finger's", () => {
    const { tracker, types } = recorder();
    tracker.down(mouse(1, 100, 100, 0));
    for (let step = 1; step <= 10; step += 1) tracker.move(mouse(1, 100 + step, 100, step * 100));
    tracker.up(mouse(1, 110, 100, 1100));
    expect(types()).toContain("pan");
    expect(types()).not.toContain("tap");
    // The same movement by a finger is within a finger's slop: a tap.
    const finger = recorder();
    finger.tracker.down(touch(1, 100, 100, 0));
    finger.tracker.move(touch(1, 110, 100, 100));
    finger.tracker.up(touch(1, 110, 100, 200));
    expect(finger.types()).toContain("tap");
  });

  test("a touch held past the tap timeout pans within the slop, and is not a tap", () => {
    const { tracker, intents, types } = recorder();
    tracker.down(touch(1, 100, 100, 0));
    tracker.move(touch(1, 105, 100, 500));
    expect(intents.at(-1)).toEqual({ type: "pan", dx: 5, dy: 0, x: 105, y: 100 });
    tracker.up(touch(1, 105, 100, 520));
    expect(types()).not.toContain("tap");
  });

  test("a wandering drag that returns near its start is not a tap", () => {
    const { tracker, types } = recorder();
    for (const [id, start] of [[1, 0], [2, 100]] as const) {
      tracker.down(touch(id, 195, 400, start));
      tracker.move(touch(id, 340, 400, start + 20));
      tracker.move(touch(id, 195, 400, start + 40));
      tracker.up(touch(id, 197, 401, start + 60));
    }
    expect(types()).not.toContain("tap");
    expect(types()).not.toContain("double-tap");
  });

  test("a long press is not a tap on touch", () => {
    const { tracker, types } = recorder();
    tracker.down(touch(1, 10, 10, 0));
    tracker.up(touch(1, 10, 10, 1000));
    expect(types()).not.toContain("tap");
  });

  test("two quick taps in one place are a double-tap", () => {
    const { tracker, types } = recorder();
    tracker.down(touch(1, 100, 100, 0));
    tracker.up(touch(1, 100, 100, 50));
    tracker.down(touch(2, 105, 102, 150));
    tracker.up(touch(2, 105, 102, 200));
    expect(types().filter(type => type === "tap" || type === "double-tap")).toEqual(["tap", "double-tap"]);
  });

  test("taps too far apart in time or space are not a double-tap", () => {
    const slow = recorder();
    slow.tracker.down(touch(1, 100, 100, 0));
    slow.tracker.up(touch(1, 100, 100, 50));
    slow.tracker.down(touch(2, 100, 100, 500));
    slow.tracker.up(touch(2, 100, 100, 550));
    expect(slow.types()).not.toContain("double-tap");

    const far = recorder();
    far.tracker.down(touch(1, 100, 100, 0));
    far.tracker.up(touch(1, 100, 100, 50));
    far.tracker.down(touch(2, 200, 100, 100));
    far.tracker.up(touch(2, 200, 100, 150));
    expect(far.types()).not.toContain("double-tap");
  });

  test("a tap, then a pan, then a tap is not a double-tap", () => {
    const { tracker, types } = recorder();
    tracker.down(touch(51, 195, 300, 0));
    tracker.up(touch(51, 195, 300, 10));
    tracker.down(touch(52, 195, 300, 20));
    tracker.move(touch(52, 195, 500, 30));
    tracker.up(touch(52, 195, 500, 40));
    tracker.down(touch(53, 195, 300, 50));
    tracker.up(touch(53, 195, 300, 60));
    expect(types()).not.toContain("double-tap");
    expect(types().filter(type => type === "tap").length).toBe(2);
  });

  test("a tap, then a pinch, then a tap is not a double-tap", () => {
    const { tracker, types } = recorder();
    tracker.down(touch(54, 195, 300, 0));
    tracker.up(touch(54, 195, 300, 10));
    tracker.down(touch(55, 165, 300, 20));
    tracker.down(touch(56, 225, 300, 20));
    tracker.move(touch(55, 155, 300, 30));
    tracker.move(touch(56, 235, 300, 30));
    tracker.up(touch(55, 155, 300, 40));
    tracker.up(touch(56, 235, 300, 40));
    tracker.down(touch(57, 195, 300, 50));
    tracker.up(touch(57, 195, 300, 60));
    expect(types()).not.toContain("double-tap");
  });

  test("a cancelled pointer is not a tap and breaks a tap sequence", () => {
    const { tracker, types, intents } = recorder();
    tracker.down(touch(1, 100, 100, 0));
    tracker.up(touch(1, 100, 100, 10));
    tracker.down(touch(2, 100, 100, 20));
    tracker.cancel(touch(2, 100, 100, 30));
    expect(tracker.size).toBe(0);
    expect(intents.at(-1)).toEqual({ type: "idle" });
    tracker.down(touch(3, 100, 100, 40));
    tracker.up(touch(3, 100, 100, 50));
    expect(types()).not.toContain("double-tap");
    expect(types().filter(type => type === "tap").length).toBe(2);
  });

  test("the mouse taps but never double-taps, and a slow click is still a click", () => {
    const { tracker, types } = recorder();
    tracker.down(mouse(1, 100, 100, 0));
    tracker.up(mouse(1, 100, 100, 900));
    tracker.down(mouse(1, 100, 100, 950));
    tracker.up(mouse(1, 100, 100, 990));
    expect(types().filter(type => type === "tap" || type === "double-tap")).toEqual(["tap", "tap"]);
  });

  test("a mouse drag is not a tap", () => {
    const { tracker, types } = recorder();
    tracker.down(mouse(1, 100, 100, 0));
    tracker.move(mouse(1, 160, 100, 10));
    tracker.up(mouse(1, 160, 100, 20));
    expect(types()).not.toContain("tap");
  });

  test("reset drops live pointers and any pending tap", () => {
    const { tracker, types } = recorder();
    tracker.down(touch(1, 100, 100, 0));
    tracker.up(touch(1, 100, 100, 10));
    tracker.down(touch(2, 300, 300, 20));
    tracker.reset();
    expect(tracker.size).toBe(0);
    // The lost pointer's moves and release are ignored.
    tracker.move(touch(2, 320, 300, 30));
    tracker.up(touch(2, 320, 300, 40));
    // A later tap does not pair with the tap from before the reset.
    tracker.down(touch(3, 100, 100, 50));
    tracker.up(touch(3, 100, 100, 60));
    expect(types()).not.toContain("double-tap");
  });

  test("moves and releases of unknown pointers are ignored", () => {
    const { tracker, intents } = recorder();
    tracker.move(touch(9, 1, 1, 0));
    tracker.up(touch(9, 1, 1, 0));
    tracker.cancel(touch(9, 1, 1, 0));
    expect(intents).toEqual([]);
  });
});

describe("tap targets", () => {
  // Left half is the media, right half the backdrop, judged from the press.
  function targeted() {
    const intents: GestureIntent[] = [];
    const presses: { start: { x: number; y: number }; end: { x: number; y: number } }[] = [];
    const tracker = new GestureTracker(intent => intents.push(intent), {
      tapTarget: press => {
        presses.push(press);
        return press.start.x < 100 && press.end.x < 100 ? "media" : "backdrop";
      },
    });
    return { tracker, intents, presses, taps: () => intents.filter(i => i.type === "tap" || i.type === "double-tap") };
  }

  test("a tap is classified from where its press started and where it ended", () => {
    const { tracker, presses, taps } = targeted();
    tracker.down(touch(1, 95, 10, 0));
    tracker.move(touch(1, 104, 10, 16));
    tracker.up(touch(1, 104, 10, 32));
    expect(presses).toEqual([{ start: { x: 95, y: 10 }, end: { x: 104, y: 10 } }]);
    expect(taps()).toEqual([{ type: "tap", x: 104, y: 10, pointerType: "touch", target: "backdrop" }]);
  });

  test("taps on different targets never pair into a double-tap", () => {
    const { tracker, taps } = targeted();
    tracker.down(touch(1, 90, 10, 0));
    tracker.up(touch(1, 90, 10, 30));
    tracker.down(touch(2, 110, 10, 100));
    tracker.up(touch(2, 110, 10, 130));
    expect(taps().map(tap => tap.type === "tap" && tap.target)).toEqual(["media", "backdrop"]);
  });

  test("two quick taps on one target still pair", () => {
    const { tracker, taps } = targeted();
    tracker.down(touch(1, 50, 10, 0));
    tracker.up(touch(1, 50, 10, 30));
    tracker.down(touch(2, 52, 10, 100));
    tracker.up(touch(2, 52, 10, 130));
    expect(taps().map(tap => tap.type)).toEqual(["tap", "double-tap"]);
  });
});

describe("classifyPress", () => {
  const media = { left: 100, top: 50, width: 200, height: 100 };

  test("a press is on the backdrop only when it both started and ended there", () => {
    expect(classifyPress({ start: { x: 50, y: 10 }, end: { x: 60, y: 12 } }, media)).toBe("backdrop");
    expect(classifyPress({ start: { x: 105, y: 55 }, end: { x: 95, y: 55 } }, media)).toBe("media");
    expect(classifyPress({ start: { x: 95, y: 55 }, end: { x: 105, y: 55 } }, media)).toBe("media");
    expect(classifyPress({ start: { x: 150, y: 100 }, end: { x: 150, y: 100 } }, media)).toBe("media");
  });
});

describe("classifyTap", () => {
  const media = { left: 100, top: 50, width: 200, height: 100 };

  test("a tap inside the media's rectangle is on the media", () => {
    expect(classifyTap({ x: 150, y: 100 }, media)).toBe("media");
    expect(classifyTap({ x: 100, y: 50 }, media)).toBe("media");
    expect(classifyTap({ x: 300, y: 150 }, media)).toBe("media");
  });

  test("a tap outside it is on the backdrop", () => {
    expect(classifyTap({ x: 99, y: 100 }, media)).toBe("backdrop");
    expect(classifyTap({ x: 301, y: 100 }, media)).toBe("backdrop");
    expect(classifyTap({ x: 150, y: 49 }, media)).toBe("backdrop");
    expect(classifyTap({ x: 150, y: 151 }, media)).toBe("backdrop");
  });
});
