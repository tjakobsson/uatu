import { describe, expect, test } from "bun:test";

import { swipeToArrowSequences } from "./touch-scroll";

describe("swipeToArrowSequences", () => {
  test("finger up by one cell emits one arrow-down (CSI mode)", () => {
    const result = swipeToArrowSequences({ deltaY: -17, cellHeight: 17, applicationCursor: false, carry: 0 });
    expect(result.sequences).toBe("\x1b[B");
    expect(result.carry).toBe(0);
  });

  test("finger down emits arrow-up, proportionally to distance", () => {
    const result = swipeToArrowSequences({ deltaY: 51, cellHeight: 17, applicationCursor: false, carry: 0 });
    expect(result.sequences).toBe("\x1b[A\x1b[A\x1b[A");
  });

  test("application cursor mode uses SS3 sequences", () => {
    const result = swipeToArrowSequences({ deltaY: -34, cellHeight: 17, applicationCursor: true, carry: 0 });
    expect(result.sequences).toBe("\x1bOB\x1bOB");
  });

  test("sub-cell movement accumulates through the carry instead of being lost", () => {
    const first = swipeToArrowSequences({ deltaY: -9, cellHeight: 17, applicationCursor: false, carry: 0 });
    expect(first.sequences).toBe("");
    expect(first.carry).toBe(-9);
    const second = swipeToArrowSequences({ deltaY: -9, cellHeight: 17, applicationCursor: false, carry: first.carry });
    expect(second.sequences).toBe("\x1b[B");
    expect(second.carry).toBeCloseTo(-1);
  });

  test("direction reversal drains the carry before emitting the other way", () => {
    const up = swipeToArrowSequences({ deltaY: -10, cellHeight: 17, applicationCursor: false, carry: 0 });
    const reversed = swipeToArrowSequences({ deltaY: 12, cellHeight: 17, applicationCursor: false, carry: up.carry });
    expect(reversed.sequences).toBe("");
    expect(reversed.carry).toBe(2);
  });

  test("a zero or negative cell height emits nothing and resets the carry", () => {
    expect(swipeToArrowSequences({ deltaY: -40, cellHeight: 0, applicationCursor: false, carry: 5 })).toEqual({
      sequences: "",
      carry: 0,
    });
  });
});
