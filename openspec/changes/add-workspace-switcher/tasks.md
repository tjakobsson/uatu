# Tasks

## 1. Model

- [x] 1.1 Add `src/shell/switcher-model.ts`: the face label, the button's spoken name, checkout row lines and order, pull request row lines, sort and filter, one search over both lists, and the query helpers moved from the picker (number/URL parsing, other-repository sentence, lookup text and timing, list selection). Verify with `src/shell/switcher-model.test.ts` (the picker's tests moved there) under `bun test src/shell`.

## 2. The dialog and the Hub's part

- [x] 2.1 Add `src/shell/switcher.ts` and the markup: the body-level `#hub-menu` dialog (status card, search combobox, Checkouts and Pull requests listboxes, footer), its backdrop, focus containment, Escape stepping back then closing, focus returned to the opener. Verify with unit tests for open/close, Escape and the combobox's active row.
- [x] 2.2 Rework `initHubNav` to register its adapter: the status card's facts and Start, two-line Checkouts rows (status order, spinner, states, `role="option"`), **+ New** for the current repository without "From a pull request…", no Sign out; keep stable row nodes (grouped by repository since 5.1). Verify the updated `src/shell/hub-nav.test.ts`.
- [x] 2.3 Pull requests in the dialog: the list, the `Open ▾` filter menu, the first three and `Show all n`, marks for Viewing and Checked out, pending/review-requested first, the no-credential line, stale `as of · Retry`, the lookup in any state. Verify with unit tests for the section's states.
- [x] 2.4 The choice step: View here / Check out as a worktree… (simulated confirmation with More details and the fork line), Go to its worktree first for a checked-out pull request, the branch's own pull request as Back, a pending review going straight to View here. Verify with unit tests for each path.

## 3. Chrome, strip and vocabulary

- [x] 3.1 The touch button in `#touch-tab-bar` outside the tablist (face, eye pill, attention count, spoken name, dimmed when stopped, landscape one-line layout) and the desktop chip's two lines; the header dropdown hidden on touch. Verify `tab-bar` roving skips it and e2e `mobile`/`ipad` stay green.
- [x] 3.2 The Viewing strip on Files and Preview (touch; preview on desktop with the sidebar collapsed; hidden on short screens), replacing the pane's Picked note, the Files scope bar's Back and the preview's Picked chip; Change Overview's label reads `⎇ <branch>` while viewing. Verify with `src/shell/switcher.test.ts` and the `.local/ux-loop` r9 probes (the e2e harness serves no GitHub data, so the strip is not reachable from e2e).
- [x] 3.3 Retire `src/shell/pull-request-picker.ts`; point the Pull request pane's search button and its no-pull-request `Browse pull requests…` at the switcher's Pull requests. Verify no import of the picker remains (`bunx tsc --noEmit`).
- [x] 3.4 Styles for the sheet, the panel, two-line rows (15px/13px type, rows at least 54px, targets 44px), the choice cards, the strip, both themes and the landscape two-column sheet. Verify with screenshots at 390×844, 844×390 and 1440×900.

## 4. Tests, docs and evidence

- [x] 4.1 Update e2e suites that drove the old menu (`hub-switcher`, `hub-stopped-session`, `worktree-*`, `hub-nav-bounds`, `terminal-hub-navigation`, `hub-chat-preferences`) and add switcher e2e coverage through a real Hub. Verify the listed suites pass.
- [x] 4.2 Update `ARCHITECTURE.md` and `CLAUDE.md`'s folder map for the switcher and the retired picker. Verify by reading the sections against the code.
- [x] 4.3 Run `bunx tsc --noEmit`, the unit tests of touched folders, the requested e2e suites and the `.local/ux-loop` probes (updated for the switcher) on an own instance; capture `pr-mockups/switcher/built-*.png` matching the six wireframes in dark and compare.

## 5. Owner feedback: which repository

- [x] 5.1 Group Checkouts by repository when there is more than one (`groupCheckouts` in `src/shell/hub-nav.ts`): one labelled `role="group"` per repository under a small, muted, sticky heading, the current repository first, others by name, `Other folders` last; no heading with one repository; rows keep their two lines and status order and drop the other-repository fact; search matches repository names. Verify `src/shell/hub-nav.test.ts` and the two-repository instance (`.local/ux-loop/fix-tools/start2.sh`).
- [x] 5.2 Name the repository in the Pull requests heading (`Pull requests · octo-org/uatu`), a compact selector when the workspace has more than one Git repository (`pullRequestStore.chooseRepository`, also chosen by a `?repository=` pull request URL), and the status card's Viewing line names the repository when it is another than the workspace's first. Verify `src/shell/switcher.test.ts` and `src/github/pull-request-store.test.ts`.
  - Follow-up: `Working in` and `terminal stays on` always name the checkout (the workspace's first repository, `pullRequestStore.workingRepository()`), never the repository picked for pull requests, and the Pull request pane names the repository beside the number with more than one repository. The heading, the selector and the Viewing line are verified end to end in `workspace-switcher.e2e.ts` and `pull-request-read.e2e.ts` (both repositories on GitHub through the transport fake, desktop and touch); their duplicated unit tests were removed.
  - E2E coverage (follow-up): `tests/e2e/workspace-switcher.e2e.ts` drives the switcher through a real Hub with two repositories (atlas, beacon): the chip and the fifth button, the status card, Checkouts grouped by repository with sticky headings, `Pull requests · octo-org/uatu`, the filter menu and Show all, one search over both lists (and one lookup for a number not listed), View here with the chip's and strips' Back, Go to its worktree, the keyboard (combobox, arrows, Escape's steps, focus return, Tab kept inside), and touch and landscape layouts. The repository selector is covered by `pull-request-read.e2e.ts`, which found that choosing a repository not on GitHub removed the selector and that a re-render dropped focus; both fixed in `src/shell/switcher.ts`.

## 6. Phase 3: real check-out

- [x] 6.1 Add `src/shell/pull-request-checkout.ts`: a fork's pull request as one `pull-request` creation, a same-repository one as `fetch` then `existing-local` or `remote-tracking`, refusals as one sentence, a reused branch's difference from the head. Verify `src/shell/pull-request-checkout.test.ts`.
- [x] 6.2 Replace the simulated Create worktree when the Hub serves worktree operations (`worktreeSource()` from hub-nav): you stay, `Creating…` under Checkouts (`#switcher-creating`), `Checking out…` on the row, the `#switcher-ready` notice with Go to, `Couldn't create · Retry` with the reason on the pull request's step; keep the labelled simulation without the service; the folder preview follows `worktreeFolderName`. Verify `src/shell/switcher.test.ts` and `switcher-model.test.ts`.
  - Follow-up: the real creation (the request, `Creating…`, `Checking out…`, no second start, the notice and Go to, `Couldn't create` with Retry) is verified end to end in `pull-request-worktree.e2e.ts`, and its unit duplicates were removed; `switcher.test.ts` keeps the labelled simulation.
- [x] 6.3 Cover it through a real Hub and real Git. Verify `tests/e2e/pull-request-worktree.e2e.ts` (children serve the GitHub fake through `hubGithubFake`), and that `worktree-ui`, `worktree-integration` and `hub-switcher` still pass.
- [x] 6.4 Update `ARCHITECTURE.md` and `docs/WORKTREES.md`. Verify by reading them against the code.

## Workflow follow-up

- Archive after `add-github-pr-review`.
