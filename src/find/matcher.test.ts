import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MATCH_OPTIONS,
  findMatches,
  nearestSpan,
  stepIndex,
  type MatchOptions,
} from "./matcher";

function options(overrides: Partial<MatchOptions> = {}): MatchOptions {
  return { ...DEFAULT_MATCH_OPTIONS, ...overrides };
}

function matched(text: string, query: string, overrides: Partial<MatchOptions> = {}): string[] {
  const result = findMatches(text, query, options(overrides));
  if (!result.ok) {
    throw new Error(`expected a match result, got error: ${result.error}`);
  }
  return result.spans.map(span => text.slice(span.start, span.end));
}

describe("literal matching", () => {
  test("finds every occurrence in document order", () => {
    const result = findMatches("the cat sat on the mat", "at", options());
    expect(result.ok && result.spans).toEqual([
      { start: 5, end: 7 },
      { start: 9, end: 11 },
      { start: 20, end: 22 },
    ]);
  });

  test("is case-insensitive by default", () => {
    expect(matched("Preview preview PREVIEW", "preview")).toHaveLength(3);
  });

  test("case-sensitive excludes other casings", () => {
    expect(matched("Preview preview PREVIEW", "Preview", { caseSensitive: true })).toEqual([
      "Preview",
    ]);
  });

  test("regex metacharacters are literal unless regex mode is on", () => {
    // `a.c` must not match `abc` when the user meant the three characters.
    expect(matched("abc a.c", "a.c")).toEqual(["a.c"]);
  });

  test("an empty query clears rather than matching everything", () => {
    const result = findMatches("anything", "", options());
    expect(result.ok && result.spans).toEqual([]);
  });

  test("overlapping candidates advance past each match", () => {
    expect(matched("aaaa", "aa")).toEqual(["aa", "aa"]);
  });
});

describe("whole-word matching", () => {
  test("excludes matches inside longer words", () => {
    expect(matched("cat concatenate cats", "cat", { wholeWord: true })).toEqual(["cat"]);
  });

  test("punctuated queries still match", () => {
    // `\bfoo(\b` would anchor against a boundary that cannot exist, silently
    // matching nothing. Only word-character edges get anchored.
    expect(matched("call foo() now", "foo(", { wholeWord: true })).toEqual(["foo("]);
  });

  test("a fully non-word query is unaffected by the toggle", () => {
    expect(matched("a -> b -> c", "->", { wholeWord: true })).toHaveLength(2);
  });

  test("a regex alternation is grouped before anchoring", () => {
    // Ungrouped, `\bfoo|bar\b` would let `foo` match inside `foobar` and
    // `bar` match inside `crowbar`.
    expect(matched("foobar crowbar foo bar", "foo|bar", { wholeWord: true, regex: true })).toEqual([
      "foo",
      "bar",
    ]);
  });
});

describe("regex matching", () => {
  test("applies the pattern when regex mode is on", () => {
    expect(matched("a1 b2 c3", "[a-z]\\d", { regex: true })).toEqual(["a1", "b2", "c3"]);
  });

  test("invalid syntax is reported, not thrown", () => {
    const result = findMatches("text", "(unterminated", options({ regex: true }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.length).toBeGreaterThan(0);
  });

  test("a pattern matching the empty string terminates with a finite count", () => {
    const result = findMatches("abc", "x*", options({ regex: true }));
    expect(result.ok).toBe(true);
    // Every match is zero-width, so none is navigable — and crucially the
    // enumeration returns at all.
    expect(result.ok && result.spans).toEqual([]);
  });

  test("a mixed pattern keeps the non-empty matches and drops the empty ones", () => {
    const result = findMatches("aXbXc", "X*", options({ regex: true }));
    expect(result.ok && result.spans.map(s => "aXbXc".slice(s.start, s.end))).toEqual(["X", "X"]);
  });

  test("an anchor that matches at every position still terminates", () => {
    const result = findMatches("abc", "^", options({ regex: true }));
    expect(result.ok && result.spans).toEqual([]);
  });

  test("case sensitivity applies to regex mode too", () => {
    expect(matched("Foo foo", "f.o", { regex: true, caseSensitive: true })).toEqual(["foo"]);
  });
});

describe("match cap", () => {
  test("caps the span list and reports truncation", () => {
    const result = findMatches("x".repeat(50), "x", options(), 10);
    expect(result.ok && result.spans).toHaveLength(10);
    expect(result.ok && result.truncated).toBe(true);
  });

  test("a result exactly at the cap with nothing left is not truncated", () => {
    const result = findMatches("xxx", "x", options(), 3);
    expect(result.ok && result.spans).toHaveLength(3);
    expect(result.ok && result.truncated).toBe(false);
  });

  test("under the cap is never truncated", () => {
    const result = findMatches("xxx", "x", options(), 10);
    expect(result.ok && result.truncated).toBe(false);
  });
});

describe("nearestSpan", () => {
  const spans = [
    { start: 5, end: 8 },
    { start: 20, end: 23 },
    { start: 40, end: 43 },
  ];

  test("lands on the span nearest the reader's position", () => {
    expect(nearestSpan(spans, 0)).toBe(0);
    expect(nearestSpan(spans, 20)).toBe(1);
    expect(nearestSpan(spans, 100)).toBe(2);
  });

  test("an edit before the match does not skip past it", () => {
    // The reader's match was at 22 before a deletion shifted it to 20. The
    // old at-or-after rule would skip it and jump to the next occurrence.
    expect(nearestSpan(spans, 22)).toBe(1);
  });

  test("prefers the later span when equidistant", () => {
    expect(nearestSpan([{ start: 10, end: 12 }, { start: 30, end: 32 }], 20)).toBe(1);
  });

  test("reports nothing for an empty set", () => {
    expect(nearestSpan([], 0)).toBe(-1);
  });
});

describe("stepIndex", () => {
  test("advances and wraps past the last match", () => {
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, 1)).toBe(0);
  });

  test("retreats and wraps past the first match", () => {
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(1, 3, -1)).toBe(0);
  });

  test("an empty set has no current match", () => {
    expect(stepIndex(0, 0, 1)).toBe(-1);
  });
});
