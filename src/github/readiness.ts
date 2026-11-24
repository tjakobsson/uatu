// Merge readiness, read-only (design D11): what the Pull request pane and the
// PR view say about merging. uatu never merges; GitHub owns that (merge
// queues, rulesets, stacked pull requests, the async merge API), so every
// surface links to the pull request on GitHub instead.

import type { MergeMethod, MergeReadiness, PullRequestSummary, Reviewer } from "../shared/github-contract";

const REVIEWER_STATE_ORDER: { state: Reviewer["state"]; label: string }[] = [
  { state: "CHANGES_REQUESTED", label: "Changes requested by" },
  { state: "APPROVED", label: "Approved by" },
  { state: "COMMENTED", label: "Commented:" },
  { state: "REQUESTED", label: "Awaiting" },
];

// Who stands where, by state, so a decision badge is never read as naming
// the wrong people: "Changes requested by a · Approved by b, c".
export function reviewerStatesText(reviewers: readonly Reviewer[]): string {
  return REVIEWER_STATE_ORDER.flatMap(({ state, label }) => {
    const logins = reviewers.filter(reviewer => reviewer.state === state).map(reviewer => reviewer.login);
    return logins.length ? [`${label} ${logins.join(", ")}`] : [];
  }).join(" · ");
}

export type ReadinessView = {
  tone: "ready" | "blocked" | "unknown" | "merged" | "closed";
  // One short line: "Ready to merge on GitHub", "Blocked: <first reason>
  // (+N more)".
  headline: string;
  // Every reason GitHub would refuse a merge now, most important first.
  reasons: string[];
  // The repository's merge methods and what happens to the head branch.
  notes: string[];
  // Set while the viewer has pending review comments on this pull request.
  pendingNote: string | null;
};

const METHOD_NAMES: Record<MergeMethod, string> = { MERGE: "merge commit", SQUASH: "squash", REBASE: "rebase" };

export function mergeMethodsText(methods: readonly MergeMethod[]): string {
  if (methods.length === 0) return "No merge method is allowed in this repository.";
  const names = methods.map(method => METHOD_NAMES[method]);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
  return `Merges by ${list}.`;
}

export function pendingCommentsNote(pending: number): string | null {
  if (pending <= 0) return null;
  return `You have ${pending} pending ${pending === 1 ? "comment" : "comments"} — finish your review before merging on GitHub.`;
}

export function mergeReadinessView(
  pr: Pick<PullRequestSummary, "state" | "isCrossRepository" | "headOwner" | "viewerPendingComments">,
  readiness: MergeReadiness | null,
): ReadinessView {
  if (pr.state === "MERGED") return { tone: "merged", headline: "Merged on GitHub", reasons: [], notes: [], pendingNote: null };
  if (pr.state === "CLOSED") return { tone: "closed", headline: "Closed without merging", reasons: [], notes: [], pendingNote: null };
  const pendingNote = pendingCommentsNote(pr.viewerPendingComments);
  if (!readiness) return { tone: "unknown", headline: "Reading merge readiness…", reasons: [], notes: [], pendingNote };
  const notes = [
    mergeMethodsText(readiness.allowedMethods),
    pr.isCrossRepository
      ? `The head branch lives in ${pr.headOwner}'s fork and stays there.`
      : readiness.deleteBranchOnMerge ? "GitHub deletes the head branch after merging." : "GitHub keeps the head branch after merging.",
  ];
  if (readiness.mergeable) return { tone: "ready", headline: "Ready to merge on GitHub", reasons: [], notes, pendingNote };
  const reasons = readiness.blockers.length ? readiness.blockers : ["GitHub hasn't said why."];
  return {
    tone: "blocked",
    headline: `Blocked: ${reasons[0]}${reasons.length > 1 ? ` (+${reasons.length - 1} more)` : ""}`,
    reasons,
    notes,
    pendingNote,
  };
}
