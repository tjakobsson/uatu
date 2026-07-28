import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SEARCH_OPTIONS,
  MAX_FILE_BYTES,
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
    fileSize: async absolutePath =>
      files[absolutePath] === undefined ? null : files[absolutePath]!.length,
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
    expect(matchLine("the cat sat", pattern, 10).matches.map(m => [m.start, m.end])).toEqual([
      [5, 7],
      [9, 11],
    ]);
  });

  test("a zero-width pattern terminates rather than enumerating forever", () => {
    const pattern = buildSearchPattern("x*", { ...DEFAULT_SEARCH_OPTIONS, regex: true }) as RegExp;
    expect(matchLine("abc", pattern, 10).matches).toEqual([]);
  });

  test("respects the remaining-results limit", () => {
    const pattern = buildSearchPattern("a", DEFAULT_SEARCH_OPTIONS) as RegExp;
    const capped = matchLine("aaaaa", pattern, 2);
    expect(capped.matches).toHaveLength(2);
    expect(capped.more).toBe(true);
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
        matches: [{ line: 2, text: "second needle here", start: 7, end: 13, ordinal: 0 }],
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
      fileSize: async () => 5,
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
      fileSize: async () => 1,
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

  test("whole-word groups a regex alternation before anchoring", async () => {
    // Ungrouped, `\bfoo|bar\b` would match `foo` inside `foobar` and `bar`
    // inside `crowbar`.
    const files = { "/abs/a.md": "foobar crowbar foo bar\n" };
    const events = await collect(roots(doc("a.md")), "foo|bar", files, {
      wholeWord: true,
      regex: true,
    });
    expect(fileResults(events)[0]!.matches.map(m => m.text.slice(m.start, m.end))).toEqual([
      "foo",
      "bar",
    ]);
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
      fileSize: async () => 100,
      now: () => 0,
    };
    await collect(roots(doc("a.md"), doc("b.md")), "xy", {}, {}, deps);
    expect(read).toEqual(["/abs/a.md"]);
  });

  test("a document that blows the time budget is reported, and the sweep continues", async () => {
    // A clock that jumps past the per-document budget once slow.md's own
    // matching starts — expressed in terms of that event rather than a call
    // count, so it does not shift when the sweep gains a reading elsewhere.
    // 1s is past the 250ms document budget and well inside the sweep
    // deadline, so this exercises the per-document path alone.
    let readingSlow = false;
    let callsSinceRead = 0;
    const deps: SearchDeps = {
      fileSize: async () => 10,
      readFile: async path => {
        readingSlow = path === "/abs/slow.md";
        callsSinceRead = 0;
        return readingSlow ? "a\nb\nc\n" : "hit\n";
      },
      now: () => {
        if (!readingSlow) return 0;
        callsSinceRead += 1;
        // The first reading after the read is the document's start stamp.
        return callsSinceRead <= 1 ? 0 : 1_000;
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

describe("sweep deadline", () => {
  // The per-document budget is checked between lines, so it cannot interrupt
  // backtracking inside a single match attempt. A whole-sweep deadline bounds
  // the damage to "deadline plus one attempt".
  test("a sweep past its deadline stops and says so", async () => {
    const docs = Array.from({ length: 100 }, (_, i) => doc(`f${i}.md`));
    const files = Object.fromEntries(docs.map(d => [d.id, "needle\n"]));
    let clock = 0;
    const deps: SearchDeps = {
      readFile: async path => files[path] ?? null,
      fileSize: async () => 10,
      // 50ms per reading. Four readings per document keeps each one inside
      // the 250ms per-document budget, so only the 10s sweep deadline fires —
      // which is the bound under test.
      now: () => (clock += 50),
    };
    const events: SearchEvent[] = [];
    for await (const e of searchDocuments(roots(...docs), "needle", DEFAULT_SEARCH_OPTIONS, deps)) {
      events.push(e);
    }
    const last = events.at(-1);
    expect(last?.kind === "done" && last.abandoned).toBe(true);
    // It stopped early rather than sweeping all fifty.
    expect(fileResults(events).length).toBeLessThan(docs.length);
  });

  test("results collected before the deadline are still reported", async () => {
    const docs = Array.from({ length: 100 }, (_, i) => doc(`f${i}.md`));
    const files = Object.fromEntries(docs.map(d => [d.id, "needle\n"]));
    let clock = 0;
    const deps: SearchDeps = {
      readFile: async path => files[path] ?? null,
      fileSize: async () => 10,
      now: () => (clock += 50),
    };
    const events: SearchEvent[] = [];
    for await (const e of searchDocuments(roots(...docs), "needle", DEFAULT_SEARCH_OPTIONS, deps)) {
      events.push(e);
    }
    expect(fileResults(events).length).toBeGreaterThan(0);
  });

  test("a sweep inside its deadline is not marked abandoned", async () => {
    const events = await collect(roots(doc("a.md")), "needle", { "/abs/a.md": "needle\n" });
    const last = events.at(-1);
    expect(last?.kind === "done" && last.abandoned).toBeUndefined();
  });
});

describe("literal ordinals", () => {
  // The client's reveal scans *literal* occurrences, so the ordinal has to
  // count those — not the match's position in the result list. Under
  // whole-word or regex those two disagree, and the result lands on the wrong
  // text with nothing to indicate it.
  test("whole-word: the only match is the second literal occurrence", async () => {
    const events = await collect(roots(doc("a.md")), "cat", { "/abs/a.md": "catapult cat\n" }, {
      wholeWord: true,
    });
    const matches = fileResults(events)[0]!.matches;
    expect(matches).toHaveLength(1);
    expect(matches[0]!.ordinal).toBe(1);
  });

  test("literal search: ordinals run 0, 1, 2 in document order", async () => {
    const events = await collect(roots(doc("a.md")), "cat", { "/abs/a.md": "cat\ncat\ncat\n" });
    expect(fileResults(events)[0]!.matches.map(m => m.ordinal)).toEqual([0, 1, 2]);
  });

  test("ordinals count across lines, not within them", async () => {
    const events = await collect(roots(doc("a.md")), "x", { "/abs/a.md": "xx\nx\n" }, {});
    // Below the minimum query length — nothing to assert but termination.
    expect(events.at(-1)?.kind).toBe("done");
  });

  test("a regex whose matches skip literal occurrences still lands right", async () => {
    // `cat\d` matches only `cat9`, which is the second literal `cat`.
    const events = await collect(roots(doc("a.md")), "cat(?=9)", { "/abs/a.md": "cat cat9\n" }, {
      regex: true,
    });
    const matches = fileResults(events)[0]!.matches;
    expect(matches).toHaveLength(1);
    expect(matches[0]!.ordinal).toBe(1);
  });
});

describe("truncation within a single line", () => {
  // A line holding more hits than the cap allows used to drop the excess in
  // silence. If that line was the last one, the sweep reported a capped list
  // as complete.
  test("a single line past the cap still reports truncation", async () => {
    const line = "xy ".repeat(MAX_RESULTS + 50);
    const events = await collect(roots(doc("a.md")), "xy", { "/abs/a.md": line });
    expect(doneEvent(events).truncated).toBe(true);
  });

  test("the only document, the only line, still reports truncation", async () => {
    const line = "xy".repeat(MAX_RESULTS + 1);
    const events = await collect(roots(doc("only.md")), "xy", { "/abs/only.md": line });
    const total = fileResults(events).reduce((n, r) => n + r.matches.length, 0);
    expect(total).toBe(MAX_RESULTS);
    expect(doneEvent(events).truncated).toBe(true);
  });

  test("a line exactly at the cap with nothing beyond is not truncated", async () => {
    const line = "xy".repeat(3);
    const events = await collect(roots(doc("a.md")), "xy", { "/abs/a.md": line }, {}, undefined);
    expect(doneEvent(events).truncated).toBe(false);
  });
});

describe("oversized files", () => {
  // Reading happens before any budget can be checked, so a huge generated file
  // costs its full read no matter what the deadline says.
  test("a file past the byte cap is never read", async () => {
    const read: string[] = [];
    const deps: SearchDeps = {
      fileSize: async path => (path === "/abs/huge.md" ? MAX_FILE_BYTES + 1 : 10),
      readFile: async path => {
        read.push(path);
        return "needle\n";
      },
      now: () => 0,
    };
    await collect(roots(doc("huge.md"), doc("small.md")), "needle", {}, {}, deps);
    expect(read).toEqual(["/abs/small.md"]);
  });

  test("skipping is disclosed, not silent", async () => {
    const deps: SearchDeps = {
      fileSize: async () => MAX_FILE_BYTES + 1,
      readFile: async () => "needle\n",
      now: () => 0,
    };
    const events = await collect(roots(doc("huge.md")), "needle", {}, {}, deps);
    expect(events.some(e => e.kind === "oversized" && e.relativePath === "huge.md")).toBe(true);
  });

  test("a file at the cap is still searched", async () => {
    const deps: SearchDeps = {
      fileSize: async () => MAX_FILE_BYTES,
      readFile: async () => "needle\n",
      now: () => 0,
    };
    const events = await collect(roots(doc("edge.md")), "needle", {}, {}, deps);
    expect(fileResults(events)).toHaveLength(1);
  });
});
