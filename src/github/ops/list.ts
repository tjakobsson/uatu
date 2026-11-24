// The repository's open pull requests (design D5, task 4.1): at most 100,
// most recently updated first, with each one's checks counts, whether the
// viewer's review is requested and the viewer's pending comment count.
// Filtering by text happens in the browser. `totalCount` says how many are
// open on GitHub, so the list can link there for the rest.

import type { PullRequestListItem } from "../../shared/github-contract";
import { bool, login, nodes, obj, ParseNotes, str, totalCount } from "./parse";
import { checksFrom, requestedLogins, reviewDecision, viewerPendingCount } from "./summary";

export const LIST_LIMIT = 100;

export const OPEN_PULL_REQUESTS = {
  name: "UatuOpenPullRequests",
  query: `query UatuOpenPullRequests($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${LIST_LIMIT}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      nodes {
        number
        title
        updatedAt
        isDraft
        isCrossRepository
        headRefName
        reviewDecision
        author { login }
        headRepositoryOwner { login }
        reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { slug organization { login } } } } }
        viewerPending: reviews(states: PENDING, first: 1) { nodes { comments { totalCount } } }
        lastCommit: commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 100) {
                  totalCount
                  nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state description } }
                }
              }
            }
          }
        }
      }
    }
  }
}`,
};

export function parseOpenPullRequests(data: unknown, notes = new ParseNotes()): { viewer: string; items: PullRequestListItem[]; totalCount: number } | null {
  const root = obj(data);
  const connection = obj(obj(root?.repository)?.pullRequests);
  if (!connection) return null;
  const viewer = login(root?.viewer);
  const items = nodes(connection).flatMap(node => {
    const number = typeof node.number === "number" ? node.number : 0;
    if (number < 1) return [];
    const checks = checksFrom(node, notes).rollup;
    return [{
      number,
      title: str(node.title),
      author: login(node.author),
      headRefName: str(node.headRefName),
      headOwner: login(node.headRepositoryOwner),
      isCrossRepository: bool(node.isCrossRepository),
      isDraft: bool(node.isDraft),
      reviewDecision: reviewDecision(node.reviewDecision, notes),
      viewerReviewRequested: requestedLogins(node, notes).some(reviewer => reviewer.toLowerCase() === viewer.toLowerCase()),
      checks: { state: checks.state, passed: checks.passed, failed: checks.failed, pending: checks.pending },
      updatedAt: str(node.updatedAt),
      viewerPendingComments: viewerPendingCount(node),
    }];
  });
  return { viewer, items, totalCount: totalCount(connection) };
}
