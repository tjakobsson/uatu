import { describe, expect, test } from "bun:test";
import { expandedWorkBudget } from "./work-budget";

describe("expanded work capacity", () => {
  test("desktop balances expanded work with conversation reading room", () => {
    expect(expandedWorkBudget(600, 150, "desktop")).toEqual({ reading: 300, capacity: 300 });
  });
  test("desktop transitions from its reading floor through balance to its cap", () => {
    expect(expandedWorkBudget(398, 150, "desktop")).toEqual({ reading: 200, capacity: 198 });
    expect(expandedWorkBudget(400, 150, "desktop")).toEqual({ reading: 200, capacity: 200 });
    expect(expandedWorkBudget(402, 150, "desktop")).toEqual({ reading: 201, capacity: 201 });
    expect(expandedWorkBudget(838, 150, "desktop")).toEqual({ reading: 419, capacity: 419 });
    expect(expandedWorkBudget(840, 150, "desktop")).toEqual({ reading: 420, capacity: 420 });
    expect(expandedWorkBudget(842, 150, "desktop")).toEqual({ reading: 420, capacity: 422 });
  });
  test("desktop reserves a useful reading band and yields in short windows", () => {
    expect(expandedWorkBudget(720, 150, "desktop")).toEqual({ reading: 360, capacity: 360 });
    expect(expandedWorkBudget(1000, 150, "desktop")).toEqual({ reading: 420, capacity: 580 });
    expect(expandedWorkBudget(240, 150, "desktop")).toEqual({ reading: 90, capacity: 150 });
    expect(expandedWorkBudget(100, 160, "desktop")).toEqual({ reading: 10, capacity: 90 });
  });
  test("uses actual remaining layout pixels, not a viewport percentage cap", () => {
    expect(expandedWorkBudget(600, 150)).toEqual({ reading: 96, capacity: 504 });
    expect(expandedWorkBudget(300, 150)).toEqual({ reading: 60, capacity: 240 });
    expect(expandedWorkBudget(140, 90)).toEqual({ reading: 32, capacity: 108 });
  });
  test("retains a whole transcript action band before compacting desktop work", () => {
    expect(expandedWorkBudget(218.15625, 160, "desktop", 100)).toEqual({ reading: 100, capacity: 118.15625 });
    expect(expandedWorkBudget(80, 160, "desktop", 100)).toEqual({ reading: 80, capacity: 0 });
  });
  test("yields its preferred strip to whole actions, retaining a truthful small strip", () => {
    expect(expandedWorkBudget(100, 90)).toEqual({ reading: 10, capacity: 90 });
    expect(expandedWorkBudget(100, 160)).toEqual({ reading: 10, capacity: 90 });
    expect(expandedWorkBudget(0, 160)).toEqual({ reading: 0, capacity: 0 });
    expect(expandedWorkBudget(-20, 160)).toEqual({ reading: 0, capacity: 0 });
  });
});
