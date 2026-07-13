import { describe, expect, test } from "bun:test";

import {
  createTrailingSignal,
  formatByteSize,
  formatRelativeTime,
  renderFileFactsStripHtml,
} from "./file-facts-strip";
import type { FileFacts } from "../shared/types";

const NOW = Date.parse("2026-07-13T12:00:00Z");

function gitFacts(overrides: Partial<NonNullable<FileFacts["git"]>> = {}): FileFacts {
  return {
    lines: 214,
    bytes: 8400,
    mtime: "2026-07-13T11:58:00Z",
    git: {
      author: "Tobias Jakobsson",
      authoredAt: "2025-11-04T10:00:00Z",
      shortSha: "dfe9088a",
      subject: "advertise-url and some clean up",
      dirty: false,
      ...overrides,
    },
  };
}

describe("formatByteSize", () => {
  test("bytes below 1024 stay in B", () => {
    expect(formatByteSize(512)).toBe("512 B");
  });

  test("kilobytes get one decimal under 10", () => {
    expect(formatByteSize(8400)).toBe("8.2 KB");
  });

  test("larger values round to whole units", () => {
    expect(formatByteSize(200 * 1024)).toBe("200 KB");
    expect(formatByteSize(3 * 1024 * 1024)).toBe("3 MB");
  });
});

describe("formatRelativeTime", () => {
  test("under a minute is just now", () => {
    expect(formatRelativeTime("2026-07-13T11:59:30Z", NOW)).toBe("just now");
  });

  test("minutes and hours", () => {
    expect(formatRelativeTime("2026-07-13T11:58:00Z", NOW)).toBe("2m ago");
    expect(formatRelativeTime("2026-07-13T09:00:00Z", NOW)).toBe("3h ago");
  });

  test("beyond a week degrades to the absolute date", () => {
    expect(formatRelativeTime("2026-05-01T00:00:00Z", NOW)).toMatch(/2026/);
  });

  test("garbage input yields empty string", () => {
    expect(formatRelativeTime("not-a-date", NOW)).toBe("");
  });
});

describe("renderFileFactsStripHtml — source variant", () => {
  test("clean committed file shows author, commit date, sha, lines, size", () => {
    const html = renderFileFactsStripHtml({ kind: "source", facts: gitFacts() }, NOW);
    expect(html).toContain("Tobias Jakobsson");
    expect(html).toContain("dfe9088a");
    expect(html).toContain("214 lines");
    expect(html).toContain("8.2 KB");
    expect(html).toContain("file-facts-freshness");
    expect(html).not.toContain("uncommitted");
    expect(html).not.toContain("modified");
  });

  test("dirty file shows modified-relative time with uncommitted marker", () => {
    const html = renderFileFactsStripHtml(
      { kind: "source", facts: gitFacts({ dirty: true }) },
      NOW,
    );
    expect(html).toContain("modified 2m ago");
    expect(html).toContain("uncommitted");
    // Last-commit identity survives alongside the dirty freshness.
    expect(html).toContain("dfe9088a");
  });

  test("never-committed file has no author or sha but keeps the uncommitted marker", () => {
    const facts: FileFacts = {
      lines: 3,
      bytes: 20,
      mtime: "2026-07-13T11:58:00Z",
      git: { author: null, authoredAt: null, shortSha: null, subject: null, dirty: true },
    };
    const html = renderFileFactsStripHtml({ kind: "source", facts }, NOW);
    expect(html).toContain("uncommitted");
    expect(html).toContain("3 lines");
    expect(html).not.toContain("file-facts-author");
    expect(html).not.toContain("file-facts-sha");
  });

  test("non-git root degrades to lines, size, and mtime without the uncommitted marker", () => {
    const facts: FileFacts = { lines: 1, bytes: 6, mtime: "2026-07-13T11:58:00Z" };
    const html = renderFileFactsStripHtml({ kind: "source", facts }, NOW);
    expect(html).toContain("1 line");
    expect(html).toContain("6 B");
    expect(html).toContain("modified 2m ago");
    expect(html).not.toContain("uncommitted");
  });

  test("missing facts render nothing", () => {
    expect(renderFileFactsStripHtml({ kind: "source", facts: undefined }, NOW)).toBe("");
  });
});

describe("renderFileFactsStripHtml — diff variant", () => {
  test("shows base ref, +/− counts, author, and sha", () => {
    const html = renderFileFactsStripHtml(
      { kind: "diff", facts: gitFacts(), baseRef: "origin/main", added: 12, deleted: 4 },
      NOW,
    );
    expect(html).toContain("vs origin/main");
    expect(html).toContain(">+12<");
    expect(html).toContain(">−4<");
    expect(html).toContain("Tobias Jakobsson");
    expect(html).toContain("dfe9088a");
    expect(html).not.toContain("lines");
  });

  test("escapes the base ref", () => {
    const html = renderFileFactsStripHtml(
      { kind: "diff", facts: undefined, baseRef: "<img>", added: null, deleted: null },
      NOW,
    );
    expect(html).not.toContain("<img>");
    expect(html).toContain("&lt;img&gt;");
  });

  test("no-git diff renders nothing when there is no base and no facts", () => {
    const html = renderFileFactsStripHtml(
      { kind: "diff", facts: undefined, baseRef: null, added: null, deleted: null },
      NOW,
    );
    expect(html).toBe("");
  });
});

describe("renderFileFactsStripHtml — hidden", () => {
  test("hidden state renders nothing", () => {
    expect(renderFileFactsStripHtml({ kind: "hidden" }, NOW)).toBe("");
  });
});

describe("createTrailingSignal", () => {
  type Timer = { callback: () => void; id: number };

  function fakeScheduler() {
    const timers = new Map<number, Timer>();
    let nextId = 1;
    return {
      timers,
      set: ((callback: () => void) => {
        const id = nextId++;
        timers.set(id, { callback, id });
        return id;
      }) as unknown as typeof setTimeout,
      clear: ((id: number) => {
        timers.delete(id);
      }) as unknown as typeof clearTimeout,
      fireAll() {
        const pending = [...timers.values()];
        timers.clear();
        for (const timer of pending) timer.callback();
      },
    };
  }

  test("first fire activates once; the burst does not re-trigger onChange", () => {
    const scheduler = fakeScheduler();
    const changes: boolean[] = [];
    const signal = createTrailingSignal(3000, active => changes.push(active), scheduler);

    signal.fire();
    signal.fire();
    signal.fire();
    expect(changes).toEqual([true]);
    // Rapid fires reset the timer instead of stacking: one pending timeout.
    expect(scheduler.timers.size).toBe(1);
  });

  test("settles after quiet — trailing edge, not leading", () => {
    const scheduler = fakeScheduler();
    const changes: boolean[] = [];
    const signal = createTrailingSignal(3000, active => changes.push(active), scheduler);

    signal.fire();
    scheduler.fireAll();
    expect(changes).toEqual([true, false]);

    // A new burst after settling lights it again.
    signal.fire();
    expect(changes).toEqual([true, false, true]);
  });

  test("clear() deactivates immediately and cancels the pending timer", () => {
    const scheduler = fakeScheduler();
    const changes: boolean[] = [];
    const signal = createTrailingSignal(3000, active => changes.push(active), scheduler);

    signal.fire();
    signal.clear();
    expect(changes).toEqual([true, false]);
    expect(scheduler.timers.size).toBe(0);

    // Clearing while inactive is a no-op.
    signal.clear();
    expect(changes).toEqual([true, false]);
  });
});
