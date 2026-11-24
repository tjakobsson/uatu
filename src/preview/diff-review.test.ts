import { describe, expect, test } from "bun:test";

import { reviewBarShownOn, reviewMarkBadges } from "./diff-review";

describe("reviewMarkBadges", () => {
  test("reads as words, with the glyphs hidden from assistive technology", () => {
    const html = reviewMarkBadges({ threads: 1, pending: 2 });
    expect(html).toContain('<span aria-hidden="true">💬 1</span><span class="sr-only">1 open review thread</span>');
    expect(html).toContain('<span aria-hidden="true">✎ 2</span><span class="sr-only">2 pending comments in your review</span>');
    expect(reviewMarkBadges({ threads: 0, pending: 0 })).toBe("");
    expect(reviewMarkBadges(undefined)).toBe("");
  });
});

describe("reviewBarShownOn", () => {
  const layout = { touch: false, pending: 0, open: true };
  const where = (input: Partial<typeof layout>) =>
    (["files", "conversation", "header"] as const).filter(surface => reviewBarShownOn(surface, { ...layout, ...input }));

  test("desktop: the review button in the tabs row; the bar above the files, and above the conversation while a review is pending", () => {
    expect(where({})).toEqual(["files", "header"]);
    expect(where({ pending: 2 })).toEqual(["files", "conversation", "header"]);
    // A closed pull request says so above its files, with no review button.
    expect(where({ open: false })).toEqual(["files"]);
  });

  test("touch: the one review button sits in the tabs row, pending or not", () => {
    expect(where({ touch: true })).toEqual(["header"]);
    expect(where({ touch: true, pending: 1 })).toEqual(["header"]);
    expect(where({ touch: true, open: false })).toEqual([]);
  });
});
