## Purpose

Lets a reviewer see the GitHub pull request behind a checkout, browse the repository's open pull requests, read a pull request's description and conversation, and see whether GitHub would merge it, inside Uatu, using the GitHub CLI credential the workspace already has. Uatu never merges: merging links to the pull request on GitHub.

## ADDED Requirements

### Requirement: The GitHub repository is resolved from the checkout's remotes
For each Git repository in a workspace, the server SHALL resolve one GitHub repository (host, owner, name) from the checkout's remotes, never from client input. A remote selected as the base repository with `gh repo set-default` SHALL win, then `upstream`, then `origin`. A host other than `github.com` SHALL count as GitHub only when the GitHub CLI is authenticated for it.

#### Scenario: Origin points at github.com
- **WHEN** a repository's only remote is `origin` with URL `git@github.com:acme/widgets.git`
- **THEN** the resolved GitHub repository is `github.com/acme/widgets`

#### Scenario: Fork workflow with an upstream remote
- **WHEN** `origin` points at `github.com/me/widgets` and `upstream` points at `github.com/acme/widgets`, and no default repository was set with `gh repo set-default`
- **THEN** the resolved GitHub repository is `github.com/acme/widgets`

#### Scenario: GitHub Enterprise host with a credential
- **WHEN** `origin` points at `https://ghe.example.com/acme/widgets.git` and the GitHub CLI is authenticated for `ghe.example.com`
- **THEN** the resolved GitHub repository is `ghe.example.com/acme/widgets`

#### Scenario: Remote on an unknown host
- **WHEN** the only remote points at a host that is neither `github.com` nor authenticated in the GitHub CLI
- **THEN** the repository's GitHub status is `not-github` and no GitHub request is made

### Requirement: GitHub access uses the workspace's GitHub CLI credential
The server SHALL reach GitHub only through the GitHub CLI available to the workspace session, with the credential the session was started with. It MUST NOT read, store, or forward the token itself. The token, CLI configuration, and raw CLI error output MUST NOT reach the browser.

#### Scenario: Responses carry no credential material
- **WHEN** any GitHub-backed route answers, successfully or with an error
- **THEN** the response contains no token, CLI configuration path, environment value, or raw CLI stderr
- **AND** an error carries a classified status and, at most, GitHub's own bounded error message

#### Scenario: Write text is never interpreted by the CLI
- **WHEN** a comment or review body begins with `@`, `-`, or contains newlines or shell metacharacters
- **THEN** GitHub receives the body exactly as written and no local file is read or option parsed from it

### Requirement: GitHub status has a defined state for every failure
Each repository's GitHub summary SHALL carry one status: `ready`, `no-pull-request`, `not-github`, `gh-missing`, `no-credential`, `no-access`, `rate-limited`, or `unavailable`. Every status other than `ready` and `no-pull-request` SHALL show a plain explanation and the next step. Last known pull request data SHALL stay visible, marked stale, during `rate-limited` and `unavailable`.

#### Scenario: GitHub CLI is missing or too old
- **WHEN** the GitHub CLI is not on the session's path or is older than the supported minimum version
- **THEN** the status is `gh-missing` and the explanation names the minimum version and how to install it

#### Scenario: No credential in a Hub workspace
- **WHEN** the session runs under a Hub and the GitHub CLI is not authenticated for the repository's host
- **THEN** the status is `no-credential`
- **AND** the explanation links to the Hub's Settings to assign a token with the GitHub CLI capability for that host, and says the workspace must restart to pick it up

#### Scenario: No credential outside a Hub
- **WHEN** the session runs outside a Hub and the GitHub CLI is not authenticated for the host
- **THEN** the explanation shows the `gh auth login --hostname <host>` command to run

#### Scenario: Token cannot see the repository
- **WHEN** GitHub answers that the repository is not found or access is forbidden, including an organization single sign-on refusal
- **THEN** the status is `no-access` and the explanation shows GitHub's message

#### Scenario: Rate limit reached
- **WHEN** GitHub reports that the rate limit is exhausted
- **THEN** the status is `rate-limited` with the reset time
- **AND** no further GitHub request is made for that host before the reset time, except one the user explicitly asks for

