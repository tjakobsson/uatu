// Every GitHub write uatu makes (design D9), as pinned GraphQL mutations whose
// input travels in `variables` on stdin (never `-f`/`-F`), plus the small
// precondition read each write re-checks first. The pending review is
// GitHub's own object: drafts survive reloads and show on github.com.
//
// There is no merge here, and no REST write: merging happens on GitHub
// (D11).

import type { PullRequestState } from "../../shared/github-contract";
import { login, nodes, obj, ParseNotes, required, str, totalCount } from "./parse";
import { pullRequestState } from "./summary";

const mutation = (name: string, field: string, input: string, selection: string) => ({
  name,
  write: true,
  query: `mutation ${name}($input: ${input}!) {
  ${field}(input: $input) { ${selection} }
}`,
});

export const ADD_COMMENT = mutation("UatuAddComment", "addComment", "AddCommentInput", "clientMutationId");
// Without `event` it creates the viewer's pending review; with one it creates
// and submits a review in one step.
export const ADD_REVIEW = mutation("UatuAddReview", "addPullRequestReview", "AddPullRequestReviewInput", "pullRequestReview { id }");
export const ADD_REVIEW_THREAD = mutation("UatuAddReviewThread", "addPullRequestReviewThread", "AddPullRequestReviewThreadInput", "thread { id }");
export const REPLY_TO_THREAD = mutation("UatuReplyToThread", "addPullRequestReviewThreadReply", "AddPullRequestReviewThreadReplyInput", "comment { id }");
export const RESOLVE_THREAD = mutation("UatuResolveThread", "resolveReviewThread", "ResolveReviewThreadInput", "thread { id }");
export const UNRESOLVE_THREAD = mutation("UatuUnresolveThread", "unresolveReviewThread", "UnresolveReviewThreadInput", "thread { id }");
export const EDIT_PENDING_COMMENT = mutation("UatuEditPendingComment", "updatePullRequestReviewComment", "UpdatePullRequestReviewCommentInput", "pullRequestReviewComment { id }");
export const DELETE_PENDING_COMMENT = mutation("UatuDeletePendingComment", "deletePullRequestReviewComment", "DeletePullRequestReviewCommentInput", "clientMutationId");
export const SUBMIT_REVIEW = mutation("UatuSubmitReview", "submitPullRequestReview", "SubmitPullRequestReviewInput", "pullRequestReview { id }");
export const DISCARD_REVIEW = mutation("UatuDiscardReview", "deletePullRequestReview", "DeletePullRequestReviewInput", "pullRequestReview { id }");

export const ALL_MUTATIONS = [
  ADD_COMMENT, ADD_REVIEW, ADD_REVIEW_THREAD, REPLY_TO_THREAD, RESOLVE_THREAD, UNRESOLVE_THREAD,
  EDIT_PENDING_COMMENT, DELETE_PENDING_COMMENT, SUBMIT_REVIEW, DISCARD_REVIEW,
];

export const WRITE_PRECONDITION = {
  name: "UatuPullRequestWriteCheck",
  query: `query UatuPullRequestWriteCheck($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      state
      headRefOid
      author { login }
      pendingReviews: reviews(states: PENDING, first: 1) {
        nodes { id commit { oid } comments(first: 100) { totalCount nodes { id } } }
      }
    }
  }
}`,
};

export type WritePrecondition = {
  viewer: string;
  id: string;
  state: PullRequestState;
  headRefOid: string;
  author: string;
  pending: { id: string; commitOid: string; commentIds: string[]; commentCount: number } | null;
};

export function parseWritePrecondition(data: unknown, notes = new ParseNotes()): WritePrecondition | null {
  const root = obj(data);
  const node = obj(obj(root?.repository)?.pullRequest);
  if (!node) return null;
  const operation = WRITE_PRECONDITION.name;
  const pending = nodes(node.pendingReviews)[0];
  return {
    viewer: login(root?.viewer),
    id: required(str(node.id) || null, "pull request id", operation),
    state: pullRequestState(node.state, notes),
    headRefOid: required(str(node.headRefOid) || null, "head commit", operation),
    author: login(node.author),
    pending: pending
      ? {
          id: str(pending.id),
          commitOid: str(obj(pending.commit)?.oid),
          commentIds: nodes(pending.comments).map(comment => str(comment.id)),
          commentCount: totalCount(pending.comments),
        }
      : null,
  };
}
