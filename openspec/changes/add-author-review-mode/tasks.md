## 1. Shared Types and Persistence

- [ ] 1.1 Add a `Mode` type (`"author" | "review"`) and a constant for the localStorage key (`uatu:mode`, matching existing `uatu:*` keys) in the shared types module.
- [ ] 1.2 Extend the initial-state payload type with an optional `startupMode` field used only when the CLI flag is present.
- [ ] 1.3 Add a small client-side preference helper that reads the persisted Mode from localStorage with the default `author`, and a setter that overwrites it.
- [ ] 1.4 Add unit tests for the preference helper covering the default, persistence round-trip, and the `startupMode`-overrides-persisted path.

## 2. CLI and Watch-Session Integration

- [ ] 2.1 Add the `--mode=author|review` CLI flag to `uatu watch`, with parsing, validation, and a clear error message for invalid values.
- [ ] 2.2 Plumb the parsed startup Mode into the initial-state payload as `startupMode` when the flag is present; omit otherwise.
- [ ] 2.3 When `--mode=review` is in effect, ensure the session-level follow flag is forced off and emit a startup warning if `--follow` was also supplied.
- [ ] 2.4 Add unit tests for CLI parsing (valid values, invalid value, both flags present) and for initial-state payload composition.

## 3. Browser Mode Control

- [ ] 3.1 Add a top-level `Mode` control to the browser UI header with two values, `Author` and `Review`, sized and styled to fit the existing header row.
- [ ] 3.2 On SPA boot, derive initial Mode from `startupMode` if present, else from the localStorage helper, else default to `author`; persist the derived value back to localStorage so subsequent reloads are stable.
- [ ] 3.3 Wire the control's change handler to update Mode state, persist to localStorage, and apply downstream effects (Follow off when entering Review; Follow availability restored when entering Author without auto-enabling).
- [ ] 3.4 Add a Mode-aware label selector that returns `"Reviewer burden forecast"` for Author and `"Change review burden"` for Review; route the `Change Overview` headline through it.
- [ ] 3.5 Add unit tests for the label selector (both modes, same fixture) and for the boot precedence (`startupMode` > persisted > default).

## 4. Follow Disablement and File-Change Gating

- [ ] 4.1 Make the sidebar Follow control Mode-aware: render visibly disabled (not hidden) in Review with a tooltip naming Mode as the reason; restore interactivity in Author.
- [ ] 4.2 Update the file-change handler to short-circuit any preview-switching effect when Mode is Review, while keeping indexed sidebar updates intact.
- [ ] 4.3 Update the in-place active-file refresh path to apply only in Author Mode; in Review, do not auto-render new on-disk content for the active file.
- [ ] 4.4 Verify (with tests where practical) that `Files`-pane clicks, `Git Log` commit clicks, and direct URL navigation continue to work in Review.

## 5. Stale-Content Hint in Review

- [ ] 5.1 Add a stale-content hint strip component to the preview header, with two variants: changed-on-disk (refresh affordance) and deleted-on-disk (close/back affordance).
- [ ] 5.2 Track per-active-file hint state in the SPA so multiple disk changes coalesce into a single visible hint.
- [ ] 5.3 Wire the file-change handler to set the changed-on-disk hint state for the active file when Mode is Review; suppress in Author.
- [ ] 5.4 Wire the file-deletion handler to set the deleted-on-disk hint state for the active file when Mode is Review; keep stale rendered content visible until the user acts.
- [ ] 5.5 On refresh-affordance activation, re-render the active preview to current on-disk content for the same file and clear the hint.
- [ ] 5.6 Clear the hint as a side effect of any navigation that changes the active preview (sidebar selection, commit click, URL navigation, switching Mode); when switching to Author, re-render to current on-disk content.
- [ ] 5.7 Add unit tests for hint state reducer logic: appearance, coalescing, refresh, navigation-clear, mode-switch-clear, deleted-state distinct affordance.

## 6. Score Label Wiring in Change Overview

- [ ] 6.1 Replace the static headline label in the `Change Overview` pane with the Mode-aware label selector from 3.4; verify the score number, level pill, drivers, thresholds, configured-area summaries, and warnings remain unchanged.
- [ ] 6.2 Confirm the score-explanation preview content is fully Mode-independent (no Mode-dependent text); add a regression test that renders the preview in both Modes and asserts identical DOM text.

## 7. Styling and Accessibility

- [ ] 7.1 Style the Mode control to match existing header controls; ensure it is keyboard-focusable and announces its current value to assistive tech.
- [ ] 7.2 Style the disabled Follow control state with a clear visual treatment plus tooltip/inline note pointing at Mode as the reason.
- [ ] 7.3 Style the stale-content hint strip (changed and deleted variants) with discoverable but non-intrusive treatment; ensure refresh / close affordances are keyboard-activatable and have accessible labels.

## 8. End-to-End Coverage and Documentation

- [ ] 8.1 Extend the Playwright workspace fixtures so a test can mutate or delete an active file on disk while the SPA is connected.
- [ ] 8.2 Add Playwright coverage: default Mode is Author; Mode persists across reload; switching Author→Review disables Follow; switching Review→Author re-enables Follow availability without auto-on; CLI `--mode=review` boots with Mode=Review and Follow off; CLI Mode flag overrides persisted preference at startup.
- [ ] 8.3 Add Playwright coverage for Review behavior: file-change event does not switch active preview; manual sidebar selection does switch; `Git Log` commit click renders commit preview; direct URL navigation works.
- [ ] 8.4 Add Playwright coverage for the stale-content hint: appears in Review when active file changes on disk; refresh re-renders and clears; multiple changes coalesce; manual navigation clears; switching to Author clears and re-renders; hint never appears in Author; deleted-on-disk variant shows close/back affordance and keeps stale content visible.
- [ ] 8.5 Add Playwright coverage that the score number and level pill are identical across Mode switches, while only the headline label string changes.
- [ ] 8.6 Update the README (or equivalent user-facing docs) to introduce Mode, the `--mode` CLI flag, the Follow availability rule, the headline-label difference, and the stale-content hint behavior in Review.
- [ ] 8.7 Run `bun test`, `bun run build`, and the relevant Playwright suites; fix any failures.
