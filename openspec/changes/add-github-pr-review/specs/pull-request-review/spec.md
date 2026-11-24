## Purpose

Lets a reviewer take part in a GitHub pull request's review from Uatu: comment on the conversation, comment on diff lines and reply to threads in a pending review, and submit that review, with every comment landing on the line the reviewer saw.

## ADDED Requirements

### Requirement: Reviewers can add conversation comments
The pull request view, for the checked-out branch's pull request or any other open one, SHALL offer a composer that posts a top-level comment to the pull request's conversation. The comment SHALL appear in the conversation after a successful post without a page reload. A failed post SHALL keep the draft text and show the reason.

#### Scenario: Posting a comment
- **WHEN** the reviewer writes `Looks good after the rename` and activates Comment
- **THEN** GitHub receives that comment on the pull request and the view shows it in the conversation
- **AND** the composer is back on an empty Write tab with focus in it, even when it was posted from Preview

#### Scenario: Previewing a long draft
- **WHEN** the reviewer previews a 10,000-character draft with no spaces
- **THEN** the preview wraps it and scrolls inside a bounded height, and the composer's actions stay right below it

#### Scenario: Posting fails
- **WHEN** GitHub refuses the comment or cannot be reached
- **THEN** the composer keeps the text and shows the reason, and nothing is shown as posted

### Requirement: Inline comments and replies accumulate in a pending review
New inline comments and replies to existing review threads SHALL be added to the viewer's pending review on GitHub, creating one if none exists. Pending comments SHALL be shown as pending, SHALL survive reloads, and SHALL be the same pending review the viewer sees on github.com. The reviewer SHALL be able to delete a pending comment.

#### Scenario: First inline comment starts a pending review
- **WHEN** the viewer has no pending review and adds an inline comment
- **THEN** a pending review is created on GitHub at the pull request's head commit and holds that comment
- **AND** Uatu shows that a pending review with one comment exists

#### Scenario: Pending review started on github.com
- **WHEN** the viewer already has a pending review with two comments created on github.com
- **THEN** Uatu shows both comments as pending and adds new comments to the same review

#### Scenario: Replying to a thread
- **WHEN** the reviewer replies to an existing review thread
- **THEN** the reply is added to the pending review and shown as pending under that thread

#### Scenario: Deleting a pending comment
- **WHEN** the reviewer deletes one of their pending comments
- **THEN** it is removed from the pending review on GitHub and from Uatu

#### Scenario: Resolving a thread that holds a pending reply
- **WHEN** the reviewer resolves a thread under which their pending reply is shown
- **THEN** the thread stays expanded with the pending reply visible; only a thread without the viewer's pending or unsent text folds away

#### Scenario: Editing a pending comment where it is shown
- **WHEN** the reviewer edits a pending comment, in Files changed or in Finish review
- **THEN** the new text replaces it in the pending review on GitHub, and an unsaved edit survives a reload

### Requirement: A pending review stays in sight
The viewer's pending reviews on pull requests other than the one shown SHALL stay visible: the Pull request pane and each row of the open pull request list SHALL mark them with their comment counts, and leaving a pull request with pending comments SHALL say that its review is still pending and where it is marked.

#### Scenario: The review bar on a phone
- **WHEN** the reviewer has 2 pending comments in Files changed on a 390×844 touch device
- **THEN** the pinned review bar is one row: a `✎ 2` badge, Discard, and `Finish (2)`, whose accessible names are `Discard your pending review (2 comments)` and `Finish review (2)`, and the pull request tabs are at least 44px tall

#### Scenario: The review bar on Conversation
- **WHEN** the reviewer has a pending review and shows the Conversation tab
- **THEN** the same pending-review bar (count, Discard, Finish review (n)) is at the top of Conversation, pinned while it scrolls

#### Scenario: A phone in landscape
- **WHEN** the reviewer reads Files changed on an 844×390 touch device
- **THEN** the pull request's preview header scrolls away and only the review bar and the tab bar stay pinned, leaving the diff most of the screen