#### Scenario: GitHub is unreachable
- **WHEN** a GitHub request fails because of the network or a server error
- **THEN** the status is `unavailable`, the last known data stays visible as stale, and retries back off

#### Scenario: Said once per screen
- **WHEN** the summary is rate-limited while the pull request view and the Pull request pane are both on screen
- **THEN** the view's banner explains it once, the pane shows a one-line `Rate-limited · sending paused` tag with Retry, and the Files pane does not repeat it
- **AND** the review bar says only why its own Discard and Finish buttons wait

#### Scenario: Retrying from a stale notice
- **WHEN** the user activates Retry on a stale notice
- **THEN** the notice says `Retrying…`, announced to assistive technology, until GitHub answers
- **AND** it then shows the fresh data with its new time, or the same refusal again with the time of this retry

#### Scenario: A retry result belongs to its status
- **WHEN** Retry said `the rate limit still holds` and GitHub's status then changes, to `unavailable` or back to `ready`
- **THEN** that retry result is gone; a later stale notice shows no retry time until the user retries again

### Requirement: The checked-out branch's pull request is detected
The server SHALL detect the pull request whose head is the repository's checked-out branch. A branch whose upstream is `refs/pull/<number>/head` SHALL map to that number. Otherwise the server SHALL match the branch's upstream branch name, or its local name, against pull request heads in the resolved repository's network, preferring an open pull request, then the most recently updated one.

#### Scenario: Branch with an open pull request
- **WHEN** the checked-out branch `feature/login` tracks `origin/feature/login` and pull request #42 has head `acme:feature/login`
- **THEN** the repository's GitHub summary is `ready` and names pull request #42

#### Scenario: Pull request checkout from a fork
- **WHEN** the checked-out branch `pr/57` has upstream `refs/pull/57/head`
- **THEN** the summary names pull request #57 without a branch-name search

#### Scenario: Branch without a pull request
- **WHEN** no pull request has the checked-out branch as its head
- **THEN** the status is `no-pull-request` and the open pull request list stays available

#### Scenario: Detached HEAD
- **WHEN** the repository's HEAD is detached
- **THEN** the status is `no-pull-request` and the explanation says no branch is checked out

#### Scenario: Merged pull request
- **WHEN** the only pull request for the branch has been merged
- **THEN** the summary names it with state Merged

### Requirement: The summary reaches clients with repository updates
The pull request summary SHALL ride each repository's snapshot on the existing document live updates. It MUST NOT add a browser connection, topic, or polling loop. The summary SHALL be bounded and SHALL include number, title, URL, state, draft flag, author, base and head branch names, base and head commit ids, review decision, a checks rollup, requested reviewers, and update time.

#### Scenario: A summary change reaches open clients
- **WHEN** a pull request's review decision changes on GitHub and the next refresh sees it
- **THEN** every open client of that workspace receives the new summary through its existing live connection

#### Scenario: A summary change does not re-collect Git data
- **WHEN** only the pull request summary changed
- **THEN** the repository snapshot is republished from the last Git collection without running Git again

### Requirement: Pull request data refreshes on events, never on a timer
Pull request data SHALL refresh when the checked-out branch, its upstream, or HEAD changes, when a pull request view opens, when the user returns to the page (window focus or the page becoming visible), after each of the user's own writes, and when the user asks. It MUST NOT refresh on a timer, and it MUST NOT contact GitHub because a file was edited. Returning to the page SHALL refresh at most once per short interval, however often focus changes.

#### Scenario: File edits do not reach GitHub
- **WHEN** a user saves a tracked file repeatedly while a pull request is detected
- **THEN** no GitHub request results from those edits

#### Scenario: Switching branches re-detects
- **WHEN** the checkout switches from `feature/login` to `main`
- **THEN** detection reruns and the summary reflects `main`'s pull request or `no-pull-request`

#### Scenario: Manual refresh
- **WHEN** the user asks to refresh the pull request
- **THEN** the summary and any open pull request detail are fetched again, including while rate-limited

#### Scenario: Returning to the page
- **WHEN** the user switches back to the Uatu window while a pull request view is open
- **THEN** the summary and that pull request are read again, and what changed on GitHub meanwhile shows

