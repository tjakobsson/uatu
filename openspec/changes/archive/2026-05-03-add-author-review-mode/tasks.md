## 1. Shared Types and Persistence

- [x] 1.1 Add a `Mode` type (`"author" | "review"`) and a constant for the localStorage key (`uatu:mode`, matching existing `uatu:*` keys) in the shared types module.
- [x] 1.2 Extend the initial-state payload type with an optional `startupMode` field used only when the CLI flag is present.
- [x] 1.3 Add a small client-side preference helper that reads the persisted Mode from localStorage with the default `author`, and a setter that overwrites it.
- [x] 1.4 Add unit tests for the preference helper covering the default, persistence round-trip, and the `startupMode`-overrides-persisted path.

## 2. CLI and Watch-Session Integration

- [x] 2.1 Add the `--mode=author|review` CLI flag to `uatu watch`, with parsing, validation, and a clear error message for invalid values.
- [x] 2.2 Plumb the parsed startup Mode into the initial-state payload as `startupMode` when the flag is present; omit otherwise.
- [x] 2.3 When `--mode=review` is in effect, ensure the session-level follow flag is forced off. (No `--follow` flag exists in the CLI today, so the contradiction warning has no triggering input; deferred until/unless `--follow` is added.)
- [x] 2.4 Add unit tests for CLI parsing (valid values, invalid value, both flags present) and for initial-state payload composition.

## 3. Browser Mode Control

- [x] 3.1 Add a top-level `Mode` control to the browser UI header with two values, `Author` and `Review`, sized and styled to fit the existing header row.
- [x] 3.2 On SPA boot, derive initial Mode from `startupMode` if present, else from the localStorage helper, else default to `author`; persist the derived value back to localStorage so subsequent reloads are stable.
- [x] 3.3 Wire the control's change handler to update Mode state, persist to localStorage, and apply downstream effects (Follow off when entering Review; Follow availability restored when entering Author without auto-enabling).
- [x] 3.4 Add a Mode-aware label selector that returns `"Reviewer burden forecast"` for Author and `"Change review burden"` for Review; route the `Change Overview` headline through it.
- [x] 3.5 Add unit tests for the label selector (both modes, same fixture) and for the boot precedence (`startupMode` > persisted > default).

## 4. Follow Disablement and File-Change Gating

- [x] 4.1 Make the sidebar Follow control Mode-aware: render visibly disabled (not hidden) in Review with a tooltip naming Mode as the reason; restore interactivity in Author.
- [x] 4.2 Update the file-change handler to short-circuit any preview-switching effect when Mode is Review, while keeping indexed sidebar updates intact.
- [x] 4.3 Update the in-place active-file refresh path to apply only in Author Mode; in Review, do not auto-render new on-disk content for the active file.
- [x] 4.4 Verified by code path (manual Files/Git Log click handlers and URL navigation all bypass the SSE state path); end-to-end coverage lands in G8.

## 5. Stale-Content Hint in Review

- [x] 5.1 Add a stale-content hint strip component to the preview header, with two variants: changed-on-disk (refresh affordance) and deleted-on-disk (close/back affordance).
- [x] 5.2 Track per-active-file hint state in the SPA so multiple disk changes coalesce into a single visible hint.
- [x] 5.3 Wire the file-change handler to set the changed-on-disk hint state for the active file when Mode is Review; suppress in Author.
- [x] 5.4 Wire the file-deletion handler to set the deleted-on-disk hint state for the active file when Mode is Review; keep stale rendered content visible until the user acts.
- [x] 5.5 On refresh-affordance activation, re-render the active preview to current on-disk content for the same file and clear the hint.
- [x] 5.6 Clear the hint as a side effect of any navigation that changes the active preview (sidebar selection, commit click, URL navigation, switching Mode); when switching to Author, re-render to current on-disk content.
- [x] 5.7 Add unit tests for hint state reducer logic: appearance, coalescing, refresh, navigation-clear, mode-switch-clear, deleted-state distinct affordance.

## 6. Score Label Wiring in Change Overview

- [x] 6.1 Replace the static headline label in the `Change Overview` pane with the Mode-aware label selector from 3.4; verify the score number, level pill, drivers, thresholds, configured-area summaries, and warnings remain unchanged.
- [x] 6.2 Score-explanation preview is Mode-independent by construction: the helper builds HTML from the load result alone with no Mode parameter or `appState.mode` reference. A static-analysis regression test (app-score-explanation.test.ts) asserts the body contains no `appState.mode`, no `reviewBurdenHeadlineLabel` call, and no hardcoded Mode-specific label strings.

## 7. Styling and Accessibility

- [x] 7.1 Style the Mode control to match existing header controls; ensure it is keyboard-focusable and announces its current value to assistive tech.
- [x] 7.2 Style the disabled Follow control state with a clear visual treatment plus tooltip/inline note pointing at Mode as the reason.
- [x] 7.3 Style the stale-content hint strip (changed and deleted variants) with discoverable but non-intrusive treatment; ensure refresh / close affordances are keyboard-activatable and have accessible labels.

## 8. End-to-End Coverage and Documentation

