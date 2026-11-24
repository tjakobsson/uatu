## Context

See `proposal.md` for motivation and scope. The behavior contract is in this change's `specs/`. This section records only the current state that shapes the approach.

- **No GitHub integration exists.** Nothing in `src/` calls the GitHub API, uses octokit, runs `gh pr`, fetches `refs/pull/*`, or parses owner/repo from a remote.
- **`gh` is already projected into sessions.** When a workspace is assigned a token with the `github-cli` capability, `src/hub/credential-context.ts` exposes `gh` on the session's tool path and `src/hub/provider-runtime.ts` writes a private `GH_CONFIG_DIR` and sets `GH_HOST` plus `GH_TOKEN` (or `GH_ENTERPRISE_TOKEN`). Ambient `GH_*`/`GITHUB_TOKEN` are stripped. Without an assignment, `GH_CONFIG_DIR` points at an empty directory. The environment is a session-start snapshot; disabling the token stops the session (`openspec/specs/hub-credentials/spec.md`). Outside a Hub (source runs), the user's own `gh` login applies.
- **Base selection has no override.** `resolveCompareBase()` in `src/document/git-base-ref.ts` tries `origin/HEAD`, `origin/main`, `origin/master`, `main`, `master`. `git-data.ts` (repository snapshots) and `diff.ts` (per-file diff, cached per repo and validated by HEAD) both call it. `CompareTarget` is `base | last-commit`.
- **Repository snapshots ride the `document` live topic.** `RepositorySnapshot` (closed schema in `api/openapi.yaml`) is republished by `src/server/repository-refresh.ts` when Git results change. Child routes under `/api/*` are internal and excluded from the public contract; the Hub proxy already enforces session authentication and the same-origin check on every proxied request (`src/hub/server.ts`).
- **Worktree creation happens in the Hub.** `src/hub/worktree-create.ts` supports `new-branch | existing-local | remote-tracking`, never forces, and `worktree-fetch.ts` fetches the default refspec with the parent's credentials. `CreateWorktreeRequest` is a public Hub operation.
- **`@pierre/diffs` 1.6.4 supports line annotations.** Verified in the installed package's type declarations (`dist/types.d.ts`, `dist/components/FileDiff.d.ts`, `dist/managers/InteractionManager.d.ts`):
  - `FileDiff` accepts `lineAnnotations: DiffLineAnnotation<T>[]`, where each annotation has `side: 'deletions' | 'additions'`, `lineNumber`, and typed `metadata`. `lineNumber: 0` places a file-level annotation above the first hunk.
  - `renderAnnotation(annotation, fileDiff) => HTMLElement` renders any DOM below the annotated line. `setLineAnnotations()` updates annotations without re-rendering the diff.
  - Interaction options include `enableGutterUtility` with `renderGutterUtility` and `onGutterUtilityClick(range: SelectedLineRange)` (a hover "+" button), and `enableLineSelection` with `onLineSelectionEnd(range)`. `SelectedLineRange` is `{ start, end, side?, endSide? }`.
  - The README lists a "flexible annotation framework for injecting comments". `src/preview/diff-view.ts` is still the only consumer, and it uses the vanilla `FileDiff` entry, so no React is needed.

## Goals / Non-Goals

**Goals:**

- One GitHub access path: the session child shells out to `gh`. Uatu holds no token and adds no dependency.
- Ship value in phases: read view, then PR base diffs, then any-PR worktrees, then comments, then reviews, then merge readiness. Each phase stands on its own.
- Never misplace a comment. When Uatu cannot prove that a displayed line is the line GitHub will record, it does not offer to comment there.
- No new browser connection, live topic, or polling loop, and no refresh timer. GitHub traffic is bounded, event-driven, and never triggered by file edits.

**Non-Goals:**

