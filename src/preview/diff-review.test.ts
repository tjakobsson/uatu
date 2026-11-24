import { describe, expect, test } from "bun:test";

import { reviewMarkBadges } from "./diff-review";

describe("reviewMarkBadges", () => {
  test("reads as words, with the glyphs hidden from assistive technology", () => {
    const html = reviewMarkBadges({ threads: 1, pending: 2 });
    expect(html).toContain('<span aria-hidden="true">💬 1</span><span class="sr-only">1 open review thread</span>');
    expect(html).toContain('<span aria-hidden="true">✎ 2</span><span class="sr-only">2 pending comments in your review</span>');
    expect(reviewMarkBadges({ threads: 0, pending: 0 })).toBe("");
    expect(reviewMarkBadges(undefined)).toBe("");
  });
});
