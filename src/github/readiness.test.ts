import { describe, expect, test } from "bun:test";

import { detailsDisclosureText, mergeMethodsText, mergeReadinessView, pendingCommentsNote, readinessVerdict, reviewerStatesText } from "./readiness";

const open = { state: "OPEN" as const, isCrossRepository: false, headOwner: "octo-org", viewerPendingComments: 0 };
const readiness = { mergeable: true, blockers: [], allowedMethods: ["SQUASH" as const, "REBASE" as const], deleteBranchOnMerge: true };

describe("mergeReadinessView", () => {
  test("a mergeable pull request is ready, with the methods and the head branch's fate", () => {
    expect(mergeReadinessView(open, readiness)).toEqual({
      tone: "ready",
      headline: "Ready to merge on GitHub",
      reasons: [],
      notes: ["Merges by squash or rebase.", "GitHub deletes the head branch after merging."],
      pendingNote: null,
      stale: false,
    });
  });

  test("while GitHub can't be asked, the last verdict is qualified with its time", () => {
    expect(mergeReadinessView(open, readiness, "09:41")).toMatchObject({ tone: "ready", stale: true, headline: "Last known: ready to merge · as of 09:41" });
    expect(mergeReadinessView(open, { ...readiness, mergeable: false, blockers: ["a", "b"] }, "09:41"))
      .toMatchObject({ tone: "blocked", stale: true, headline: "Last known: blocked · as of 09:41", reasons: ["a", "b"] });
    expect(mergeReadinessView({ ...open, state: "MERGED" }, readiness, "09:41")).toMatchObject({ headline: "Merged on GitHub", stale: false });
  });

  test("a blocked pull request names its first reason and counts the rest", () => {
    expect(mergeReadinessView(open, { ...readiness, mergeable: false, blockers: ["Conflicts with main must be resolved."] }).headline)
      .toBe("Blocked: Conflicts with main must be resolved.");
    const view = mergeReadinessView(open, { ...readiness, mergeable: false, blockers: ["a", "b"] });
    expect(view).toMatchObject({ tone: "blocked", headline: "Blocked: a (+1 more)", reasons: ["a", "b"] });
  });

  test("pending comments add the finish-your-review note", () => {
    expect(mergeReadinessView({ ...open, viewerPendingComments: 2 }, readiness).pendingNote)
      .toBe("You have 2 pending comments — finish your review before merging on GitHub.");
    expect(pendingCommentsNote(1)).toBe("You have 1 pending comment — finish your review before merging on GitHub.");
    expect(pendingCommentsNote(0)).toBeNull();
  });

  test("forks keep their head branch, and a repository may keep head branches", () => {
    expect(mergeReadinessView({ ...open, isCrossRepository: true, headOwner: "octo-contrib" }, readiness).notes[1])
      .toBe("The head branch lives in octo-contrib's fork and stays there.");
    expect(mergeReadinessView(open, { ...readiness, deleteBranchOnMerge: false }).notes[1]).toBe("GitHub keeps the head branch after merging.");
  });

  test("merged, closed and not-yet-read pull requests say so", () => {
    expect(mergeReadinessView({ ...open, state: "MERGED" }, readiness).headline).toBe("Merged on GitHub");
    expect(mergeReadinessView({ ...open, state: "CLOSED" }, readiness).tone).toBe("closed");
    expect(mergeReadinessView(open, null).tone).toBe("unknown");
  });
});

describe("mergeMethodsText", () => {
  test("lists the allowed methods in words", () => {
    expect(mergeMethodsText(["MERGE", "SQUASH", "REBASE"])).toBe("Merges by merge commit, squash or rebase.");
    expect(mergeMethodsText(["SQUASH"])).toBe("Merges by squash.");
    expect(mergeMethodsText([])).toBe("No merge method is allowed in this repository.");
  });
});

describe("reviewerStatesText", () => {
  test("names who requested changes apart from who approved", () => {
    expect(reviewerStatesText([
      { login: "octo-maintainer", state: "APPROVED" },
      { login: "octo-lead", state: "CHANGES_REQUESTED" },
      { login: "octo-bot", state: "COMMENTED" },
      { login: "octo-new", state: "REQUESTED" },
      { login: "octo-second", state: "APPROVED" },
    ])).toBe("Changes requested by octo-lead · Approved by octo-maintainer, octo-second · Commented: octo-bot · Awaiting octo-new");
  });

  test("is empty without reviewers", () => {
    expect(reviewerStatesText([])).toBe("");
  });
});

describe("the pane's Details row and Merge readiness heading", () => {
  test("the row says what is behind it, the verdict first when there is one", () => {
    expect(detailsDisclosureText("blocked", 5, 2)).toBe("Blockers, 5 checks, 2 reviewers");
    expect(detailsDisclosureText("ready", 1, 1)).toBe("Ready to merge, 1 check, 1 reviewer");
    expect(detailsDisclosureText("merged", 0, 0)).toBe("Readiness, 0 checks, 0 reviewers");
  });

  test("the heading's verdict counts the blockers", () => {
    expect(readinessVerdict({ tone: "blocked", reasons: ["a", "b"] })).toBe("2 blockers");
    expect(readinessVerdict({ tone: "blocked", reasons: ["a"] })).toBe("1 blocker");
    expect(readinessVerdict({ tone: "ready", reasons: [] })).toBe("Ready");
    expect(readinessVerdict({ tone: "unknown", reasons: [] })).toBe("Unknown");
  });
});