#### Scenario: Leaving the page open
- **WHEN** a pull request view stays open and nobody interacts with it
- **THEN** no GitHub request is made until one of the refresh events happens

### Requirement: The workspace surfaces the detected pull request without user action
When a repository has a detected pull request, the workspace SHALL show it without the user searching for it: number, title, state or draft, author, base and head branches, review decision, checks rollup with failing check names, requested reviewers, and a link that opens it on GitHub in a new tab. It SHALL say when the checkout's HEAD differs from the pull request's head commit.

#### Scenario: Ready pull request
- **WHEN** a pull request is detected with two passing checks, one failing check, and review decision Changes requested
- **THEN** the workspace shows the number, title, `Open`, `Changes requested`, a checks rollup naming the failing check, the requested reviewers, and an Open on GitHub link

#### Scenario: Local checkout is behind the pull request
- **WHEN** the checkout's HEAD is not the pull request's head commit
- **THEN** the workspace says the checkout differs from the pull request head and shows the head commit's short id

#### Scenario: Several repositories in one workspace
- **WHEN** a workspace has two repositories and only one has a detected pull request
- **THEN** that repository's pull request is shown labeled with the repository name, alongside the other repository's status

#### Scenario: No pull request
- **WHEN** no pull request is detected or the repository is not on GitHub
- **THEN** no pull request summary or placeholder is added to existing repository views

#### Scenario: A short pane
- **WHEN** the pane holding the summary is only a few lines tall
- **THEN** a top row pinned while the pane scrolls holds the state, the review decision and the `Details` toggle on one line (the number is in the pane header), and below it the title, checks count and the first merge blocker sit above the summary's actions
- **AND** whenever the pull request or the status shown changes, the pane starts at its top

#### Scenario: No row is cut at the pane's bottom
- **WHEN** the pane is at its default height, with Details closed or open
- **THEN** its bottom edge falls between rows: a row that would be cut is left wholly below it, and the pixels go to another pane

#### Scenario: Opening the details
- **WHEN** the user expands the details
- **THEN** the title stays in view; the pane scrolls only as far as keeps the title below the pinned top row and its bottom edge between rows

#### Scenario: Review actions say what they do
- **WHEN** the viewer has no pending review on the shown pull request
- **THEN** the summary's review action reads `Start review`, and it opens the pull request's Files changed with focus on the first file's line numbers (on touch, its `Comment on a line…`), without a dialog
- **AND** with 2 pending comments it reads `Finish review (2)`, as the Files changed review bar does, and opens the Finish review dialog
- **AND** a review with a summary only (an approval without line comments) starts from Files changed's `Review without line comments…`

#### Scenario: Links to GitHub say they open a new tab
- **WHEN** a screen reader reaches `Merge on GitHub ↗`, Open on GitHub, or another link that opens GitHub in a new tab
- **THEN** its name ends with `(opens in a new tab)`

### Requirement: Merge readiness is shown read-only, and merging happens on GitHub
Uatu MUST NOT merge pull requests. For a shown pull request it SHALL say, read-only, whether GitHub would merge it now and every reason it would not, beside the checks and review state, the repository's allowed merge methods, and whether GitHub deletes the head branch after merging. It SHALL offer a prominent `Merge on GitHub ↗` link that opens the pull request on GitHub. When the viewer has pending review comments on the pull request, it SHALL say so before the link.

#### Scenario: Ready to merge
- **WHEN** an open pull request has its required reviews and passing checks, and no conflicts
- **THEN** the summary says it is ready to merge on GitHub and highlights `Merge on GitHub ↗`

#### Scenario: Blocked
- **WHEN** GitHub would refuse the merge because a required check is still running and a review is missing
- **THEN** the summary shows the first reason with a count of the rest, its details list both reasons, and `Merge on GitHub ↗` still opens the pull request on GitHub

#### Scenario: Pending comments
- **WHEN** the viewer has 2 pending review comments on the pull request
- **THEN** the readiness says `You have 2 pending comments — finish your review before merging on GitHub.`

