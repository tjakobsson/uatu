import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SEARCH_OPTIONS,
  MAX_RESULTS,
  matchLine,
  searchDocuments,
  searchableDocuments,
  buildSearchPattern,
  type SearchDeps,
  type SearchEvent,
  type SearchOptions,
} from "./search";
import type { DocumentKind, RootGroup } from "../shared/types";

function doc(relativePath: string, kind: DocumentKind = "markdown") {
  return {
    id: `/abs/${relativePath}`,
    name: relativePath.split("/").pop()!,
    relativePath,
    mtimeMs: 0,
    rootId: "/abs",
    kind,
  };
}

function roots(...docs: ReturnType<typeof doc>[]): RootGroup[] {
  return [{ id: "/abs", label: "abs", path: "/abs", docs, hiddenCount: 0 }];
}

function depsFor(files: Record<string, string>, clock?: () => number): SearchDeps {
  return {
    readFile: async absolutePath => files[absolutePath] ?? null,
    now: clock ?? (() => 0),
  };
}

async function collect(
  rootGroups: RootGroup[],
  query: string,
  files: Record<string, string>,
  options: Partial<SearchOptions> = {},
  deps?: SearchDeps,
): Promise<SearchEvent[]> {
  const events: SearchEvent[] = [];
  for await (const event of searchDocuments(
    rootGroups,
    query,
    { ...DEFAULT_SEARCH_OPTIONS, ...options },
    deps ?? depsFor(files),
  )) {
    events.push(event);
  }
  return events;
}

function fileResults(events: SearchEvent[]) {
  return events.flatMap(e => (e.kind === "file" ? [e.result] : []));
}

function doneEvent(events: SearchEvent[]) {
  const last = events.at(-1);
  if (last?.kind !== "done") {
    throw new Error("expected a done event");
  }
  return last;
}

describe("searchableDocuments", () => {
  test("binaries carry no prose and are excluded", () => {
    const list = searchableDocuments(
      roots(doc("a.md"), doc("logo.png", "binary"), doc("notes.txt", "text")),
    );
    expect(list.map(d => d.relativePath)).toEqual(["a.md", "notes.txt"]);
  });

  test("documents come out in tree order", () => {
    const list = searchableDocuments(roots(doc("a.md"), doc("b.md"), doc("c.md")));
    expect(list.map(d => d.relativePath)).toEqual(["a.md", "b.md", "c.md"]);
  });
});

describe("matchLine", () => {
  test("reports every match with its offsets", () => {
    const pattern = buildSearchPattern("at", DEFAULT_SEARCH_OPTIONS) as RegExp;
    expect(matchLine("the cat sat", pattern, 10).map(m => [m.start, m.end])).toEqual([
      [5, 7],
      [9, 11],
    ]);
  });

  test("a zero-width pattern terminates rather than enumerating forever", () => {
    const pattern = buildSearchPattern("x*", { ...DEFAULT_SEARCH_OPTIONS, regex: true }) as RegExp;
    expect(matchLine("abc", pattern, 10)).toEqual([]);
  });

  test("respects the remaining-results limit", () => {
    const pattern = buildSearchPattern("a", DEFAULT_SEARCH_OPTIONS) as RegExp;
    expect(matchLine("aaaaa", pattern, 2)).toHaveLength(2);
  });
});

describe("searchDocuments", () => {
  test("finds matches with 1-based line numbers and the full line", async () => {
    const events = await collect(roots(doc("a.md")), "needle", {
      "/abs/a.md": "first\nsecond needle here\nthird\n",
    });
    expect(fileResults(events)).toEqual([
      {
        documentId: "/abs/a.md",
        relativePath: "a.md",
        rootId: "/abs",
        matches: [{ line: 2, text: "second needle here", start: 7, end: 13 }],
      },
    ]);
  });

  test("groups by document and reports totals", async () => {
    const events = await collect(roots(doc("a.md"), doc("b.md")), "xy", {
      "/abs/a.md": "xy\nxy\n",
      "/abs/b.md": "nothing\n",
    });
    expect(fileResults(events)).toHaveLength(1);
    expect(doneEvent(events).totalMatches).toBe(2);
    expect(doneEvent(events).filesSearched).toBe(2);
  });

  test("multiple matches on one line are all reported", async () => {
    const events = await collect(roots(doc("a.md")), "ab", { "/abs/a.md": "ab ab ab\n" });
    expect(fileResults(events)[0]!.matches).toHaveLength(3);
  });

  test("binaries are never read", async () => {
    const read: string[] = [];
    const deps: SearchDeps = {
      readFile: async path => {
        read.push(path);
        return "match";
      },
      now: () => 0,
    };
    await collect(roots(doc("a.md"), doc("logo.png", "binary")), "match", {}, {}, deps);
    expect(read).toEqual(["/abs/a.md"]);
  });

  test("a query below the minimum length dispatches no reads", async () => {
    const read: string[] = [];
    const deps: SearchDeps = {
      readFile: async path => {
        read.push(path);
        return "a";
      },
      now: () => 0,
    };
    const events = await collect(roots(doc("a.md")), "a", {}, {}, deps);  // 1 char
    expect(read).toEqual([]);
    expect(doneEvent(events).totalMatches).toBe(0);
  });

  test("a file deleted between scan and read is skipped, not fatal", async () => {
    const events = await collect(roots(doc("gone.md"), doc("here.md")), "hit", {
      "/abs/here.md": "hit\n",
    });
    expect(fileResults(events).map(r => r.relativePath)).toEqual(["here.md"]);
    expect(doneEvent(events).filesSearched).toBe(1);
  });
});

