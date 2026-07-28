// Content search across the watched roots.
//
// There is no index and no walker here on purpose. The watch session already
// holds a `RootGroup[]` that is ignore-filtered (`.gitignore` + `.uatu.json`),
// binary-classified, and kept current by the watcher — so searching is reading
// that list and matching. Building a second corpus would mean a second set of
// ignore rules to keep in step and an invalidation problem to acquire.
//
// Everything that can go wrong with a user-supplied pattern is bounded here:
// syntax errors, patterns that match everywhere, patterns that can match the
// empty string, and patterns that are simply too expensive to run.

import type { DocumentMeta, RootGroup } from "../shared/types";

export type SearchOptions = {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
};

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

// Below this a query matches so much of the tree that the results are noise
// and the sweep is pure cost.
export const MIN_QUERY_LENGTH = 2;

// Enough to answer "where else does this appear" many times over; past it the
// result list has stopped being navigation.
export const MAX_RESULTS = 500;

// A single document may not monopolise the sweep. Generous for prose, tight
// enough that a catastrophic backtrack surfaces as one skipped file rather
// than a hung server.
export const PER_DOCUMENT_BUDGET_MS = 250;

// Largest file the sweep will read.
//
// Reading happens before any budget can be checked, and `split("\n")` then
// allocates a second copy — so a single generated file, minified bundle, or
// long log can cost far more than the sweep deadline suggests, in memory as
// well as time. Files past this are skipped and disclosed rather than silently
// dropped. (`document/diff.ts` bounds itself the same way, for the same
// reason.)
export const MAX_FILE_BYTES = 2_000_000;

// How long a whole sweep may run before it is abandoned.
//
// Checked between match attempts, never during one: a single `RegExp.exec` is
// not interruptible from JavaScript, so the honest bound is "this deadline,
// plus however long one attempt takes". Measured on Bun's JavaScriptCore,
// runaway backtracking plateaus around 460 ms per attempt rather than growing
// without limit, so the overshoot is bounded in practice — but it is the engine
// bounding it, not us.
//
// Running the sweep in a worker the server could terminate would make the bound
// ours. That was built and reverted: `bun build --compile` does not embed the
// worker module, so it held from source and silently fell back in the shipped
// binary. A guarantee that only applies in development is worse than a weaker
// one that applies everywhere.
export const SWEEP_DEADLINE_MS = 10_000;

export type SearchMatch = {
  // 1-based, the way editors and `grep -n` count.
  line: number;
  text: string;
  // Offsets of the match within `text`.
  start: number;
  end: number;
  // How many literal occurrences of this exact matched string precede it in
  // the document.
  //
  // Not the same as "which match this is": under whole-word or regex, literal
  // occurrences exist that are not matches. A whole-word search for `cat` in
  // `catapult cat` has one match, but it is the *second* literal `cat` — and
  // the reveal on the client scans literal occurrences, so it needs this
  // number rather than the match's position in the result list.
  ordinal: number;
  // Total literal occurrences of the matched string in the whole document.
  //
  // The ordinal is a *source* ordinal; the client reveals against whatever
  // view the reader is in, usually rendered. Rendering can drop occurrences
  // (a match inside a link URL exists in source but not in the rendered DOM),
  // and when it drops an *earlier* one, source ordinal n silently lands on a
  // different rendered occurrence. Comparing this total against the count the
  // client sees is how it knows whether the ordinals line up at all.
  literalTotal: number;
};

export type SearchFileResult = {
  documentId: string;
  relativePath: string;
  rootId: string;
  matches: SearchMatch[];
};

export type SearchEvent =
  | { kind: "file"; result: SearchFileResult }
  // Emitted when a document's pattern evaluation blew the time budget. The
  // sweep continues; the pane reports the pattern as too expensive rather
  // than pretending the file had no matches.
  | { kind: "expensive"; relativePath: string }
  // A document too large to read within the sweep's means. Skipped, and said
  // out loud — silently omitting a file makes the results a quiet lie.
  | { kind: "oversized"; relativePath: string }
  | {
      kind: "done";
      truncated: boolean;
      filesSearched: number;
      totalMatches: number;
      // Set when the sweep hit its deadline and stopped early. Results
      // collected before that point are still valid.
      abandoned?: boolean;
    };

