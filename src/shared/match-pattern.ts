// Query → RegExp, shared by the in-document find (`src/find/matcher.ts`) and
// the project-search sweep (`src/server/search.ts`).
//
// One definition on purpose: the case, whole-word, and regex toggles must
// mean exactly the same thing on both sides of the app — the reveal that
// connects them (open a project-search hit, land on the same text ⌘F would
// find) only holds while they agree. The two sides duplicated this logic
// once, and the copies required the same fix twice.

export type MatchPatternOptions = {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
};

export function escapeRegexLiteral(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// JavaScript's `\w` and `\b` are ASCII-only: `\b` sees no boundary between
// `é` and `s`, so whole-word `café` would still match inside `cafés`. These
// classes are the Unicode reading of "word character". They need the `u`
// flag, which is why compilation tries the Unicode form first and falls back
// to an ASCII form for the rare pattern the `u` grammar rejects.
const WORD = "[\\p{L}\\p{N}_]";
const NON_WORD = "[^\\p{L}\\p{N}_]";
const STARTS_WITH_WORD = /^[\p{L}\p{N}_]/u;
const ENDS_WITH_WORD = /[\p{L}\p{N}_]$/u;

// Whole-word means: where a match's edge character is a word character, the
// character beyond it must not be. An edge that is itself punctuation needs
// no boundary — `foo(` can never sit at a trailing one, and demanding it
// anyway would make whole-word silently break every punctuated query.
//
// For a literal the match edges ARE the query edges, so the rule resolves
// statically to a plain lookaround (or nothing). A regex source's raw first
// and last characters say nothing about where a *match* begins — `(foo|bar)`
// starts with `(` but its matches start on word characters, so inspecting the
// source's edges would (and did) apply no boundaries at all. Instead each
// side gets the rule as an alternation evaluated at match time: either the
// character beyond the edge is not a word character, or the edge itself is
// not one.
function wholeWordSource(base: string, query: string, regex: boolean, unicode: boolean): string {
  if (regex) {
    const [word, nonWord] = unicode ? [WORD, NON_WORD] : ["\\w", "\\W"];
    const leading = `(?:(?<!${word})|(?=${nonWord}))`;
    const trailing = `(?:(?<=${nonWord})|(?!${word}))`;
    // Grouped before anchoring, or `\bfoo|bar\b` would distribute the
    // boundaries across the alternation.
    return `${leading}(?:${base})${trailing}`;
  }
  const leading = STARTS_WITH_WORD.test(query) ? (unicode ? `(?<!${WORD})` : "\\b") : "";
  const trailing = ENDS_WITH_WORD.test(query) ? (unicode ? `(?!${WORD})` : "\\b") : "";
  return `${leading}${base}${trailing}`;
}

export function buildMatchPattern(
  query: string,
  options: MatchPatternOptions,
): RegExp | { error: string } {
  const base = options.regex ? query : escapeRegexLiteral(query);
  const flags = options.caseSensitive ? "g" : "gi";

  if (!options.wholeWord) {
    // No `u` flag here: it makes the regex grammar stricter, and a raw user
    // pattern that compiles today must keep compiling.
    try {
      return new RegExp(base, flags);
    } catch (error) {
      return { error: describe(error) };
    }
  }

  try {
    return new RegExp(wholeWordSource(base, query, options.regex, true), `${flags}u`);
  } catch {
    // The `u` grammar rejects some patterns the default grammar accepts (an
    // unescaped `{` outside a quantifier, unknown escapes). Fall back to
    // ASCII boundaries rather than rejecting a pattern that worked without
    // the whole-word toggle.
  }

  try {
    return new RegExp(wholeWordSource(base, query, options.regex, false), flags);
  } catch (error) {
    return { error: describe(error) };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "invalid pattern";
}
