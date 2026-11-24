// Merge readiness, read-only (design D11): every reason GitHub would refuse a
// merge now, most important first, mapped by one pure function from the
// pull request's and the repository's merge fields. uatu never merges: no
// query in src/github/ops names a merge mutation or the merge endpoint
// (readiness.test.ts checks that).
//
// Unknown `mergeStateStatus` or `mergeable` values become a generic blocker,
// never a throw. `isRequired` on a check is GitHub's answer for this pull
// request's base; a check whose requiredness GitHub didn't say counts as
// not required (it may still show as failing in the checks list).

import type { MergeMethod, MergeReadiness, PullRequestState, ReviewDecision } from "../../shared/github-contract";

export const MERGE_STATE_STATUSES = ["BEHIND", "BLOCKED", "CLEAN", "DIRTY", "DRAFT", "HAS_HOOKS", "UNKNOWN", "UNSTABLE"] as const;
export type MergeStateStatus = (typeof MERGE_STATE_STATUSES)[number] | "other";
export type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | "other";
export type ViewerPermission = "ADMIN" | "MAINTAIN" | "WRITE" | "TRIAGE" | "READ" | "other" | null;

export type ReadinessInput = {
  state: PullRequestState;
  isDraft: boolean;
  baseRefName: string;
  mergeable: Mergeable;
  mergeStateStatus: MergeStateStatus;
  // The raw value when it was unknown, for the generic blocker's words.
  mergeStateStatusRaw?: string;
  reviewDecision: ReviewDecision;
  requiredFailing: string[];
  requiredPending: string[];
  repository: { mergeCommitAllowed: boolean; squashMergeAllowed: boolean; rebaseMergeAllowed: boolean; deleteBranchOnMerge: boolean };
  viewerPermission: ViewerPermission;
};

function list(names: string[]): string {
  return names.slice(0, 10).join(", ") + (names.length > 10 ? ` and ${names.length - 10} more` : "");
}

export function mergeReadinessFrom(input: ReadinessInput): MergeReadiness {
  const allowedMethods: MergeMethod[] = [
    ...(input.repository.mergeCommitAllowed ? ["MERGE" as const] : []),
    ...(input.repository.squashMergeAllowed ? ["SQUASH" as const] : []),
    ...(input.repository.rebaseMergeAllowed ? ["REBASE" as const] : []),
  ];
  const result = (blockers: string[]): MergeReadiness => ({
    mergeable: blockers.length === 0,
    blockers,
    allowedMethods,
    deleteBranchOnMerge: input.repository.deleteBranchOnMerge,
  });
  if (input.state === "MERGED") return result(["Already merged."]);
  if (input.state === "CLOSED") return result(["Closed."]);

  const blockers: string[] = [];
  if (input.isDraft || input.mergeStateStatus === "DRAFT") blockers.push("Draft: mark it ready for review on GitHub first.");
  if (input.mergeable === "CONFLICTING" || input.mergeStateStatus === "DIRTY") blockers.push(`Conflicts with ${input.baseRefName} must be resolved.`);
  if (input.reviewDecision === "CHANGES_REQUESTED") blockers.push("Changes were requested; that reviewer must approve.");
  if (input.reviewDecision === "REVIEW_REQUIRED") blockers.push(`${input.baseRefName} requires an approving review.`);
  if (input.requiredFailing.length > 0) {
    blockers.push(`Required ${input.requiredFailing.length === 1 ? "check" : "checks"} failing: ${list(input.requiredFailing)}.`);
  }
  if (input.requiredPending.length > 0) {
    blockers.push(`Waiting for required ${input.requiredPending.length === 1 ? "check" : "checks"}: ${list(input.requiredPending)}.`);
  }
  if (input.mergeStateStatus === "BEHIND") blockers.push(`Behind ${input.baseRefName}: update the branch on GitHub first.`);
  if (input.mergeable === "UNKNOWN" || input.mergeStateStatus === "UNKNOWN") blockers.push("GitHub is still checking whether it can merge.");
  if (input.mergeable === "other") blockers.push("GitHub reports a mergeability uatu doesn't know; see the pull request on GitHub.");
  if (input.mergeStateStatus === "other") {
    blockers.push(`GitHub reports merge state ${input.mergeStateStatusRaw ?? "unknown"}; see the pull request on GitHub.`);
  }
  // BLOCKED with nothing above to explain it: a branch rule GitHub enforces
  // that the API doesn't spell out (a required conversation resolution, a
  // ruleset, a code owner's review).
  if (input.mergeStateStatus === "BLOCKED" && blockers.length === 0) {
    blockers.push(`A rule on ${input.baseRefName} blocks merging; see the pull request on GitHub.`);
  }
  if (input.viewerPermission === "READ" || input.viewerPermission === "TRIAGE") {
    blockers.push(`Your access to this repository (${input.viewerPermission.toLowerCase()}) can't merge.`);
  }
  if (allowedMethods.length === 0) blockers.push("The repository allows no merge method.");
  return result(blockers);
}