describe("match options", () => {
  test("case-insensitive by default, case-sensitive on request", async () => {
    const files = { "/abs/a.md": "Preview preview\n" };
    expect(fileResults(await collect(roots(doc("a.md")), "preview", files))[0]!.matches).toHaveLength(2);
    const sensitive = await collect(roots(doc("a.md")), "preview", files, { caseSensitive: true });
    expect(fileResults(sensitive)[0]!.matches).toHaveLength(1);
  });

  test("whole-word rejects matches inside longer words", async () => {
    const files = { "/abs/a.md": "cat concatenate\n" };
    const events = await collect(roots(doc("a.md")), "cat", files, { wholeWord: true });
    expect(fileResults(events)[0]!.matches).toHaveLength(1);
  });

  test("regex metacharacters are literal unless regex mode is on", async () => {
    const files = { "/abs/a.md": "abc a.c\n" };
    const events = await collect(roots(doc("a.md")), "a.c", files);
    expect(fileResults(events)[0]!.matches).toHaveLength(1);
  });

  test("regex mode applies the pattern", async () => {
    const files = { "/abs/a.md": "a1 b2\n" };
    const events = await collect(roots(doc("a.md")), "[a-z]\\d", files, { regex: true });
    expect(fileResults(events)[0]!.matches).toHaveLength(2);
  });

  test("an invalid pattern is reported rather than thrown", () => {
    const built = buildSearchPattern("(unterminated", { ...DEFAULT_SEARCH_OPTIONS, regex: true });
    expect("error" in built).toBe(true);
  });
});

describe("bounds", () => {
  test("caps total results and says so", async () => {
    const line = "xy\n".repeat(MAX_RESULTS + 50);
    const events = await collect(roots(doc("a.md")), "xy", { "/abs/a.md": line });
    expect(doneEvent(events).truncated).toBe(true);
    const total = fileResults(events).reduce((n, r) => n + r.matches.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_RESULTS);
  });

  test("stops reading further documents once the cap is reached", async () => {
    const read: string[] = [];
    const deps: SearchDeps = {
      readFile: async path => {
        read.push(path);
        return "xy\n".repeat(MAX_RESULTS + 10);
      },
      now: () => 0,
    };
    await collect(roots(doc("a.md"), doc("b.md")), "xy", {}, {}, deps);
    expect(read).toEqual(["/abs/a.md"]);
  });

  test("a document that blows the time budget is reported, and the sweep continues", async () => {
    // A clock that jumps past the budget once matching starts.
    let ticks = 0;
    const deps: SearchDeps = {
      readFile: async path => (path === "/abs/slow.md" ? "a\nb\nc\n" : "hit\n"),
      now: () => {
        ticks += 1;
        return ticks > 2 ? 10_000 : 0;
      },
    };
    const events = await collect(roots(doc("slow.md"), doc("fast.md")), "hit", {}, {}, deps);
    expect(events.some(e => e.kind === "expensive" && e.relativePath === "slow.md")).toBe(true);
    expect(doneEvent(events)).toBeDefined();
  });

  test("under the cap nothing is marked truncated", async () => {
    const events = await collect(roots(doc("a.md")), "xy", { "/abs/a.md": "xy\n" });
    expect(doneEvent(events).truncated).toBe(false);
  });
});

describe("streaming", () => {
  test("each document's hits arrive before the sweep finishes", async () => {
    const events = await collect(roots(doc("a.md"), doc("b.md")), "hit", {
      "/abs/a.md": "hit\n",
      "/abs/b.md": "hit\n",
    });
    // Two file events, then done — not one batch at the end.
    expect(events.map(e => e.kind)).toEqual(["file", "file", "done"]);
  });
});