#### Scenario: Touch controls
- **WHEN** the pull request surfaces are shown on a touch device
- **THEN** every control in them is at least 44px tall (a link inside a sentence keeps its line height and gets a 44px tap box), and every text field, text area and select uses 16px text, so focusing one never zooms the page

#### Scenario: Leaving a picked pull request mid-review
- **WHEN** the reviewer adds an inline comment on picked pull request #639 and goes back to the checked-out branch
- **THEN** a notice says the review of #639 is still pending with 1 comment, and the pane and #639's row in the list mark it

### Requirement: Unsent text is kept until GitHub takes it
Every composer SHALL keep its unsent text across re-renders and reloads and ask before discarding changed text (Cancel, Escape, or a backdrop click). Several lines MAY hold unsent comments at once. Its saved draft SHALL be dropped exactly when GitHub accepts the text, before the page updates, and a saved draft that GitHub already holds SHALL NOT reopen as unsent.

#### Scenario: Opening another line keeps the draft
- **WHEN** the reviewer has unsent text on `docs/pr-review.md` line 9 and opens a comment on line 12
- **THEN** both composers are open, line 9's with its text, and focus is in line 12's; an empty composer elsewhere closes instead

#### Scenario: Finishing with unsent line comments
- **WHEN** the reviewer opens Finish review while a typed comment on `docs/pr-review.md` line 14 was never added to the review
- **THEN** the dialog names it and offers `Add it to the review` and `Leave it as a draft`, and Submit waits until one is chosen
- **AND** adding it puts it in the pending review and counts it in what Submit publishes; leaving it keeps it open as a draft in Files changed, unpublished

#### Scenario: Escape during an edit
- **WHEN** the reviewer changes a pending comment's text in Finish review and presses Escape
- **THEN** Uatu asks before discarding the edit, and keeping it leaves the dialog and the text open

#### Scenario: Reload after adding a comment
- **WHEN** an inline comment was added to the pending review and the page reloads
- **THEN** the comment shows as pending and no composer reopens with its text

### Requirement: Composed text stays within GitHub's limit
A body over GitHub's 65,536-character limit SHALL be refused while composing, with a counter near the limit and the reason sending is disabled.

#### Scenario: Too long
- **WHEN** the reviewer pastes 65,600 characters into a composer
- **THEN** sending is disabled with `Too long by 64 characters: GitHub takes at most 65,536.` before anything is sent

### Requirement: Write dialogs act only on the pull request on screen
A dialog that writes to a pull request SHALL close when the workspace stops showing that pull request, including through browser Back and Forward, keeping what was typed as a draft and saying why it closed. Each dialog SHALL open with focus on its safe choice, never on a button that publishes or creates; on touch devices it SHALL NOT focus a text field on open.

#### Scenario: Focus returns to the opener
- **WHEN** the reviewer opens Finish review from Files changed's review bar, or from the Pull request pane's button or header count, and presses Escape
- **THEN** focus returns to that same control, even when the bar or pane re-rendered while the dialog was open

#### Scenario: Back onto another pull request
- **WHEN** Finish review is open for #627 and the user presses Back onto #639
- **THEN** the dialog closes, its summary stays as a draft for #627, and a notice says the workspace now shows #639

### Requirement: The pull request view's Files changed takes inline comments for any pull request
Files changed in the pull request view SHALL render GitHub's own diff of the pull request (its base and head contents as GitHub serves them), so its line numbers are GitHub's by construction. It SHALL place current threads on their lines and offer new inline comments and replies for any open pull request, whether or not it is checked out here, with no check of the local checkout.

#### Scenario: Reviewing a pull request that is not checked out
- **WHEN** `feat/view-pr` is checked out and the reviewer opens pull request #639's Files changed and comments on added line 3 of `src/terminal/links.ts`
- **THEN** the comment joins the viewer's pending review on #639 at #639's head commit, right side, line 3

