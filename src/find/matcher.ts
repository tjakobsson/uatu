// Query → spans over the flattened text from `text-index.ts`.
//
// Pure string work: no DOM, no highlighting, no scrolling. Everything that
// can go wrong with a user-supplied pattern is contained here — invalid
// syntax, patterns that match nothing, patterns that match *everywhere*, and
// patterns that can match the empty string and would otherwise enumerate
// forever.

import { buildMatchPattern } from "../shared/match-pattern";
import type { TextSpan } from "./text-index";

export type MatchOptions = {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
};

export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

// Above this, a highlight set stops being navigation and starts being a
// second copy of the document. Callers disclose truncation rather than
// presenting a capped list as complete.
export const MATCH_CAP = 2000;

export type MatchResult =
  | { ok: true; spans: TextSpan[]; truncated: boolean }
  | { ok: false; error: string };

// Compilation — escaping, whole-word anchoring, Unicode boundaries — lives in
// `shared/match-pattern.ts`, one definition for both find surfaces.
export function buildPattern(query: string, options: MatchOptions): RegExp | { error: string } {
  return buildMatchPattern(query, options);
}

// Enumerate every match of `query` in `text`.
//
// An empty query matches nothing rather than everything — an empty find box
// should clear the highlight, not paint the document.
export function findMatches(
  text: string,
  query: string,
  options: MatchOptions = DEFAULT_MATCH_OPTIONS,
  cap: number = MATCH_CAP,
): MatchResult {
  if (query.length === 0) {
    return { ok: true, spans: [], truncated: false };
  }

  const pattern = buildPattern(query, options);
  if ("error" in pattern) {
    return { ok: false, error: pattern.error };
  }

  const spans: TextSpan[] = [];
  let truncated = false;
  let match = pattern.exec(text);
  while (match !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (end > start) {
      spans.push({ start, end });
      if (spans.length >= cap) {
        truncated = pattern.exec(text) !== null;
        break;
      }
    }
    // A pattern that can match the empty string (`a*`, `(?:)`, `^`) leaves
    // lastIndex where it was and would loop forever. Step past it; the match
    // itself is dropped because a zero-width span cannot be highlighted or
    // scrolled to.
    if (end === start) {
      pattern.lastIndex = start + 1;
      if (pattern.lastIndex > text.length) {
        break;
      }
    }
    match = pattern.exec(text);
  }

  return { ok: true, spans, truncated };
}

// The match to make current when the query changes, given where the reader
// currently is. Keeps the viewport stable: retyping a query lands on the
// first match at or after the previous position rather than jumping to the
// top of the document.
export function firstSpanAtOrAfter(spans: TextSpan[], offset: number): number {
  for (let index = 0; index < spans.length; index += 1) {
    if (spans[index]!.start >= offset) {
      return index;
    }
  }
  return spans.length > 0 ? 0 : -1;
}

// Step through matches with wrap-around at both ends.
export function stepIndex(current: number, total: number, delta: number): number {
  if (total <= 0) {
    return -1;
  }
  return (((current + delta) % total) + total) % total;
}
