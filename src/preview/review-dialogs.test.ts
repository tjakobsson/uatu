import { describe, expect, test } from "bun:test";

import type { PullRequestDetail } from "../shared/github-contract";
import { caretAtEnd, createLeftAsDrafts, reviewActionLabel, reviewDialogStart, reviewSubmitReason, submitReviewLabel, summaryGuidance, unsentReviewDrafts } from "./review-dialogs";

describe("reviewSubmitReason", () => {
  const open = { number: 7, state: "OPEN" };
  test("needs a verdict, and words for Comment or Request changes", () => {
    expect(reviewSubmitReason({ paused: null, pr: open, choice: null, summary: "", pendingComments: 0 })).toBe("Choose Comment, Approve or Request changes.");
    expect(reviewSubmitReason({ paused: null, pr: open, choice: "COMMENT", summary: "", pendingComments: 0 })).toBe("Write a summary or add a line comment first.");
    expect(reviewSubmitReason({ paused: null, pr: open, choice: "REQUEST_CHANGES", summary: " ", pendingComments: 0 })).toBe("Say what needs to change in the summary.");
    expect(reviewSubmitReason({ paused: null, pr: open, choice: "APPROVE", summary: "", pendingComments: 0 })).toBeNull();
    expect(reviewSubmitReason({ paused: null, pr: open, choice: "COMMENT", summary: "", pendingComments: 1 })).toBeNull();
  });

  test("a change request needs a summary even with pending comments (GitHub's rule)", () => {
    expect(reviewSubmitReason({ paused: null, pr: open, choice: "REQUEST_CHANGES", summary: "", pendingComments: 2 })).toBe("Say what needs to change in the summary.");
    expect(reviewSubmitReason({ paused: null, pr: open, choice: "REQUEST_CHANGES", summary: "Split it.", pendingComments: 0 })).toBeNull();
  });

  test("waits while GitHub can't take writes, and refuses a closed pull request", () => {
    expect(reviewSubmitReason({ paused: "paused", pr: open, choice: "APPROVE", summary: "", pendingComments: 0 })).toBe("paused");
    expect(reviewSubmitReason({ paused: null, pr: { number: 7, state: "MERGED" }, choice: "APPROVE", summary: "", pendingComments: 0 }))
      .toBe("#7 is merged; it can no longer be reviewed.");
  });
});

describe("summaryGuidance", () => {
  const cases: [Parameters<typeof summaryGuidance>[0], number][] = [
    [null, 0], [null, 2], ["APPROVE", 0], ["APPROVE", 1], ["COMMENT", 0], ["COMMENT", 1], ["COMMENT", 3], ["REQUEST_CHANGES", 0], ["REQUEST_CHANGES", 2],
  ];
  test("says required exactly when an empty summary can't be submitted", () => {
    const open = { number: 7, state: "OPEN" };
    for (const [choice, pending] of cases) {
      if (choice === null) continue;
      const blocked = reviewSubmitReason({ paused: null, pr: open, choice, summary: "", pendingComments: pending }) !== null;
      expect(`${choice}/${pending}: ${summaryGuidance(choice, pending).need}`).toBe(`${choice}/${pending}: ${blocked ? "required" : "optional"}`);
    }
  });

  test("follows the verdict and the pending count", () => {
    expect(summaryGuidance(null, 0)).toEqual({ need: null, placeholder: "Leave a summary (Markdown). Required to comment or request changes; optional to approve." });
    expect(summaryGuidance(null, 2).placeholder).toBe("Leave a summary (Markdown). Required to request changes.");
    expect(summaryGuidance("APPROVE", 0).placeholder).toBe("Optional: add a note to your approval (Markdown).");
    expect(summaryGuidance("COMMENT", 1).placeholder).toBe("Optional: your pending comment is published with it (Markdown).");
    expect(summaryGuidance("COMMENT", 3).placeholder).toBe("Optional: your 3 pending comments are published with it (Markdown).");
    expect(summaryGuidance("COMMENT", 0).placeholder).toBe("Write your comment (Markdown).");
    expect(summaryGuidance("REQUEST_CHANGES", 2).placeholder).toBe("Say what needs to change (Markdown).");
  });
});

describe("reviewSubmitReason with an edit open", () => {
  test("refuses to submit while a pending comment's edit is open, naming it", () => {
    const open = { number: 7, state: "OPEN" };
    expect(reviewSubmitReason({ paused: null, pr: open, choice: "APPROVE", summary: "", pendingComments: 1, editing: "README.md:10" }))
      .toBe("Save or cancel your edit of the comment on README.md:10 first.");
    expect(reviewSubmitReason({ paused: null, pr: open, choice: "APPROVE", summary: "", pendingComments: 1, editing: null })).toBeNull();
  });
});

describe("reviewSubmitReason and the length limit", () => {
  test("refuses a summary past GitHub's limit, with the reason", () => {
    const open = { number: 7, state: "OPEN" };
    expect(reviewSubmitReason({ paused: null, pr: open, choice: "COMMENT", summary: "x".repeat(65_537), pendingComments: 0 }))
      .toBe("Summary: Too long by 1 character: GitHub takes at most 65,536.");
    expect(reviewSubmitReason({ paused: null, pr: open, choice: "COMMENT", summary: "x".repeat(65_536), pendingComments: 0 })).toBeNull();
  });
});