- Resolving or unresolving threads, reactions, editing posted comments, editing PR metadata (title, labels, assignees, reviewers), requesting reviewers, and closing or reopening PRs.
- Authoring suggested-change blocks. They render as code blocks.
- Merging of any kind (merge, squash, rebase, auto-merge, merge queues, admin bypass) and deleting branches on GitHub. Uatu shows merge readiness read-only and links to the pull request on GitHub (D11).
- Pushing to fork branches from a `pr/<number>` checkout, including "maintainers can modify".
- GitLab or other forges. The `src/github/` domain does not pretend to be forge-neutral.
- A Hub-level GitHub service. All GitHub access happens inside the workspace session that holds the credential.
- Notifications for PR activity.

## Decisions

### D1. Module placement: a `src/github/` domain folder plus region UI

`src/github/` holds the session child's GitHub domain:

- `remote.ts`: parses remotes and picks the GitHub repository (D3).
- `gh.ts`: the `gh` transport and error classification (D2).
- `queries.ts`: GraphQL documents and REST paths.
- `normalize.ts`: GitHub responses to wire DTOs.
- `service.ts`: per-session detection, caching, refresh and write actions.
- `anchoring.ts`: the commentability rule (D8).
- `client.ts`: the browser-side API wrapper built on `appUrl()`.

Wire types live in `src/shared/github-contract.ts` so the client and server share one definition. UI goes into the region that renders it, as the commit preview and Git Log already do. Two pieces are fixed by the specs whatever the surface decision:

- `src/preview/diff-review.ts`: annotations, composer and pending review indicator on top of `diff-view.ts`.
- `src/preview/review-dialogs.ts`: submit and discard confirmations.

The rest is **provisional until the UX review settles open questions Q1 and Q2**: the PR summary, open-PR list and PR view. If the pane-plus-preview option wins, they would be `src/sidebar/pull-request-pane.ts` and `src/preview/pull-request.ts`, with a new `PreviewMode` kind. A view mode or a workspace review mode would move them into `src/preview/` view-mode handling or a new `src/shell/` mode owner. Either way they read the same summary field and detail routes (D5), so the server side does not depend on the outcome.

Routes go into `buildRoutes` in `src/server/routes.ts` behind a `github` dependency, so `src/cli.ts` wires the real service and `tests/e2e/server.ts` wires one built on a fake transport. `CLAUDE.md`'s folder map and `ARCHITECTURE.md` gain a `github/` entry and a "Pull request review" section.

*Alternative:* a `src/server/github/` subfolder. Rejected because the domain spans server, shared and client code, as `chat/` does, and the folder map organizes by domain.

### D2. `gh api` is the only GitHub transport

The child runs only `gh api`: GraphQL through `gh api graphql`, REST where GraphQL has no equivalent. It never uses `gh pr …` porcelain, whose JSON fields and selection rules change between `gh` versions. `gh` is the authenticated transport: it resolves the token source (Hub projection, `GH_ENTERPRISE_TOKEN`, or a user login outside a Hub), the API endpoint for GitHub Enterprise hosts, proxies and certificates. Uatu never sees the token.

Invocation rules:

- `execFile` with an argv array, never a shell. Bounded timeout (15 s reads, 30 s writes), bounded output, cancellation on session stop.
- Every request names its host with `--hostname`.
- **All variables and write bodies go as JSON on stdin (`--input -`).** `gh api -F key=@value` reads a local file when a value starts with `@`, so a comment body of `@/etc/passwd` could otherwise publish a local file. `-F`/`-f` are never used for user-supplied text.
- `--include` is used where the classifier needs response status and rate-limit headers.
- Version floor: the Hub's existing `gh` 2.0 floor (`provider-runtime.ts`), raised only if a flag used here needs newer. The floor is checked once per session with `gh --version`.

The transport is an interface, `GitHubTransport.request({ host, method, path | graphql, variables, body }) → { status, headers, json }`, implemented by `gh.ts`. Tests substitute it (D15).

Error classification maps to the spec's statuses:

| Signal | Status |
| --- | --- |
| `gh` not found, or below the floor | `gh-missing` |
| 401, or `gh` reports no authentication for the host | `no-credential` |
| 403/404 on the repository, or SAML/SSO enforcement | `no-access` |
| 403/429 with `x-ratelimit-remaining: 0`, a GraphQL `RATE_LIMITED` error, or a secondary rate limit | `rate-limited`, with reset time from headers or `retry-after` |
| Network failures, timeouts, 5xx | `unavailable` |

