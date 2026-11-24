// The anchoring rule (add-github-pr-review D8): the document Diff view shows
// the local checkout, so it may place review threads on its lines and offer
// new inline comments only when that diff is provably the pull request's own
// diff of the file. That holds when all of these do:
// - the file is among the pull request's changed files;
// - the compare target is `base`;
// - the base is the pull request's exact base (D7 case 1: GitHub's base
//   commit is local, and the diff is measured from its merge base with HEAD);
// - HEAD is the pull request's head commit;
// - the file has no staged, unstaged or untracked changes.
// Then the displayed hunks are GitHub's: right-side numbers are the head
// blob's lines, left-side numbers the merge base's. Otherwise the answer
// names the first reason, in the order above, and the view lists the
// threads instead.
//
// Files changed in the pull request view needs none of this: it renders
// GitHub's own diff (D8's scope), so its comments are always anchored.
//
// The pull request facts come from the service's memory (`reviewContext`),
// never a GitHub request; the Git facts from the checkout.

import { documentDiffAnchor, repositoryDiffAnchor, type DocumentDiffAnchor } from "../document/diff";
import type { CompareTarget, RootGroup } from "../shared/types";
import type { DocumentDiffReview } from "../shared/github-contract";
import type { GithubService, PullRequestReviewContext } from "./service";

export function anchorReview(anchor: DocumentDiffAnchor, pullRequest: PullRequestReviewContext): DocumentDiffReview {
  const known = { number: pullRequest.number, headOid: pullRequest.headOid, path: anchor.relativePath };
  if (pullRequest.paths && !pullRequest.paths.has(anchor.relativePath)) return { ...known, exact: false, reason: "not-in-pr" };
  if (anchor.base.compareTarget !== "base") return { ...known, exact: false, reason: "last-commit" };
  const base = anchor.base.pullRequest;
  if (anchor.base.mode !== "pull-request" || !base || base.number !== pullRequest.number || base.state !== "exact" || anchor.base.targetsCollapsed) {
    const baseState = base && base.number === pullRequest.number && base.state !== "exact" ? base.state : "other";
    return { ...known, exact: false, reason: "base-inexact", baseState };
  }
  if (anchor.headSha !== pullRequest.headOid) return { ...known, exact: false, reason: "head-mismatch" };
  if (!anchor.clean) return { ...known, exact: false, reason: "local-changes" };
  if (!pullRequest.paths) return { ...known, exact: false, reason: "files-unknown" };
  return { ...known, exact: true };
}

// The `review` field of a document's diff, or null when its repository has
// no pull request the service knows of (or the session serves no GitHub).
export async function documentDiffReview(
  service: GithubService | null,
  roots: RootGroup[],
  documentId: string,
  compareTarget: CompareTarget,
): Promise<DocumentDiffReview | null> {
  if (!service?.reviewContext) return null;
  const anchor = await documentDiffAnchor(roots, documentId, compareTarget);
  if (!anchor) return null;
  const pullRequest = service.reviewContext(anchor.repoRoot);
  return pullRequest ? anchorReview(anchor, pullRequest) : null;
}

// The write-time re-check of a comment from the document Diff view: the same
// rule over the checkout as it is now, against the head GitHub just named.
export async function checkoutReview(repoRoot: string, filePath: string, pullRequest: PullRequestReviewContext): Promise<DocumentDiffReview | null> {
  const anchor = await repositoryDiffAnchor(repoRoot, filePath, "base");
  return anchor ? anchorReview(anchor, pullRequest) : null;
}