- [x] 8.1 Extended e2e-server `/__e2e/reset` to accept `startupMode` (and `follow`) so Playwright can simulate the CLI flag; existing `fs.writeFile` and `fs.unlink` against `workspacePath(...)` already support active-file mutation/deletion.
- [x] 8.2 Added Playwright coverage: default Mode is Author; Mode persists across reload; switching Author→Review disables Follow; switching Review→Author re-enables Follow availability without auto-on; CLI `--mode=review` boots with Mode=Review and Follow off; CLI Mode flag overrides persisted preference at startup.
- [x] 8.3 Added Review-behavior coverage for file-change event ignored, manual selection still works (Git Log click and direct URL paths are exercised by existing tests that don't depend on Mode).
- [x] 8.4 Added stale-content hint coverage: appears in Review when active file changes; refresh re-renders and clears; coalescing; manual navigation clears; switching to Author clears and re-renders; hint never appears in Author; deleted-on-disk variant.
- [x] 8.5 Added a regression test asserting numeric score, level pill, and burden-meter class are identical across Mode switches; only the headline string differs.
- [x] 8.6 Updated README with the Mode toggle in the features list, the `--mode` CLI flag in usage, and a dedicated "Mode: Author vs Review" section covering Follow gating, label difference, and stale-content hint behavior.
- [x] 8.7 `bun test` (199 pass), `bun run build` (clean), and `bun x playwright test` (78/78 pass) all green.

## 9. Mode Visual Differentiation

- [x] 9.1 Added a Mode-aware sidebar brand subtitle (`Authoring session` / `Review session`) replacing the static "Codebase Watcher" h1; wired from `syncModeControl` and re-applied at boot.
- [x] 9.2 Added a persistent Mode pill (`AUTHORING` / `REVIEWING`) directly under the brand subtitle; structural border + neutral background, dashed border in Review for additional non-color distinction.
- [x] 9.3 Added mode-glyph icons inside the toolbar Mode segments (pencil for Author, eye for Review); both icons present regardless of which mode is active.
- [x] 9.4 Made the connection indicator Mode-aware: Author live = pulsing "Online" (existing); Review live = steady "Reading — auto-refresh paused" (italicized) via `syncConnectionDisplay()`. Connecting/Reconnecting states unchanged in both Modes.
- [x] 9.5 Added a "framed read" preview treatment in Review (`.preview-shell.is-mode-review #preview` border + radius + inner shadow + extra padding); class is removed when switching back to Author.
- [x] 9.6 Added Playwright coverage for all five cues: subtitle text, pill text + data attribute, icon presence in segments, connection indicator wording + computed-style animation, and preview frame class on/off across Mode switches.
- [x] 9.7 `bun test` (199 pass), `bun run build` (clean), `bun x playwright test` (79/79 pass) all green.

## 10. Mode-Aware Layout & Sidebar Simplification

- [x] 10.1 Refactored pane state to per-mode: `uatu:sidebar-panes:author` / `uatu:sidebar-panes:review`; `PANE_DEFS_BY_MODE` catalog with Author = [Change Overview, Files], Review = [Change Overview, Files, Git Log]; `applyMode` persists outgoing then loads destination pane state and triggers re-render + height normalization.
- [x] 10.2 Panels-restore menu now iterates `paneDefsForMode(appState.mode)` so Git Log doesn't appear in Author.
- [x] 10.3 Moved the Mode toggle out of the preview toolbar into a `.sidebar-mode-row` directly under the brand block. CSS expanded the toggle to span the row width.
- [x] 10.4 Removed the Pin UI: `#pin-toggle` button, click handler, `syncPinToggle`, `postScope`, and all 9 call sites. Server-side `Scope` mechanism + `/api/scope` endpoint preserved for CLI single-file watch (verified by an updated direct-link test that now hits `/api/scope` directly).
- [x] 10.5 Git Log hidden in Author Mode (`syncPaneDom` force-hides panes outside the active catalog) and absent from the panels-restore menu in Author.
- [x] 10.6 Added All/Changed view toggle in the Files pane header. Default = All (full tree, preserves all prior behavior); Changed renders `RepositoryReviewSnapshot.reviewLoad.changedFiles` with status glyph + path + `+adds -dels`; renames show `oldPath → path`; deleted entries non-clickable. Toggle hidden when no `available` repo. View persists per-mode under `uatu:files-view:{mode}`.
- [x] 10.7 Full-tree listing remains the default and the no-git fallback. No notice added.
- [x] 10.8 Added inline `FOLDER_ICON_SVG` next to directory names in the tree; styled via `.tree-folder-icon`.
- [x] 10.9 Bumped `--sidebar-width` from 300px to 360px.
- [x] 10.10 Playwright updates: removed the standalone Pin test; rewrote the direct-link "session pinned" test to call `/api/scope` directly; flipped Git-Log-dependent tests to `startupMode: "review"`; added 8 new tests covering Mode-toggle placement, Pin removal, Files-view toggle visibility/default/switching, per-mode persistence, per-mode pane state independence, panels menu Git-Log absence in Author, and folder icons.
- [x] 10.11 `bun test` (199 pass), `bun run build` (clean), `bun x playwright test` (86/86 pass).
