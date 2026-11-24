## Why

Uatu already shows a branch's changed files, per-file diffs and commit history, but reviewing a GitHub pull request still means leaving for github.com: the diff there is against the PR's base, the conversation and review threads live there, and so does the review button. Reviewers who already work in Uatu, often beside an agent in the same workspace, want to read, discuss and review a pull request, and see whether it is ready to merge, in the checkout where they can also run and edit the code.

## What Changes

- Detect the GitHub pull request for each repository's checked-out branch and show it automatically: number, title, state or draft, review decision, checks, requested reviewers and a link to GitHub.
- Add a URL-addressable pull request view that renders the PR description and conversation with the existing sanitized GitHub-flavored Markdown renderer.
- Where these live in the UI is not settled. A separate UX review will choose between a sidebar pane with its own preview target, a view mode, and a workspace "review mode", and will decide where "open any PR" is offered. The specs describe behavior without fixing the surface; `design.md` records the options.
- While the checked-out branch has an open pull request, measure the `base` compare target against the PR's base branch (`baseRefName` and GitHub's base commit) instead of the repository's default branch. Changed files, the compare anchor and the per-file Diff view all follow it. `last-commit` is unchanged.
- List the repository's open pull requests and open any of them for review in its own Hub worktree. Same-repository PRs use their real head branch; PRs from forks get a local `pr/<number>` branch fetched from `refs/pull/<number>/head`. This adds a `pull-request` creation mode to the Hub worktree API.
- Add top-level conversation comments.
- Add inline comments on the Diff view and replies to existing review threads. Both accumulate in the viewer's pending review on GitHub, as they do on github.com. Inline comments are offered only when the displayed diff is exactly the PR's diff at its head commit; otherwise Uatu explains why and never guesses a line.
- Submit the pending review as Comment, Approve or Request changes, or discard it.
- Show merge readiness read-only: whether GitHub would merge the pull request now and every reason it would not, beside checks, review state, the repository's merge methods and whether GitHub deletes the head branch, plus a prominent "Merge on GitHub ↗" link. Uatu does not merge: GitHub made its async merge API the recommended programmatic path on 2026-10-01, and the synchronous merge calls don't support merge queues or stacked pull requests, so merging stays on GitHub.
- All GitHub access goes through the `gh` CLI the Hub already projects into the workspace session. The token never reaches the browser. Missing `gh`, a missing credential, a non-GitHub remote, a branch without a PR, rate limiting and GitHub Enterprise hosts each have a defined state and next step.

## Capabilities

### New Capabilities

- `github-pull-requests`: GitHub repository and credential resolution, pull request detection for the checked-out branch, the automatic summary, read-only merge readiness with the link to merge on GitHub, the open-PR list, the URL-addressable pull request view, event-driven refresh, status and error states, and safe rendering of GitHub content.
- `pull-request-review`: conversation comments, inline comments and thread replies in a GitHub pending review, editing pending comments, resolving and unresolving threads, keeping pending reviews and unsent text in sight, the rule for anchoring inline comments to the PR head, review submission, and action attribution.

### Modified Capabilities

- `change-review-load`: an open pull request supplies the `base` compare target and its anchor.
- `document-diff-view`: the base-resolution order gains the pull request base ahead of the repository default.
- `git-worktree-workspaces`: a pull request can be opened as a Hub worktree through a new creation mode, including PRs from forks.

## Impact

- New `src/github/` domain folder for the session child: remote parsing, the `gh` transport, GraphQL/REST queries, normalization, the per-session pull request service, and the anchoring rule. New internal child routes under `/api/github/` in `src/server/routes.ts`; they fall under the existing internal `workspace-api` and `direct-child-api` route exclusions.
- Client: review annotations on `src/preview/diff-view.ts` through `@pierre/diffs` line annotations, and URL and history handling in `src/shell/`. The PR summary, list and view surfaces land in `src/sidebar/`, `src/preview/` or `src/shell/` depending on the UX review's outcome. Requirement deltas for `sidebar-shell` or `document-routing` are added then, if the chosen surface needs them.
- Git data: `src/document/git-base-ref.ts`, `git-data.ts` and `diff.ts` accept a pull request base override; `CompareBaseMode` gains `pull-request`.
- Hub: `src/hub/worktree-create.ts`, `worktree-fetch.ts` and `src/shared/worktree-contract.ts` gain the `pull-request` mode.
- Public contract: `CreateWorktreeRequest` gains the `pull-request` mode (Hub revision bump), with `api/openapi.yaml`, `api/contract.json`, `src/shared/version.ts` and `api/CHANGELOG.md` updated. The pull request summary stays on the session's internal routes, read on demand; `RepositorySnapshot` and the workspace revision are unchanged (design D5).
- No new dependency. `gh` is already a Hub-managed tool; uatu does not add a token path of its own.
- Tests never call GitHub: the child's transport is a seam with an in-memory fake for e2e and a fake `gh` executable for unit tests.
- Docs: `CLAUDE.md` folder map, `ARCHITECTURE.md` and user-facing docs.