#### Scenario: Merged elsewhere
- **WHEN** the pull request was merged on GitHub
- **THEN** the next refresh shows it as Merged, and no local branch, remote-tracking ref or worktree is touched

### Requirement: Open pull requests can be listed
The workspace SHALL list the resolved repository's open pull requests on demand, newest update first, bounded to the first 100 with a link to GitHub for the rest. Each row SHALL show number, title, author, draft flag, and checks rollup, and SHALL be filterable by text.

#### Scenario: Listing open pull requests
- **WHEN** the user asks for the repository's open pull requests
- **THEN** the list loads and shows each open pull request with number, title, author, draft flag, and checks rollup

#### Scenario: Filtering the list
- **WHEN** the user types `login` into the list filter
- **THEN** only pull requests whose number, title, author, or head branch matches remain

#### Scenario: More than 100 open pull requests
- **WHEN** the repository has 140 open pull requests
- **THEN** the list shows the 100 most recently updated and a link to the rest on GitHub

#### Scenario: Picking on a phone
- **WHEN** the user opens the list on a touch device
- **THEN** it fills the screen, its search field does not take focus (the keyboard would cover the list), and each row's actions sit outside the row, so rows hold no nested controls

#### Scenario: Opened to create a worktree
- **WHEN** the user chooses `From a pull request…` in the worktree menu and selects #639
- **THEN** the list is titled `Create a worktree from a pull request`, `Create worktree…` is the primary action and Enter runs it, with `Show in workspace` beside it
- **AND** opened from the Pull request pane, `Show in workspace` is the primary action

#### Scenario: Names for the list
- **WHEN** the list is offered from the Pull request pane's header or its no-pull-request state
- **THEN** each entry point reads `Browse pull requests…`, and so does the list's title
- **AND** the worktree menu offers it as `From a pull request…`, beside `New branch / worktree` and `Existing branch`

#### Scenario: Filtering by keyboard
- **WHEN** the user activates a filter chip with Enter or Space
- **THEN** the list filters and focus stays on that chip

#### Scenario: Finding a merged or closed pull request by number
- **WHEN** the user types `#642` or pastes the pull request's URL, and #642 is merged
- **THEN** the list says #642 isn't open, looks it up in any state, and offers to show it with its state

### Requirement: The pull request view renders the description and conversation
The pull request view SHALL render the description and the conversation in time order: comments, submitted reviews with their bodies, and review threads with their file path, resolved and outdated flags, and replies. All GitHub-authored Markdown SHALL be rendered with the same sanitizer used for documents. Large conversations SHALL be bounded with a link to GitHub.

#### Scenario: Opening the pull request view
- **WHEN** the user opens the detected pull request from its summary
- **THEN** the view shows the title, state, description, and conversation

#### Scenario: Hostile Markdown in a comment
- **WHEN** a comment contains `<script>`, an `onerror` attribute, or a `javascript:` link
- **THEN** the rendered comment contains none of them and no script runs

#### Scenario: Links leave the app
- **WHEN** the user clicks a link inside a pull request description
- **THEN** it opens in a new browser tab, as preview links do

#### Scenario: Long conversation
- **WHEN** a pull request has more conversation items than the bound
- **THEN** the view shows the most recent items and a link to the full conversation on GitHub

#### Scenario: The parts read apart on a phone
- **WHEN** the pull request view is shown at phone width (390px), in the light or the dark theme
- **THEN** the pull request's facts, the description, each review and comment, the merge box and the composer are each set apart: a full-width band with a tinted header strip (author · action · time) or tinted surface, hairlines above and below, and the same gap between parts, with no width given to side borders
- **AND** review threads are tinted cards, and all their text keeps at least 4.5:1 contrast

### Requirement: The pull request view is addressable by URL
The pull request view SHALL have a same-origin URL naming the pull request number (`?pr=<n>`), and the repository only when it is not the workspace's pull request repository (its first Git repository). URLs that name the repository SHALL keep working. Direct arrival, refresh, and browser Back/Forward SHALL restore it, and an unresolvable URL SHALL show why the pull request is unavailable rather than an unrelated document.

