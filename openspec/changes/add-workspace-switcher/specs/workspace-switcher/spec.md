## Purpose

The in-workspace switcher answers two questions in the same words everywhere: which checkout you are *working in* (its files, terminal and agent), and what Files and Preview are *viewing*. It is also where you move to another checkout or open a pull request.

## ADDED Requirements

### Requirement: The switcher names where you work and what you view
The switcher SHALL name the checkout the page works in: its branch for a Git checkout (`Detached HEAD` or `Branch unknown` when that is the fact, never a guess) or its display name for a workspace outside any repository. While Files and Preview show a pull request other than the checked-out branch's own, it SHALL also say `Viewing #<n>`. It SHALL be offered whenever the page is served by a Hub or the session serves GitHub data, and be absent otherwise.

#### Scenario: Touch mode's switcher button
- **WHEN** a Hub-served workspace on `feat/view-pr` shows pull request #618 without checking it out on a 390×844 touch phone
- **THEN** the bottom bar's last control, about one and a half tab cells wide with a divider before it, shows a branch glyph over `feat/view-pr` and an eye pill `#618`
- **AND** it is a button outside the tablist: it never reads as selected, the arrow keys that rove the four tabs skip it, and it is one Tab stop after the tabs
- **AND** its accessible name reads like `Switch. Working in uatu, feat/view-pr. Viewing pull request 618. 1 workspace awaiting your reply.`
- **AND** it carries the attention badge under the existing badge rules, its face dims while the session is stopped, and it is present on every tab

#### Scenario: A phone in landscape
- **WHEN** the same page is shown on an 844×390 touch phone
- **THEN** the button puts the glyph, the eye pill, the checkout's name and the attention count on one line in the slim bar, with a tap box at least 44px tall

#### Scenario: Desktop's chip
- **WHEN** the same workspace is shown in desktop mode
- **THEN** the sidebar header's chip shows the branch glyph and `feat/view-pr` on its first line, and on a second line, only while viewing, `Viewing #618` with `← Back` (named `Back to feat/view-pr`)
- **AND** activating the first line opens the switcher

#### Scenario: Outside a Hub
- **WHEN** a session is not served by a Hub and does not serve GitHub data
- **THEN** there is no switcher button and the bar has its four tabs
- **AND** when the session serves GitHub data the switcher is offered and holds only the status card and Pull requests

### Requirement: The switcher is one dialog with a status card, search, Checkouts and Pull requests
Activating the switcher SHALL open one labelled modal dialog titled `Switch`: a full-height sheet on touch and a panel under the chip on desktop, with the same sections, words and order. From top to bottom it SHALL hold a status card, one search field, **Checkouts**, **Pull requests** and a footer with `Hub dashboard` and `Settings`. It MUST NOT offer Sign out.

#### Scenario: The status card
- **WHEN** the switcher opens on `uatu · feat/view-pr` while #618 is viewed
- **THEN** the card reads `Working in uatu · feat/view-pr`, then `Viewing #618` with `← Back` (named `Back to feat/view-pr`) and the muted line `Not checked out · terminal stays on feat/view-pr`
- **AND** with nothing viewed the Viewing block is absent
- **AND** when the viewed pull request is from another of the workspace's Git repositories than its first, the Viewing line names that repository, like `Viewing octo-org/docs #12`
- **AND** while the current session is stopped the card reads `Working in … · Stopped` with Start, which starts the session in place without navigating

#### Scenario: One search over both lists
- **WHEN** the user types `63` in the search field
- **THEN** the status card folds away and Checkouts and Pull requests show only rows whose name, branch, number, title or author match, or whose repository's name does (a checkout's repository)
- **AND** a number or a pull request URL also finds a merged or closed pull request after a pause, as one result
- **AND** on touch the field is not focused on open, so the keyboard does not cover the lists; on desktop focus starts in it

#### Scenario: Keyboard and screen readers
- **WHEN** focus is in the search field
- **THEN** it is a combobox over both lists: ArrowDown and ArrowUp move the active row across Checkouts and Pull requests, Enter activates it, and Escape steps back from a choice and then closes the dialog with focus returned to the control that opened it
- **AND** each list is a labelled group, each row is named by both its lines and its marks in words plus what Enter does, and no state relies on colour alone
- **AND** every control in the dialog has a tap box at least 44px tall on touch

#### Scenario: Landscape phone
- **WHEN** the switcher opens on an 844×390 touch phone
- **THEN** it fills the screen in two columns: the status card, search and footer on the left, the two lists on the right, rows keeping their two lines

#### Scenario: Sign out stays on the Hub's pages
- **WHEN** the user wants to sign out from a workspace
- **THEN** the switcher's footer offers Hub dashboard and Settings, and Sign out is on those pages

