# Proposal

## Why

A workspace page has two independent states: the checkout you work in (files on disk, terminal, agent) and what Files and Preview show. Since pull request review arrived, Files and Preview can show a pull request that is not checked out, but the switcher still names only the checkout, the way back sits in three places under three wordings ("Picked PR, not checked out.", "Picked · ← Back", the Files bar's "← Back"), and the pull request picker is a second, separate list. The approved design (`pr-mockups/switcher/design.md`, "middle ground" version) gives both states one place and one vocabulary.

## What Changes

- **Touch:** a fifth control in the bottom bar, about 1.5 tabs wide and outside the tablist, names the checkout you work in, carries an eye pill `#N` while a pull request is viewed and today's attention badge, and opens the switcher. The sidebar header's dropdown is gone on touch.
- **The switcher:** one dialog (a full-height sheet on touch, a panel under the chip on desktop) with a status card (*Working in*, and *Viewing #N* with ← Back and "Not checked out · terminal stays on <branch>"), one search field over both lists, **Checkouts** (two-line rows ordered by who needs you, **+ New** in the heading), **Pull requests** (two-line rows, an `Open ▾` filter menu, the first three then `Show all n`), and a footer with Hub dashboard and Settings. **Sign out leaves the switcher**; it stays on the Hub's own pages.
- **The choice:** choosing a pull request that is not checked out asks **View here** or **Check out as a worktree…** (phase 3 makes it real on the Hub's `pull-request` create mode; it stays a labelled simulation only without the Hub's worktree operations); one already checked out offers **Go to its worktree** first and **View here** second.
- **One Viewing strip** (`Viewing #N` · `← Back to <branch>`) on Files and Preview replaces the Pull request pane's "Picked" note, the preview header's "Picked · ← Back" chip and the Files scope bar's "← Back". On desktop the chip's second line says it instead; the strip shows in the preview only while the sidebar is collapsed.
- **Vocabulary:** Picked → Viewing; Show in workspace → View here; Create worktree… (from a pull request) → Check out as a worktree…; Go to worktree → Go to its worktree; ← Back → ← Back to `<branch>`.
- **BREAKING (UI):** the "Browse pull requests…" dialog is retired. The Pull request pane's search button and its no-pull-request state open the switcher at Pull requests; the fork menu's "From a pull request…" item is removed.
- Change Overview's `Local branch` label reads the branch (`⎇ feat/view-pr`) while a pull request is viewed.

Phase 3 adds the real checkout from a pull request with its *Creating…* row and ready notice, on the Hub's `pull-request` create mode (`add-github-pr-review` D12). Out of scope: Navigator links (phase 4).

## Capabilities

### New Capabilities
- `workspace-switcher`: the in-workspace switcher: its touch button and desktop chip, the dialog's sections and rows, the view-or-check-out choice, the Viewing strip and the vocabulary that names *Working in* and *Viewing*.

### Modified Capabilities
- `touch-navigation`: the tab bar holds the four surface tabs and the switcher button (still never a mode control).
- `hub-dashboard`: the in-session switcher's navigation, Start, activity and worktree-creation requirements move to the new dialog (status card, Checkouts rows, **+ New**), without Sign out and without repository group headers.
- `hub-auth`: sign out is offered on the Hub's pages, not in the in-session switcher.

The open change `add-github-pr-review` (same branch, not archived) is revised in place: its "Open pull requests can be listed" and "A picked pull request becomes the workspace's current one" requirements describe the switcher's Pull requests and the Viewing strip instead of the picker dialog and the three notices. This change is archived after it.

## Impact

- Client only; no server or API change. `src/shell/hub-nav.ts` (data and the Checkouts rows), a new `src/shell/switcher.ts` and `src/shell/switcher-model.ts`, `src/shell/pull-request-picker.ts` retired (its query helpers move to the model), `src/shell/tab-bar.ts`, `src/index.html`, `src/styles.css`, `src/sidebar/pull-request-pane.ts`, `src/sidebar/pull-request-scope.ts`, `src/preview/pull-request-view.ts`.
- Tests: hub-nav unit tests, the picker's unit tests (moved), and e2e suites that drove the old menu (`hub-switcher`, `hub-stopped-session`, `worktree-*`, `hub-nav-bounds`, `terminal-hub-navigation`, `hub-chat-preferences`).
- Docs: `ARCHITECTURE.md` (pull request review and switcher sections), `CLAUDE.md` folder map.
