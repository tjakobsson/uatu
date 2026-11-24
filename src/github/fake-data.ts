// MOCKED GITHUB DATA. Fictional seed for the in-memory fake
// (src/github/fake.ts): repository octo-org/uatu, viewer octo-reviewer, and a
// handful of open pull requests. Every login, branch, commit id and file body
// here is invented; nothing is read from or sent to GitHub.

import type { CheckRun, MergeMethod, ReviewerState } from "../shared/github-contract";

export const FAKE_REPOSITORY = { host: "github.com", owner: "octo-org", name: "uatu" } as const;
export const FAKE_VIEWER = "octo-reviewer";

export const FAKE_REPOSITORY_SETTINGS: {
  allowed: MergeMethod[];
  deleteBranchOnMerge: boolean;
  requiredApprovals: number;
} = {
  // Merge commits are disabled for the repository, as in the mockups.
  allowed: ["SQUASH", "REBASE"],
  deleteBranchOnMerge: true,
  requiredApprovals: 2,
};

// The pull request the fake reports for the checked-out branch.
export const FAKE_CURRENT_PULL_REQUEST = 642;

export type SeedFile = { path: string; old: string; new: string };
export type SeedCheck = CheckRun & { finishesAfterMs?: number; finishedDetail?: string };
export type SeedComment = { author: string; body: string; hoursAgo: number };
export type SeedThread = { id: string; path: string; line: number; comments: SeedComment[] };
export type SeedReview = {
  id: string;
  author: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
  body: string;
  hoursAgo: number;
  threadIds: string[];
};

export type SeedPullRequest = {
  number: number;
  title: string;
  author: string;
  headRefName: string;
  headOwner: string;
  isCrossRepository: boolean;
  isDraft: boolean;
  baseRefName: string;
  baseRefOid: string;
  headRefOid: string;
  commits: number;
  createdHoursAgo: number;
  updatedHoursAgo: number;
  body: string;
  files: SeedFile[];
  checks: SeedCheck[];
  requestedReviewers: string[];
  // Each reviewer's latest review state, for the reviewer list.
  reviewerStates: Record<string, ReviewerState>;
  reviews: SeedReview[];
  threads: SeedThread[];
  comments: SeedComment[];
  conflicting?: boolean;
};

const PR_REVIEW_DOC_OLD = `# Pull request review

uatu shows the branch's pull request in the sidebar.

## Reviewing

Open **Diff** to compare against the base branch.
`;

const PR_REVIEW_DOC_NEW = `# Pull request review

uatu shows the checked-out branch's pull request in the
**Pull request** pane: state, checks and reviewers.

## Reviewing

Open **Diff** to compare against the PR's base branch.
Click \`+\` beside a line to start a review comment; comments
stay pending until you submit the review.

## Finishing a review

**Finish review** lists every pending comment with its file and line,
so nothing is published by surprise. Choose Comment, Approve or
Request changes, then submit them together.

## Merging

The Pull request pane says whether GitHub would merge now and why not.
Merge on GitHub itself: **Merge on GitHub ↗** opens the pull request
there. Nothing in your local worktree changes.
`;

const HUB_DOC_OLD = `# Hub

The hub serves every registered workspace from one origin.

## Credentials

Assign a credential to a workspace in **Settings → Credentials**.
Child worktrees inherit the assignment from their main checkout.
`;

const HUB_DOC_NEW = `# Hub

The hub serves every registered workspace from one origin.

## Credentials

Assign a credential to a workspace in **Settings → Credentials**.
Child worktrees inherit the assignment from their main checkout.

## Checks

The Pull request pane lists every check GitHub reports for the head
commit: GitHub Actions jobs, status contexts from other CI systems,
and third-party check runs. A required check that is still running
shows as a merge blocker until it finishes.
`;

const README_OLD = `# uatu

A local docs previewer with an embedded terminal and agent chat.

## Features

- Live Markdown and AsciiDoc preview
- Diff against the branch base
- Embedded terminal
`;

