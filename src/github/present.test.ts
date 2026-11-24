import { describe, expect, test } from "bun:test";

import { age, checkGlyph, checksSummaryHtml, externalLink } from "./present";

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
