import { describe, expect, test } from "bun:test";
import { expandedWorkBudget } from "./work-budget";

describe("expanded work capacity", () => {
  test("desktop reserves a useful reading band and yields in short windows", () => {
    expect(expandedWorkBudget(720, 150, "desktop").reading).toBeCloseTo(252);
    expect(expandedWorkBudget(720, 150, "desktop").capacity).toBeCloseTo(468);
    expect(expandedWorkBudget(1000, 150, "desktop")).toEqual({ reading: 280, capacity: 720 });
    expect(expandedWorkBudget(240, 150, "desktop")).toEqual({ reading: 90, capacity: 150 });
    expect(expandedWorkBudget(100, 160, "desktop")).toEqual({ reading: 10, capacity: 90 });
  });
  test("uses actual remaining layout pixels, not a viewport percentage cap", () => {
    expect(expandedWorkBudget(600, 150)).toEqual({ reading: 96, capacity: 504 });
    expect(expandedWorkBudget(300, 150)).toEqual({ reading: 60, capacity: 240 });
    expect(expandedWorkBudget(140, 90)).toEqual({ reading: 32, capacity: 108 });
  });
  test("yields its preferred strip to whole actions, retaining a truthful small strip", () => {
    expect(expandedWorkBudget(100, 90)).toEqual({ reading: 10, capacity: 90 });
    expect(expandedWorkBudget(100, 160)).toEqual({ reading: 10, capacity: 90 });
    expect(expandedWorkBudget(0, 160)).toEqual({ reading: 0, capacity: 0 });
    expect(expandedWorkBudget(-20, 160)).toEqual({ reading: 0, capacity: 0 });
  });
});
