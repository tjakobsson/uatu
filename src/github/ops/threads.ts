// A pull request's review threads and the viewer's pending review (design
// D5, D9), in one query. GitHub shows a reviewer their own pending comments
// inside `reviewThreads` too; this adapter splits them out into the pending
// review, so a thread lists only submitted comments.
//
// - A thread on a whole file (`subjectType: FILE`) has no line and is not
//   outdated: `line: null`, `subjectType: "FILE"`.
// - An outdated thread (`isOutdated`, or no current `line`) is listed, never
//   placed on the diff.
// - At most 100 threads with 50 comments each; `truncated` says there are
//   more on GitHub.

import type { DiffSide, PendingComment, PendingReview, ReviewThread } from "../../shared/github-contract";
import { renderGithubMarkdown } from "../markdown";
import { githubComment } from "./conversation";
import { bool, enumValue, intOrNull, nodes, obj, ParseNotes, str, totalCount, type JsonObject } from "./parse";

export const THREAD_LIMIT = 100;
export const THREAD_COMMENT_LIMIT = 50;

export const PULL_REQUEST_THREADS = {
  name: "UatuPullRequestThreads",
  query: `query UatuPullRequestThreads($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${THREAD_LIMIT}) {
        totalCount
        nodes {
          id
          path
          line
          startLine
          originalLine
          diffSide
          isResolved
          isOutdated
          subjectType
          comments(first: ${THREAD_COMMENT_LIMIT}) {
            totalCount
            nodes { id author { login } body createdAt diffHunk state pullRequestReview { id } }
          }
        }
      }
      pendingReviews: reviews(states: PENDING, first: 1) {
        nodes {
          id
          commit { oid }
          comments(first: 100) { nodes { id body createdAt path line replyTo { id } } }
        }
      }
    }
  }
}`,
};

export type ParsedThreads = {
  threads: ReviewThread[];
  pendingReview: PendingReview | null;
  // review id → the threads that review started (the Conversation's review
  // entries list them).
  threadsByReview: Map<string, string[]>;
  truncated: boolean;
};

// The commented line's text: the last line of GitHub's diff hunk, without
// its +/-/space marker.
export function lineTextFromHunk(hunk: unknown): string {
  const lines = str(hunk).split("\n").filter(line => !line.startsWith("@@"));
  const last = lines.at(-1) ?? "";
  return last.length > 0 && "+- ".includes(last[0]!) ? last.slice(1) : last;
}

function side(value: unknown, notes: ParseNotes): DiffSide {
  const parsed = enumValue(value, ["LEFT", "RIGHT"] as const, notes, "DiffSide");
  return parsed === "other" ? "RIGHT" : parsed;
}

export function parseThreads(data: unknown, notes = new ParseNotes(), url = ""): ParsedThreads | null {
  const pullRequest = obj(obj(obj(data)?.repository)?.pullRequest);
  if (!pullRequest) return null;
  const connection = obj(pullRequest.reviewThreads);
  const threads: ReviewThread[] = [];
  const threadByComment = new Map<string, { thread: ReviewThread; submitted: boolean }>();
  const threadsByReview = new Map<string, string[]>();
  let truncated = totalCount(connection) > nodes(connection).length;
  for (const node of nodes(connection)) {
    const subject = enumValue(node.subjectType ?? "LINE", ["LINE", "FILE"] as const, notes, "PullRequestReviewThreadSubjectType");
    const fileLevel = subject === "FILE";
    const comments = nodes(node.comments);
    if (totalCount(node.comments) > comments.length) truncated = true;
    const submitted = comments.filter(comment => str(comment.state) !== "PENDING");
    const line = fileLevel ? null : intOrNull(node.line);
    const thread: ReviewThread = {
      id: str(node.id),
      path: str(node.path),
      line,
      side: side(node.diffSide, notes),
      isResolved: bool(node.isResolved),
      // A file-level thread has no line and isn't outdated for it.
      isOutdated: fileLevel ? bool(node.isOutdated) : bool(node.isOutdated) || line === null,
      lineText: fileLevel ? "" : lineTextFromHunk(comments[0]?.diffHunk),
      comments: submitted.map(comment => githubComment(comment, url)),
      ...(fileLevel ? { subjectType: "FILE" as const } : {}),
    };
    for (const comment of comments) threadByComment.set(str(comment.id), { thread, submitted: submitted.length > 0 });
    if (submitted.length === 0) continue;
    threads.push(thread);
    const reviewId = str(obj(submitted[0]!.pullRequestReview)?.id);
    if (reviewId) threadsByReview.set(reviewId, [...(threadsByReview.get(reviewId) ?? []), thread.id]);
  }
  const pendingNode = nodes(pullRequest.pendingReviews)[0];
  const pendingReview: PendingReview | null = pendingNode
    ? {
        id: str(pendingNode.id),
        commitOid: str(obj(pendingNode.commit)?.oid),
        comments: nodes(pendingNode.comments).map(comment => pendingComment(comment, threadByComment, url)),
      }
    : null;
  return { threads, pendingReview, threadsByReview, truncated };
}

function pendingComment(comment: JsonObject, threadByComment: Map<string, { thread: ReviewThread; submitted: boolean }>, url: string): PendingComment {
  const body = str(comment.body);
  const base = { id: str(comment.id), body, bodyHtml: renderGithubMarkdown(body, url), createdAt: str(comment.createdAt) };
  const owner = threadByComment.get(str(comment.id));
  // A reply: its thread has submitted comments already.
  if (owner?.submitted) return { ...base, path: owner.thread.path, line: owner.thread.line ?? 0, side: owner.thread.side, threadId: owner.thread.id };
  if (owner) return { ...base, path: owner.thread.path, line: owner.thread.line ?? intOrNull(comment.line) ?? 0, side: owner.thread.side };
  return { ...base, path: str(comment.path), line: intOrNull(comment.line) ?? 0, side: "RIGHT" };
}
