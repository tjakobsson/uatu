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

#### Scenario: Said before typing
- **WHEN** the reviewer reaches the conversation's composer on #642
- **THEN** its placeholder reads `Comment on #642 — posts immediately`, and its name says it posts as the viewer at once, unlike line comments, which wait for the review

#### Scenario: Posting fails
- **WHEN** GitHub refuses the comment or cannot be reached
- **THEN** the composer keeps the text and shows the reason, and nothing is shown as posted

### Requirement: Inline comments and replies accumulate in a pending review
New inline comments and replies to existing review threads SHALL be added to the viewer's pending review on GitHub, creating one if none exists. Pending comments SHALL be shown as pending, SHALL survive reloads, and SHALL be the same pending review the viewer sees on github.com. The reviewer SHALL be able to edit and delete a pending comment or reply, and to resolve and unresolve a review thread.

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

#### Scenario: A resolved thread folds at once
- **WHEN** the reviewer resolves a thread with no pending reply and no reply text
- **THEN** it folds the moment Resolve is pressed, and unfolds again with the reason if GitHub refuses
- **AND** for a few seconds its folded footer says `Resolved on GitHub just now.` with focus on `Undo` (named `Undo: unresolve conversation on <path> line <n> (applies now)`), which unresolves it; then the footer reads `Conversation resolved.` and the same button, still focused, reads `Unresolve`

#### Scenario: Editing a pending comment where it is shown
- **WHEN** the reviewer edits a pending comment or a pending reply, in Files changed or in Finish review
- **THEN** the new text replaces it in the pending review on GitHub, and an unsaved edit survives a reload
- **AND** a pending reply under its thread has its own Edit and Discard, as a pending line comment does
- **AND** ⌘/Ctrl+Enter saves the edit, in Finish review as in the composers
- **AND** the text field opens with the caret after the comment's text, so typing appends; the same holds for every field that opens with text (a restored draft, the review summary)

### Requirement: A pending review stays in sight
The viewer's pending reviews on pull requests other than the one shown SHALL stay visible: the Pull request pane and each row of the open pull request list SHALL mark them with their comment counts, and leaving a pull request with pending comments SHALL say that its review is still pending and where it is marked.

#### Scenario: The review button on a phone
- **WHEN** the reviewer opens a pull request on a 390×844 touch device
- **THEN** the one review button is in the pull request's tabs row, pinned with it, on Conversation and on Files changed: `Review`, or with 2 pending comments a `✎ 2` badge and Finish, named `Finish review (2)`; no separate review band takes the diff's rows, and the pull request tabs are at least 44px tall
- **AND** Discard review is in the review dialog, beside its pending comments

#### Scenario: The review button on a desktop
- **WHEN** the reviewer opens a pull request on a desktop
- **THEN** the same one review button is in the header's tabs row, beside the tabs, on Conversation and on Files changed alike; no other review button is in the pull request view (the Pull request pane keeps its own)
- **AND** Files changed's bar above the files keeps the how-to, and while a review is pending its count and Discard review, pinned

#### Scenario: The review bar on Conversation
- **WHEN** the reviewer has a pending review and shows the Conversation tab on a desktop
- **THEN** a pending-review bar (count and Discard review) is at the top of Conversation, pinned while it scrolls, under the header's Finish review

