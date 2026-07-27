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
// both sides of the app.
function applyWholeWord(source: string, query: string): string {
  const leading = /^\w/.test(query) ? "\\b" : "";
  const trailing = /\w$/.test(query) ? "\\b" : "";
  return `${leading}${source}${trailing}`;
}

export function buildSearchPattern(
  query: string,
  options: SearchOptions,
): RegExp | { error: string } {
  const base = options.regex ? query : escapeLiteral(query);
  const source = options.wholeWord ? applyWholeWord(base, query) : base;
  try {
    return new RegExp(source, options.caseSensitive ? "g" : "gi");
  } catch (error) {
    return { error: error instanceof Error ? error.message : "invalid pattern" };
  }
}

// Match one line. Zero-width matches are dropped and stepped past — a pattern
// that can match the empty string would otherwise enumerate forever.
export function matchLine(line: string, pattern: RegExp, limit: number): SearchMatch[] {
  const found: SearchMatch[] = [];
  pattern.lastIndex = 0;
  let match = pattern.exec(line);
  while (match !== null && found.length < limit) {
    const start = match.index;
    const end = start + match[0].length;
    if (end > start) {
      found.push({ line: 0, text: line, start, end });
    } else {
      pattern.lastIndex = start + 1;
      if (pattern.lastIndex > line.length) {
        break;
      }
    }
    match = pattern.exec(line);
  }
  return found;
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
  now: () => number;
};

const defaultDeps: SearchDeps = {
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
export async function* searchDocuments(
  roots: readonly RootGroup[],
  query: string,
  options: SearchOptions = DEFAULT_SEARCH_OPTIONS,
  deps: SearchDeps = defaultDeps,
  deadlineMs: number = SWEEP_DEADLINE_MS,
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
    if (totalMatches >= MAX_RESULTS) {
      truncated = true;
      break;
    }
    if (deps.now() - sweepStartedAt > deadlineMs) {
      abandoned = true;
      break;
    }

    const contents = await deps.readFile(doc.id);
    if (contents === null) {
      continue;
    }
    filesSearched += 1;

    const matches: SearchMatch[] = [];
    const startedAt = deps.now();
    let expensive = false;
    const lines = contents.split("\n");

    for (let index = 0; index < lines.length; index += 1) {
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
      const line = lines[index]!;
      for (const hit of matchLine(line, pattern, remaining)) {
        matches.push({ ...hit, line: index + 1 });
      }
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
