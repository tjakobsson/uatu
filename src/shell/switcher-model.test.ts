import { describe, expect, test } from "bun:test";

import type { PullRequestListItem } from "../shared/github-contract";
import {
  filterPullRequests,
  lookupText,
  matchesSearch,
  middleTruncate,
  nextListSelection,
  otherRepositoryName,
  pullRequestCheckout,
  pullRequestLine2,
  pullRequestMatches,
  pullRequestQueryTarget,
  pullRequestRowName,
  shouldLookUp,
  sortPullRequests,
  switcherSpokenName,
  type LinePart,
} from "./switcher-model";

const repository = { host: "github.com", owner: "octo-org", name: "uatu" };

describe("pullRequestQueryTarget", () => {
  test("reads a number, with or without #", () => {
    expect(pullRequestQueryTarget("642")).toEqual({ number: 642, repository: null });
    expect(pullRequestQueryTarget(" #642 ")).toEqual({ number: 642, repository: null });
  });

  test("reads a pull request URL and the repository it names, with or without a trailing tab", () => {
    expect(pullRequestQueryTarget("https://github.com/octo-org/uatu/pull/642")).toEqual({ number: 642, repository });
    expect(pullRequestQueryTarget("https://github.com/octo-org/uatu/pull/642/files?w=1")?.number).toBe(642);
  });

  test("leaves words, zero and other URLs to the text search", () => {
    expect(pullRequestQueryTarget("fix 642")).toBeNull();
    expect(pullRequestQueryTarget("#0")).toBeNull();
    expect(pullRequestQueryTarget("https://github.com/octo-org/uatu/issues/642")).toBeNull();
    expect(pullRequestQueryTarget("")).toBeNull();
  });
});

describe("otherRepositoryName", () => {
  test("this repository's URL (any case, www.) is not another's; a number names none", () => {
    expect(otherRepositoryName(pullRequestQueryTarget("https://github.com/octo-org/uatu/pull/1")!, repository)).toBeNull();
    expect(otherRepositoryName(pullRequestQueryTarget("https://www.GitHub.com/Octo-Org/UATU/pull/1")!, repository)).toBeNull();
    expect(otherRepositoryName(pullRequestQueryTarget("#1")!, repository)).toBeNull();
  });

  test("names another repository, with its host when that differs", () => {
    expect(otherRepositoryName(pullRequestQueryTarget("https://github.com/someone/else/pull/642")!, repository)).toBe("someone/else");
    expect(otherRepositoryName(pullRequestQueryTarget("https://ghe.example.com/octo-org/uatu/pull/642")!, repository)).toBe("ghe.example.com/octo-org/uatu");
  });
});

describe("lookupText", () => {
  test("one sentence per outcome, without repeating GitHub's own words", () => {
    expect(lookupText(600, { status: "loading" }, "octo-org/uatu")).toBe("#600 isn't in the open list. Looking it up on GitHub…");
    expect(lookupText(99999, { status: "error", message: "Pull request #99999 does not exist in octo-org/uatu.", missing: true }, "octo-org/uatu"))
      .toBe("There's no pull request #99999 in octo-org/uatu.");
    expect(lookupText(5, { status: "error", message: "GitHub is unreachable.", missing: false }, "octo-org/uatu")).toBe("Couldn't look up #5 on GitHub: GitHub is unreachable.");
  });

  test("a found pull request says why it isn't in the open list", () => {
    const pr = { state: "MERGED" } as Parameters<typeof lookupText>[1] extends infer L ? L extends { status: "found"; pr: infer P } ? P : never : never;
    expect(lookupText(600, { status: "found", pr }, "octo-org/uatu")).toBe("#600 is merged, so it isn't in the open list.");
  });
});

describe("nextListSelection", () => {
  const rows = [642, 639, 631];
  test("with nothing selected, Down starts at the first row and Up at the last", () => {
    expect(nextListSelection(rows, null, "ArrowDown")).toBe(642);
    expect(nextListSelection(rows, null, "ArrowUp")).toBe(631);
    expect(nextListSelection(rows, 7, "ArrowUp")).toBe(631);
  });
  test("moves one row and wraps at both ends", () => {
    expect(nextListSelection(rows, 642, "ArrowDown")).toBe(639);
    expect(nextListSelection(rows, 631, "ArrowDown")).toBe(642);
    expect(nextListSelection(rows, 642, "ArrowUp")).toBe(631);
    expect(nextListSelection([], null, "ArrowUp")).toBeNull();
  });
});

describe("shouldLookUp", () => {
  const base = { named: true, otherRepository: false, exactOpen: false, visibleMatches: 0, settled: true };
  test("looks a number up only once typing has paused and nothing open matches", () => {
    expect(shouldLookUp(base)).toBe(true);
    // Typing "6", "63" on the way to "636": not yet.
    expect(shouldLookUp({ ...base, settled: false })).toBe(false);
    // An open pull request matches what is typed: no lookup, no "not found".
    expect(shouldLookUp({ ...base, visibleMatches: 2 })).toBe(false);
    expect(shouldLookUp({ ...base, exactOpen: true })).toBe(false);
    expect(shouldLookUp({ ...base, otherRepository: true })).toBe(false);
    expect(shouldLookUp({ ...base, named: false })).toBe(false);
  });
});

