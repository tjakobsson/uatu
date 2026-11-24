import { describe, expect, test } from "bun:test";

import { age, checkGlyph, checksSummaryHtml, externalLink, mergeLinkHtml, omittedNoteHtml, omittedNotes } from "./present";

const text = (html: string) => html.replace(/<span class="sr-only">([^<]*)<\/span>/g, "$1").replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

describe("age", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  test("reads just now under a minute, and for a clock slightly ahead", () => {
    expect(age("2026-11-23T12:00:00Z", now)).toBe("just now");
    expect(age("2026-11-23T11:59:01Z", now)).toBe("just now");
    expect(age("2026-11-23T12:00:05Z", now)).toBe("just now");
  });
  test("uses Git's long form from a minute on", () => {
    expect(age("2026-11-23T11:59:00Z", now)).toBe("60 seconds ago");
    expect(age("2026-11-23T11:55:00Z", now)).toBe("5 minutes ago");
    expect(age("not a date", now)).toBe("");
  });
});

describe("check glyphs", () => {
  test("a glyph beside words is hidden from screen readers", () => {
    expect(checkGlyph("PENDING")).toContain(`aria-label="running"`);
    expect(checkGlyph("PENDING", true)).toContain(`aria-hidden="true"`);
    expect(checkGlyph("PENDING", true)).not.toContain("aria-label");
  });
  test("the summary names each state once", () => {
    expect(text(checksSummaryHtml({ passed: 4, failed: 0, pending: 1 }))).toBe("4 passed, 1 running");
    expect(text(checksSummaryHtml({ passed: 3, failed: 0, pending: 0 }))).toBe("3 of 3 passed");
  });
});

describe("externalLink", () => {
  test("says it opens a new tab", () => {
    const html = externalLink("https://github.com/o/r/pull/1", "GitHub");
    expect(html).toContain(`target="_blank"`);
    expect(text(html)).toBe("GitHub (opens in a new tab)");
  });
});

describe("mergeLinkHtml", () => {
  test("Merge on GitHub, primary, only when ready; View on GitHub otherwise", () => {
    const ready = mergeLinkHtml("https://github.com/o/r/pull/1", true);
    expect(text(ready)).toBe("Merge on GitHub (opens in a new tab)");
    expect(ready).toContain("gh-button gh-button-merge");
    const blocked = mergeLinkHtml("https://github.com/o/r/pull/1", false, "x");
    expect(text(blocked)).toBe("View on GitHub (opens in a new tab)");
    expect(blocked).toContain('class="gh-button x"');
  });
});

describe("omittedNotes", () => {
  const omitted = (value: Partial<{ timeline: number; threads: boolean; files: boolean; unavailable: string[] }>) =>
    ({ omitted: { timeline: 0, threads: false, files: false, unavailable: [], ...value } });

  test("say nothing for a complete answer, or one from the fake", () => {
    expect(omittedNotes({}, "conversation")).toEqual([]);
    expect(omittedNotes(omitted({}), "conversation")).toEqual([]);
    expect(omittedNotes(omitted({}), "files")).toEqual([]);
    expect(omittedNoteHtml([], "https://github.com/acme/widgets/pull/42")).toBe("");
  });

  test("Conversation names timeline entries left out, threads and checks", () => {
    expect(omittedNotes(omitted({ timeline: 1 }), "conversation")).toEqual(["1 more timeline entry on GitHub"]);
    expect(omittedNotes(omitted({ timeline: 7, threads: true, unavailable: ["checks"] }), "conversation"))
      .toEqual(["7 more timeline entries on GitHub", "More review threads on GitHub", "GitHub didn't send the checks"]);
    expect(omittedNotes(omitted({ threads: true, unavailable: ["threads"] }), "conversation")).toEqual(["GitHub didn't send the review threads"]);
    // Files are Files changed's to say.
    expect(omittedNotes(omitted({ files: true, unavailable: ["files"] }), "conversation")).toEqual([]);
  });

  test("Files changed names files and threads", () => {
    expect(omittedNotes(omitted({ files: true }), "files")).toEqual(["More changed files on GitHub than shown here"]);
    expect(omittedNotes(omitted({ files: true, unavailable: ["files", "threads"] }), "files"))
      .toEqual(["GitHub didn't send the changed files", "GitHub didn't send the review threads"]);
    expect(omittedNotes(omitted({ timeline: 3, unavailable: ["checks"] }), "files")).toEqual([]);
  });

  test("the note links to GitHub and escapes nothing it didn't write", () => {
    const html = omittedNoteHtml(["2 more timeline entries on GitHub"], "https://github.com/acme/widgets/pull/42");
    expect(text(html)).toBe("2 more timeline entries on GitHub. Open on GitHub (opens in a new tab)");
    expect(html).toContain('href="https://github.com/acme/widgets/pull/42"');
    expect(html).toContain('role="note"');
  });
});