function escapeLiteral(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word boundaries only at edges that are themselves word characters — the same
// rule the in-document matcher uses, so the two toggles mean the same thing on
// both sides of the app. A regex source must be grouped before anchoring, or
// `\bfoo|bar\b` distributes the boundaries across the alternation.
function applyWholeWord(source: string, query: string, group: boolean): string {
  const leading = /^\w/.test(query) ? "\\b" : "";
  const trailing = /\w$/.test(query) ? "\\b" : "";
  if (leading === "" && trailing === "") {
    return source;
  }
  const body = group ? `(?:${source})` : source;
  return `${leading}${body}${trailing}`;
}

export function buildSearchPattern(
  query: string,
  options: SearchOptions,
): RegExp | { error: string } {
  const base = options.regex ? query : escapeLiteral(query);
  const source = options.wholeWord ? applyWholeWord(base, query, options.regex) : base;
  try {
    return new RegExp(source, options.caseSensitive ? "g" : "gi");
  } catch (error) {
    return { error: error instanceof Error ? error.message : "invalid pattern" };
  }
}

// A hit within one line, before it is placed in the document. The line number
// and the literal ordinal are added by the caller, which is the only place that
// knows them.
export type LineMatch = Pick<SearchMatch, "text" | "start" | "end">;

// Match one line. Zero-width matches are dropped and stepped past — a pattern
// that can match the empty string would otherwise enumerate forever.
//
// `more` says whether the line held matches beyond `limit`. Without it, a line
// carrying more hits than the cap allows would have the excess dropped in
// silence, and a sweep that ended on that line would report a capped list as
// complete — the exact reading a reviewer must not be given.
//
// `outOfBudget` is checked while stepping past zero-width matches. Real
// matches are bounded by `limit`, but zero-width ones never fill `found`, so
// on a long line that walk is O(line length) exec calls that no outer check
// can interrupt — a pattern like `(?=(a?){50})` on a single-line file would
// otherwise occupy the server far past every advertised bound. `interrupted`
// reports the trip; the caller treats it like any blown document budget.
export function matchLine(
  line: string,
  pattern: RegExp,
  limit: number,
  outOfBudget?: () => boolean,
): { matches: LineMatch[]; more: boolean; interrupted: boolean } {
  const found: LineMatch[] = [];
  let more = false;
  pattern.lastIndex = 0;
  let match = pattern.exec(line);
  while (match !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (end > start) {
      if (found.length >= limit) {
        more = true;
        break;
      }
      found.push({ text: line, start, end });
    } else {
      if (outOfBudget?.()) {
        return { matches: found, more, interrupted: true };
      }
      pattern.lastIndex = start + 1;
      if (pattern.lastIndex > line.length) {
        break;
      }
    }
    match = pattern.exec(line);
  }
  return { matches: found, more, interrupted: false };
}

// How many non-overlapping literal occurrences of `needle` appear in `haystack`
// before `offset`. Counts the same way the client's reveal scans, which is what
// makes the two agree.
export function literalOrdinal(haystack: string, needle: string, offset: number): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1 && at < offset) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

// Every searchable document in tree order. Binaries carry no prose and would
// only ever match by accident, so they are excluded by the classification the
// tree already did.
export function searchableDocuments(roots: readonly RootGroup[]): DocumentMeta[] {
  const documents: DocumentMeta[] = [];
  for (const root of roots) {
    for (const doc of root.docs) {
      if (doc.kind !== "binary") {
        documents.push(doc);
      }
    }
  }
  return documents;
}

export type SearchDeps = {
  // Injected so the sweep can be tested without touching the filesystem.
  readFile: (absolutePath: string) => Promise<string | null>;
  // Size in bytes, or null when the file is unreadable. Consulted before the
  // read so an oversized file is never loaded at all.
  fileSize: (absolutePath: string) => Promise<number | null>;
  now: () => number;
};

const defaultDeps: SearchDeps = {
  fileSize: async absolutePath => {
    try {
      return Bun.file(absolutePath).size;
    } catch {
      return null;
    }
  },
  readFile: async absolutePath => {
    try {
      return await Bun.file(absolutePath).text();
    } catch {
      // Deleted between the scan and the read, or unreadable. Not an error
      // worth surfacing — the tree will catch up.
      return null;
    }
  },
  now: () => Date.now(),
};

