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
- **THEN** a top row pinned while the pane scrolls holds the state and the review decision (the number is in the pane header), and below it the title and one status line (the checks count and the first merge blocker) sit above the summary's actions, followed by the full-width `Details` row
- **AND** the review decision is never cut: `Open` and `Changes requested` fit one line in a 300px sidebar, and in a narrower one the decision wraps under the state
- **AND** whenever what the pane says changes (the pull request, the status, the review decision, the pending count, an update on GitHub, or the fake's Reset data), the pane starts at its top, so its title row is in view
- **AND** the pinned top row covers the pane from its top edge: nothing scrolled shows above it, with Details open or closed

#### Scenario: The pane on touch fills the Files tab
- **WHEN** the Pull request pane is the expanded pane of touch mode's accordion
- **THEN** its details start open, so the pane's height holds the pull request's readiness, checks, reviewers, branches and stats instead of empty space, and the Details row still folds them
- **AND** with less to show than the room (Details folded, no pull request, no credential) the pane is as tall as its content and the folded panes' headers follow right under it, leaving no blank stretch inside the pane
- **AND** the title shows at most its clamped lines (two on touch, a viewed pull request's too), a clipped extra line never shows, a one-line title leaves no gap under it, its full text is its tooltip, and its tap box is still at least 44px tall

#### Scenario: The pane's header on touch
- **WHEN** the viewer has 1 pending comment and the Pull request pane's header shows on a phone
- **THEN** its pending count is a compact `✎ 1` pill, not stretched to the row's height, with a 44px tap box around it

#### Scenario: Refreshing by keyboard
- **WHEN** the user presses Enter on the pane's Refresh
- **THEN** focus stays on Refresh while it runs and after the pane re-renders; while busy it says so without being disabled

#### Scenario: A stale error tooltip goes
- **WHEN** reading the pull request failed (no credential) and the header's tooltip said why, and GitHub then answers
- **THEN** the tooltip is gone once fresh data arrives or the status changes

#### Scenario: The pending review stays in sight in every state
- **WHEN** the viewer has 1 pending comment on #642 and the pane turns to no pull request for the branch, no credential, or GitHub unreachable
- **THEN** the pane still says `#642: 1 pending comment` on one line (its link named `Your review of #642`) with a link to its Files changed, wherever the count is known on the page

#### Scenario: A viewed pull request on a short screen
- **WHEN** a viewed pull request with a pending comment is shown in the expanded Pull request pane on an 844×390 touch phone
- **THEN** the pane carries no note of its own (the switcher button in the bar says `#639`, and the way back is in the switcher) and the pending note keeps to `Finish your review before merging.`, so Finish review (1) and Merge on GitHub are inside the pane without scrolling; their full words stay their accessible text

#### Scenario: The way back stays in reach
- **WHEN** a viewed pull request is shown in the Pull request pane and the pane is scrolled to its end, or Details is opened, on a desktop or a touch device
- **THEN** the way back is outside the pane, never scrolled with it: the switcher chip's `Viewing #639 · ← Back` line on a desktop, and the Viewing strip at the top of the Files tab on touch
- **AND** Back is at least 24px tall on a desktop and 44px on touch, and is hit at its centre

#### Scenario: No row is cut at the pane's bottom
- **WHEN** the pane is at its default height, with Details closed or open
- **THEN** its bottom edge falls between rows: a row that would be cut is left wholly below it, and the pixels go to another pane

#### Scenario: The Details row
- **WHEN** the pane shows an open pull request blocked twice, with 5 checks and 2 reviewers
- **THEN** under the actions a full-width row reads `Details`, then muted `Blockers, 5 checks, 2 reviewers`, then a chevron; it is a button with `aria-expanded` and `aria-controls`, at least 44px tall on touch, and a bordered button on desktop that stays marked while its panel is open
- **AND** it never cuts its words: in a 300px sidebar its summary wraps rather than ending in an ellipsis
- **AND** on a touch screen 500px tall or less, which has the width and not the height, it fills the rest of the actions' line instead of a line of its own

#### Scenario: The details are separated and easy to read
- **WHEN** the details are open, on a 390×844 or 844×390 touch phone or a 1440×900 desktop, in the light or the dark theme
- **THEN** they are four separate cards, in this order: `Merge readiness` (each reason a row with an attention mark, the verdict like `2 blockers` at the heading's right, the merge notes muted under them), `Checks` (one row per check: glyph, name, its time at the right; the counts at the heading's right), `Reviewers` (avatar, login, state badge at the right; `1 of 2 approved` at the heading's right) and `Branch and stats` (Branches, Changes with the files link, Author and Repository, each a muted label with its value at the right)
- **AND** headings are sentence case, not uppercase; rows in a card are divided by hairlines; and every text in them keeps a contrast of at least 4.5:1 against its card

#### Scenario: Opening the details
- **WHEN** the user expands the details on a desktop at 1440×900, the Pull request, Change Overview and Files panes shown
- **THEN** the details float beside the pane, level with the Details row (moved up as far as it takes to show them whole), as one panel holding the four cards, whole and hit where they show; the pane's summary and actions stay in view, and the panel scrolls on its own only when the window is too short for it
- **AND** Escape closes it with focus back on Details, and so does a click outside it; a click on one of the pane's controls (Review) both closes it and reaches that control, so the review dialog opens on the first click
- **AND** it is the same floating panel whatever GitHub's status: over stale data (rate-limited, unreachable) it is opaque and on top of the preview, and only the pane's rows are dimmed
- **AND** on touch, where the expanded pane takes the Files tab, the details open in the pane itself; the title stays in view, and the pane scrolls only as far as keeps the title below the pinned top row and its bottom edge between rows

#### Scenario: One review button
- **WHEN** the viewer has no pending review on the shown pull request
- **THEN** the summary's review action is one button, `Review`, as in the pull request view's tabs row; it opens the review dialog (the verdict with nothing preselected, the summary, the pending comments, and `Add line comments`)
- **AND** with 2 pending comments it reads `Finish review (2)` everywhere and opens the same dialog
- **AND** a manual ↻ that GitHub answers shows `Updated just now` beside the number for a few seconds, and says it to screen readers

#### Scenario: Links to GitHub say they open a new tab
- **WHEN** a screen reader reaches `Merge on GitHub ↗`, Open on GitHub, or another link that opens GitHub in a new tab
- **THEN** its name ends with `(opens in a new tab)`

### Requirement: Merge readiness is shown read-only, and merging happens on GitHub
Uatu MUST NOT merge pull requests. For a shown pull request it SHALL say, read-only, whether GitHub would merge it now and every reason it would not, beside the checks and review state, the allowed merge methods and branch deletion. It SHALL link to the pull request on GitHub: a prominent `Merge on GitHub ↗` while GitHub would merge it, else a secondary `View on GitHub ↗`. When the viewer has pending review comments on the pull request, it SHALL say so before the link.

#### Scenario: Ready to merge
- **WHEN** an open pull request has its required reviews and passing checks, and no conflicts
- **THEN** the summary says it is ready to merge on GitHub and highlights `Merge on GitHub ↗`

#### Scenario: Blocked
- **WHEN** GitHub would refuse the merge because a required check is still running and a review is missing
- **THEN** the summary shows the first reason with a count of the rest, its details list both reasons, and the link is a secondary `View on GitHub ↗` that opens the pull request on GitHub

#### Scenario: Changes requested and approvals missing
- **WHEN** a reviewer requests changes on a pull request whose base requires 2 approving reviews and has 1
- **THEN** the reasons list both `Changes were requested; that reviewer must approve.` and `main requires 2 approving reviews.`: one blocker never hides another

#### Scenario: Last known readiness while GitHub can't be asked
- **WHEN** GitHub is rate-limited or unreachable while a pull request's readiness is shown
- **THEN** the conversation's merge box and the pane's status line qualify it in place, like `Last known: ready to merge · as of 09:41` or `Last known: blocked · as of 09:41` (short: the reasons are the bullets under it, not repeated in the heading), dimmed, and the link is the secondary `View on GitHub ↗`
- **AND** the pane says the readiness once: its status line, with the reasons and merge notes under Details' `Merge readiness`

#### Scenario: Pending comments
- **WHEN** the viewer has 2 pending review comments on the pull request
- **THEN** the readiness says `You have 2 pending comments — finish your review before merging on GitHub.`

#### Scenario: Merged elsewhere
- **WHEN** the pull request was merged on GitHub
- **THEN** the next refresh shows it as Merged, and no local branch, remote-tracking ref or worktree is touched

### Requirement: Open pull requests can be listed
The workspace SHALL list the resolved repository's open pull requests in the workspace switcher's Pull requests section, newest update first, bounded to the first 100 with a link to GitHub for the rest. Each row SHALL show number, title, author, the draft or fork flag, the checks rollup and the review state, and the list SHALL be filterable by text and by state. There is no separate pull request picker.

#### Scenario: Listing open pull requests
- **WHEN** the user opens the switcher in a workspace that serves GitHub data
- **THEN** Pull requests loads and shows each open pull request as a two-line row: `#number title`, then author, `Draft` or `Fork`, checks and review state

#### Scenario: Filtering the list
- **WHEN** the user types `login` into the switcher's search field
- **THEN** only pull requests whose number, title, author, or head branch matches remain

#### Scenario: Filtering by menu
- **WHEN** the user chooses `Review requested` in the `Open ▾` menu with Enter or a tap
- **THEN** the list keeps the pull requests that request the viewer's review, the heading's control reads `Review requested ▾`, and focus returns to it

#### Scenario: More than 100 open pull requests
- **WHEN** the repository has 140 open pull requests
- **THEN** `Show all` lists the 100 most recently updated and a link to the rest on GitHub

#### Scenario: Opening the list from the Pull request pane
- **WHEN** the user activates the Pull request pane's search control, or `Browse pull requests…` in its no-pull-request state
- **THEN** the switcher opens with its Pull requests section in view (on a desktop, focus in its search field)
- **AND** the worktree menu has no `From a pull request…` item: the Pull requests list replaces it

#### Scenario: Arrow keys from the search field
- **WHEN** the search field is empty, no row is active, and the user presses ArrowUp (or ArrowDown)
- **THEN** the last row (or the first) of the switcher's lists becomes active, and further presses move one row, wrapping at both ends

#### Scenario: Finding a merged or closed pull request by number
- **WHEN** the user types `#642` or pastes the pull request's URL, and #642 is merged
- **THEN** the switcher says #642 is merged, so it isn't in the open list, after looking it up in any state, and shows it as the one result, whose row views it here

#### Scenario: Typing a number looks it up once
- **WHEN** the user types `6`, `3`, `0` (looking for #630, which isn't open)
- **THEN** nothing is looked up and nothing says "not found" while an open pull request matches what is typed, or until typing pauses (about 400ms) or Enter is pressed; then #630 alone is looked up

#### Scenario: A number or URL naming an open pull request
- **WHEN** the user types `642` or pastes #642's URL, and #642 is open
- **THEN** #642's row is the active row, and Enter acts on it

#### Scenario: A URL for another repository
- **WHEN** the user pastes `https://github.com/someone/else/pull/642` in a workspace of `octo-org/uatu`
- **THEN** the switcher says `This link is for someone/else, not octo-org/uatu.`, looks nothing up and offers no action; hosts, owners and names compare case-insensitively

#### Scenario: A number that doesn't exist
- **WHEN** the user types `#99999` and GitHub has no such pull request
- **THEN** one sentence says `There's no pull request #99999 in octo-org/uatu.`

#### Scenario: Listing without a credential
- **WHEN** the user opens the switcher while GitHub isn't connected for the workspace
- **THEN** Pull requests is one line of guidance with `Open Hub Settings → Credentials` (outside a Hub, the `gh auth login` step), and no filter or pull request rows

### Requirement: The pull request view renders the description and conversation
The pull request view SHALL render the description and the conversation in time order: comments, submitted reviews with their bodies, and review threads with their file path, resolved and outdated flags, and replies. All GitHub-authored Markdown SHALL be rendered with the same sanitizer used for documents. Large conversations SHALL be bounded with a link to GitHub.

#### Scenario: Opening the pull request view
- **WHEN** the user opens the detected pull request from its summary
- **THEN** the view shows the title, state, description, and conversation

#### Scenario: A review thread's summary
- **WHEN** a review in Conversation lists its threads
- **THEN** each says its file, its line, Resolved or Unresolved and its reply count (`1 reply`, `2 replies`); a thread with only its first comment says no count at all, never `0 replies`

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
- **AND** `View in diff →` on a thread summary and the ready state's `Merge on GitHub ↗` keep at least 4.5:1 contrast in light and dark themes
- **AND** the state badges' white text (`Open`, `Merged`, `Closed`, `Draft`) and the green `+N` addition counts, file headers included, keep at least 4.5:1 contrast in light and dark themes

### Requirement: The pull request view is addressable by URL
The pull request view SHALL have a same-origin URL naming the pull request number (`?pr=<n>`), and the repository only when it is not the workspace's first Git repository. URLs that name the repository SHALL keep working. Direct arrival, refresh, and browser Back/Forward SHALL restore it, and an unresolvable URL SHALL show why the pull request is unavailable rather than an unrelated document.

#### Scenario: A pull request of another of the workspace's repositories
- **WHEN** the workspace has two Git repositories and a URL names the second with `?repository=<id>&pr=12`
- **THEN** that repository becomes the page's pull request repository, as the switcher's repository selector makes it, and #12 is read from it

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

#### Scenario: A viewed pull request without a credential
- **WHEN** GitHub isn't connected and the user opens `?pr=639`
- **THEN** the header still names `Pull request #639` (`#639 · <owner>/<repo> · GitHub not connected`), the main card gives the full guidance to connect GitHub, and the Pull request pane says it in one short line with a link to connect, so the message is said once

#### Scenario: A thread's place survives reload and Back / Forward
- **WHEN** the reviewer chooses `View in diff →` on a thread in Conversation, then reloads, or goes Back to Conversation and Forward again
- **THEN** the URL names the thread (`?pr=642&tab=files&thread=<id>`), and each time Files changed opens scrolled to that thread with focus on it, clear of the pinned header
- **AND** a Jump to file choice updates the URL's `file=` in place, so a reload lands on that file

#### Scenario: Another pull request in the repository
- **WHEN** the URL names a pull request other than the checked-out branch's
- **THEN** it is shown with its full review: conversation comments, and inline comments and replies on its Files changed, which renders GitHub's own diff of that pull request rather than this checkout
- **AND** when served by a Hub, an offer to open it in its own worktree

### Requirement: A viewed pull request is what Files and Preview show
Choosing **View here** for a pull request SHALL make it what Files and Preview show without fetching or checking anything out: the Pull request pane and the pull request view SHALL show it, and the Files pane SHALL list its changed files as a tree with review marks and line counts. The terminal and agent stay on the checkout. Viewing SHALL be page-local and restored by the pull request view's URL, and one control, **← Back to `<branch>`**, SHALL return Files and Preview to the checkout.

#### Scenario: Viewing another pull request
- **WHEN** the user views pull request #639 while `feat/view-pr` (#642) is checked out
- **THEN** the Pull request pane shows #639's summary, with no note of its own
- **AND** the Files pane's heading reads `PR #639 files`, and it lists #639's changed files under a scope bar holding `PR #639` and #639's title (up to two lines on touch) in place of the workspace tree
- **AND** Change Overview's label reads `⎇ feat/view-pr`, its tooltip saying it describes the local branch, not #639
- **AND** the same label, reading `Local branch`, marks Change Overview whenever its comparison isn't the shown pull request's diff: uncommitted changes, a checked-out commit other than the pull request's head, or Since last commit

#### Scenario: The Files options act on the workspace tree only
- **WHEN** a viewed pull request's files are shown in the Files pane
- **THEN** the Files options (ignored files, file types) and the tree's filters are hidden, so nothing changes the workspace tree out of sight, and they are back with the workspace tree

#### Scenario: One file order everywhere
- **WHEN** a pull request changes `README.md`, `docs/pr-review.md` and `docs/hub.md`
- **THEN** the Files pane's pull request scope, Files changed and its Jump to file list all show `docs/hub.md`, `docs/pr-review.md`, then `README.md`: tree order, folders before files at every level, then by name

#### Scenario: Opening a file from the pull request scope
- **WHEN** the user picks a file in the Files pane's pull request scope
- **THEN** the pull request view opens on Files changed, scrolled to that file's diff, and the URL names the file

#### Scenario: Returning to the checked-out branch
- **WHEN** the user chooses `← Back to feat/view-pr`
- **THEN** the pane shows the branch's pull request (or its no-pull-request state), the Files pane shows the workspace tree, and a preview of the viewed pull request gives way to the branch's own

#### Scenario: Touch mode
- **WHEN** the user views a pull request on a touch device
- **THEN** the Preview tab comes forward with the pull request's conversation, the Files tab lists its files one tap away, and picking a file there brings the Preview tab back with that file's diff

#### Scenario: One way back
- **WHEN** a viewed pull request is shown
- **THEN** the only notice is the Viewing strip, `Viewing #639` with `← Back to feat/view-pr`: at the top of the Files and Preview tabs on touch, and on a desktop the switcher chip's second line (the preview shows the strip only while the sidebar is collapsed)
- **AND** the Pull request pane, the Files scope bar and the preview header carry no Picked note, chip or Back of their own

#### Scenario: Focus after viewing a pull request
- **WHEN** the user views a pull request from the switcher, including from a simulated worktree's result, or opens one from the pane while the preview is out of sight (a narrow window stacking the sidebar above the preview, or touch mode's Files tab)
- **THEN** the preview comes into view and its heading takes focus

### Requirement: Only another pull request counts as viewed, and the list is always at hand
Only a pull request other than the checked-out branch's own SHALL count as viewed. The Pull request pane SHALL offer a way to the repository's pull requests whatever it shows.

#### Scenario: The branch's own pull request is never viewed
- **WHEN** the pull request view shows #642, whose head is the checked-out branch, and GitHub later reports no pull request for the branch
- **THEN** #642 is not labelled as viewed
- **AND** the view says GitHub links no pull request to the branch and #642 is shown only because the address names it

#### Scenario: Browsing from any state
- **WHEN** the Pull request pane shows the branch's pull request, a viewed one, or the branch's no-pull-request state
- **THEN** its header's search control opens the switcher at Pull requests
