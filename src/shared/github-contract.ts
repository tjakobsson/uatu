// Wire types for the GitHub pull request surfaces, shared by the session
// child's `/api/github/*` routes (src/github/http.ts) and the browser
// (src/github/client.ts). One definition, so the two halves cannot drift.
//
// Names follow openspec/changes/add-github-pr-review/design.md (D5) where it
// was cheap. The summary is fetched on demand from `/api/github/summary`
// rather than riding `RepositorySnapshot.github`, which keeps these internal
// routes out of the public workspace contract.
//
// Two backends answer in this shape: the real `gh api` service
// (src/github/gh-service.ts) and the in-memory fake (src/github/fake.ts).
// Fields only one of them fills are optional.

// Every repository's GitHub summary carries exactly one status.
export const GITHUB_STATUSES = [
  "ready",
  "no-pull-request",
  "not-github",
  "gh-missing",
  "no-credential",
  "no-access",
  "rate-limited",
  "unavailable",
] as const;
export type GithubStatus = (typeof GITHUB_STATUSES)[number];

export type GithubRepositoryRef = { host: string; owner: string; name: string };

export type PullRequestState = "OPEN" | "CLOSED" | "MERGED";
export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
export type CheckState = "SUCCESS" | "FAILURE" | "PENDING";
export type MergeMethod = "MERGE" | "SQUASH" | "REBASE";
export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
export type DiffSide = "LEFT" | "RIGHT";

export type CheckRun = { name: string; state: CheckState; detail: string };
export type ChecksRollup = {
  state: CheckState;
  passed: number;
  failed: number;
  pending: number;
  runs: CheckRun[];
};

export type ReviewerState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "REQUESTED";
export type Reviewer = { login: string; state: ReviewerState };

export type PullRequestSummary = {
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  isDraft: boolean;
  author: string;
  baseRefName: string;
  headRefName: string;
  baseRefOid: string;
  headRefOid: string;
  isCrossRepository: boolean;
  headOwner: string;
  reviewDecision: ReviewDecision;
  checks: ChecksRollup;
  reviewers: Reviewer[];
  commits: number;
  changedFiles: number;
  additions: number;
  deletions: number;
  createdAt: string;
  updatedAt: string;
  // Comments in the viewer's pending review on this PR (0 without one).
  viewerPendingComments: number;
};

export type GithubSummary = {
  status: GithubStatus;
  // True when the data comes from the in-memory fake (src/github/fake.ts).
  // The UI labels every surface "Mocked GitHub data" while it is set.
  mock: boolean;
  repository: GithubRepositoryRef | null;
  viewer: string | null;
  // When GitHub last answered successfully (ms since epoch).
  checkedAt: number;
  // The pull request below is the last known answer, not a fresh one.
  stale: boolean;
  retryAt?: number;
  message?: string;
  // Present for `ready`, and as last known data while `stale`.
  pullRequest?: PullRequestSummary;
  // The fake's dev scenario (only while `mock`): the Mock scenario menu
  // shows it, since `head-not-fetched` answers `ready`.
  mockScenario?: GithubFakeScenario;
  // The session's GitHub setting is `read` (UATU_GITHUB=read): pull requests
  // show, nothing is sent.
  readOnly?: boolean;
};

export type GithubComment = {
  id: string;
  author: string;
  body: string;
  // Rendered server-side with src/render/markdown.ts (sanitized GFM).
  bodyHtml: string;
  createdAt: string;
};

export type ReviewThread = {
  id: string;
  path: string;
  // Null once GitHub can no longer place the thread on the current diff, and
  // for a thread on the whole file (`subjectType: "FILE"`).
  line: number | null;
  // Set for a thread on a whole file rather than a line.
  subjectType?: "FILE";
  side: DiffSide;
  isResolved: boolean;
  isOutdated: boolean;
  // The commented line's text, for the conversation summary.
  lineText: string;
  comments: GithubComment[];
};

export type PendingComment = {
  id: string;
  body: string;
  bodyHtml: string;
  createdAt: string;
  // A new inline thread names its position; a reply names its thread.
  path: string;
  line: number;
  side: DiffSide;
  threadId?: string;
};

export type PendingReview = {
  id: string;
  commitOid: string;
  comments: PendingComment[];
};

export type TimelineItem =
  | { kind: "comment"; comment: GithubComment }
  | {
      kind: "review";
      id: string;
      author: string;
      state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
      body: string;
      bodyHtml: string;
      submittedAt: string;
      threadIds: string[];
    }
  // `method` only when known: GitHub's merged event doesn't say it.
  | { kind: "merged"; actor: string; method?: MergeMethod; at: string; deletedBranch: boolean };

export type PullRequestFile = {
  path: string;
  // GitHub's renamed, copied and changed files read as modified.
  status: "added" | "modified" | "removed";
  additions: number;
  deletions: number;
  // A renamed or copied file's earlier path.
  previousPath?: string;
  // Both sides of the file, so the diff renderer can show expandable
  // context (the fake).
  oldContents?: string;
  newContents?: string;
  // GitHub's unified diff of the file, with file headers (the real service).
  // Neither contents nor patch: GitHub sent no patch (a binary or very large
  // file), and the file is shown on GitHub.
  patch?: string;
};

// Whether GitHub would merge the pull request now, read-only: uatu shows it
// and links to the pull request on GitHub, which owns merging (merge queues,
// rulesets, stacked pull requests). It never merges.
export type MergeReadiness = {
  mergeable: boolean;
  // Why GitHub would refuse a merge now, most important first; empty when
  // mergeable.
  blockers: string[];
  // The merge methods the repository allows, for the readiness note.
  allowedMethods: MergeMethod[];
  // The repository's "Automatically delete head branches" setting.
  deleteBranchOnMerge: boolean;
};