#### Scenario: Local changes do not block the pull request view
- **WHEN** the checked-out files have uncommitted changes or HEAD differs from the pull request's head
- **THEN** Files changed in the pull request view still offers inline comments, because it does not show the local files

#### Scenario: Files read apart on a phone
- **WHEN** Files changed is shown at phone width (390px)
- **THEN** each file is a full-width block with a tinted header and space before the next, threads are tinted cards, and pending comments carry the attention tint

#### Scenario: Start review leaves no row under the pinned header
- **WHEN** the reviewer taps Start review in the Pull request pane on a 390×844 touch device
- **THEN** Files changed opens from its top, right under the pinned preview header, with the first file's opening lines in view
- **AND** no row sits partly under the header

### Requirement: Inline comments are offered only where the diff is the pull request's diff
The per-document Diff view, which compares the local checkout, SHALL offer new inline comments on a file, and place review threads on its lines, only when the checkout's HEAD is the pull request's head commit, the file has no uncommitted changes, the compare target is `base`, and the diff is measured from the merge base of GitHub's base commit and the head commit. Otherwise it SHALL say why and list the file's threads above the diff.

#### Scenario: Diff matches the pull request
- **WHEN** HEAD is the pull request's head commit, the file is unmodified locally, and the compare target is `base` with the pull request's exact base
- **THEN** existing threads appear on their lines and the reviewer can start a comment on any added, deleted, or context line in the diff

#### Scenario: Local edits to the file
- **WHEN** the file has uncommitted changes
- **THEN** no new inline comment can be started on that file, the Diff view says local changes would move line numbers, and threads are listed above the diff rather than placed on lines

#### Scenario: Checkout behind the pull request
- **WHEN** HEAD is not the pull request's head commit
- **THEN** inline commenting is unavailable with an explanation naming the head commit, and the fetch pull request refs action is offered

#### Scenario: Last-commit target
- **WHEN** the compare target is `last-commit`
- **THEN** inline commenting is unavailable and the Diff view says to compare against the base to comment

#### Scenario: Outdated threads
- **WHEN** a thread is outdated on GitHub
- **THEN** it is listed above the diff as outdated and never placed on a current line

#### Scenario: Very large diff
- **WHEN** the file's diff falls back to the lightweight render
- **THEN** threads are listed above the diff and inline commenting is unavailable

### Requirement: Inline comments support lines, ranges, and both sides
An inline comment SHALL target one line or a contiguous range on one side of the diff. Added and context lines SHALL use the new file's line numbers on the right side; deleted lines SHALL use the old file's line numbers on the left side.

#### Scenario: Comment on an added line
- **WHEN** the reviewer comments on added line 18 of `src/app.ts`
- **THEN** GitHub receives a comment on path `src/app.ts`, right side, line 18

#### Scenario: Comment on a deleted line
- **WHEN** the reviewer comments on deleted line 7 of the old file
- **THEN** GitHub receives a comment on the left side, line 7

#### Scenario: Comment on a range
- **WHEN** the reviewer selects added lines 10 through 14 and comments
- **THEN** GitHub receives a comment with start line 10 and line 14 on the right side

### Requirement: The server refuses comments it cannot anchor
Every inline comment request SHALL name the pull request number and the head commit the client displayed. The server SHALL refuse it when that commit is no longer the pull request head, when the path is not in the pull request's changed files, or when the pending review was started on another commit. Only requests from the per-document Diff view SHALL also be checked against the local checkout. The refusal SHALL keep the draft text.

#### Scenario: Diff view request against a changed checkout
- **WHEN** an inline comment from the per-document Diff view names a commit that is not the local HEAD, or a file with local changes
- **THEN** the server refuses it and keeps the draft

#### Scenario: Pull request view request
- **WHEN** an inline comment comes from the pull request view's Files changed
- **THEN** the server checks it against the pull request's head, changed paths and pending review only, not the local checkout

