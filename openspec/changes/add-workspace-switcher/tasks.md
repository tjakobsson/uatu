# Tasks

## 1. Model

- [x] 1.1 Add `src/shell/switcher-model.ts`: the face label, the button's spoken name, checkout row lines and order, pull request row lines, sort and filter, one search over both lists, and the query helpers moved from the picker (number/URL parsing, other-repository sentence, lookup text and timing, list selection). Verify with `src/shell/switcher-model.test.ts` (the picker's tests moved there) under `bun test src/shell`.

## 2. The dialog and the Hub's part

- [x] 2.1 Add `src/shell/switcher.ts` and the markup: the body-level `#hub-menu` dialog (status card, search combobox, Checkouts and Pull requests listboxes, footer), its backdrop, focus containment, Escape stepping back then closing, focus returned to the opener. Verify with unit tests for open/close, Escape and the combobox's active row.
- [x] 2.2 Rework `initHubNav` to register its adapter: the status card's facts and Start, two-line Checkouts rows (status order, spinner, states, `role="option"`), **+ New** for the current repository without "From a pull request…", no Sign out, no group headers; keep stable row nodes. Verify the updated `src/shell/hub-nav.test.ts`.
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

## Workflow follow-up

- Archive after `add-github-pr-review`.