const README_NEW = `# uatu

A local docs previewer with an embedded terminal and agent chat.

## Features

- Live Markdown and AsciiDoc preview
- Diff against the branch base
- Embedded terminal
- GitHub pull request review: conversation, inline comments, merge readiness
`;

const PR_VIEW_NEW = `// Pull request preview: description, conversation and review threads.
import { escapeHtml } from "../shared/html";
import type { PullRequestDetail } from "../shared/github-contract";

export function renderPullRequestHeader(detail: PullRequestDetail): string {
  const pr = detail.summary;
  return \`<header class="pr-header">
    <h1>\${escapeHtml(pr.title)}</h1>
    <p>#\${pr.number} · \${escapeHtml(pr.headRefName)} → \${escapeHtml(pr.baseRefName)}</p>
  </header>\`;
}

export function renderConversation(detail: PullRequestDetail): string {
  const items = detail.timeline.map(item => {
    if (item.kind === "comment") return renderComment(item.comment.author, item.comment.bodyHtml);
    if (item.kind === "review") return renderComment(item.author, item.bodyHtml);
    return "";
  });
  return \`<ol class="pr-timeline">\${items.join("")}</ol>\`;
}

function renderComment(author: string, bodyHtml: string): string {
  return \`<li><strong>\${escapeHtml(author)}</strong>\${bodyHtml}</li>\`;
}
`;

const PANE_NEW = `// Pull request pane: state, checks and reviewers for the checked-out branch.
import type { GithubSummary } from "../shared/github-contract";

export function pullRequestPaneTitle(summary: GithubSummary): string {
  if (summary.status !== "ready" || !summary.pullRequest) return "Pull request";
  return \`Pull request #\${summary.pullRequest.number}\`;
}

export function checksLabel(summary: GithubSummary): string {
  const checks = summary.pullRequest?.checks;
  if (!checks) return "";
  if (checks.failed > 0) return \`\${checks.failed} failing\`;
  if (checks.pending > 0) return \`\${checks.passed} passed · \${checks.pending} running\`;
  return \`\${checks.passed} of \${checks.passed} passed\`;
}
`;

const DIFF_VIEW_OLD = `export type RenderDiffOptions = {
  diffStyle?: DiffStyle;
  wrap?: boolean;
  onDiffStyleChange?: (next: DiffStyle) => void;
};

export async function renderDocumentDiff(host: HTMLElement, payload: DocumentDiffPayload) {
  clearHost(host);
  await renderWithPierre(host, payload);
}
`;

const DIFF_VIEW_NEW = `export type RenderDiffOptions = {
  diffStyle?: DiffStyle;
  wrap?: boolean;
  onDiffStyleChange?: (next: DiffStyle) => void;
  // Inline review: threads and pending comments as line annotations, and a
  // gutter "+" that opens a composer on the clicked line.
  review?: DiffReviewOptions;
};

export async function renderDocumentDiff(host: HTMLElement, payload: DocumentDiffPayload, options: RenderDiffOptions = {}) {
  clearHost(host);
  return renderWithPierre(host, payload, options.review);
}
`;

const GITHUB_SERVER_OLD = `export function githubRoutes() {
  return {};
}
`;

const GITHUB_SERVER_NEW = `export function githubRoutes(service: GithubService | null) {
  if (!service) return {};
  return {
    summary: (repository: string) => service.summary(repository),
    pullRequest: (repository: string, number: number) => service.pullRequest(repository, number),
  };
}
`;

const CONTRACT_NEW = `export type GithubStatus =
  | "ready"
  | "no-pull-request"
  | "no-credential"
  | "rate-limited"
  | "unavailable";

export type PullRequestSummary = {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
};
`;

const E2E_NEW = `import { expect, test } from "@playwright/test";

test("the pull request pane shows the branch's pull request", async ({ page }) => {
  await page.goto("/");
  const pane = page.locator('[data-pane-id="pull-request"]');
  await expect(pane).toContainText("#642");
  await expect(pane).toContainText("Review required");
});
`;

