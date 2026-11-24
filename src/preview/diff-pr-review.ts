// The document Diff view's pull request review (add-github-pr-review D8):
// what the view does with the session's `review` answer
// (`GET /api/document/diff`, src/github/anchoring.ts).
//
// - Exact (the checkout's diff of the file is provably the pull request's
//   own): the view mounts that file's Files changed (src/preview/
//   diff-review.ts, `only`, `fromCheckout`), so threads sit on their lines
//   and the gutter "+" opens the composer: one implementation of threads,
//   composers and the pending review. Exactness means those lines are the
//   checkout's lines, and each comment is re-checked against the checkout
//   when it is sent.
// - Not exact: the local diff stays, and a note above it says why
//   commenting isn't offered here, with the file's threads listed
//   (outdated ones marked), each opening in the pull request's Files
//   changed, where comments are always anchored.
// A file outside the pull request gets neither.

import { shortOid } from "../github/present";
import type { DocumentDiffReview, DocumentDiffReviewReason, PullRequestDetail, ReviewThread } from "../shared/github-contract";
import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import type { DiffRenderTier } from "./diff-view";

export type DiffReviewPlan =
  | { kind: "none" }
  | { kind: "inline"; number: number; path: string }
  | { kind: "list"; number: number; path: string; reason: DocumentDiffReviewReason; review: DocumentDiffReview; threads: ReviewThread[] };

// `detail`: the pull request as the page holds it (null while it's read).
export function diffReviewPlan(review: DocumentDiffReview | undefined, tier: DiffRenderTier | null, detail: PullRequestDetail | null): DiffReviewPlan {
  if (!review) return { kind: "none" };
  if (!review.exact && review.reason === "not-in-pr") return { kind: "none" };
  const known = detail && detail.summary.number === review.number ? detail : null;
  const threads = (known?.threads ?? []).filter(thread => thread.path === review.path);
  const list = (reason: DocumentDiffReviewReason): DiffReviewPlan => ({ kind: "list", number: review.number, path: review.path, reason, review, threads });
  if (!review.exact) return list(review.reason);
  if (tier === "lightweight") return list("lightweight-render");
  // The page's copy of the pull request must be the one the session judged:
  // the same head, with this file's diff.
  const file = known?.files.find(candidate => candidate.path === review.path);
  if (!known || known.summary.headRefOid !== review.headOid || !file || !(file.patch || file.newContents !== undefined)) return list("files-unknown");
  return { kind: "inline", number: review.number, path: review.path };
}

// Why commenting isn't offered in this Diff view, in the reviewer's words.
export function diffReviewReasonText(plan: Extract<DiffReviewPlan, { kind: "list" }>, checkoutCommit: string | null): string {
  const number = `#${plan.number}`;
  switch (plan.reason) {
    case "last-commit":
      return `This Diff compares against your last commit. Compare against the base to comment on ${number} here.`;
    case "base-inexact": {
      const state = plan.review.exact ? undefined : plan.review.baseState;
      return state === "missing"
        ? `${number}'s base isn't available locally, so this Diff isn't ${number}'s diff. Fetch its refs to compare against it.`
        : `${number}'s exact base commit isn't here, so this Diff may not match GitHub's. Fetch its refs to compare against it.`;
    }
    case "head-mismatch":
      return `Your checkout${checkoutCommit ? ` is at ${checkoutCommit}, not` : " isn't at"} ${number}'s head ${shortOid(plan.review.headOid)}, so line numbers may differ from GitHub's.`;
    case "local-changes":
      return "This file has local changes, which would move its line numbers on GitHub.";
    case "lightweight-render":
      return "This diff is too large to comment on inline.";
    case "files-unknown":
      return `Reading ${number}'s review…`;
    case "not-in-pr":
      return `This file isn't part of ${number}.`;
  }
}

// The reasons a fetch can fix: it brings the pull request's head and base in.
export function diffReviewOffersFetch(plan: Extract<DiffReviewPlan, { kind: "list" }>): boolean {
  return plan.reason === "base-inexact" || plan.reason === "head-mismatch";
}

// The note above a Diff that can't take comments: why, the way to the pull
// request's Files changed, and the file's threads (read-only here).
export function diffReviewNoteHtml(plan: Extract<DiffReviewPlan, { kind: "list" }>, options: { checkoutCommit: string | null; filesHref: (threadId?: string) => string }): string {
  const number = `#${plan.number}`;
  const threads = plan.threads.map(thread => {
    const first = thread.comments[0];
    const where = thread.isOutdated || thread.line === null
      ? `<span class="gh-pill">Outdated</span>`
      : `Line ${thread.line}${thread.side === "LEFT" ? " (old)" : ""}`;
    const more = thread.comments.length > 1 ? ` · ${thread.comments.length - 1} more` : "";
    return `<li class="uatu-diff-review-thread${thread.isResolved ? " is-resolved" : ""}">
        <div class="uatu-diff-review-thread-meta">${where}${thread.isResolved ? ` · Resolved` : ""}${first ? ` · <strong>${escapeHtml(first.author)}</strong>` : ""}${more}
          <a class="gh-link-button" href="${escapeHtmlAttribute(options.filesHref(thread.id))}" data-diff-review-open="${escapeHtmlAttribute(thread.id)}">Open in ${escapeHtml(number)}</a></div>
        ${first ? `<div class="markdown-body uatu-diff-review-thread-body">${first.bodyHtml}</div>` : ""}
      </li>`;
  }).join("");
  const fetch = diffReviewOffersFetch(plan)
    ? `<button type="button" class="gh-button" data-diff-review-fetch>Fetch ${escapeHtml(number)}'s refs</button>`
    : "";
  return `<div class="uatu-diff-review" role="note" aria-label="Commenting on ${escapeHtmlAttribute(number)}" data-diff-review-reason="${escapeHtmlAttribute(plan.reason)}">
      <p class="uatu-diff-review-why">${escapeHtml(diffReviewReasonText(plan, options.checkoutCommit))}
        ${plan.reason === "files-unknown" ? "" : `Comment in <a href="${escapeHtmlAttribute(options.filesHref())}" data-diff-review-open>${escapeHtml(number)}'s Files changed</a>.`}</p>
      ${fetch ? `<p class="uatu-diff-review-actions">${fetch}<span class="pr-muted" role="status" data-diff-review-status></span></p>` : ""}
      ${threads ? `<p class="uatu-diff-review-count">${plan.threads.length} ${plan.threads.length === 1 ? "thread" : "threads"} on this file</p><ul class="uatu-diff-review-threads">${threads}</ul>` : ""}
    </div>`;
}