The client receives only the status, plus GitHub's JSON `message` when there is one, length-bounded. Raw stderr goes to the child log, not to clients.

*Alternative:* `fetch` with `GH_TOKEN` read from the child's environment. Rejected: Uatu would then own token-source precedence, Enterprise API URLs, and a second credential path the Hub's revocation rules do not describe.

### D3. Repository resolution and GitHub host recognition

`remote.ts` parses `git remote -v` URLs (scp-like SSH, `ssh://`, `https://`, with or without `.git`) into host/owner/name. The base repository is chosen as follows:

1. A remote marked by `gh repo set-default` (`remote.<name>.gh-resolved` = `base`).
2. `upstream`.
3. `origin`.

That remote's name is kept: the fetch action (D7) and PR worktrees (D12) use it. `github.com` always counts as GitHub. Any other host counts only when `gh auth status --hostname <host>` succeeds, which covers GitHub Enterprise without a configured host list. With no GitHub remote, no `gh` process is started at all.

### D4. Detecting the checked-out branch's PR

Inputs come from the repository snapshot the child already collects (branch, HEAD, detached flag) plus `git config branch.<name>.merge` and `branch.<name>.remote`:

1. Detached HEAD → `no-pull-request`.
2. Upstream merge ref `refs/pull/<n>/head` → PR `<n>` (fork checkouts created by D12, and by `gh pr checkout`).
3. Otherwise head name = upstream branch name, or the local name when there is no upstream. Head owner = the owner of the upstream remote's repository, or the base owner when there is no upstream. Query `repository.pullRequests(headRefName:, states: [OPEN, MERGED, CLOSED], orderBy: UPDATED_AT DESC, first: 10)` and keep those whose `headRepositoryOwner` matches. Prefer an OPEN one, else the most recently updated.

Detection reruns only when branch, HEAD, or upstream configuration changes in the collected snapshot. Results are cached per repository root.

### D5. Data contract: a summary on the snapshot, detail on demand

**Summary.** `RepositorySnapshot` gains an optional `github` field (the type lives in `src/shared/github-contract.ts`):

- `status`: one of the spec's eight values.
- Repository identity: `host`, `owner`, `name`.
- `viewer` login and `checkedAt`.
- `stale`, and `retryAt` while rate-limited.
- `pullRequest` (absent unless `ready`): number, title, URL, state, isDraft, author, base and head ref names, `baseRefOid`, `headRefOid`, isCrossRepository, reviewDecision, checks rollup `{ state, passed, failed, pending, failing: string[≤10] }`, requested reviewers (≤20), mergeable, mergeStateStatus, updatedAt.
- `local`: `{ headMatches, baseCommitPresent, baseRefPresent }`, computed by the child with Git, not by GitHub.

The field stays well under 8 KB. It is absent for non-Git repositories.

**Detail.** Fetched on demand through internal child routes (all with `repository=<id>`; writes also carry `number`):

| Route | Purpose |
| --- | --- |
| `GET /api/github/pull-request?number=` | Body and timeline (≤100 items), reviews, threads (≤100, ≤50 comments each), viewer's pending review, permissions, merge readiness (D11). Markdown pre-rendered (D13). |
| `GET /api/github/pull-requests` | Open PR list (≤100), cached 30 s, with the viewer's pending comment count per PR. |
| `GET /api/github/pull-request/files?number=` | Changed paths, used for the anchoring check and file markers. |
| `POST /api/github/refresh` | Manual refresh. |
| `POST /api/github/fetch-refs` | D7. |
| `POST /api/github/comments` | Conversation comment. |
| `POST /api/github/review/threads` | New inline comment. |
| `POST /api/github/review/threads/:threadId/replies` | Thread reply. |
| `DELETE /api/github/review/comments/:commentId` | Delete a pending comment. |
| `POST /api/github/review/submit` | Submit the pending review. |
| `PATCH /api/github/review/comments/:commentId` | Edit a pending comment. |
| `DELETE /api/github/review` | Discard the pending review. |