### Requirement: Checkout rows show what helps you choose
**Checkouts** SHALL list every Hub workspace except the current one, which the status card names, ordered by who needs you. Each row SHALL have at most two lines, and tapping it SHALL be its only action. The heading SHALL carry **+ New** when the current repository can host worktrees. When the checkouts belong to more than one repository, they SHALL be grouped under compact repository headings; with one repository there SHALL be no heading.

#### Scenario: Two lines and an order
- **WHEN** the switcher lists other checkouts
- **THEN** line 1 is the checkout's pull request (`#636 title`, when its branch has one in the listed pull requests) or else its name: the repository for a main checkout, the branch for a worktree, the display name otherwise
- **AND** line 2, muted, is the branch unless line 1 already is the branch, then one state
- **AND** rows are ordered awaiting you, working, finished, idle, stopped, then unavailable

#### Scenario: Checkouts of two repositories
- **WHEN** the switcher opens in `uatu · feat/view-pr` and the Hub also has `uatu`'s worktree `fix/pane-heights` and the repository `docs-site` with its worktrees `feat/search` and `fix/typos`
- **THEN** Checkouts shows a group headed `uatu` holding `fix/pane-heights`, then a group headed `docs-site` holding `docs-site`, `feat/search` and `fix/typos`, each group a labelled group named by its repository
- **AND** each heading is the repository's name, small and muted, and sticks to the top of the scrolling lists while its group's rows pass under it
- **AND** the current repository's group comes first, the others follow by name, and folders outside any repository come last under `Other folders`; within a group the rows keep their two lines and their order by who needs you, and no row repeats its repository on line 2
- **AND** the current checkout's repository counts even without another row of its own, so a list of only `docs-site`'s checkouts still has its heading
- **AND** typing `docs-site` in the search lists that repository's three checkouts under their heading

#### Scenario: States on line 2
- **WHEN** other checkouts await the user, work, finished, are stopped, are missing, or conflict
- **THEN** line 2's state reads `Awaiting you` (amber), `Working` (with a spinner in place of the status dot), `Finished`, `Stopped` (with a hollow dot), `Missing checkout` / `Missing folder`, or `Identity conflict`, and an idle running checkout carries no state word
- **AND** a missing or conflicting checkout is not actionable

#### Scenario: Going to another checkout
- **WHEN** the user taps a running checkout's row
- **THEN** the page navigates to that checkout's stable session URL; a stopped one is started first (`Starting…` on its row), and a locked credential routes to the Hub's start flow
- **AND** a modified click or middle click keeps the link's open-elsewhere behaviour

#### Scenario: Creating a worktree
- **WHEN** the user activates **+ New** in the Checkouts heading
- **THEN** today's worktree menu opens (New branch / worktree, Existing branch, Register worktree…) for the current repository, without a "From a pull request…" item
- **AND** after creation the user stays where they are, and the existing confirmation offers Open

#### Scenario: Privacy of other workspaces
- **WHEN** other workspaces report activity
- **THEN** their rows show states only, never conversation content or titles

### Requirement: Pull request rows show who, checks and review
**Pull requests** SHALL list the current repository's open pull requests as two-line rows, with the repository named in the heading (`Pull requests · octo-org/uatu`) and a filter menu in the heading (`Open ▾`: Open, Review requested, Mine, Drafts), showing the first three rows and then `Show all n`, which expands the list in place. Pull requests awaiting the viewer's review or holding the viewer's pending review SHALL sort first.

#### Scenario: What a row says
- **WHEN** the switcher lists pull requests
- **THEN** line 1 reads `#number title`, and line 2, muted, the author, `Fork` or `Draft`, checks (`✓ checks`, `✗ checks`, `◷ checks running`) and the review state: `approved`, `changes requested`, `review required`, `review requested` (from the viewer), or `✎ n pending` for the viewer's unsent review, which takes the review slot
- **AND** only the fact to act on is coloured: amber for `review requested` and `✎ n pending`, red for `changes requested`, green for `approved`

#### Scenario: Which repository's pull requests
- **WHEN** the switcher lists pull requests
- **THEN** the heading reads `Pull requests · octo-org/uatu`: the GitHub repository once GitHub has named it, else the local repository's name, cut at its end when long
- **AND** with one Git repository in the workspace the name is plain text
- **AND** when the workspace has more than one Git repository the name is a compact selector, a menu naming each repository, that lists the chosen repository's pull requests; the choice is page-local, a pull request viewed from the previous repository is let go first, and a pull request URL naming one of the repositories (`?repository=`) chooses it too
- **AND** with another of its repositories chosen, the Hub's checkouts are not offered as that repository's: its rows view the pull request here

