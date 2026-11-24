// The checked-out branch's pull request: detection (design D4) and the
// summary (D5), as pinned GraphQL documents and soft parsers.
//
// Detection asks for at most ten pull requests whose head branch has the
// branch's name and keeps those whose head owner matches; the summary reads
// one pull request by number. Each costs about one point of GitHub's
// GraphQL budget.

import type {
  CheckRun,
  CheckState,
  ChecksRollup,
  PullRequestState,
  PullRequestSummary,
  ReviewDecision,
  Reviewer,
  ReviewerState,
} from "../../shared/github-contract";
import { MERGE_STATE_STATUSES, type Mergeable, type MergeStateStatus } from "./readiness";
import { bool, enumValue, int, login, nodes, obj, ParseNotes, required, str, totalCount, type JsonObject } from "./parse";

// Every summary field. `$number` is declared by the operation using it
// (requiredness of a check depends on the pull request's base).
export const SUMMARY_FRAGMENT = `fragment UatuPullRequestSummary on PullRequest {
  id
  number
  title
  url
  state
  isDraft
  createdAt
  updatedAt
  author { login }
  baseRefName
  headRefName
  baseRefOid
  headRefOid
  isCrossRepository
  headRepositoryOwner { login }
  reviewDecision
  commits { totalCount }
  changedFiles
  additions
  deletions
  mergeable
  mergeStateStatus
  reviewRequests(first: 20) {
    nodes {
      requestedReviewer {
        __typename
        ... on User { login }
        ... on Bot { login }
        ... on Mannequin { login }
        ... on Team { slug organization { login } }
      }
    }
  }
  latestReviews(first: 20) { nodes { author { login } state } }
  viewerPending: reviews(states: PENDING, first: 1) { nodes { comments { totalCount } } }
  lastCommit: commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          state
          contexts(first: 100) {
            totalCount
            nodes {
              __typename
              ... on CheckRun { name status conclusion isRequired(pullRequestNumber: $number) }
              ... on StatusContext { context state description isRequired(pullRequestNumber: $number) }
            }
          }
        }
      }
    }
  }
}`;

export const DETECT_PULL_REQUEST = {
  name: "UatuDetectPullRequest",
  query: `query UatuDetectPullRequest($owner: String!, $name: String!, $head: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $head, states: [OPEN, MERGED, CLOSED], first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number state updatedAt headRepositoryOwner { login } }
    }
  }
}`,
};

export const PULL_REQUEST_SUMMARY = {
  name: "UatuPullRequestSummary",
  query: `query UatuPullRequestSummary($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { ...UatuPullRequestSummary }
  }
}
${SUMMARY_FRAGMENT}`,
};

const PULL_REQUEST_STATES = ["OPEN", "CLOSED", "MERGED"] as const;
const REVIEW_DECISIONS = ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"] as const;

export function pullRequestState(value: unknown, notes: ParseNotes): PullRequestState {
  const state = enumValue(value, PULL_REQUEST_STATES, notes, "PullRequestState");
  // A state uatu doesn't know offers no writes: closed is the safe reading.
  return state === "other" ? "CLOSED" : state;
}

export function reviewDecision(value: unknown, notes: ParseNotes): ReviewDecision {
  if (value === null || value === undefined) return null;
  const decision = enumValue(value, REVIEW_DECISIONS, notes, "PullRequestReviewDecision");
  return decision === "other" ? null : decision;
}

// Detection's choice: the pull requests whose head owner matches, open first,
// then the most recently updated (GitHub already ordered them so).
export function pickDetected(data: unknown, headOwner: string, notes = new ParseNotes()): { viewer: string; number: number | null; repositoryFound: boolean } {
  const root = obj(data);
  const repository = obj(root?.repository);
  const candidates = nodes(obj(repository?.pullRequests)).filter(node => login(node.headRepositoryOwner).toLowerCase() === headOwner.toLowerCase());
  const open = candidates.find(node => pullRequestState(node.state, notes) === "OPEN");
  const chosen = open ?? candidates[0];
  return { viewer: login(root?.viewer), number: chosen ? int(chosen.number) || null : null, repositoryFound: repository !== null };
}

export type CheckFacts = { rollup: ChecksRollup; requiredFailing: string[]; requiredPending: string[] };

const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const PASSED_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const CHECK_RUN_CONCLUSIONS = [...FAILED_CONCLUSIONS, ...PASSED_CONCLUSIONS] as const;
const STATUS_STATES = ["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"] as const;

// One check run or commit status, as the contract's three states. An unknown
// conclusion reads as pending and says what GitHub sent.
function checkFromNode(node: JsonObject, notes: ParseNotes): (CheckRun & { required: boolean }) | null {
  const typename = str(node.__typename);
  if (typename === "CheckRun") {
    const name = str(node.name, "check");
    const status = str(node.status);
    if (status !== "COMPLETED") return { name, state: "PENDING", detail: status ? status.toLowerCase().replace(/_/g, " ") : "pending", required: bool(node.isRequired) };
    const conclusion = enumValue(node.conclusion, CHECK_RUN_CONCLUSIONS, notes, "CheckConclusionState");
    const state: CheckState = conclusion === "other" ? "PENDING" : FAILED_CONCLUSIONS.has(conclusion) ? "FAILURE" : "SUCCESS";
    const detail = conclusion === "other" ? `GitHub reported ${str(node.conclusion, "no result")}` : conclusion.toLowerCase().replace(/_/g, " ");
    return { name, state, detail, required: bool(node.isRequired) };
  }
  if (typename === "StatusContext") {
    const raw = enumValue(node.state, STATUS_STATES, notes, "StatusState");
    const state: CheckState = raw === "SUCCESS" ? "SUCCESS" : raw === "FAILURE" || raw === "ERROR" ? "FAILURE" : "PENDING";
    const description = str(node.description);
    return { name: str(node.context, "status"), state, detail: description || (raw === "other" ? "unknown" : raw.toLowerCase()), required: bool(node.isRequired) };
  }
  notes.skippedUnknown += 1;
  notes.note(`check __typename=${typename}`);
  return null;
}

