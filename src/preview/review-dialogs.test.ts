import { describe, expect, test } from "bun:test";

import type { PullRequestDetail } from "../shared/github-contract";
import { reviewActionLabel, reviewDialogStart, reviewSubmitReason, unsentReviewDrafts } from "./review-dialogs";

describe("reviewSubmitReason", () => {
  const open = { number: 7, state: "OPEN" };
  test("needs a verdict, and words for Comment or Request changes", () => {
    expect(reviewSubmitReason({ paused: null, pr: open, choice: null, summary: "", pendingComments: 0 })).toBe("Choose Comment, Approve or Request changes.");
    expect(reviewSubmitReason({ paused: null, pr: open, choice: "COMMENT", summary: "", pendingComments: 0 })).toBe("Write a summary or add a comment first.");
    expect(reviewSubmitReason({ paused: null, pr: open, choice: "REQUEST_CHANGES", summary: " ", pendingComments: 0 })).toBe("Say what needs to change.");
    expect(reviewSubmitReason({ paused: null, pr: open, choice: "APPROVE", summary: "", pendingComments: 0 })).toBeNull();
    expect(reviewSubmitReason({ paused: null, pr: open, choice: "COMMENT", summary: "", pendingComments: 1 })).toBeNull();
  });

  test("waits while GitHub can't take writes, and refuses a closed pull request", () => {
    expect(reviewSubmitReason({ paused: "paused", pr: open, choice: "APPROVE", summary: "", pendingComments: 0 })).toBe("paused");
    expect(reviewSubmitReason({ paused: null, pr: { number: 7, state: "MERGED" }, choice: "APPROVE", summary: "", pendingComments: 0 }))
      .toBe("#7 is merged; it can no longer be reviewed.");
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
      { location: { kind: "inline", path: "a.md", side: "RIGHT", line: 2 }, draft: draft("sent already") },
      { location: { kind: "inline", path: "gone.md", side: "RIGHT", line: 1 }, draft: draft("x") },
      { location: { kind: "reply", threadId: "gone" }, draft: draft("x") },
      { location: { kind: "conversation" }, draft: draft("not a review comment") },
    ], detail)).toEqual([]);
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
  test("starts a review, or finishes the one in progress with its count", () => {
    expect(reviewActionLabel(0)).toBe("Start review");
    expect(reviewActionLabel(2)).toBe("Finish review (2)");
  });
});
