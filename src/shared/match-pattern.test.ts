import { describe, expect, test } from "bun:test";

import { buildMatchPattern, type MatchPatternOptions } from "./match-pattern";

const BASE: MatchPatternOptions = { caseSensitive: false, wholeWord: false, regex: false };

function matchesIn(text: string, query: string, options: Partial<MatchPatternOptions>): string[] {
  const pattern = buildMatchPattern(query, { ...BASE, ...options });
  if ("error" in pattern) {
    throw new Error(pattern.error);
  }
  return [...text.matchAll(pattern)].map(m => m[0]);
}

describe("whole word at Unicode edges", () => {
  // JavaScript's `\b` is ASCII-only: it sees a boundary between `é` and `s`,
  // so without Unicode-aware classes whole-word `café` matches inside `cafés`.
  test("café does not match inside cafés", () => {
    expect(matchesIn("cafés serve café daily", "café", { wholeWord: true })).toEqual(["café"]);
  });

  test("a single accented letter does not match inside a word", () => {
    expect(matchesIn("café", "é", { wholeWord: true })).toEqual([]);
    expect(matchesIn("é above", "é", { wholeWord: true })).toEqual(["é"]);
  });

  test("ASCII words still bound as before", () => {
    expect(matchesIn("catapult cat", "cat", { wholeWord: true })).toEqual(["cat"]);
  });

  test("punctuation edges stay unanchored for literals", () => {
    // `foo(` can never sit at a trailing word boundary; anchoring it anyway
    // would make whole-word silently break every punctuated query.
    expect(matchesIn("call foo(bar)", "foo(", { wholeWord: true })).toEqual(["foo("]);
  });
});

describe("whole word over regex sources", () => {
  test("a grouped alternation is bounded", () => {
    // The raw source starts with `(`, so edge inspection would apply no
    // boundaries at all and `foo` would match inside `foobar`.
    expect(
      matchesIn("foobar crowbar foo bar", "(foo|bar)", { wholeWord: true, regex: true }),
    ).toEqual(["foo", "bar"]);
  });

  test("an ungrouped alternation is bounded the same way", () => {
    expect(
      matchesIn("foobar crowbar foo bar", "foo|bar", { wholeWord: true, regex: true }),
    ).toEqual(["foo", "bar"]);
  });

  test("regex whole-word is Unicode-aware", () => {
    expect(matchesIn("cafés café", "caf.", { wholeWord: true, regex: true })).toEqual(["café"]);
  });
});

describe("compilation fallback", () => {
  test("a pattern the u-flag grammar rejects still compiles with ASCII boundaries", () => {
    // `a{` is a valid pattern without the `u` flag and a syntax error with it.
    expect(matchesIn("xa{ a{", "a{", { wholeWord: true, regex: true })).toEqual(["a{"]);
  });

  test("plain regex mode is not subjected to u-flag strictness", () => {
    expect(matchesIn("a{ b", "a{", { regex: true })).toEqual(["a{"]);
  });

  test("an invalid pattern reports an error", () => {
    const pattern = buildMatchPattern("(", { ...BASE, regex: true });
    expect("error" in pattern).toBe(true);
  });
});