export function checksFrom(pullRequest: JsonObject, notes: ParseNotes): CheckFacts {
  const commit = obj(nodes(pullRequest.lastCommit)[0]?.commit);
  const rollupNode = obj(commit?.statusCheckRollup);
  const contexts = obj(rollupNode?.contexts);
  const runs = nodes(contexts).flatMap(node => checkFromNode(node, notes) ?? []);
  const passed = runs.filter(run => run.state === "SUCCESS").length;
  const failed = runs.filter(run => run.state === "FAILURE").length;
  const pending = runs.filter(run => run.state === "PENDING").length;
  // More checks than were read: GitHub's own rollup state decides.
  const truncated = totalCount(contexts) > runs.length;
  const rollupState = str(rollupNode?.state);
  const state: CheckState = truncated && rollupState
    ? (rollupState === "SUCCESS" ? "SUCCESS" : rollupState === "FAILURE" || rollupState === "ERROR" ? "FAILURE" : "PENDING")
    : failed > 0 ? "FAILURE" : pending > 0 ? "PENDING" : "SUCCESS";
  return {
    rollup: { state, passed, failed, pending, runs: runs.map(({ name, state: runState, detail }) => ({ name, state: runState, detail })) },
    requiredFailing: runs.filter(run => run.required && run.state === "FAILURE").map(run => run.name),
    requiredPending: runs.filter(run => run.required && run.state === "PENDING").map(run => run.name),
  };
}

const REVIEW_STATES = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"] as const;

export function requestedLogins(pullRequest: JsonObject, notes: ParseNotes): string[] {
  return nodes(pullRequest.reviewRequests).flatMap(request => {
    const reviewer = obj(request.requestedReviewer);
    if (!reviewer) return [];
    const typename = str(reviewer.__typename);
    if (typename === "Team") return [`${login(reviewer.organization)}/${str(reviewer.slug, "team")}`];
    if (typename === "User" || typename === "Bot" || typename === "Mannequin") return [login(reviewer)];
    notes.skippedUnknown += 1;
    notes.note(`reviewer __typename=${typename}`);
    return [];
  });
}

// Latest review per reviewer, then the outstanding requests: a reviewer asked
// again after reviewing reads as awaited, as on GitHub.
export function reviewersFrom(pullRequest: JsonObject, notes: ParseNotes): Reviewer[] {
  const byLogin = new Map<string, ReviewerState>();
  for (const review of nodes(pullRequest.latestReviews)) {
    const state = enumValue(review.state, REVIEW_STATES, notes, "PullRequestReviewState");
    if (state === "APPROVED" || state === "CHANGES_REQUESTED" || state === "COMMENTED") byLogin.set(login(review.author), state);
  }
  for (const requested of requestedLogins(pullRequest, notes)) byLogin.set(requested, "REQUESTED");
  return [...byLogin].map(([reviewerLogin, state]) => ({ login: reviewerLogin, state })).slice(0, 20);
}

export function viewerPendingCount(pullRequest: JsonObject): number {
  return totalCount(obj(nodes(pullRequest.viewerPending)[0]?.comments));
}

export function mergeableFrom(value: unknown, notes: ParseNotes): Mergeable {
  return enumValue(value, ["MERGEABLE", "CONFLICTING", "UNKNOWN"] as const, notes, "MergeableState");
}

export function mergeStateStatusFrom(value: unknown, notes: ParseNotes): MergeStateStatus {
  return enumValue(value, MERGE_STATE_STATUSES, notes, "MergeStateStatus");
}

export type ParsedSummary = { summary: PullRequestSummary; id: string; checks: CheckFacts; mergeable: Mergeable; mergeStateStatus: MergeStateStatus; mergeStateStatusRaw: string };

export function parsePullRequestSummary(node: JsonObject, notes: ParseNotes, operation: string): ParsedSummary {
  const checks = checksFrom(node, notes);
  const number = required(int(node.number) || null, "pull request number", operation);
  const summary: PullRequestSummary = {
    number,
    title: str(node.title),
    url: required(str(node.url) || null, "pull request URL", operation),
    state: pullRequestState(node.state, notes),
    isDraft: bool(node.isDraft),
    author: login(node.author),
    baseRefName: str(node.baseRefName),
    headRefName: str(node.headRefName),
    baseRefOid: str(node.baseRefOid),
    headRefOid: required(str(node.headRefOid) || null, "head commit", operation),
    isCrossRepository: bool(node.isCrossRepository),
    headOwner: login(node.headRepositoryOwner),
    reviewDecision: reviewDecision(node.reviewDecision, notes),
    checks: checks.rollup,
    reviewers: reviewersFrom(node, notes),
    commits: totalCount(node.commits),
    changedFiles: int(node.changedFiles),
    additions: int(node.additions),
    deletions: int(node.deletions),
    createdAt: str(node.createdAt),
    updatedAt: str(node.updatedAt),
    viewerPendingComments: viewerPendingCount(node),
  };
  return {
    summary,
    id: required(str(node.id) || null, "pull request id", operation),
    checks,
    mergeable: mergeableFrom(node.mergeable, notes),
    mergeStateStatus: mergeStateStatusFrom(node.mergeStateStatus, notes),
    mergeStateStatusRaw: str(node.mergeStateStatus),
  };
}

