# Validation — preserve-tree-folder-state

> **Superseded contract.** Everything from "Outcome" through "Limitations and
> observations" records the first implementation (`1a5e990`) and its review
> follow-up, where a collapsed ancestor kept its active file selected but
> hidden. The revised contract — manual ancestor collapse closes the document —
> and its verification are in [Revised contract](#revised-contract-collapse-closes-the-document)
> at the end. The earlier sections are kept as historical evidence.

## Outcome

Implemented selection-aware reveal in the tree adapter. All-to-All refreshes
preserve surviving open and closed folders while keeping the active document
selected. Initial/new selections still reveal additively. Changed-filter
expansion policy is unchanged.

Two implementation discoveries were explicitly approved and added to the plan:

- `resetPaths` implicitly opens ancestors of expanded descendants. Public
  directory handles now restore the intended collapsed ancestors after reset,
  without discarding descendant expansion.
- Clicking a directory replaces the library's selected leaf. Directory callbacks
  now reconcile the currently available active-file selection without revealing
  it or changing keyboard focus. Cleared/unavailable selections are not revived.

## Commands and results

Run on 2026-09-16 using the installed dependencies and Playwright Chromium.

### Red baseline

```sh
bun run test:e2e tests/e2e/document-tree.e2e.ts --grep 'user-expanded|user-collapsed' --workers=1
```

- Original reproductions: **2 passed, 2 failed**, both failures caused by a
  collapsed selected-file ancestor reopening.
- Extended reproductions against unchanged product code: **2 passed, 5 failed**.
  Content update, addition, removal, rename, and Follow-on same-document update
  all reached their observable refresh-completion signal before failing on
  `aria-expanded`. These were not setup/watcher timeouts.
- Direct adapter tests against unchanged product code: **34 passed, 5 failed**
  using `bun test src/sidebar/tree-view.test.ts`. Failures covered unchanged and
  path-changing refreshes plus temporary absence with nested folder state.

### Intermediate diagnosis

After separating reveal from selection and restoring nested reset state, the
direct suite passed **39 tests**, but the focused browser run reported **3 passed,
4 failed** at the post-reopen selected-row assertion. A single-case rerun:

```sh
bun run test:e2e tests/e2e/document-tree.e2e.ts --grep 'a user-collapsed active folder stays collapsed when its file is updated'
```

confirmed the library selected `guides/setup.md` before the directory click and
`guides/` afterward. Diagnostic logging was removed. Additional direct and browser
tests caught this before directory-selection reconciliation was implemented.

### Initial implementation verification (`1a5e990`)

```sh
bun run test:e2e tests/e2e/document-tree.e2e.ts --grep 'user-expanded|user-collapsed|pointer and keyboard' --workers=1
```

**8 passed**. Includes both expansion controls, all five collapsed-folder cases,
and pointer/keyboard navigation after refresh. Tests assert the real library's
selected paths before reopening and the selected row afterward; no fixed sleeps
were added for refresh completion.

```sh
bun run test:e2e tests/e2e/document-tree.e2e.ts tests/e2e/follow-mode.e2e.ts tests/e2e/manual-selection.e2e.ts tests/e2e/files-pane-filter.e2e.ts --workers=1
```

**51 passed** in approximately 1.7 minutes. Covers initial nested reveal,
Follow-driven switches, unchanged-document Follow updates, filter restoration,
manual navigation, and desktop/touch unavailable-selection recovery.

```sh
bun test src/sidebar/tree-view.test.ts
bun run typecheck
```

**42 unit tests passed**, **300 assertions**; typecheck passed. Direct adapter
tests use the real tree library with linkedom, including identity/path changes,
clear/reselect, disposal/remount, nested open/closed state, temporary absence,
pending reveal, selection callback guarding, and directory focus preservation.

```sh
bunx --no-install openspec validate preserve-tree-folder-state --strict
git diff --check
```

OpenSpec reported the change valid; whitespace validation passed. Final diff
inspection found no leftover diagnostic logging or temporary product edits.

## Independent-review follow-up

Fresh research of `1a5e990` found two omitted scenarios, recorded in
[`research.md`](research.md). Both now have permanent regressions and fixes:

- Representation is scoped to the currently requested document identity. A →
  unavailable B → A reveals A, while the same continuously selected document
  returning after temporary absence still preserves collapsed ancestors.
- A capture/bubble click bridge supplements the library's selection callback
  only for an already-sole-selected file. Native pointer, Enter, Space, and touch
  activation reaches the existing manual-navigation handler exactly once, turns
  Follow off, and brings touch Preview forward. Different-file activation remains
  library-driven. The bridge does not intercept keyboard events, modify row DOM,
  or prevent default behavior; listeners are removed on disposal.

### Follow-up red runs

```sh
bun test src/sidebar/tree-view.test.ts -t 'returning A|real-library file clicks'
bun run test:e2e tests/e2e/document-tree.e2e.ts --grep 'reopened selected file' --workers=1
```

Before the fixes, both selected unit tests failed: A stayed collapsed after the
unavailable B interval, and same-file activation emitted no navigation callback.
All four browser variants (pointer, Enter, Space, touch) reached the activation
assertion and failed because Follow stayed on.

### Follow-up green runs

```sh
bun test src/sidebar/tree-view.test.ts
bun run test:e2e tests/e2e/document-tree.e2e.ts --grep 'reopened selected file' --workers=1
bun run test:e2e tests/e2e/document-tree.e2e.ts --workers=1
bun run typecheck
```

**45 unit tests passed** with **333 assertions**; **4 focused activation tests
passed**; the full document-tree file passed **22 tests**; typecheck passed.
The native browser tests count document requests to verify exactly-once routing
for both same-file and different-file activation, including touch Preview state.
Direct tests cover disposal/remount and the bridge's exclusion conditions.

```sh
bun run test:e2e tests/e2e/document-tree.e2e.ts tests/e2e/follow-mode.e2e.ts tests/e2e/manual-selection.e2e.ts tests/e2e/files-pane-filter.e2e.ts --workers=1
bun test src/sidebar/tree-view.test.ts
bun run typecheck
```

The primary agent independently reran these checks: **55 integration tests passed**
in approximately 2.2 minutes, **45 unit tests passed**, and typecheck passed.
A fresh focused source review found no actionable follow-up defects; that review
did not independently execute tests.

`bunx --no-install openspec validate preserve-tree-folder-state --strict` reported
the updated change valid, and `git diff --check` passed after the follow-up.

The linkedom direct-test harness supplies missing capture-phase ordering for
click tests; library target/bubble behavior and selection callbacks remain real.
The four browser variants independently exercise actual native propagation.
This bridge deliberately depends on the pinned library's row-button/event
contract, so those browser tests should run when upgrading the library.

## Limitations and observations

- The full repository unit suite and full E2E suite were not run; verification
  targets the suites required by this change. No additional browser engines or
  native desktop builds were tested.
- The E2E harness emitted `live upstream document subscription failed
  (unreachable)` warnings around workspace resets, including the passing runs.
  All required completion and behavior assertions passed.
- Folder state across page reloads and Changed-filter expansion redesign remain
  out of scope. No API, dependency, storage, or desktop-native changes were made.
- No diagnostic product edits or logging remain. No PR or archive was created.
  Stable-release classification remains a pre-PR task, as specified in the
  design's migration plan.

## Revised contract: collapse closes the document

Run on 2026-09-17 against the uncommitted working tree on top of `1a5e990`.

### What changed

- A native pointer, touch, Enter/Space or ArrowLeft collapse of any expanded
  ancestor of the active file closes the document through Rule A. The selection
  and preview are cleared and Follow turns off. Touch stays on Files. Focus stays
  on the operated directory whenever that directory is still displayed.
- The intentional-empty state survives reopening, background refreshes, filter
  transitions, resume and reload. Only explicit document navigation or enabling
  Follow ends it.
- Persistence is **browser-local only**
  (`uatu:presentation:v1:<base>:uatu:document-selection-cleared`, via
  `src/shell/selection-storage.ts`). A briefly implemented Hub
  `selectionCleared` field and API revision bump were fully reverted; the
  personal-state contract is unchanged. Background reconciliation (including
  from another tab) and commit-route navigation and boot do not clear the marker.
- Preview load generations prevent late rendered/source/diff responses from
  repopulating a closed preview.
- **Changed-view focus decision (user):** when closing the document drops the
  operated directory from the Changed view (it was visible only through the
  active-selection override), focus moves to a remaining visible row. The filter
  does not retain an excluded row. The spec, design and the regression
  `Changed active-only ancestor collapse moves keyboard focus to the next visible row`
  record this.
- **Unrelated directory clicks keep the active highlight.** Removing
  hidden-leaf restoration (task 2.4) had also removed restoration after *any*
  directory click. The library selects the clicked directory, so opening an
  unrelated folder or root dropped the active file's `aria-selected`
  (reproduced by the multi-root browser regression). Restoration is back for
  directories that are **not** ancestors of the active path; ancestor collapse
  still closes the document. New unit regression:
  `keeps the active leaf selected when an unrelated root's directories are clicked`.
  With the restoration disabled, it fails (69 pass, 1 fail).

### Review findings resolved

Integrated lifecycle review (analyst):
1. *Background updates in another client erase persisted emptiness.* Resolved
   by browser-local persistence and by `setSelectedId` distinguishing
   `"navigation"` from `"reconcile"`; reconciliation never removes the marker.
2. *Changed-view override collapse loses the operated folder.* Resolved by the
   user's focus decision above.
3. *Commit reload changes persisted intent.* Resolved; commit navigation and
   commit-route boot preserve the marker.

### Commands and results

```sh
bun test src/sidebar/tree-view.test.ts
```
**70 passed, 0 failed.**

```sh
bun run test:e2e tests/e2e/document-tree.e2e.ts tests/e2e/manual-selection.e2e.ts --grep 'Changed active-only ancestor|multi-root ancestor matching' --workers=1
```
**3 passed**: the Changed focus test and multi-root on desktop and touch. Both
were failing at the end of the previous session.

```sh
bun run test:e2e tests/e2e/document-tree.e2e.ts tests/e2e/follow-mode.e2e.ts tests/e2e/manual-selection.e2e.ts tests/e2e/files-pane-filter.e2e.ts --workers=1
```
**103 passed** in 4.2 minutes. This includes
`navigation through unavailable B then return to A`, which failed once in an
earlier aborted run (86/102) and was not reproducible in five focused repeats.
It passed here as well.

```sh
bun test
```
**3312 passed, 4 failed** (3326 tests, 210 files). The four failures are all in
`src/hub/credential-context.test.ts`. They are caused by the Hub-managed
workspace's projected Git/SSH environment (`GIT_CONFIG_*`, `GIT_SSH_COMMAND`),
as noted in `CLAUDE.md`. Rerunning that file with a clean environment
(`env -i HOME=… PATH=… bun test src/hub/credential-context.test.ts`):
**28 passed, 0 failed.** They are unrelated to this change.

```sh
bun run typecheck
git diff --check
bunx --no-install openspec validate preserve-tree-folder-state --strict
```
All passed.

### Fresh UX pass (task 4.3)

A temporary Playwright walkthrough (removed afterward) drove the real e2e server
at 1440×900 desktop and 390×844 touch emulation, with real file edits. Evidence:
`test-results/ux-tree-state-revised/` (per-step screenshots plus
`desktop-states.md` / `touch-states.md` with URL, preview, Follow, selected and
focused rows).

| Step | Desktop and touch |
|---|---|
| Open `guides/setup.md`, collapse unrelated `metadata/` | Document stays open and highlighted; focus on `metadata/` |
| Collapse `guides/` | URL `/`, empty preview, Follow off, no selected file, focus on `guides/`; touch stays on Files |
| Edit `guides/setup.md` and add `added.md` | Stays empty; `guides/` stays collapsed |
| Reopen `guides/` | Stays empty; touch Preview tab also empty |
| Reload | Stays empty, Follow off |
| Click `setup.md` | Opens, URL restored; touch switches to Preview; the next reload keeps it |
| Close again, enable Follow, edit a file | Follow resumes and renders the newest document |

Findings (not blocking, not changed):
- **Copy:** every empty preview, including a deliberate close, shows the title
  "No document selected" with the body "Waiting for viewable files". After a
  deliberate close with 18 files in the tree, "waiting" is misleading.
  Consider a close-specific message (e.g. "Select a file to preview").
- Reopening the collapsed ancestor left the library's directory selection
  highlighted (`guides/`), together with its focus ring. **Resolved (user
  decision: folder clicks only toggle; see below).**

### Folder clicks only toggle (user decision)

The user asked that clicking a folder never leave it looking selected, because
the click only expands or collapses it. The library selects the clicked
directory before toggling it, and it rings its active row after pointer
clicks as well as keyboard navigation. Two adapter changes address this:

- `handleSelectionChange` never leaves a directory selected. When a directory
  is selected, the selection moves back to the active file, unless the click
  collapses an expanded ancestor of that file (which closes the document). In
  that case, and when no file is active, the directory is just deselected.
  The expansion state read in the callback is the pre-toggle state
  (`handleRowClick` selects, focuses, then toggles).
- An unlayered rule in the tree's shadow root
  (`[data-item-focused="true"]:not(:focus-visible)::before { outline: none }`)
  hides the library's ring after pointer and touch focus. Keyboard navigation
  still shows it. The library's styles are in `@layer base`, so the rule needs
  no `!important`.

```sh
bun test src/sidebar/tree-view.test.ts
bun run typecheck
```
**71 passed, 0 failed**; typecheck passed. The old
`does not restore the former leaf from a directory selection callback`
test asserted a selected `guides/`. It was replaced by two tests: a collapsed
ancestor keeps the active leaf represented, and an expanded ancestor drops the
directory selection without restoring the leaf. The unavailable/null
resurrection tests and the native collapse tests now require no selected rows.

```sh
bun run test:e2e tests/e2e/document-tree.e2e.ts --grep 'folder clicks only toggle' --workers=1
```
**1 passed.** It fails with either fix removed: without the CSS rule the
computed `::before` outline is `solid` rather than `none`, and without the
directory deselection a selected folder row is found (count 1 rather than 0).

```sh
bun run test:e2e tests/e2e/document-tree.e2e.ts tests/e2e/follow-mode.e2e.ts tests/e2e/manual-selection.e2e.ts tests/e2e/files-pane-filter.e2e.ts --workers=1
```
**104 passed** in 3.5 minutes.

**Touch follow-up (reported from iOS Safari):** a tapped folder still showed
a selection-like background. The row was not selected: iOS keeps `:hover` on
the last tapped element, and the library tints `:hover` rows. Its
context-hover attribute is not involved, because the context menu is disabled
and the pointer-over handler is not wired. A `@media (hover: none)` rule
resets hovered rows to the plain row background, except for selected rows and
drag targets. New browser regression, run in both Chromium and WebKit with
iPhone-sized touch emulation:
`<browser> touch: a tapped folder keeps the plain row background even while :hover sticks`.
It taps a folder and forces `:hover`, then compares the folder's background
with an unselected row's. It also checks that a selected file keeps its
selection color. With the rule disabled, both engines fail with the hover tint
(`lab(94.77 …)` instead of `rgb(248, 248, 248)`).

```sh
bun run test:e2e tests/e2e/document-tree.e2e.ts tests/e2e/follow-mode.e2e.ts tests/e2e/manual-selection.e2e.ts tests/e2e/files-pane-filter.e2e.ts tests/e2e/mobile.e2e.ts tests/e2e/ipad.e2e.ts tests/e2e/sidebar.e2e.ts tests/e2e/touch-scroll.e2e.ts --workers=1
```
**157 passed** in 5.8 minutes; `tree-view.test.ts` 71 passed; typecheck passed.
Testing on a physical iPhone is left to the user.

The full-suite run below predates this touch rule.

```sh
bun run test:e2e
bunx playwright test --last-failed --workers=1
```
Full browser suite (732 tests, default 4 workers, 29 minutes): **708 passed,
21 failed, 3 did not run**. The failures were mostly chat frame-budget,
following and scrollback timing tests, plus one test each in `compare-target`,
`find` and `terminal-session-manager`. Rerunning the failed and not-run tests
serially: **24 passed, 0 failed**. The failures were caused by parallel load,
not by this change.

### Limitations

- Isolation of the browser marker across workspaces is covered by unit tests
  (`selection-storage.test.ts`) only; the e2e harness serves one workspace.
- No physical devices, screen readers or other browser engines were tested.
- The `live upstream document subscription failed (unreachable)` warnings still
  appear around e2e resets; all assertions passed.