#### Scenario: A phone in landscape
- **WHEN** the reviewer opens Files changed on an 844×390 touch device
- **THEN** the pull request's header is one slim pinned row: the number and title (up to two lines), the tabs, the review button (`Review`, or the pending count and Finish), Open on GitHub, Jump to file and the text size buttons
- **AND** the tab bar is a slim row of icons (40px, each tab's tap box still 44px, its label still its name), and at least 10 lines of the first file's diff show without scrolling
- **AND** while the files scroll only that header row, the current file's header (40px, its buttons keeping 44px tap boxes) and the tab bar stay pinned: at most 100px over the diff

#### Scenario: Files changed on a phone in portrait
- **WHEN** the reviewer opens Files changed on a 390×844 touch device
- **THEN** the first diff line is within the top 40% of the screen: the header is a title row (`#642`, then the title in up to two lines, a tap showing the rest, with Open on GitHub and the text size buttons at its end), then the tabs row with no frame around the 44px tabs; a viewed pull request has the one Viewing strip above the header and no chip in it. Files changed leaves out the state / author / branches band that Conversation shows, no review band takes a row, and the counts and base ← head are one line
- **AND** while the files scroll, the title row scrolls away with no sliver left, and only the tabs row (the tabs, the review button and Jump to file), the current file's header and the tab bar stay pinned: at most 120px over the diff

#### Scenario: One file header pinned at a time
- **WHEN** the reviewer scrolls Files changed through every file, on a 390×844 or 844×390 touch device or a 1440×900 desktop
- **THEN** at every position exactly one file header is pinned, flush under the pinned tabs row (or an active review bar), and each file's header pins only within its own file: leaving with its file, it slides under the tabs row, which always paints over it, so no header is drawn over the tabs and no two headers stack in the pinned place

#### Scenario: The touch how-to hint folds away
- **WHEN** Files changed opens on a touch device for the first time
- **THEN** the files toolbar carries a one-line hint, `Tap a line to comment on it.`, with a button that folds it to a `?` icon, and each file's header has a `Comment` button whose label shows beside its icon
- **AND** it folds on its own once the reviewer has started (a pending comment or an open composer) or scrolled the files, and stays folded on that device; the icon opens it again on that page

#### Scenario: A tap on a line opens its composer
- **WHEN** the reviewer taps anywhere on a diff line's row in Files changed on a touch device (not a drag, not a long press that selects text, not a comment card)
- **THEN** that line's composer opens, as a tap on its line number does, while the number column stays compact
- **AND** the row is the target in touch mode however it was entered: on a coarse pointer, and on a fine pointer with touch mode chosen in the layout toggle

#### Scenario: The tab bar steps aside while composing
- **WHEN** a pull request composer's text area has focus on a touch device, in portrait or landscape
- **THEN** the bottom tab bar is hidden, so the soft keyboard leaves the composer room, and what keeps controls clear of the bar (the page's bottom scroll padding, the composer's in-view check, the toasts) no longer counts it
- **AND** it comes back when the text area loses focus

#### Scenario: Touch controls
- **WHEN** the pull request surfaces are shown on a touch device
- **THEN** every control in them is at least 44px tall (a link inside a sentence keeps its line height and gets a 44px tap box), and every text field, text area and select uses 16px text, so focusing one never zooms the page
- **AND** no two controls share a name: the composer's Write / Preview tabs are named `Write comment` and `Preview comment`, apart from the tab bar's Preview

#### Scenario: The desktop how-to names the keys
- **WHEN** Files changed shows its idle review bar on a desktop
- **THEN** it says how to comment with the mouse (click a line number, or hover a line and click `+`) and with the keyboard (Tab to a file's line numbers, the arrow keys, then Enter)

#### Scenario: Leaving a viewed pull request mid-review
- **WHEN** the reviewer adds an inline comment on viewed pull request #639 and goes back to the checked-out branch
- **THEN** a notice says the review of #639 is still pending with 1 comment, and the pane and #639's row in the switcher (`✎ 1 pending`) mark it

### Requirement: Unsent text is kept until GitHub takes it
Every composer SHALL keep its unsent text across re-renders and reloads and ask before discarding changed text (Cancel, Escape, or a backdrop click). Several lines MAY hold unsent comments at once. A saved draft SHALL be dropped exactly when GitHub accepts the text, before the page updates; after a reload it SHALL count as sent only when a matching comment appeared after its send began.

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

#### Scenario: Escape anywhere in a line composer
- **WHEN** focus is on a line composer's line picker, its Cancel or another of its controls and the reviewer presses Escape
- **THEN** the composer closes as Cancel does, asking first when it holds text
- **AND** focus goes back to what opened it: `Comment on a line in <path>`, else the line's number (for a click or tap on the number or its row), never the diff as a whole

#### Scenario: Reload after adding a comment
- **WHEN** an inline comment was added to the pending review and the page reloads
- **THEN** the comment shows as pending and no composer reopens with its text

#### Scenario: The same words again are a new draft
- **WHEN** the reviewer posts a conversation comment, types the same text again without sending it, and reloads
- **THEN** the composer reopens with that text; the same holds for a line comment or a reply repeated on the same line or thread

#### Scenario: A draft left out stays left out
- **WHEN** the reviewer chooses `Leave it as a draft` in Finish review, closes the dialog and opens it again
- **THEN** the dialog doesn't ask about that draft again and Submit is available, until the draft's text changes; the choice lasts while the page shows the pull request

#### Scenario: The composer's note follows the review
- **WHEN** a line composer is open while the review is submitted (or a comment is added elsewhere)
- **THEN** its note says what is pending now: `Starts your review…` once nothing is pending, never the old count

### Requirement: Composed text stays within GitHub's limit
A body over GitHub's 65,536-character limit SHALL be refused while composing, with a counter near the limit and the reason sending is disabled.

#### Scenario: Too long
- **WHEN** the reviewer pastes 65,600 characters into a composer
- **THEN** sending is disabled with `Too long by 64 characters: GitHub takes at most 65,536.` before anything is sent
- **AND** Preview says the same at once, without asking the server to render it

### Requirement: Write dialogs act only on the pull request on screen
A dialog that writes to a pull request SHALL close when the workspace stops showing that pull request, including through browser Back and Forward, keeping what was typed as a draft and saying why it closed. Each dialog SHALL open with focus on its safe choice, never on a button that publishes or creates; on touch devices it SHALL NOT focus a text field on open.

#### Scenario: Focus returns to the opener
- **WHEN** the reviewer opens Finish review from the tabs row's review button, or from the Pull request pane's button or header count, and presses Escape
- **THEN** focus returns to that same control, even when the bar or pane re-rendered while the dialog was open

#### Scenario: Focus after submitting a review
- **WHEN** the reviewer submits a review from the tabs row's review button (on Conversation or Files changed) or the Pull request pane, on a desktop or a touch device
- **THEN** a live region announces the confirmation (the verdict and what was published), and focus goes back to the control the dialog was opened from, else a stable control where it was: the tabs row's review button (now `Review`) or the shown tab, or the pane's review button; focus never moves from the preview to the sidebar or back; nothing scrolls
- **AND** a short toast shows the same words without ever taking focus or taps, and goes on its timeout; on a short touch screen it is a compact line over the pinned header, never over the diff

#### Scenario: Dialogs on a short touch screen
- **WHEN** Finish review opens on an 844×390 touch phone in landscape
- **THEN** the dialog has one scrolling body and a one-row footer at most 64px tall, the why-not line in the attribution's place while it has something to say
- **AND** every control (the summary, each verdict, each button) is hit at its centre once scrolled into view, never under the footer
- **AND** the review dialog's three verdicts come first, right under its pinned head (the number and the title on one line), one compact 44px row each, all in view without scrolling; the summary and the pending list follow

#### Scenario: Focus never under a dialog's footer
- **WHEN** the reviewer opens Finish review on a 390×844 phone, edits a pending comment and presses Tab to reach Save
- **THEN** Save scrolls into view above the pinned footer, in portrait and in landscape alike: the dialog's scroll padding is its footer's height

#### Scenario: The review dialog keeps its head in view
- **WHEN** the reviewer scrolls the review dialog, or chooses `Add it to the review` for an unsent comment on a 390×844 phone
- **THEN** the dialog's head (`Finish your review · #642` and the title line) stays pinned at its top, the dialog keeps its place instead of jumping to the focused control, and nothing focused or scrolled to lands under the head

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
- **AND** at 320px the idle review bar's actions stack inside the bar, and the page never scrolls sideways

#### Scenario: Switching to touch mode wraps the diff
- **WHEN** Files changed is shown in desktop mode at 390px, its long lines scrolling sideways, and the user switches to touch mode
- **THEN** the mounted diffs re-render wrapped, without a reload, and the review state moves to the tabs row

#### Scenario: Wrapped code keeps its indentation
- **WHEN** Wrap is on and an indented line is too long for its row (#636's `src/shell/state.test.ts` lines 2 and 7 at 390px), in Files changed or in the document Diff view
- **THEN** the first row holds the indentation and the text after it, never the indentation alone, and continuation rows start 2ch right of where the first row's text starts

#### Scenario: Resolving says it applies now
- **WHEN** the reviewer reaches a thread's Resolve (or Unresolve) button
- **THEN** its tooltip and accessible name say it applies on GitHub at once, not with the pending review
- **AND** on touch, where no tooltip shows, a small `Applies now` stands beside it

#### Scenario: Add line comments from the review dialog
- **WHEN** the reviewer opens the review dialog from any review button, types a summary, chooses a verdict and chooses `Add line comments`
- **THEN** the dialog closes, keeping the summary and the verdict as drafts, and Files changed opens from its top, right under the pinned preview header, with a comment composer on the first file's first non-blank changed line (an added one when there is one), focus in its text so typing goes there, and the line picker one Shift+Tab back
- **AND** no row sits partly under the header, Cancel or Escape on the empty composer closes it with nothing written, and the review dialog opens again with the summary and verdict as they were left
- **AND** there is no separate `Start review` or `Review without line comments…` control: one `Review` button opens the dialog everywhere

#### Scenario: Each file's header
- **WHEN** Files changed lists a file
- **THEN** its header is one row, pinned while the file's diff scrolls: a toggle that folds the diff (the path, shortened from its start so the file name stays, the line counts and review marks), then `Comment on a line in <path>`: an icon with a tooltip on desktop, an icon and a visible `Comment` label on touch, at least 44×44
- **AND** it opens a composer on the file's first non-blank changed line with focus on its line picker, and no separate row holds the action
- **AND** before it, `View <path> at the pull request's head` (an icon on desktop, an icon and `View` on touch, at least 44×44) opens the file view on that file

#### Scenario: The file view's Diff is Files changed for one file
- **WHEN** the reviewer shows a file of the pull request in the file view's Diff
- **THEN** it is that file's Files changed: GitHub's diff, its threads, the gutter `+`, line taps, Comment on a line, the composer, pending comments and the review bar, with the same drafts as Files changed itself, and the same anchoring
- **AND** the file view's Rendered and Source never offer a composer: their threads bar's Show in Diff is the way to comment

#### Scenario: Jumping to a file
- **WHEN** the reviewer chooses Jump to file, the one button at the end of the pinned tabs row on Files changed (named `Jump to file (9 files)`; its words show on a desktop, its icon on touch)
- **THEN** a list of every file in tree order, with its counts and review marks, opens with the file being read marked current; choosing one scrolls to it and focuses its header, and Escape returns focus to the button
- **AND** a `Filter by path` field over the list keeps the files whose path contains every typed word (case-insensitive), saying so when none does; typing `pr-view` then Enter opens `src/preview/pr-view.ts`, the first match, and ↓ / ↑ move between the field and the rows
- **AND** the field takes focus when the list opens on a desktop, and not on touch, where it would raise the keyboard
- **AND** the file's header and its first lines land below everything pinned (the preview header or tabs row, an active review bar), on a phone and on a desktop; focus scrolling inside Files changed keeps the same clearance, a file's pinned header included

#### Scenario: A composer stays above the tab bar after rotating
- **WHEN** the reviewer is writing in an inline composer on a phone and rotates it
- **THEN** the composer and its actions are in view above the tab bar

#### Scenario: Composers on both sides of a line read apart
- **WHEN** composers are open on the old and the new side of line 1 in Split
- **THEN** their text areas are named `Comment on docs/pr-review.md:1 (old) as @octo-reviewer…` and `…:1 (new)…`, and the line picker names each line's side

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
The reviewer SHALL be able to submit the pending review as Comment, Approve, or Request changes, with a summary, or discard it. Approve and Request changes SHALL be unavailable on the viewer's own pull request. Request changes SHALL require a summary, as GitHub does; Comment without a summary SHALL require at least one pending comment; Approve takes an optional summary.

#### Scenario: The final button names the verdict
- **WHEN** the reviewer chooses a verdict in the review dialog
- **THEN** its final button reads `Publish approval` for Approve, `Request changes` for Request changes, and `Post comment review` for Comment (`Submit review`, disabled, before one is chosen)

#### Scenario: Discarding from the dialog
- **WHEN** the reviewer has pending comments and chooses `Discard review…` beside them in the review dialog, and confirms
- **THEN** the pending review is deleted from GitHub and the dialog stays open as `Review`, with nothing pending

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
- **AND** composers stay open for drafting, and Review still opens the review dialog, whose Add line comments opens Files changed

#### Scenario: Pending comments name their side and code
- **WHEN** the reviewer has pending comments on the old and the new side of line 1 of `links.ts`
- **THEN** Finish review lists them as `links.ts:1 (old)` and `links.ts:1 (new)`, each with its line's code on one line, and the Files changed cards say `Line 1 (old)` and `Line 1 (new)`

#### Scenario: Empty request for changes
- **WHEN** the reviewer chooses Request changes with no summary, with or without pending comments
- **THEN** Submit is disabled with `Say what needs to change in the summary.` until a summary is written, and the field reads `Summary (required)` with the placeholder `Say what needs to change (Markdown).`

#### Scenario: The summary says what it needs
- **WHEN** the reviewer has 1 pending comment and chooses Approve, then Comment
- **THEN** the field reads `Summary (optional)` for both, its placeholder `Optional: add a note to your approval (Markdown).`, then `Optional: your pending comment is published with it (Markdown).`, and Submit is enabled with an empty summary
- **AND** with nothing pending, Comment reads `Summary (required)` with `Write your comment (Markdown).`, and Submit waits with `Write a summary or add a line comment first.`

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