const TERMINAL_OLD = `export function linkRanges(line: string): LinkRange[] {
  return [...line.matchAll(OSC8)].map(match => toRange(match));
}
`;

const TERMINAL_NEW = `export function linkRanges(line: string, wrapped: boolean): LinkRange[] {
  // A reflowed row continues the previous row's open OSC 8 link.
  const ranges = [...line.matchAll(OSC8)].map(match => toRange(match));
  return wrapped ? carryOpenLink(ranges) : ranges;
}
`;

const PANES_OLD = `export function readPaneState(storage: Storage | null): PaneState {
  const fallback = defaultPaneState();
  return fallback;
}
`;

const PANES_NEW = `export function readPaneState(storage: Storage | null): PaneState {
  const fallback = defaultPaneState();
  const stored = parseStoredPanes(storage);
  // Keep stored heights; only fill panes the stored layout never saw.
  return { ...fallback, ...stored };
}
`;

const QUEUE_OLD = `export function nextQueued(queue: Queued[]): Queued | undefined {
  return queue.at(-1);
}
`;

const QUEUE_NEW = `export function nextQueued(queue: Queued[]): Queued | undefined {
  // Steering messages go first, then the held queue in arrival order.
  return queue.find(item => item.steer) ?? queue[0];
}
`;

const WORKTREE_DOC_NEW = `# Removing worktrees

Remove a worktree from the hub's worktree menu once its branch is merged.
The hub refuses while the worktree has uncommitted changes.
`;

const RATE_LIMIT_OLD = `const LOGIN_ATTEMPTS_PER_MINUTE = 10;
const attempts = new Map<string, number>();
`;

const RATE_LIMIT_NEW = `const LOGIN_ATTEMPTS_PER_MINUTE = 10;
// Keyed by device label and address, so one device cannot lock out others.
const attempts = new Map<\`\${string}|\${string}\`, number>();
`;

// More files for the other open pull requests, so picking one in "Pull
// request…" shows a real tree of changed files, diffs and threads.
const TERMINAL_TEST_NEW = `import { expect, test } from "bun:test";

import { linkRanges } from "./links";

test("a wrapped row continues the open OSC 8 link", () => {
  const first = linkRanges("\\x1b]8;;https://example.com\\x07docs", false);
  const next = linkRanges("/page\\x1b]8;;\\x07", true);
  expect(next[0]?.uri).toBe(first[0]?.uri);
});
`;

const TERMINAL_DOC_OLD = `# Terminal

Links printed with OSC 8 open in a new tab.
`;

const TERMINAL_DOC_NEW = `# Terminal

Links printed with OSC 8 open in a new tab, also after the terminal
reflows a wrapped row.
`;

const STATE_TEST_OLD = `test("reads the default pane layout", () => {
  expect(readPaneState(null)).toEqual(defaultPaneState());
});
`;

const STATE_TEST_NEW = `test("reads the default pane layout", () => {
  expect(readPaneState(null)).toEqual(defaultPaneState());
});

test("keeps stored heights when a new pane appears", () => {
  const storage = memoryStorage({ files: { visible: true, collapsed: false, height: 320 } });
  expect(readPaneState(storage).files.height).toBe(320);
});
`;

const QUEUE_TEST_NEW = `import { expect, test } from "bun:test";

import { nextQueued } from "./queue";

test("a steering message leaves the queue first", () => {
  const queue = [{ id: "a", steer: false }, { id: "b", steer: true }];
  expect(nextQueued(queue)?.id).toBe("b");
});
`;

const DOCS_INDEX_OLD = `# uatu docs

- [Hub](hub.md)
- [Pull request review](pr-review.md)
`;

const DOCS_INDEX_NEW = `# uatu docs

- [Hub](hub.md)
- [Pull request review](pr-review.md)
- [Removing worktrees](worktree-cleanup.md)
`;