describe("opening Finish review", () => {
  test("drops a whitespace-only summary, and starts with no verdict unless one was kept on this page", () => {
    expect(reviewDialogStart(null)).toEqual({ summary: "", choice: null });
    expect(reviewDialogStart({ text: "  \n ", at: 1 })).toEqual({ summary: "", choice: null });
    expect(reviewDialogStart({ text: "Needs a test", at: 1 })).toEqual({ summary: "Needs a test", choice: null });
    expect(reviewDialogStart(null, "APPROVE")).toEqual({ summary: "", choice: "APPROVE" });
  });
});

describe("unsent drafts at Finish review", () => {
  const detail = {
    viewer: "me",
    timeline: [],
    files: [{ path: "a.md" }],
    threads: [{ id: "t1", path: "a.md", line: 4, side: "RIGHT" }],
    pendingReview: { comments: [{ id: "c1", path: "a.md", line: 2, side: "RIGHT", body: "sent already", threadId: null }] },
  } as unknown as PullRequestDetail;
  const draft = (text: string) => ({ text, at: 1 });
  test("names line comments and replies not yet in the review", () => {
    const unsent = unsentReviewDrafts([
      { location: { kind: "inline", path: "a.md", side: "RIGHT", line: 14 }, draft: draft("look here") },
      { location: { kind: "reply", threadId: "t1" }, draft: draft("agreed") },
    ], detail);
    expect(unsent.map(entry => entry.where)).toEqual(["a.md:14 (new)", "reply on a.md:4 (new)"]);
  });
  test("skips blank drafts, ones GitHub already holds, and places gone from the pull request", () => {
    expect(unsentReviewDrafts([
      { location: { kind: "inline", path: "a.md", side: "RIGHT", line: 14 }, draft: draft("  ") },
      { location: { kind: "inline", path: "a.md", side: "RIGHT", line: 2 }, draft: { ...draft("sent already"), sending: [] } },
      { location: { kind: "inline", path: "gone.md", side: "RIGHT", line: 1 }, draft: draft("x") },
      { location: { kind: "reply", threadId: "gone" }, draft: draft("x") },
      { location: { kind: "conversation" }, draft: draft("not a review comment") },
    ], detail)).toEqual([]);
  });
  test("keeps the same words typed again on a line that already has them", () => {
    const repeat = unsentReviewDrafts([{ location: { kind: "inline", path: "a.md", side: "RIGHT", line: 2 }, draft: draft("sent already") }], detail);
    expect(repeat.map(entry => entry.where)).toEqual(["a.md:2 (new)"]);
  });
  test("a draft left out stays left out until its text changes", () => {
    const left = createLeftAsDrafts();
    const pr = { repositoryId: "repo", number: 7 };
    const entry = { location: { kind: "inline" as const, path: "a.md", side: "RIGHT" as const, line: 14 }, text: "look here" };
    expect(left.has(pr, entry)).toBe(false);
    left.leave(pr, entry);
    expect(left.has(pr, entry)).toBe(true);
    expect(left.has(pr, { ...entry, text: "look here, again" })).toBe(false);
    expect(left.has({ ...pr, number: 8 }, entry)).toBe(false);
  });
  test("Submit waits until each is added or left as a draft", () => {
    const open = { number: 7, state: "OPEN" };
    expect(reviewSubmitReason({ paused: null, pr: open, choice: "APPROVE", summary: "", pendingComments: 2, unsent: 1 }))
      .toBe("Add your unsent comment to the review, or leave it as a draft.");
    expect(reviewSubmitReason({ paused: null, pr: open, choice: "APPROVE", summary: "", pendingComments: 2, unsent: 2 }))
      .toBe("Add your 2 unsent comments to the review, or leave them as drafts.");
    expect(reviewSubmitReason({ paused: null, pr: open, choice: "APPROVE", summary: "", pendingComments: 2, unsent: 0 })).toBeNull();
  });
});

describe("reviewActionLabel", () => {
  test("one review button: Review, or Finish review with the pending count", () => {
    expect(reviewActionLabel(0)).toBe("Review");
    expect(reviewActionLabel(2)).toBe("Finish review (2)");
  });
});

describe("submitReviewLabel", () => {
  test("names the verdict it publishes", () => {
    expect(submitReviewLabel("APPROVE")).toBe("Publish approval");
    expect(submitReviewLabel("REQUEST_CHANGES")).toBe("Request changes");
    expect(submitReviewLabel("COMMENT")).toBe("Post comment review");
    expect(submitReviewLabel(null)).toBe("Submit review");
  });
});

describe("caretAtEnd", () => {
  test("puts the caret after text the field was given, so typing appends", () => {
    let range = [-1, -1];
    const field = { value: "Escape-loss test", setSelectionRange: (start: number, end: number) => { range = [start, end]; } };
    caretAtEnd(field);
    expect(range).toEqual([16, 16]);
    field.value = "";
    caretAtEnd(field);
    expect(range).toEqual([0, 0]);
  });
});