#### Scenario: Rows and marks
- **WHEN** #618 is viewed and #636 is checked out in another worktree
- **THEN** #618's row is tinted with an eye named `Viewing`, and #636's row carries a branch glyph named `Checked out`

#### Scenario: No credential, rate limit, no GitHub data
- **WHEN** GitHub isn't connected for the workspace
- **THEN** Pull requests collapses to one line of today's connect guidance
- **AND** while GitHub is rate-limited or unreachable the last list shows with `as of <time> · Retry` under the heading
- **AND** when the session does not serve GitHub data the section is absent, and while the current session is stopped it reads `Start <name> to list pull requests.`

### Requirement: Choosing a pull request asks how
Tapping a pull request row SHALL never act on the tap alone when there is a choice to make. A pull request that is not checked out SHALL open a choice step offering **View here** and, in a Hub whose repository can host worktrees, **Check out as a worktree…**; one already checked out in another worktree SHALL offer **Go to its worktree** first and **View here** second. Each choice SHALL be one button named in full.

#### Scenario: The choice step
- **WHEN** the user taps #639, which is not checked out
- **THEN** a step headed `#639` with its title offers **View here** (the default, outlined: "Opens in Files and Preview, from GitHub" / "Terminal and agent stay on feat/view-pr") and **Check out as a worktree…** ("New folder pr-639, on branch pr/639" / "Its own terminal and agent")

#### Scenario: View here
- **WHEN** the user chooses View here for #639
- **THEN** the switcher closes, the pull request becomes the viewed one without fetching or checking out anything, Preview comes forward on its conversation, its heading takes focus, the strip and the eye pill appear, and a live region says `Viewing #639. Terminal and agent stay on feat/view-pr.`

#### Scenario: Check out as a worktree
- **WHEN** the user chooses Check out as a worktree… for #639
- **THEN** one confirmation shows the folder and branch, with the source and credentials under `More details`, a fork's pull request adds `From a fork: uatu won't push back to it.`, and `Create worktree` is followed by `You stay here and get a notice when it's ready.`
- **AND** while GitHub data is mocked, Create worktree says plainly that nothing was created and offers to view #639 here

#### Scenario: Already checked out
- **WHEN** the user taps #636, checked out as `fix/pane-heights`
- **THEN** the step offers `Go to its worktree` ("Opens fix/pane-heights · <state>" / "Its own terminal and agent") first, and View here second

#### Scenario: Shortcuts that need no choice
- **WHEN** the user taps the checked-out branch's own pull request, or a pull request holding their pending review, or the session is not served by a Hub
- **THEN** the branch's own pull request is the same as Back, a pending review goes straight to View here, and outside a Hub every row views the pull request here

#### Scenario: Stepping back
- **WHEN** the choice step is open and the user presses Escape or its back control
- **THEN** the lists return; a second Escape closes the switcher

### Requirement: One Viewing strip says what Files and Preview show
While a pull request other than the checked-out branch's own is viewed, one accent-tinted strip SHALL read `Viewing #<n>` with `← Back to <branch>` at its right edge. It SHALL be the only such notice: the Pull request pane, the preview header and the Files scope bar carry none of their own.

#### Scenario: Where the strip shows
- **WHEN** #618 is viewed
- **THEN** on touch the strip is at the top of the Files tab (under the brand) and above the pull request in the Preview tab, never on Terminal or Chat
- **AND** on desktop it shows in the preview only while the sidebar is collapsed; otherwise the chip's second line says it
- **AND** on a touch screen 500px tall or less it is not shown: the bar and the switcher say both facts

#### Scenario: Back from the strip
- **WHEN** the user activates `← Back to feat/view-pr` on the strip, the chip or the status card
- **THEN** Files and Preview show the checkout again (the branch's pull request or the workspace's default document), nothing on disk changes, and focus lands on the branch's pull request heading or, from the Files strip, in the workspace tree

#### Scenario: The Files scope keeps its heading
- **WHEN** #618 is viewed
- **THEN** the Files pane's scope bar keeps `PR #618` and the title as the tree's heading, without a Back of its own
- **AND** the `Changed n | All files` switch under it (the pull request file view, `add-github-pr-review`) changes only which of #618's files are listed, never what is viewed
- **AND** Change Overview's `Local branch` label reads the branch (`⎇ feat/view-pr`), its tooltip saying why

#### Scenario: The viewed pull request's branch gets checked out here
- **WHEN** the checkout's branch becomes the viewed pull request's branch
- **THEN** it is the branch's own pull request, and the strip and the eye pill disappear
