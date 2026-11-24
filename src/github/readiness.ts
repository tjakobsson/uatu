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
  // GitHub can't be asked now (rate-limited, unreachable): the verdict is
  // the last one read, and the headline says so with its time.
  stale: boolean;
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

// `lastKnownAt` ("09:41"): GitHub can't be asked now, so a ready or blocked
// verdict is qualified in place, "Last known: ready to merge · as of 09:41",
// never shown as current. A stale "blocked" heading stays short; the reasons
// are the bullets under it.
export function mergeReadinessView(
  pr: Pick<PullRequestSummary, "state" | "isCrossRepository" | "headOwner" | "viewerPendingComments">,
  readiness: MergeReadiness | null,
  lastKnownAt: string | null = null,
): ReadinessView {
  if (pr.state === "MERGED") return { tone: "merged", headline: "Merged on GitHub", reasons: [], notes: [], pendingNote: null, stale: false };
  if (pr.state === "CLOSED") return { tone: "closed", headline: "Closed without merging", reasons: [], notes: [], pendingNote: null, stale: false };
  const pendingNote = pendingCommentsNote(pr.viewerPendingComments);
  if (!readiness) return { tone: "unknown", headline: lastKnownAt ? "Merge readiness unknown: GitHub can't be reached" : "Reading merge readiness…", reasons: [], notes: [], pendingNote, stale: lastKnownAt !== null };
  const notes = [
    mergeMethodsText(readiness.allowedMethods),
    pr.isCrossRepository
      ? `The head branch lives in ${pr.headOwner}'s fork and stays there.`
      : readiness.deleteBranchOnMerge ? "GitHub deletes the head branch after merging." : "GitHub keeps the head branch after merging.",
  ];
  const stale = lastKnownAt !== null;
  if (readiness.mergeable) {
    return { tone: "ready", headline: stale ? `Last known: ready to merge · as of ${lastKnownAt}` : "Ready to merge on GitHub", reasons: [], notes, pendingNote, stale };
  }
  const reasons = readiness.blockers.length ? readiness.blockers : ["GitHub hasn't said why."];
  const first = `${reasons[0]}${reasons.length > 1 ? ` (+${reasons.length - 1} more)` : ""}`;
  return {
    tone: "blocked",
    headline: stale ? `Last known: blocked · as of ${lastKnownAt}` : `Blocked: ${first}`,
    reasons,
    notes,
    pendingNote,
    stale,
  };
}

// The verdict in a word or two, for the details' Merge readiness heading. A
// stale one is qualified in its rows ("Last known: blocked · as of 09:41").
export function readinessVerdict(readiness: Pick<ReadinessView, "tone" | "reasons">): string {
  switch (readiness.tone) {
    case "blocked": return `${readiness.reasons.length} ${readiness.reasons.length === 1 ? "blocker" : "blockers"}`;
    case "ready": return "Ready";
    case "merged": return "Merged";
    case "closed": return "Closed";
    default: return "Unknown";
  }
}

// What the pane's Details row says is behind it: `Blockers, 5 checks, 2
// reviewers`, its first word the verdict when there is one.
export function detailsDisclosureText(tone: ReadinessView["tone"], checks: number, reviewers: number): string {
  const readiness = tone === "blocked" ? "Blockers" : tone === "ready" ? "Ready to merge" : "Readiness";
  return [readiness, `${checks} ${checks === 1 ? "check" : "checks"}`, `${reviewers} ${reviewers === 1 ? "reviewer" : "reviewers"}`].join(", ");
}