The client re-reads detail when the summary's `updatedAt`, `headRefOid` or review decision changes, after its own writes, and on the refresh events in D6. There is no merge route. These routes fall under the existing `workspace-api` and `direct-child-api` exclusions, so no OpenAPI operations are added. The `RepositorySnapshot` change is a public payload change (D16).

*Alternative:* a new `github` live topic. Rejected for this change: it means a Hub revision, broker wiring and replay semantics for data that changes about once a minute, while the summary fits the existing repository update.

### D6. Refresh policy

Refresh is event-driven; there is no timer (owner decision). A timer spends the user's shared GitHub budget (5,000 points an hour across every token and agent of that user) on workspaces nobody is looking at, and the events below cover what a reviewer sees.

- **Triggers:** branch, HEAD or upstream change seen in a Git collection (detection plus summary); a pull request view opening (summary plus that PR's detail); the user returning to the page, on window `focus` or `visibilitychange` to visible (summary plus the pull requests on screen), at most once per 15 s however often focus moves; after each of the user's own writes (the write answers the PR's fresh detail); manual refresh and Retry (bypass rate-limit waits once).
- **Never** from file-content events or from time passing alone. The file observer has no path to the GitHub service, and a unit test asserts that edits cause no transport call.
- **Back-off:** exponential on `unavailable`, capped at 10 minutes; a full stop until `retryAt` on `rate-limited`. One in-flight request per repository; triggers coalesce.
- **Retry feedback:** Retry says `Retrying…` (also to assistive technology) while it runs, then either the fresh data with its new time or the same refusal with the time of this retry, so a repeated failure reads as a new answer.
- **Publishing:** a summary change republishes the last Git results with the new `github` field through repository-refresh's publish path, without re-running Git. If the PR association or base changed, it requests a Git re-collection instead, because changed files depend on the base (D7).
- **Cost:** GraphQL has no conditional requests. The summary query costs about 1 point, so cost follows user activity (opening views, switching back to the window), not wall-clock time. What is lost: checks turning green while the window stays unfocused show only when the user comes back or refreshes.

### D7. PR base override for `base` comparisons

`resolveCompareBase(repoRoot, override?)` accepts `{ remote, baseRefName, baseRefOid }` from the GitHub service's synchronous cache:

1. If `baseRefOid` exists locally (`git cat-file -e`): merge base = `merge-base(baseRefOid, HEAD)`, `exact: true`. This is the comparison GitHub's Files changed view shows.
2. Otherwise, if `<remote>/<baseRefName>` exists: merge base from it, `exact: false` (the UI says "may be out of date").
3. Otherwise: default resolution, with `pullRequestBaseMissing: true`.

`CompareBaseMode` gains `pull-request`, and `CompareBase` carries `pullRequest: { number, exact }`. The anchor stays `<remote>/<baseRefName>`, so "Since base" labels are unchanged. `diff.ts`'s per-repo context cache adds the override identity (number + `baseRefOid`) to its HEAD key, so a new PR base invalidates it.

**Fetch pull request refs** is an explicit child action, the only Git mutation the child makes. It runs `git fetch --no-tags <remote> +refs/heads/<base>:refs/remotes/<remote>/<base>`, plus `+refs/heads/<head>:refs/remotes/<remote>/<head>` for same-repository PRs or `refs/pull/<n>/head` (objects only) for forks, with the session's Git credentials and `GIT_TERMINAL_PROMPT=0`. It never touches the working tree, the index or local branches, and never runs automatically.

*Alternative:* fetch automatically when the base is missing. Rejected: the child otherwise only observes repositories, and silent network fetches with credentials should be a user decision.

### D8. Anchoring rule: comment only on a provably identical diff

The Diff view for file F in repository R is **PR-exact** when all of these hold:

- R has a `ready` PR.
- Compare target is `base`, and the base is `exact` (D7 case 1).
- Local HEAD equals `headRefOid`.
- F has no staged, unstaged or untracked changes.
- F is in the PR's changed files.

Under those conditions the displayed hunks are GitHub's hunks for F: right-side numbers are the head blob's lines, left-side numbers the merge-base blob's lines. `GET /api/document/diff` gains `review: { exact: true, number, headOid } | { exact: false, reason }` computed by `anchoring.ts`, so the client never decides this alone.

- **When exact:** threads with a current `line` are placed with Pierre annotations, and the gutter "+" and line selection open a composer.
- **When not exact:** the reason is shown (`local-changes`, `head-mismatch`, `base-inexact`, `last-commit`, `not-in-pr`, `lightweight-render`), threads are listed above the diff with path and original line, and no composer is offered.
- **Outdated threads** (`line == null` or `isOutdated`) are always listed, never placed.

The write route re-checks the same conditions at request time, using the client's `headOid`, so a stale page cannot post. Pierre `additions`/context map to GitHub `RIGHT` with new-file numbers; `deletions` map to `LEFT` with old-file numbers. A range must stay on one side.

*Alternative:* translate line numbers through local edits with a diff-of-diffs. Rejected: it fails silently in exactly the cases that matter, and the spec forbids silent misanchoring.

**Scope (owner decision):** D8 governs the per-document Diff view, which shows the local checkout. Files changed in the pull request view renders GitHub's own diff of the PR (the base and head contents GitHub serves), so it is PR-exact by construction for any PR, checked out or not, including one picked with Show in workspace. Inline comments and replies are offered there for every open PR. The write route checks such a request against the PR head, the PR's changed paths and the pending review's commit only; the local-HEAD and clean-file checks apply to requests from the per-document Diff view.

### D9. Pending review on GitHub, through GraphQL

The pending review is GitHub's own object, not a Uatu draft store. Drafts then survive reloads and devices, show on github.com, and need no new persistence.

- **Read:** `pullRequest.reviews(states: PENDING, first: 1)` returns only the viewer's pending review (id, `commit.oid`, comments).
- **First comment:** `addPullRequestReview(pullRequestId, commitOID: headOid)` without `event` creates the pending review. Then `addPullRequestReviewThread(pullRequestReviewId, path, line, side, startLine?, startSide?, body)`.
- **Reply:** `addPullRequestReviewThreadReply(pullRequestReviewThreadId, pullRequestReviewId, body)`.
- **Delete pending comment:** `deletePullRequestReviewComment`.
- **Submit:** `submitPullRequestReview(pullRequestReviewId, event, body)`. Submitting with no pending review creates and submits in one step with `addPullRequestReview(event, body)`.
- **Discard:** `deletePullRequestReview`.
- **Conversation comment:** `addComment(subjectId: pullRequestId, body)`. It is immediate and never part of the review, as on GitHub.

Rules:

- New inline threads require the pending review's `commit.oid` to equal the current head. A pending review started on an older commit must be submitted or discarded first; replies are still allowed. GitHub's exact anchoring of new threads in an older-commit review is not something Uatu should depend on.
- Own PR: Approve and Request changes are disabled when `viewer.login == author.login` (GitHub refuses them anyway).
- Summary: GitHub requires a body for Request changes, and for Comment unless the review carries line comments; Approve needs none. The review dialog, its field's `(required)` / `(optional)` guidance and placeholder, and the fake enforce that one rule.
- Body limit: 65,536 characters, checked before calling GitHub.
- Concurrency: one write at a time per PR in the child. Overlapping submits answer 409.

### D10. Inline UI on `@pierre/diffs`

`diff-view.ts` gains optional `review` options. When present, it passes `lineAnnotations` and `renderAnnotation` (threads and pending comments, rendered by `diff-review.ts`), and turns on `enableGutterUtility`/`onGutterUtilityClick` plus `enableLineSelection`/`onLineSelectionEnd` to open the composer, which is itself an annotation at the range's end line. Annotation updates use `setLineAnnotations()`, so posting a comment does not re-render or lose scroll.

Pierre still loads lazily and only for Diff, so the existing "Rendered/Source never load Pierre" requirement holds. The lightweight tier (oversized diffs) has no Pierre and therefore no inline UI; it falls back to the thread list (D8 reason `lightweight-render`). The `pierre-plaintext` tier keeps annotations.

*Fallback if annotations misbehave in practice* (for example with Split layout or wrapping): use the same thread list plus a line-number picker in the composer. This keeps the D8 rule and the wire contract unchanged and only degrades placement. Task 5.1 starts with a spike that confirms annotations, gutter utility and selection in Unified and Split, with wrap on and off, before the composer is built.

### D11. Merge readiness, read-only; merging happens on GitHub

Uatu does not merge (owner decision). On 2026-10-01 GitHub made its async merge API the recommended way to merge programmatically, and the synchronous REST merge and GraphQL `mergePullRequest` don't support merge queues or stacked pull requests (generally available since 2026-10-06). Merging also carried the most drift for the least added value: method gating, head pinning, branch deletion and the pending-review discard sequence. GitHub's own UI handles queues, rulesets and stacks correctly, so Uatu links there.

- **Readiness** comes from the detail payload: `repository { mergeCommitAllowed, squashMergeAllowed, rebaseMergeAllowed, deleteBranchOnMerge }` and `pullRequest { state, isDraft, mergeable, mergeStateStatus }`, normalized to `mergeReadiness { mergeable, blockers[], allowedMethods[], deleteBranchOnMerge }`. `blockers` lists every reason GitHub would refuse now (draft, conflicts, changes requested, required reviews, failing or running required checks, behind the base, mergeability still computing), most important first. Unknown `mergeStateStatus` values map to a generic blocker, never a throw.
- **Shown** read-only in two places: the Pull request pane's always-visible summary line (checks count and the first blocker, with a count of the rest) and its details (every reason, the merge methods, whether GitHub deletes the head branch), and at the end of Conversation, where GitHub has its merge box. When the viewer has pending review comments, readiness says `You have N pending comments — finish your review before merging on GitHub.`
- **Merging** is a link to the pull request's GitHub page: a prominent `Merge on GitHub ↗` when it is ready, otherwise a secondary `View on GitHub ↗` (merging is blocked, so the link is for reading). No route, service method or dialog merges, deletes a branch on GitHub, or touches a local branch, remote-tracking ref or worktree.
- *Revisit* merging from Uatu on the async merge API once GitHub Enterprise Server has it and merge queues and stacks are understood there.

### D12. Opening any PR as a Hub worktree

Wherever the open-PR list ends up (Q2), it offers **Review in worktree** only in a Hub. The client matches each row to an existing checkout using the worktree inventory it already reads (`/api/hub/worktrees`), keyed by the PR's local branch name: `headRefName` for same-repository PRs, `pr/<n>` for forks. A match offers **Open** instead.

- **Same-repository PR:** the client runs the existing worktree fetch, then sends the existing `remote-tracking` request for `<remote>/<headRefName>` against the repository's main workspace. No Hub change is needed, and the branch can be pushed to normally.
- **Fork PR:** new mode `{ mode: "pull-request", pullRequest: { number, remote } }`. The Hub validates that the number is a positive integer and that `remote` is configured in the parent. It then fetches `refs/pull/<n>/head` with the parent's credentials through `worktree-fetch.ts`'s environment. If `pr/<n>` does not exist, it creates the branch at the fetched commit and sets `branch.pr/<n>.remote=<remote>` and `branch.pr/<n>.merge=refs/pull/<n>/head`, so `git pull` updates it and detection finds it (D4). An existing `pr/<n>` with that exact upstream is checked out as-is (never reset); any other existing `pr/<n>` is a conflict. The recorded creation origin is `refs/pull/<n>/head`.

Naming: `pr/<n>` is unambiguous, cannot collide with a fork's `main` or `patch-1`, and reads clearly in the worktree picker, whose child names are exact branch names. Destinations follow the existing `<main>.worktrees/<safe-branch-folder>` rule. The Hub never calls GitHub: the PR number and remote are all it needs.

*Alternative:* a Hub-side GitHub lookup that derives the head itself. Rejected: it would add a second GitHub access path in the Hub process.

*Alternative:* materializing fork heads as `refs/remotes/<remote>/pr/<n>` and reusing `remote-tracking`. Rejected: the next `fetch --prune` deletes such refs, and the upstream would be wrong.

### D13. Rendering GitHub content

The child renders each Markdown body (`body`, never GitHub's `bodyHTML`) with `renderMarkdownToHtml` from `src/render/markdown.ts`, which applies the GitHub-modeled sanitize schema. It does so without local-document link rewriting: relative URLs resolve against the PR's GitHub URL, and links open in a new tab through the existing preview link handling. Plain strings (titles, logins, branch names, check names, GitHub error messages) are escaped with `escapeHtml` on render. Avatars are not loaded. Images in bodies load from their GitHub URLs, as remote images in documents do. Images that are private-repository attachments may not load (see Risks).

### D14. Security

- **Token:** stays in the child's environment and `gh` config (D2). No route echoes environment, config paths or stderr.
- **Requests:** writes are POST/DELETE only. Through the Hub they pass session authentication and the same-origin check in `src/hub/server.ts`. Directly, they pass `hasValidWorkspaceCredentials` and `isAllowedOrigin`, as `/api/repositories/refresh` does.
- **Input:** validation precedes any `gh` call: integers, enums, path in the PR's changed files, body length.
- **Repository identity:** always derived server-side (D3). Clients address repositories by repository id and PRs by number only.
- **Attribution:** every action runs as the credential's GitHub account. The UI shows `@viewer` on each composer and dialog. In a multi-user Hub, a second Hub user acting in the workspace posts as the token owner; the UI says so, and the existing shared-credential warning applies.

### D15. Testing without GitHub

- **Unit:** `gh.ts` runs against a fake `gh` executable written into a temporary directory on `PATH`. The fake records argv and stdin and replays scripted status, headers and JSON. It covers the version floor, missing binary, `--hostname`, stdin-only variables (including a body starting with `@`), and each error class. `remote.ts`, `normalize.ts`, `anchoring.ts`, the D11 gating table and the scheduler (fake clock) are pure tests.
- **Service:** `service.ts` runs against an in-memory `FakeGitHub` transport (`tests/fixtures/github-fake.ts`) holding repositories, PRs, timeline, threads, pending reviews and merge state, and implementing the GraphQL operations and REST paths used here, keyed by operation name. Real temporary Git repositories cover detection, base override and anchoring.
- **E2E:** `tests/e2e/server.ts` injects the service with `FakeGitHub` and a test-only `/__e2e/github` control route (scenario reset, push a new head, set mergeability, simulate rate limit or no credential), listed in `api/exclusions.yaml` as `scope: test`. `testdata/` gains a fixture repository with an `origin` remote URL on `github.com` and a local bare remote for fetches. Feature files: `tests/e2e/pull-request-read.e2e.ts` (including merge readiness), `pull-request-base.e2e.ts`, `pull-request-worktree.e2e.ts` (Hub fixtures, real Git, `refs/pull/<n>/head` created in the bare remote with `git update-ref`), `pull-request-review.e2e.ts`. A guard test asserts the e2e server never constructs the real `gh` transport.
- **Manual acceptance** against a sandbox GitHub repository happens once, before merge, by the project owner. It covers the D7/D8 claim that exact-base hunks match GitHub's, the pending-review mutations, and readiness against github.com's merge box.

### D16. Contract and revisions

- `RepositorySnapshot.github` is an addition to a closed public schema: bump `WORKSPACE_API_REVISION` (currently 37).
- The `pull-request` mode on `CreateWorktreeRequest` is a Hub API change: bump `HUB_API_REVISION` (currently 15).
- Both go into `api/openapi.yaml`, `api/contract.json`, `x-uatu-revisions` and `api/CHANGELOG.md` under Unreleased, with examples, and must pass `bun run api:validate`.
- `BUNDLED_WEB_REVISION` is unchanged: nothing existing is reshaped.

## Risks / Trade-offs

- **GitHub's PR diff base could differ from `merge-base(baseRefOid, headRefOid)` in edge cases**, such as a base that was force-pushed or a stale `baseRefOid` after a base retarget. → GitHub rejects a line outside its diff, and Uatu shows that error without posting. Changing the base triggers re-detection. Manual acceptance covers a PR whose base advanced.
- **The `pr/<n>` checkouts from forks are read-only in practice.** → Stated as a non-goal and in the PR summary: "Changes here cannot be pushed to the fork".
- **GitHub budget with many open workspaces.** → No timer: requests follow user activity (D6), with a focus throttle and rate-limit back-off. The cost is that a change on GitHub shows only on the next refresh event.
- **`gh` behavior differs across versions.** → Only `gh api` is used; the floor is checked; the fake `gh` pins the expected invocation shape.
- **Shared Hub users post as the token owner.** → `@viewer` is shown on every write, and the existing credential-sharing warning applies.
- **Private-repository image attachments may not render** because the browser has no GitHub session. → They show as broken images with alt text; the PR link opens GitHub.
- **Split layout or wrapping could interact badly with annotations.** → Task 5.1 spikes it first; the D10 fallback keeps the contract.
- **A reviewer may want to comment while editing locally.** → Uatu explains why commenting is unavailable and lets them comment on github.com. A stash-free "comment on PR head" view is a possible follow-up.
- **Adding a PR entry point to the worktree picker would reopen its approved UX.** → Q2 leaves that choice to the UX review. The Hub API mode (D12) works for any entry point.

## Migration Plan

All additions are optional and phase-gated. Older clients ignore `RepositorySnapshot.github`; older Hub API clients never send `pull-request` mode. Rollback removes the routes, field and mode together. No persisted state is introduced by the server side: the pending review lives on GitHub. If the UX review chooses a sidebar pane, its visibility uses the existing pane-state storage, which ignores unknown ids.

## Open Questions

The first two are open by the project owner's decision, pending a separate UX review that may propose larger UI changes. The specs avoid committing to either, and the tasks that depend on them are marked provisional. Static mockups that illustrate one possible answer (suggestions, not decisions) are in `/tmp/uatu-pr-mockups/`, files `01-pr-pane-and-conversation.png` through `06-no-credential-and-states.png`.

- **Q1. Where the pull request lives as a surface.** Options:
  - (a) **Own preview target:** a Pull request sidebar pane for the summary and list, plus a `pull-request` `PreviewMode` kind at `?repository=<id>&pr=<n>`, like commit previews. This is the smallest change to existing patterns. It would need `sidebar-shell` and `document-routing` deltas.
  - (b) **View mode:** a "Pull request" mode beside Rendered/Source/Diff for the workspace, with the summary in Change Overview. Fewer new surfaces, but the view-mode chooser is per document today.
  - (c) **Workspace "review mode":** a mode that reorganizes the workspace around the PR: file list from the PR, diff-first preview, conversation and review controls together. It fits a review workflow best and is the largest change.

  Whichever wins, the server contract (D5), anchoring (D8) and review model (D9) are unchanged. The choice decides the client modules in D1, the URL shape behind the spec's "addressable by URL" requirement, and any `sidebar-shell`/`document-routing` deltas.
- **Q2. Where "open any PR" lives.** Options:
  - (a) the worktree menu (picker and Hub dashboard dialog), which reopens the approved worktree UX;
  - (b) the PR surface from Q1, as a list of open PRs;
  - (c) the Hub or Navigator, as a repository-level PR list beside workspaces.

  The Hub API mode (D12) and the list route (D5) serve all three. The choice decides which client module hosts the list and whether `hub-dashboard` needs a delta.
- **Focus throttle and back-off cap.** The 15 s focus throttle and the 10 min back-off cap are starting points, to be tuned with real usage. Changing them affects no spec.
- **GitHub-only Markdown niceties.** Whether to linkify `#123`, `@user` and commit SHAs in rendered bodies, as github.com does. This is a rendering refinement that does not change the contract.
- **The exact `gh` floor.** `gh api --input` and `--hostname` predate 2.0, but confirm the floor in task 1.2 against the oldest `gh` the Hub accepts. If a newer floor is needed, raise it in one place.