export type PullRequestDetail = {
  mock: boolean;
  repository: GithubRepositoryRef;
  viewer: string;
  summary: PullRequestSummary;
  body: string;
  bodyHtml: string;
  timeline: TimelineItem[];
  threads: ReviewThread[];
  pendingReview: PendingReview | null;
  files: PullRequestFile[];
  mergeReadiness: MergeReadiness;
  // What the answer leaves out (the real service): timeline entries GitHub
  // holds beyond those shown or of kinds uatu skips, more threads or files
  // than were read, and sections GitHub refused while the rest answered
  // (`checks`, `threads`, `files`).
  omitted?: { timeline: number; threads: boolean; files: boolean; unavailable: string[] };
};

export type PullRequestListItem = {
  number: number;
  title: string;
  author: string;
  headRefName: string;
  headOwner: string;
  isCrossRepository: boolean;
  isDraft: boolean;
  reviewDecision: ReviewDecision;
  viewerReviewRequested: boolean;
  checks: Pick<ChecksRollup, "state" | "passed" | "failed" | "pending">;
  updatedAt: string;
  // Comments in the viewer's pending review on this PR (0 without one).
  viewerPendingComments: number;
};

export type PullRequestList = {
  mock: boolean;
  repository: GithubRepositoryRef;
  // The local name of the remote that is this GitHub repository (design
  // D3), which a pull request checkout fetches from. Absent: "origin".
  remote?: string;
  viewer: string;
  pullRequests: PullRequestListItem[];
  // How many are open on GitHub (the list shows at most 100).
  totalCount?: number;
};

// A pull request's file at its head or its base commit (the file view).
export type PullRequestRevision = "head" | "base";

// The document Diff view's `review` field (`GET /api/document/diff`, design
// D8): whether that diff of the local checkout is provably the pull
// request's own diff of the file, so its threads can sit on its lines and
// new comments go to GitHub; otherwise why not. Computed by the session
// (src/github/anchoring.ts), never by the browser alone, except
// `lightweight-render`, which only the browser knows (the diff is too large
// for the inline renderer).
export const DOCUMENT_DIFF_REVIEW_REASONS = [
  "not-in-pr",
  "last-commit",
  "base-inexact",
  "head-mismatch",
  "local-changes",
  "files-unknown",
  "lightweight-render",
] as const;
export type DocumentDiffReviewReason = typeof DOCUMENT_DIFF_REVIEW_REASONS[number];
export type DocumentDiffReview = {
  // The checked-out branch's pull request and its head as the session knows it.
  number: number;
  headOid: string;
  // The file's repository-relative path, as the pull request names it.
  path: string;
} & ({ exact: true } | { exact: false; reason: DocumentDiffReviewReason; baseState?: "stale" | "missing" | "other" });

// What the file view's payload adds to a rendered document: which commit it
// shows, and where that commit's blobs are served for relative images and
// links (`blobBase`, session-relative: `api/github/pr-blob/<repoKey>/<n>/<oid>/`).
export type PullRequestFileRevision = { number: number; rev: PullRequestRevision; oid: string; blobBase: string };
export type PullRequestFileFacts = {
  mock: boolean;
  bytes: number;
  // A Git LFS pointer, shown as its text: uatu never runs an LFS fetch.
  lfsPointer: boolean;
  revision: PullRequestFileRevision;
};

// Every path at the pull request's head ("All files"), exposure-filtered.
export type PullRequestTree = { mock: boolean; headOid: string; paths: string[]; truncated: boolean };

// The answer of the explicit, narrow fetch of a pull request's head.
export type PullRequestHeadFetch = { mock: boolean; headOid: string };

// Why a pull request's file can't be shown from local Git: its head isn't
// fetched yet (the consent card), or it is too large or binary.
export type PullRequestFileRefusal = "not-fetched" | "too-large" | "binary" | "not-found";

// The fake's dev-only scenario switch (item 6 of the mockups).
// `head-not-fetched` answers like `ready`, but no pull request's head except
// the checked-out branch's is local until its consent card's Fetch.
export const GITHUB_FAKE_SCENARIOS = [
  "ready",
  "head-not-fetched",
  "no-pull-request",
  "no-credential",
  "rate-limited",
  "unavailable",
] as const;
export type GithubFakeScenario = (typeof GITHUB_FAKE_SCENARIOS)[number];

export function isGithubFakeScenario(value: unknown): value is GithubFakeScenario {
  return typeof value === "string" && (GITHUB_FAKE_SCENARIOS as readonly string[]).includes(value);
}

export const GITHUB_BODY_MAX_LENGTH = 65_536;

// Checked while composing, not only after sending: near the limit a counter
// shows, and past it sending is refused with the reason.
export function bodyLengthCheck(length: number, max = GITHUB_BODY_MAX_LENGTH): { counter: string | null; tooLong: string | null } {
  const format = (value: number) => value.toLocaleString("en-US");
  if (length > max) {
    const over = length - max;
    return { counter: `${format(length)} / ${format(max)}`, tooLong: `Too long by ${format(over)} ${over === 1 ? "character" : "characters"}: GitHub takes at most ${format(max)}.` };
  }
  return { counter: length >= max * 0.9 ? `${format(length)} / ${format(max)}` : null, tooLong: null };
}

// The local branch a PR's worktree uses: its head branch for same-repository
// PRs, `pr/<n>` for forks (design D12).
export function pullRequestLocalBranch(pr: { number: number; headRefName: string; isCrossRepository: boolean }): string {
  return pr.isCrossRepository ? `pr/${pr.number}` : pr.headRefName;
}