const AUTH_TEST_NEW = `import { expect, test } from "bun:test";

import { recordFailedLogin, isLockedOut } from "./auth";

test("one device's failures do not lock out another", () => {
  for (let i = 0; i < 10; i += 1) recordFailedLogin("phone", "10.0.0.2");
  expect(isLockedOut("phone", "10.0.0.2")).toBe(true);
  expect(isLockedOut("laptop", "10.0.0.3")).toBe(false);
});
`;

const HOUR = 1;

export function seedPullRequests(): SeedPullRequest[] {
  return [
    {
      number: 642,
      title: "feat(preview): add GitHub PR review",
      author: "octo-author",
      headRefName: "feat/view-pr",
      headOwner: "octo-org",
      isCrossRepository: false,
      isDraft: false,
      baseRefName: "main",
      baseRefOid: "7dd6e40b5a1f9c3e2d4b6a8f0c1e3d5b7a9f1c2e",
      headRefOid: "9f8e7d6c5b4a39281706f5e4d3c2b1a098f7e6d5",
      commits: 4,
      createdHoursAgo: 50,
      updatedHoursAgo: 3,
      body: [
        "## Summary",
        "",
        "Adds a **Pull request** pane and a PR preview so a review happens next to the code, the terminal and the agent.",
        "",
        "- `sidebar/pull-request.ts` — state, checks, reviewers",
        "- `preview/pr-view.ts` — description + conversation; the diff compares against the PR's base",
        "",
        "## Testing",
        "",
        "- [x] unit tests for the summary and the anchoring rule",
        "- [ ] manual pass against a sandbox repository",
      ].join("\n"),
      files: [
        { path: "docs/pr-review.md", old: PR_REVIEW_DOC_OLD, new: PR_REVIEW_DOC_NEW },
        { path: "docs/hub.md", old: HUB_DOC_OLD, new: HUB_DOC_NEW },
        { path: "src/preview/pr-view.ts", old: "", new: PR_VIEW_NEW },
        { path: "src/sidebar/pull-request.ts", old: "", new: PANE_NEW },
        { path: "src/preview/diff-view.ts", old: DIFF_VIEW_OLD, new: DIFF_VIEW_NEW },
        { path: "src/server/github.ts", old: GITHUB_SERVER_OLD, new: GITHUB_SERVER_NEW },
        { path: "src/shared/github-contract.ts", old: "", new: CONTRACT_NEW },
        { path: "tests/e2e/pull-request.e2e.ts", old: "", new: E2E_NEW },
        { path: "README.md", old: README_OLD, new: README_NEW },
      ],
      checks: [
        { name: "unit", state: "SUCCESS", detail: "1m 12s" },
        { name: "e2e (leg 1)", state: "SUCCESS", detail: "15m 40s" },
        // Finishes two minutes after the fake is seeded, so the running and
        // the finished states can both be seen.
        { name: "e2e (leg 2)", state: "PENDING", detail: "running", finishesAfterMs: 2 * 60_000, finishedDetail: "16m 05s" },
        { name: "perf", state: "SUCCESS", detail: "6m 31s" },
        { name: "licenses", state: "SUCCESS", detail: "22s" },
      ],
      requestedReviewers: ["octo-maintainer", "octo-reviewer"],
      reviewerStates: { "octo-maintainer": "APPROVED", "octo-reviewer": "REQUESTED" },
      reviews: [
        {
          id: "review-maintainer-1",
          author: "octo-maintainer",
          state: "APPROVED",
          body: "Nice and small. One question on the docs wording.",
          hoursAgo: 26 * HOUR,
          threadIds: ["thread-checks-source"],
        },
      ],
      threads: [
        {
          id: "thread-checks-source",
          path: "docs/pr-review.md",
          line: 4,
          comments: [
            { author: "octo-maintainer", body: "Should this also say where the checks come from (GitHub Actions only)?", hoursAgo: 26 },
            { author: "octo-author", body: "Linked `docs/hub.md` in `9f8e7d6` — it lists every check source.", hoursAgo: 3 },
          ],
        },
      ],
      comments: [
        { author: "octo-author", body: "Thanks! Linked `docs/hub.md` in `9f8e7d6`; it lists every check source.", hoursAgo: 3 },
      ],
    },
    {
      number: 639,
      title: "fix(terminal): keep OSC 8 links across reflow",
      author: "octo-contrib",
      headRefName: "fix-osc8",
      headOwner: "octo-contrib",
      isCrossRepository: true,
      isDraft: false,
      baseRefName: "main",
      baseRefOid: "7dd6e40b5a1f9c3e2d4b6a8f0c1e3d5b7a9f1c2e",
      headRefOid: "c0ffee1234567890abcdef1234567890abcdef12",
      commits: 2,
      createdHoursAgo: 30,
      updatedHoursAgo: 5,
      body: "Links printed with OSC 8 lost their target when the terminal reflowed a wrapped row.\n\nThis carries the open link into the continuation row.",
      files: [
        { path: "src/terminal/links.ts", old: TERMINAL_OLD, new: TERMINAL_NEW },
        { path: "src/terminal/links.test.ts", old: "", new: TERMINAL_TEST_NEW },
        { path: "docs/terminal.md", old: TERMINAL_DOC_OLD, new: TERMINAL_DOC_NEW },
      ],
      checks: ["unit", "e2e (leg 1)", "e2e (leg 2)", "perf", "licenses"].map(name => ({ name, state: "SUCCESS" as const, detail: "passed" })),
      requestedReviewers: ["octo-reviewer"],
      reviewerStates: { "octo-reviewer": "REQUESTED", "octo-maintainer": "COMMENTED" },
      reviews: [
        {
          id: "review-639-maintainer",
          author: "octo-maintainer",
          state: "COMMENTED",
          body: "Looks right. One question on the carry rule.",
          hoursAgo: 4,
          threadIds: ["thread-639-carry"],
        },
      ],
      threads: [
        {
          id: "thread-639-carry",
          path: "src/terminal/links.ts",
          line: 3,
          comments: [
            { author: "octo-maintainer", body: "Does `carryOpenLink` also close a link that ends exactly at the row boundary?", hoursAgo: 4 },
          ],
        },
      ],
      comments: [
        { author: "octo-contrib", body: "Repro: `printf` a long OSC 8 link in a narrow terminal, then widen it.", hoursAgo: 29 },
      ],
    },
    {
      number: 636,
      title: "fix(sidebar): restore pane heights after reload",
      author: "octo-author",
      headRefName: "fix/pane-heights",
      headOwner: "octo-org",
      isCrossRepository: false,
      isDraft: false,
      baseRefName: "main",
      baseRefOid: "7dd6e40b5a1f9c3e2d4b6a8f0c1e3d5b7a9f1c2e",
      headRefOid: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      commits: 1,
      createdHoursAgo: 72,
      updatedHoursAgo: 8,
      body: "Stored pane heights were dropped when a new pane id appeared in the defaults.",
      files: [
        { path: "src/shell/state.ts", old: PANES_OLD, new: PANES_NEW },
        { path: "src/shell/state.test.ts", old: STATE_TEST_OLD, new: STATE_TEST_NEW },
      ],
      checks: [
        { name: "unit", state: "SUCCESS", detail: "1m 08s" },
        { name: "e2e (leg 1)", state: "PENDING", detail: "running" },
      ],
      requestedReviewers: [],
      reviewerStates: { "octo-maintainer": "APPROVED", "octo-reviewer": "APPROVED" },
      reviews: [],
      threads: [
        {
          id: "thread-636-merge-order",
          path: "src/shell/state.ts",
          line: 4,
          comments: [
            { author: "octo-maintainer", body: "Spread order matters here: stored values must win. Worth a comment?", hoursAgo: 9 },
            { author: "octo-author", body: "Added one above the return.", hoursAgo: 8 },
          ],
        },
      ],
      comments: [],
    },
    {
      number: 631,
      title: "fix(chat): queue order after steering",
      author: "octo-maintainer",
      headRefName: "fix/queue-order",
      headOwner: "octo-org",
      isCrossRepository: false,
      isDraft: true,
      baseRefName: "main",
      baseRefOid: "7dd6e40b5a1f9c3e2d4b6a8f0c1e3d5b7a9f1c2e",
      headRefOid: "b2c3d4e5f60718293a4b5c6d7e8f901234567890",
      commits: 3,
      createdHoursAgo: 96,
      updatedHoursAgo: 20,
      body: "Work in progress: steering messages should leave the queue before held ones.",
      files: [
        { path: "src/chat/queue.ts", old: QUEUE_OLD, new: QUEUE_NEW },
        { path: "src/chat/queue.test.ts", old: "", new: QUEUE_TEST_NEW },
      ],
      checks: [
        { name: "unit", state: "FAILURE", detail: "failed" },
        { name: "licenses", state: "SUCCESS", detail: "21s" },
      ],
      requestedReviewers: [],
      reviewerStates: {},
      reviews: [],
      threads: [],
      comments: [],
    },
    {
      number: 627,
      title: "docs: explain worktree cleanup",
      author: "octo-reviewer",
      headRefName: "docs/worktree-cleanup",
      headOwner: "octo-org",
      isCrossRepository: false,
      isDraft: false,
      baseRefName: "main",
      baseRefOid: "7dd6e40b5a1f9c3e2d4b6a8f0c1e3d5b7a9f1c2e",
      headRefOid: "d4e5f60718293a4b5c6d7e8f9012345678901234",
      commits: 1,
      createdHoursAgo: 120,
      updatedHoursAgo: 40,
      body: "Says when to remove a worktree and what the hub refuses.",
      files: [
        { path: "docs/worktree-cleanup.md", old: "", new: WORKTREE_DOC_NEW },
        { path: "docs/index.md", old: DOCS_INDEX_OLD, new: DOCS_INDEX_NEW },
      ],
      checks: [{ name: "licenses", state: "SUCCESS", detail: "20s" }],
      requestedReviewers: ["octo-maintainer"],
      reviewerStates: { "octo-maintainer": "REQUESTED" },
      reviews: [],
      threads: [],
      comments: [],
    },
    {
      number: 618,
      title: "fix(hub): keep the login rate limit per device",
      author: "octo-intern",
      headRefName: "fix/login-rate-limit",
      headOwner: "octo-org",
      isCrossRepository: false,
      isDraft: false,
      baseRefName: "main",
      baseRefOid: "7dd6e40b5a1f9c3e2d4b6a8f0c1e3d5b7a9f1c2e",
      headRefOid: "e5f60718293a4b5c6d7e8f901234567890123456",
      commits: 2,
      createdHoursAgo: 200,
      updatedHoursAgo: 60,
      body: "One device's failed logins no longer lock out every other device.",
      files: [
        { path: "src/hub/auth.ts", old: RATE_LIMIT_OLD, new: RATE_LIMIT_NEW },
        { path: "src/hub/auth.test.ts", old: "", new: AUTH_TEST_NEW },
      ],
      checks: [{ name: "unit", state: "SUCCESS", detail: "1m 10s" }],
      requestedReviewers: ["octo-maintainer"],
      reviewerStates: { "octo-maintainer": "CHANGES_REQUESTED" },
      reviews: [
        {
          id: "review-618-maintainer",
          author: "octo-maintainer",
          state: "CHANGES_REQUESTED",
          body: "The key needs to survive a proxy: the address alone is shared behind one.",
          hoursAgo: 58,
          threadIds: ["thread-618-key"],
        },
      ],
      threads: [
        {
          id: "thread-618-key",
          path: "src/hub/auth.ts",
          line: 3,
          comments: [
            { author: "octo-maintainer", body: "Behind a reverse proxy every device shares one address. Key on the device label first?", hoursAgo: 58 },
          ],
        },
      ],
      comments: [],
      conflicting: true,
    },
  ];
}
