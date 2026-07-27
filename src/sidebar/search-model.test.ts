import { describe, expect, test } from "bun:test";

import {
  LINE_WINDOW,
  MIN_QUERY_LENGTH,
  countMatches,
  describeSearchSummary,
  displayLine,
  mergeResult,
  shouldDispatch,
} from "./search-model";
import type { SearchFileResult } from "../server/search";

function summary(overrides: Partial<Parameters<typeof describeSearchSummary>[0]> = {}) {
  return describeSearchSummary({
    query: "term",
    files: 0,
    matches: 0,
    running: false,
    truncated: false,
    error: null,
    ...overrides,
  });
}

function result(documentId: string, lines: number[]): SearchFileResult {
  return {
    documentId,
    relativePath: documentId,
    rootId: "/abs",
    matches: lines.map(line => ({ line, text: "x", start: 0, end: 1 })),
  };
}

describe("describeSearchSummary", () => {
  test("counts results and files, pluralised", () => {
    expect(summary({ files: 1, matches: 1 }).label).toBe("1 result · 1 file");
    expect(summary({ files: 3, matches: 9 }).label).toBe("9 results · 3 files");
  });

  test("an empty query says nothing rather than 'No results'", () => {
    expect(summary({ query: "" })).toEqual({ state: "idle", label: "" });
  });

  test("a too-short query invites a longer one instead of searching", () => {
    const short = summary({ query: "a" });
    expect(short.state).toBe("short");
    expect(short.label).toContain(String(MIN_QUERY_LENGTH));
  });

  test("a running sweep with nothing yet reads as progress, not failure", () => {
    expect(summary({ running: true, matches: 0 })).toEqual({
      state: "searching",
      label: "Searching…",
    });
  });

  test("a finished sweep with nothing is a verdict", () => {
    expect(summary({ running: false, matches: 0 })).toEqual({
      state: "empty",
      label: "No results",
    });
  });

  test("a truncated count is marked so a cap never reads as complete", () => {
    // A silently capped list reads as "that's everywhere it appears", which is
    // the wrong conclusion for a reviewer to draw.
    expect(summary({ files: 2, matches: 500, truncated: true }).label).toBe(
      "500+ results · 2 files",
    );
  });

  test("results still streaming carry an ellipsis", () => {
    expect(summary({ files: 1, matches: 4, running: true }).label).toBe("4 results · 1 file…");
  });

  test("an invalid pattern outranks every other state", () => {
    expect(summary({ matches: 9, files: 2, error: "bad" })).toEqual({
      state: "invalid",
      label: "Invalid pattern",
    });
  });
});

describe("shouldDispatch", () => {
  test("refuses queries below the minimum", () => {
    expect(shouldDispatch("")).toBe(false);
    expect(shouldDispatch("a")).toBe(false);
    expect(shouldDispatch("ab")).toBe(true);
  });
});

describe("displayLine", () => {
  test("drops leading indentation and shifts offsets with it", () => {
    const line = displayLine("      const answer = 42;", 12, 18);
    expect(line.text).toBe("const answer = 42;");
    expect(line.text.slice(line.start, line.end)).toBe("answer");
  });

  test("a short line is untouched", () => {
    const line = displayLine("hello world", 6, 11);
    expect(line.truncatedStart).toBe(false);
    expect(line.truncatedEnd).toBe(false);
    expect(line.text.slice(line.start, line.end)).toBe("world");
  });

  test("a long line windows around the match rather than truncating the tail", () => {
    // The match is far to the right; a plain head-truncation would hide it.
    const prefix = "x".repeat(400);
    const line = displayLine(`${prefix}needle tail`, 400, 406);
    expect(line.text.length).toBeLessThanOrEqual(LINE_WINDOW);
    expect(line.text.slice(line.start, line.end)).toBe("needle");
    expect(line.truncatedStart).toBe(true);
  });

  test("a match at the very start of a long line keeps its head", () => {
    const line = displayLine(`needle${"x".repeat(400)}`, 0, 6);
    expect(line.truncatedStart).toBe(false);
    expect(line.text.slice(line.start, line.end)).toBe("needle");
  });
});

describe("mergeResult", () => {
  test("appends new documents in arrival order — the server emits tree order", () => {
    let acc: SearchFileResult[] = [];
    acc = mergeResult(acc, result("a.md", [1]));
    acc = mergeResult(acc, result("b.md", [2]));
    expect(acc.map(r => r.documentId)).toEqual(["a.md", "b.md"]);
  });

  test("a repeat document accumulates its matches rather than replacing them", () => {
    let acc: SearchFileResult[] = [];
    acc = mergeResult(acc, result("a.md", [1, 2]));
    acc = mergeResult(acc, result("a.md", [7]));
    expect(acc).toHaveLength(1);
    expect(acc[0]!.matches.map(m => m.line)).toEqual([1, 2, 7]);
  });
});

describe("countMatches", () => {
  test("sums across documents", () => {
    expect(countMatches([result("a.md", [1, 2]), result("b.md", [3])])).toBe(3);
  });

  test("an empty set counts zero", () => {
    expect(countMatches([])).toBe(0);
  });
});