#### Scenario: Pull request moved while composing
- **WHEN** a new commit is pushed to the pull request after the diff was displayed and the reviewer submits an inline comment
- **THEN** the server refuses with a conflict, nothing is posted, the draft is kept, and the reviewer is told to update the checkout

#### Scenario: Pending review on an older commit
- **WHEN** the viewer's pending review was started at an earlier head commit
- **THEN** new inline comments are refused with an explanation to submit or discard the pending review first, while replies to threads remain available

#### Scenario: Path outside the pull request
- **WHEN** a request names a path that is not among the pull request's changed files
- **THEN** the server refuses it without calling GitHub's write API

### Requirement: Reviewers submit or discard the pending review
The reviewer SHALL be able to submit the pending review as Comment, Approve, or Request changes with an optional summary, or discard it. Approve and Request changes SHALL be unavailable on the viewer's own pull request. Comment and Request changes without a summary SHALL require at least one pending comment.

#### Scenario: Approving
- **WHEN** the reviewer chooses Approve with summary `Ship it` and submits
- **THEN** GitHub records an approving review with that summary and every pending comment, and the pull request summary updates

#### Scenario: Own pull request
- **WHEN** the viewer is the pull request's author
- **THEN** Approve and Request changes are disabled with the reason, and Comment remains available

#### Scenario: The verdict lasts while the page does
- **WHEN** the reviewer chooses Approve, presses Escape, and opens Finish review again without leaving the pull request
- **THEN** Approve is still selected
- **AND** after a reload, a submitted review, or the workspace moving to another pull request, the dialog opens with no verdict selected

#### Scenario: A whitespace summary is not kept
- **WHEN** the reviewer types only spaces as the summary, cancels, and opens the dialog again
- **THEN** the summary is empty
- **AND** a summary with words in it is kept until the review is submitted

#### Scenario: Writes pause together
- **WHEN** GitHub's rate limit is reached, or GitHub is unreachable, while the reviewer has pending comments
- **THEN** Discard review, Finish review (n) and the Pull request pane's Finish review and pending count are all disabled, each naming the reason, and the reason is shown beside them
- **AND** composers stay open for drafting, and Start review still opens Files changed

#### Scenario: Pending comments name their side and code
- **WHEN** the reviewer has pending comments on the old and the new side of line 1 of `links.ts`
- **THEN** Finish review lists them as `links.ts:1 (old)` and `links.ts:1 (new)`, each with its line's code on one line, and the Files changed cards say `Line 1 (old)` and `Line 1 (new)`

#### Scenario: Empty request for changes
- **WHEN** the reviewer chooses Request changes with no summary and no pending comments
- **THEN** Submit is disabled until a summary is written

#### Scenario: Discarding
- **WHEN** the reviewer discards the pending review and confirms
- **THEN** the pending review and its comments are deleted on GitHub and removed from Uatu

### Requirement: Actions are attributed to the credential's GitHub account
Every write SHALL be performed as the GitHub account that owns the workspace's credential. Write controls SHALL show that account's login before the action, including in a Hub shared by several users.

#### Scenario: Composer shows who is commenting
- **WHEN** the workspace credential belongs to GitHub user `octocat`
- **THEN** each composer and the submit dialog say the action is posted as `@octocat`

#### Scenario: Read-only permission
- **WHEN** the account can read the repository but GitHub reports it may not comment or review
- **THEN** write controls are disabled with GitHub's reason and reading remains available

### Requirement: Write routes are protected requests
GitHub write routes SHALL accept only authenticated, same-origin POST or DELETE requests to the workspace, SHALL validate every field before calling GitHub, and SHALL bound comment and review text to GitHub's limits.

#### Scenario: Cross-origin write
- **WHEN** a page on another origin sends a cookie-authenticated request to a GitHub write route
- **THEN** the request is rejected before it reaches GitHub

#### Scenario: Malformed input
- **WHEN** a request has a non-integer line, an unknown side, or a body over the limit
- **THEN** the server answers 400 without calling GitHub
