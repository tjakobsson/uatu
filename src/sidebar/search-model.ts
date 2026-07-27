// Pure result-model logic for the Search pane: what the summary says, when a
// query is worth dispatching, and how a matched line is trimmed for display.
// Split out from `search-pane.ts` (which binds live DOM at module load) so the
// wording and the rules can be unit-tested — the same split
// `outline-headings.ts` uses against `outline.ts`.

import type { SearchFileResult } from "../server/search";

export const MIN_QUERY_LENGTH = 2;

// A matched line is shown in a narrow sidebar. Long lines are windowed around
// the match rather than truncated from the left, so the match is always the
// thing you can see.
export const LINE_WINDOW = 120;

export type SearchSummaryState = "idle" | "short" | "searching" | "results" | "empty" | "invalid";

export type SearchSummary = {
  state: SearchSummaryState;
  label: string;
};

export function describeSearchSummary(input: {
  query: string;
  files: number;
  matches: number;
  running: boolean;
  truncated: boolean;
  error: string | null;
}): SearchSummary {
  if (input.error !== null) {
    return { state: "invalid", label: "Invalid pattern" };
  }
  if (input.query.length === 0) {
    return { state: "idle", label: "" };
  }
  if (input.query.length < MIN_QUERY_LENGTH) {
    return { state: "short", label: `Type ${MIN_QUERY_LENGTH}+ characters` };
  }
  if (input.running && input.matches === 0) {
    return { state: "searching", label: "Searching…" };
  }
  if (input.matches === 0) {
    return { state: "empty", label: "No results" };
  }
  const matchWord = input.matches === 1 ? "result" : "results";
  const fileWord = input.files === 1 ? "file" : "files";
  const count = input.truncated ? `${input.matches}+` : `${input.matches}`;
  const suffix = input.running ? "…" : "";
  return {
    state: "results",
    label: `${count} ${matchWord} · ${input.files} ${fileWord}${suffix}`,
  };
}

export function shouldDispatch(query: string): boolean {
  return query.length >= MIN_QUERY_LENGTH;
}

export type DisplayLine = {
  text: string;
  // Offsets of the match within `text` after windowing.
  start: number;
  end: number;
  truncatedStart: boolean;
  truncatedEnd: boolean;
};

// Window a long line so the match stays visible, keeping some context on
// either side. Leading indentation is dropped — in a sidebar it is all cost.
export function displayLine(text: string, start: number, end: number): DisplayLine {
  const leading = text.length - text.trimStart().length;
  let from = Math.max(0, start - leading);
  let to = Math.max(from, end - leading);
  let body = text.slice(leading);

  if (body.length <= LINE_WINDOW) {
    return { text: body, start: from, end: to, truncatedStart: false, truncatedEnd: false };
  }

  // Centre the window on the match, then clamp to the line's bounds.
  const matchLength = to - from;
  const slack = Math.max(0, LINE_WINDOW - matchLength);
  let windowStart = Math.max(0, from - Math.floor(slack / 2));
  const windowEnd = Math.min(body.length, windowStart + LINE_WINDOW);
  windowStart = Math.max(0, windowEnd - LINE_WINDOW);

  body = body.slice(windowStart, windowEnd);
  from -= windowStart;
  to -= windowStart;
  return {
    text: body,
    start: Math.max(0, from),
    end: Math.max(0, Math.min(body.length, to)),
    truncatedStart: windowStart > 0,
    truncatedEnd: windowEnd < text.length - leading,
  };
}

// Merge a streamed file result into the accumulated list, preserving arrival
// order — the server emits in tree order, so that is the order to keep.
export function mergeResult(
  results: SearchFileResult[],
  incoming: SearchFileResult,
): SearchFileResult[] {
  const existing = results.findIndex(r => r.documentId === incoming.documentId);
  if (existing === -1) {
    return [...results, incoming];
  }
  const merged = [...results];
  merged[existing] = {
    ...incoming,
    matches: [...merged[existing]!.matches, ...incoming.matches],
  };
  return merged;
}

export function countMatches(results: readonly SearchFileResult[]): number {
  return results.reduce((total, result) => total + result.matches.length, 0);
}