#### Scenario: Direct arrival and refresh
- **WHEN** a user opens or refreshes a URL naming pull request #42 of a repository the workspace can read
- **THEN** the pull request view for #42 is shown

#### Scenario: A short URL
- **WHEN** a user opens `?pr=642` in a workspace whose Git repository has pull request #642
- **THEN** the pull request view for #642 is shown, and the view's own links and history entries use `?pr=642` without the repository's path

#### Scenario: A number that names nothing
- **WHEN** a user opens `?pr=abc`, or `?pr=642` in a workspace without a Git repository
- **THEN** a notice says why no pull request can be shown, over the workspace's default view

#### Scenario: Back and Forward
- **WHEN** a user opens a document, then a pull request view, then presses Back and then Forward
- **THEN** Back restores the document with its tree selection and Forward restores the pull request view

#### Scenario: Pull request cannot be loaded
- **WHEN** the URL names an unknown repository, a pull request that does not exist, or a repository whose GitHub status is not ready
- **THEN** the view explains why the pull request is unavailable and the sidebar remains usable

#### Scenario: Another pull request in the repository
- **WHEN** the URL names a pull request other than the checked-out branch's
- **THEN** it is shown with its full review: conversation comments, and inline comments and replies on its Files changed, which renders GitHub's own diff of that pull request rather than this checkout
- **AND** when served by a Hub, an offer to open it in its own worktree

### Requirement: A picked pull request becomes the workspace's current one
Choosing **Show in workspace** for a pull request SHALL make it the workspace's current pull request without checking it out: the Pull request pane and the pull request view SHALL show it, and the Files pane SHALL list its changed files as a tree with review marks and line counts. The pick SHALL be restored by the pull request view's URL, and a visible control SHALL return the workspace to the checked-out branch.

#### Scenario: Showing another pull request
- **WHEN** the user picks pull request #639 while `feat/view-pr` (#642) is checked out
- **THEN** the Pull request pane shows #639 with a note that `feat/view-pr` stays checked out, above #639's summary and clear of its actions
- **AND** the Files pane's heading reads `PR #639 files`, and it lists #639's changed files under a `PR #639` label in place of the workspace tree
- **AND** Change Overview is labelled as describing the local branch `feat/view-pr`, not #639


#### Scenario: Opening a file from the pull request scope
- **WHEN** the user picks a file in the Files pane's pull request scope
- **THEN** the pull request view opens on Files changed, scrolled to that file's diff, and the URL names the file

#### Scenario: Returning to the checked-out branch
- **WHEN** the user chooses the return control
- **THEN** the pane shows the branch's pull request (or its no-pull-request state), the Files pane shows the workspace tree, and a preview of the picked pull request gives way to the branch's own

#### Scenario: Touch mode
- **WHEN** the user picks a pull request on a touch device
- **THEN** the Preview tab comes forward with the pull request's conversation, the Files tab lists its files one tap away, and picking a file there brings the Preview tab back with that file's diff

#### Scenario: One way back
- **WHEN** a picked pull request is shown
- **THEN** the Pull request pane's note offers `← Back to <branch>`, and the Files pane offers the same control only while the Pull request pane is hidden or collapsed, so each screen says it once

#### Scenario: Focus after showing a pull request
- **WHEN** the user shows a pull request from Browse pull requests…, including from a simulated worktree's result, or opens one from the pane while the preview is out of sight (a narrow window stacking the sidebar above the preview, or touch mode's Files tab)
- **THEN** the preview comes into view and its heading takes focus

### Requirement: Only another pull request counts as picked, and browsing is always at hand
Only a pull request other than the checked-out branch's own SHALL count as picked. The Pull request pane SHALL offer a way to browse the repository's pull requests whatever it shows.

#### Scenario: The branch's own pull request is never a pick
- **WHEN** the pull request view shows #642, whose head is the checked-out branch, and GitHub later reports no pull request for the branch
- **THEN** #642 is not labelled as picked
- **AND** the view says GitHub links no pull request to the branch and #642 is shown only because the address names it

#### Scenario: Browsing from any state
- **WHEN** the Pull request pane shows the branch's pull request, a picked one, or the branch's no-pull-request state
- **THEN** its header's Browse pull requests control opens the pull request list
