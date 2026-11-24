import { describe, expect, test } from "bun:test";

import type { DocumentDiffReview, PullRequestDetail, ReviewThread } from "../shared/github-contract";
import { diffReviewNoteHtml, diffReviewPlan, diffReviewReasonText } from "./diff-pr-review";

const head = "a".repeat(40);
const thread = (id: string, overrides: Partial<ReviewThread> = {}): ReviewThread => ({
  id, path: "docs/guide.md", line: 3, side: "RIGHT", isResolved: false, isOutdated: false, lineText: "x",
  comments: [{ id: `${id}-c`, author: "octo-reviewer", body: "Why?", bodyHtml: "<p>Why?</p>", createdAt: "2026-11-24T00:00:00Z" }] as ReviewThread["comments"],
  ...overrides,
});
const detail = (overrides: { headRefOid?: string; patch?: boolean } = {}) => ({
  summary: { number: 42, headRefOid: overrides.headRefOid ?? head },
  files: [{ path: "docs/guide.md", status: "modified", additions: 1, deletions: 0, ...(overrides.patch === false ? {} : { patch: "@@ -1 +1 @@\n-a\n+b" }) }],
  threads: [thread("t1"), thread("t2", { line: null, isOutdated: true }), thread("t3", { path: "other.md" })],
}) as unknown as PullRequestDetail;
const exact: DocumentDiffReview = { number: 42, headOid: head, path: "docs/guide.md", exact: true };
const not = (reason: Extract<DocumentDiffReview, { exact: false }>["reason"], extra = {}): DocumentDiffReview => ({ number: 42, headOid: head, path: "docs/guide.md", exact: false, reason, ...extra });

describe("the document Diff's review plan (D8)", () => {
  test("exact, with the page's copy at the same head and the file's diff: inline", () => {
    expect(diffReviewPlan(exact, "pierre", detail())).toEqual({ kind: "inline", number: 42, path: "docs/guide.md" });
  });

  test("exact but too large for the inline renderer: listed, lightweight-render", () => {
    expect(diffReviewPlan(exact, "lightweight", detail())).toMatchObject({ kind: "list", reason: "lightweight-render" });
  });

  test("exact but the page hasn't read the pull request, or read another head: listed until it has", () => {
    expect(diffReviewPlan(exact, "pierre", null)).toMatchObject({ kind: "list", reason: "files-unknown", threads: [] });
    expect(diffReviewPlan(exact, "pierre", detail({ headRefOid: "b".repeat(40) }))).toMatchObject({ kind: "list", reason: "files-unknown" });
    expect(diffReviewPlan(exact, "pierre", detail({ patch: false }))).toMatchObject({ kind: "list", reason: "files-unknown" });
  });

  test("not exact: listed with the reason and the file's threads, outdated ones included", () => {
    const plan = diffReviewPlan(not("local-changes"), "pierre", detail());
    expect(plan).toMatchObject({ kind: "list", reason: "local-changes" });
    expect(plan.kind === "list" && plan.threads.map(entry => entry.id)).toEqual(["t1", "t2"]);
  });

  test("a file outside the pull request, or no review at all: nothing", () => {
    expect(diffReviewPlan(not("not-in-pr"), "pierre", detail())).toEqual({ kind: "none" });
    expect(diffReviewPlan(undefined, "pierre", detail())).toEqual({ kind: "none" });
  });

  test("every reason reads as a sentence, and the note lists threads with their way to Files changed", () => {
    for (const reason of ["last-commit", "base-inexact", "head-mismatch", "local-changes", "lightweight-render", "files-unknown"] as const) {
      const plan = diffReviewPlan(not(reason, reason === "base-inexact" ? { baseState: "stale" } : {}), "pierre", detail());
      if (plan.kind !== "list") throw new Error("expected a list");
      expect(diffReviewReasonText(plan, "1234567")).toMatch(/\.$|…$/);
    }
    const plan = diffReviewPlan(not("head-mismatch"), "pierre", detail());
    if (plan.kind !== "list") throw new Error("expected a list");
    expect(diffReviewReasonText(plan, "1234567")).toBe(`Your checkout is at 1234567, not #42's head ${head.slice(0, 7)}, so line numbers may differ from GitHub's.`);
    const html = diffReviewNoteHtml(plan, { checkoutCommit: "1234567", filesHref: id => `/?pr=42${id ? `&thread=${id}` : ""}` });
    expect(html).toContain("data-diff-review-fetch");
    expect(html).toContain("2 threads on this file");
    expect(html).toContain("Outdated");
    expect(html).toContain('href="/?pr=42&amp;thread=t1"');
  });
});