describe("the switcher's words", () => {
  const item = (overrides: Partial<PullRequestListItem> = {}): PullRequestListItem => ({
    number: 639, title: "fix(terminal): keep OSC 8 links", author: "octo-cat", headRefName: "osc8", headOwner: "octo-org",
    isCrossRepository: false, isDraft: false, reviewDecision: null, viewerReviewRequested: false,
    checks: { state: "SUCCESS", passed: 2, failed: 0, pending: 0 }, updatedAt: "2026-11-24T00:00:00Z", viewerPendingComments: 0,
    ...overrides,
  });

  test("a long name is cut in the middle; a short one is kept", () => {
    expect(middleTruncate("feat/view-pr", 16)).toBe("feat/view-pr");
    expect(middleTruncate("feature/a-very-long-branch-name", 16)).toBe("feature/…ch-name");
    expect(middleTruncate("feature/a-very-long-branch-name", 16)).toHaveLength(16);
  });

  test("the spoken name says both facts, then the badge", () => {
    expect(switcherSpokenName({ repository: "uatu", name: "feat/view-pr", viewing: 618, badge: "1 workspace awaiting your reply" }))
      .toBe("Switch. Working in uatu, feat/view-pr. Viewing pull request 618. 1 workspace awaiting your reply.");
    expect(switcherSpokenName({ repository: null, name: "notes", viewing: null, badge: "" })).toBe("Switch. Working in notes.");
    expect(switcherSpokenName({ repository: "uatu", name: "main", viewing: null, badge: "", stopped: true })).toBe("Switch. Working in uatu, main, stopped.");
  });

  test("line 2 reads author, Fork or Draft, checks and one review state; a pending review takes the review slot", () => {
    const text = (parts: LinePart[]) => parts.map(part => part.text).join(" · ");
    expect(text(pullRequestLine2(item({ isCrossRepository: true }), 2))).toBe("octo-cat · Fork · ✓ checks · ✎ 2 pending");
    expect(text(pullRequestLine2(item({ isDraft: true, checks: { state: "PENDING", passed: 0, failed: 0, pending: 1 } }), 0))).toBe("octo-cat · Draft · ◷ checks running");
    expect(text(pullRequestLine2(item({ reviewDecision: "CHANGES_REQUESTED", checks: { state: "FAILURE", passed: 1, failed: 1, pending: 0 } }), 0))).toBe("octo-cat · ✗ checks · changes requested");
    expect(pullRequestLine2(item({ viewerReviewRequested: true, reviewDecision: "APPROVED" }), 0).at(-1)).toEqual({ text: "review requested", tone: "attention", spoken: "your review requested" });
    expect(pullRequestLine2(item({ reviewDecision: "APPROVED" }), 0).at(-1)).toEqual({ text: "approved", tone: "success" });
  });

  test("a row's name reads both lines and the marks in words, then what Enter does", () => {
    expect(pullRequestRowName(item(), { viewing: true, checkedOut: false, pending: 0 }, "Choose how to open"))
      .toBe("Pull request 639, fix(terminal): keep OSC 8 links. octo-cat, checks passed. Viewing. Choose how to open");
  });

  test("pull requests that wait on the viewer come first; the rest keep the list's order", () => {
    const list = [item({ number: 1 }), item({ number: 2 }), item({ number: 3, viewerReviewRequested: true }), item({ number: 4 })];
    expect(sortPullRequests(list, number => number === 4 ? 1 : 0).map(entry => entry.number)).toEqual([3, 4, 1, 2]);
  });

  test("filters keep their pull requests", () => {
    const list = [item({ number: 1, author: "me" }), item({ number: 2, isDraft: true }), item({ number: 3, viewerReviewRequested: true })];
    expect(filterPullRequests(list, "open", "me").map(entry => entry.number)).toEqual([1, 2, 3]);
    expect(filterPullRequests(list, "mine", "me").map(entry => entry.number)).toEqual([1]);
    expect(filterPullRequests(list, "drafts", "me").map(entry => entry.number)).toEqual([2]);
    expect(filterPullRequests(list, "review-requested", "me").map(entry => entry.number)).toEqual([3]);
  });

  test("one search matches numbers, titles, authors and branches", () => {
    expect(pullRequestMatches(item(), "#63")).toBe(true);
    expect(pullRequestMatches(item(), "OSC")).toBe(true);
    expect(pullRequestMatches(item(), "octo-cat")).toBe(true);
    expect(pullRequestMatches(item(), "nothing")).toBe(false);
    expect(matchesSearch(["fix/pane-heights", null], "pane")).toBe(true);
  });

  test("a pull request's checkout: its branch and a folder beside the main checkout", () => {
    expect(pullRequestCheckout(item({ isCrossRepository: true }), "uatu")).toEqual({ branch: "pr/639", folderName: "pr-639", folder: "uatu.worktrees/pr-639" });
    expect(pullRequestCheckout(item({ headRefName: "fix/pane-heights" }), "uatu").folder).toBe("uatu.worktrees/fix-pane-heights");
  });
});
