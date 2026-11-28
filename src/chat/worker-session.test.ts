import { expect, test } from "bun:test";
import { workerSessionReport, formatWorkerCost, type WorkerMessageModel } from "./worker-session";

test("only an authoritative aggregate prices a session, preserving zero and rejecting malformed totals", () => {
  const models = new Map([["a", { model: "one", createdAt: 1, effort: "high" }]]);
  expect(workerSessionReport(undefined, models).costUsd).toBeNull();
  expect(workerSessionReport(0, models).costUsd).toBe(0);
  expect(workerSessionReport(0.05, models).costUsd).toBe(0.05);
  for (const value of [null, -1, Infinity, Number.NaN]) expect(workerSessionReport(value, models).costUsd).toBeNull();
});

test("the session cost is OpenCode's total plus the steps Uatu priced at list prices; a reported total is never lowered (#591)", () => {
  const models = new Map([["a", { model: "one", createdAt: 1 }]]);
  const steps = new Map([["a", { input: 10, costUsd: 0.003, listPriced: true as const }], ["b", { input: 10, costUsd: 0 }], ["c", { input: 10 }], ["d", { input: 10, costUsd: 0.001, listPriced: true as const }], ["e", { input: 10, costUsd: 0.002 }]]);
  expect(workerSessionReport(0, models, steps).costUsd).toBeCloseTo(0.004, 12);
  // OpenCode's own figure for the priced step is already in its total.
  expect(workerSessionReport(0.05, models, steps).costUsd).toBeCloseTo(0.054, 12);
  expect(workerSessionReport(undefined, models, steps).costUsd).toBeNull();
  expect(workerSessionReport(0, models, new Map([["b", { input: 10, costUsd: 0 }], ["e", { input: 10, costUsd: 0.002 }]])).costUsd).toBe(0);
});

test("latest execution model and effort travel together; opaque and explicit none/default survive", () => {
  const models = new Map<string, WorkerMessageModel>([["a", { model: "one", createdAt: 1, effort: "high" }], ["b", { model: "one", createdAt: 2, effort: "medium" }]]);
  expect(workerSessionReport(undefined, models)).toMatchObject({ model: "one", effort: "medium" });
  models.set("a", { model: "one", createdAt: 1, effort: "high" }); // old replay is not latest
  expect(workerSessionReport(undefined, models).effort).toBe("medium");
  models.set("c", { model: "two", createdAt: 3 });
  expect(workerSessionReport(undefined, models)).toEqual({ model: "two", effort: null, costUsd: null });
  for (const effort of ["none", "default", "xhigh", "provider-opaque"]) {
    models.set("d", { model: "two", createdAt: 4, effort });
    expect(workerSessionReport(undefined, models).effort).toBe(effort);
  }
});

test("cost formatting distinguishes absent, unpriced zero, sub-cent and tiny nonzero USD", () => {
  expect(formatWorkerCost(null)).toBe("—");
  // OpenCode reports 0 for a model it has no price for: unpriced, not free (#591).
  expect(formatWorkerCost(0)).toBe("—");
  expect(formatWorkerCost(0.0012)).toBe("$0.0012");
  expect(formatWorkerCost(0.000001)).toBe("<$0.0001");
  expect(formatWorkerCost(12.345)).toBe("$12.35");
});
