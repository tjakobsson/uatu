// A pull request's Conversation and merge readiness (design D5, D11): the
// summary fields, the body, the last 100 timeline entries of the kinds uatu
// shows, and the repository's merge settings. Bodies render through
// renderGithubMarkdown (D13).
//
// Timeline kinds are filtered in the query, so unrelated events (labels,
// pushes) don't crowd out comments; any `__typename` uatu doesn't know is
// still skipped and counted, never thrown. `omitted` is how many entries
// GitHub holds beyond those shown ("N more on GitHub").

import type { GithubComment, TimelineItem } from "../../shared/github-contract";
import { renderGithubMarkdown } from "../markdown";
import { mergeReadinessFrom, type ViewerPermission } from "./readiness";
import { bool, enumValue, login, nodes, obj, ParseNotes, required, str, totalCount, type JsonObject } from "./parse";
import { parsePullRequestSummary, SUMMARY_FRAGMENT, type ParsedSummary } from "./summary";

export const TIMELINE_LIMIT = 100;

export const PULL_REQUEST_CONVERSATION = {
  name: "UatuPullRequestConversation",
  query: `query UatuPullRequestConversation($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed
    squashMergeAllowed
    rebaseMergeAllowed
    deleteBranchOnMerge
    viewerPermission
    pullRequest(number: $number) {
      ...UatuPullRequestSummary
      body
      timelineItems(last: ${TIMELINE_LIMIT}, itemTypes: [ISSUE_COMMENT, PULL_REQUEST_REVIEW, MERGED_EVENT, HEAD_REF_DELETED_EVENT]) {
        totalCount
        nodes {
          __typename
          ... on IssueComment { id author { login } body createdAt }
          ... on PullRequestReview { id author { login } state body submittedAt createdAt }
          ... on MergedEvent { actor { login } createdAt }
          ... on HeadRefDeletedEvent { createdAt }
        }
      }
    }
  }
}
${SUMMARY_FRAGMENT}`,
};

export type ParsedConversation = {
  viewer: string;
  parsed: ParsedSummary;
  body: string;
  bodyHtml: string;
  // Review entries carry no thread ids yet: the threads adapter knows them.
  timeline: TimelineItem[];
  omitted: number;
  readiness: ReturnType<typeof mergeReadinessFrom>;
};

const PERMISSIONS = ["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"] as const;
const REVIEW_STATES = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"] as const;

export function githubComment(node: JsonObject, url: string): GithubComment {
  const body = str(node.body);
  return { id: str(node.id), author: login(node.author), body, bodyHtml: renderGithubMarkdown(body, url), createdAt: str(node.createdAt) };
}

export function parseConversation(data: unknown, notes = new ParseNotes()): ParsedConversation | null {
  const root = obj(data);
  const repository = obj(root?.repository);
  const node = obj(repository?.pullRequest);
  if (!repository || !node) return null;
  const operation = PULL_REQUEST_CONVERSATION.name;
  const parsed = parsePullRequestSummary(node, notes, operation);
  const url = parsed.summary.url;
  const timelineConnection = obj(node.timelineItems);
  const entries = nodes(timelineConnection);
  const timeline: TimelineItem[] = [];
  let skipped = 0;
  for (const [index, entry] of entries.entries()) {
    const typename = str(entry.__typename);
    if (typename === "IssueComment") {
      timeline.push({ kind: "comment", comment: githubComment(entry, url) });
    } else if (typename === "PullRequestReview") {
      const state = enumValue(entry.state, REVIEW_STATES, notes, "PullRequestReviewState");
      // The viewer's own pending review shows as the pending review, not here.
      if (state === "PENDING") continue;
      const body = str(entry.body);
      timeline.push({
        kind: "review",
        id: str(entry.id),
        author: login(entry.author),
        // A dismissed review (or one uatu doesn't know) reads as a comment.
        state: state === "APPROVED" || state === "CHANGES_REQUESTED" ? state : "COMMENTED",
        body,
        bodyHtml: renderGithubMarkdown(body, url),
        submittedAt: str(entry.submittedAt) || str(entry.createdAt),
        threadIds: [],
      });
    } else if (typename === "MergedEvent") {
      // GitHub's merged event doesn't say how it merged; a branch deletion
      // right after it says the head went.
      const deletedBranch = entries.slice(index + 1).some(later => str(later.__typename) === "HeadRefDeletedEvent");
      timeline.push({ kind: "merged", actor: login(entry.actor), at: str(entry.createdAt), deletedBranch });
    } else if (typename === "HeadRefDeletedEvent") {
      // Folded into the merged entry above.
    } else {
      skipped += 1;
      notes.skippedUnknown += 1;
      notes.note(`timeline __typename=${typename}`);
    }
  }
  const permission = repository.viewerPermission === null || repository.viewerPermission === undefined
    ? null
    : enumValue(repository.viewerPermission, PERMISSIONS, notes, "RepositoryPermission") as ViewerPermission;
  const readiness = mergeReadinessFrom({
    state: parsed.summary.state,
    isDraft: parsed.summary.isDraft,
    baseRefName: parsed.summary.baseRefName,
    mergeable: parsed.mergeable,
    mergeStateStatus: parsed.mergeStateStatus,
    mergeStateStatusRaw: parsed.mergeStateStatusRaw,
    reviewDecision: parsed.summary.reviewDecision,
    requiredFailing: parsed.checks.requiredFailing,
    requiredPending: parsed.checks.requiredPending,
    repository: {
      mergeCommitAllowed: bool(repository.mergeCommitAllowed),
      squashMergeAllowed: bool(repository.squashMergeAllowed),
      rebaseMergeAllowed: bool(repository.rebaseMergeAllowed),
      deleteBranchOnMerge: bool(repository.deleteBranchOnMerge),
    },
    viewerPermission: permission,
  });
  const body = str(node.body);
  return {
    viewer: required(login(root?.viewer), "viewer", operation),
    parsed,
    body,
    bodyHtml: renderGithubMarkdown(body, url),
    timeline,
    omitted: Math.max(0, totalCount(timelineConnection) - entries.length) + skipped,
    readiness,
  };
}