// Run the sweep, yielding each document's hits as they are found so the client
// can render progressively rather than waiting on the whole tree.
//
// `signal` is the consumer saying "stop": a superseded query, a closed
// connection. Once it fires there is nobody to report to, so the sweep returns
// without a `done` event rather than sweeping the rest of the corpus for it.
export async function* searchDocuments(
  roots: readonly RootGroup[],
  query: string,
  options: SearchOptions = DEFAULT_SEARCH_OPTIONS,
  deps: SearchDeps = defaultDeps,
  deadlineMs: number = SWEEP_DEADLINE_MS,
  signal?: AbortSignal,
): AsyncGenerator<SearchEvent> {
  if (query.length < MIN_QUERY_LENGTH) {
    yield { kind: "done", truncated: false, filesSearched: 0, totalMatches: 0 };
    return;
  }

  const pattern = buildSearchPattern(query, options);
  if ("error" in pattern) {
    // The route rejects invalid patterns before starting a sweep; this is the
    // belt-and-braces path.
    yield { kind: "done", truncated: false, filesSearched: 0, totalMatches: 0 };
    return;
  }

  let totalMatches = 0;
  let filesSearched = 0;
  let truncated = false;
  let abandoned = false;
  const sweepStartedAt = deps.now();

  for (const doc of searchableDocuments(roots)) {
    if (signal?.aborted) {
      return;
    }
    if (totalMatches >= MAX_RESULTS) {
      truncated = true;
      break;
    }
    if (deps.now() - sweepStartedAt > deadlineMs) {
      abandoned = true;
      break;
    }

    const size = await deps.fileSize(doc.id);
    if (size !== null && size > MAX_FILE_BYTES) {
      yield { kind: "oversized", relativePath: doc.relativePath };
      continue;
    }

    const contents = await deps.readFile(doc.id);
    if (contents === null) {
      continue;
    }
    filesSearched += 1;

    const matches: SearchMatch[] = [];
    const startedAt = deps.now();
    let expensive = false;
    // One full-document scan per distinct matched string, not per match — for
    // a literal query every hit shares one entry.
    const literalTotals = new Map<string, number>();
    const literalTotal = (text: string): number => {
      let total = literalTotals.get(text);
      if (total === undefined) {
        total = literalOrdinal(contents, text, Number.POSITIVE_INFINITY);
        literalTotals.set(text, total);
      }
      return total;
    };
    const lines = contents.split("\n");
    // Absolute offset of the current line's start, so a match can be located
    // within the whole document rather than only within its line.
    let lineOffset = 0;

    for (let index = 0; index < lines.length; index += 1) {
      if (signal?.aborted) {
        return;
      }
      const now = deps.now();
      if (now - startedAt > PER_DOCUMENT_BUDGET_MS) {
        expensive = true;
        break;
      }
      if (now - sweepStartedAt > deadlineMs) {
        abandoned = true;
        break;
      }
      const remaining = MAX_RESULTS - totalMatches - matches.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      // In a CRLF document, `split("\n")` leaves the `\r` on every logical
      // line, which sits between the last character and a `$` anchor. Match
      // against the stripped line so regex behavior is independent of
      // line-ending style; offsets index the raw source, so the accounting
      // below keeps the CR.
      const rawLine = lines[index]!;
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      const lineHits = matchLine(
        line,
        pattern,
        remaining,
        () => deps.now() - startedAt > PER_DOCUMENT_BUDGET_MS,
      );
      if (lineHits.more) {
        truncated = true;
      }
      if (lineHits.interrupted) {
        expensive = true;
        break;
      }
      for (const hit of lineHits.matches) {
        const matchedText = line.slice(hit.start, hit.end);
        matches.push({
          ...hit,
          line: index + 1,
          ordinal: literalOrdinal(contents, matchedText, lineOffset + hit.start),
          literalTotal: literalTotal(matchedText),
        });
      }
      // +1 for the newline `split` consumed.
      lineOffset += rawLine.length + 1;
    }

    if (expensive) {
      yield { kind: "expensive", relativePath: doc.relativePath };
      continue;
    }

    if (abandoned) {
      break;
    }

    if (matches.length > 0) {
      totalMatches += matches.length;
      yield {
        kind: "file",
        result: {
          documentId: doc.id,
          relativePath: doc.relativePath,
          rootId: doc.rootId,
          matches,
        },
      };
    }
  }

  yield {
    kind: "done",
    truncated,
    filesSearched,
    totalMatches,
    ...(abandoned ? { abandoned: true } : {}),
  };
}
