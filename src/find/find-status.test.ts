import { describe, expect, test } from "bun:test";

import { clampSeed, describeStatus, MAX_SEED_LENGTH } from "./find-status";

// The find bar's own wiring installs against the live preview and is covered
// end-to-end in tests/e2e/find.e2e.ts. These are the decisions the counter and
// the seeding rules make, which are pure and worth pinning.

function status(overrides: Partial<Parameters<typeof describeStatus>[0]> = {}) {
  return describeStatus({
    query: "term",
    total: 0,
    currentIndex: -1,
    truncated: false,
    error: null,
    ...overrides,
  });
}

describe("describeStatus", () => {
  test("reports position and total, one-based", () => {
    expect(status({ total: 12, currentIndex: 0 })).toEqual({ state: "ok", label: "1 of 12" });
    expect(status({ total: 12, currentIndex: 11 })).toEqual({ state: "ok", label: "12 of 12" });
  });

  test("an empty query says nothing rather than 'No results'", () => {
    // "No results" for a query never typed reads as a verdict on the
    // document, not on the search.
    expect(status({ query: "", total: 0 })).toEqual({ state: "idle", label: "" });
  });

  test("a query with no matches is distinct from an empty one", () => {
    expect(status({ query: "nothing", total: 0 })).toEqual({
      state: "empty",
      label: "No results",
    });
  });

  test("truncated totals are marked so a cap never reads as complete", () => {
    expect(status({ total: 2000, currentIndex: 0, truncated: true })).toEqual({
      state: "ok",
      label: "1 of 2000+",
    });
  });

  test("an invalid pattern outranks every other state", () => {
    expect(status({ query: "(", total: 0, error: "unterminated group" })).toEqual({
      state: "invalid",
      label: "Invalid pattern",
    });
  });
});

describe("clampSeed", () => {
  test("seeds a selected word", () => {
    expect(clampSeed("compare-target")).toBe("compare-target");
  });

  test("trims surrounding whitespace", () => {
    expect(clampSeed("  compare-target \t")).toBe("compare-target");
  });

  test("refuses a multi-line selection", () => {
    // A query spanning a line break essentially never matches, so seeding one
    // would produce "No results" for a search the reader never typed.
    expect(clampSeed("first line\nsecond line")).toBe("");
  });

  test("refuses a selection longer than a search term", () => {
    expect(clampSeed("x".repeat(MAX_SEED_LENGTH + 1))).toBe("");
    expect(clampSeed("x".repeat(MAX_SEED_LENGTH))).toHaveLength(MAX_SEED_LENGTH);
  });

  test("refuses a whitespace-only selection", () => {
    expect(clampSeed("   ")).toBe("");
    expect(clampSeed("")).toBe("");
  });
});
