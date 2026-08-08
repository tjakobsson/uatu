## 1. Attachment policy (pure)

- [x] 1.1 Add `resolveSessionPlan(inventory, shownIds, freeSlots)` to `src/terminal/picker.ts`, returning `{ attach, decide }`: not-shown detached sessions oldest-first truncated to `freeSlots` in `attach`; not-shown attached-elsewhere sessions plus detached overflow in `decide`
- [x] 1.2 Add `resolveActiveSessionId(attached, lastPtyId)` returning the saved last-active id when present in the attached set, else the newest
- [x] 1.3 Add `buildSwitcherRows(panes, inventory, activeSessionId, lastPtyId, now)` returning rows with label, `state` (`visible` | `attached-here` | `detached` | `attached-elsewhere`), age via `formatSessionAge`, and permitted actions; order attached-here (pane order) → detached → attached-elsewhere
- [x] 1.4 Unit-test all three in `picker.test.ts`: empty inventory, all-detached, all-attached-elsewhere, mixed, `freeSlots` truncation, last-active present/absent/attached-elsewhere, row states and ordering
- [x] 1.5 Keep `pickerCandidates` exported and behaviorally unchanged (the desktop chooser still calls it)

## 2. Auto-attach in the panel

- [x] 2.1 Rewrite `addPaneInteractive()` in `src/terminal/panel.ts` to fetch inventory, call `resolveSessionPlan` with the remaining pane slots, and attach every `attach` entry sequentially via `addPane({ sessionId, createdAt })`
- [x] 2.2 Re-check the panel's hidden state and the pane cap between sequential attaches; collapse the per-pane `fitAll()` into one call after the batch
- [x] 2.3 Set the active pane after the batch from `resolveActiveSessionId`
- [x] 2.4 Fall through to the chooser only when `attach` is empty and `decide` is non-empty; fall through to a fresh `addPane()` when both are empty
- [x] 2.5 Confirm `handlePaneUnavailable`'s reconcile cannot loop under auto-attach — inventory's `attached` flag and `prepareSession`'s collision check read the same holder state, so a collided session returns as attached-elsewhere and lands in `decide`; document the reasoning at the call site (a per-cycle exclusion set was built first, then removed as a guard against an unreachable state)
- [x] 2.6 Verify the per-window restore path (`state.panes` non-empty) still bypasses inventory entirely

## 3. Touch single-pane presentation

- [x] 3.1 Add the touch-mode CSS in `src/styles.css` hiding `.terminal-pane:not([data-active])` and the inter-pane resizers under `html[data-ui-mode="touch"]`
- [x] 3.2 Refit the newly revealed pane from `setActivePane` on the next frame; confirm `fitAll()` skips unmeasurable (hidden) panes without error
- [x] 3.3 Confirm hidden panes stay attached — no `detach()`, no record mutation — and that switching back shows the output that accumulated
- [x] 3.4 Verify desktop mode still renders every pane with its stored split geometry after a touch-mode visit

## 4. Keybar switch affordance

- [x] 4.1 Add the `{ kind: "switch" }` item to `KeybarItem` / `KEYBAR_ITEMS` in `src/terminal/keybar.ts`, rendered leftmost and visually separated
- [x] 4.2 Extend `KeybarDeps` with `openSwitcher()`, `dismissSwitcher()`, `isSwitcherOpen()`; wire the button to toggle on `click` and keep `aria-expanded` in sync
- [x] 4.3 Disable the switch action while the selection transcript is open, alongside the other non-selection keys
- [x] 4.4 Style the switch button in `src/styles.css`, distinct from the key pills and respecting the existing safe-area treatment
- [x] 4.5 Extend `keybar.test.ts`: toggle behavior, `aria-expanded`, disabled-in-selection-mode, no second sheet on repeat activation

## 5. Switcher sheet

- [x] 5.1 Add the `#terminal-switcher` container to `src/index.html` inside the terminal panel, after the keybar
- [x] 5.2 Render rows from `buildSwitcherRows`: select to switch/attach, explicit Take over on attached-elsewhere rows, terminate per row, and a New terminal action
- [x] 5.3 Wire selection to `setActivePane` (attached rows) and `addPane` (detached rows and New terminal), dismissing the sheet and focusing the visible pane
- [x] 5.4 Route terminate through the existing confirm + `killSessionRemote` path; on terminating the visible terminal fall back to another attached pane, or close the panel when none remains
- [x] 5.5 Disable New terminal and attach actions at the pane cap with a stated reason, leaving switching between attached panes available
- [x] 5.6 Add backdrop-tap dismissal and position the sheet against the visual-viewport sizer so it stays put with the software keyboard up
- [x] 5.7 Style the sheet in `src/styles.css`: above the keybar, terminal theming, scrollable list, safe-area inset
- [x] 5.8 Suppress `renderSessionPicker` in touch mode — the `decide` path presents the switcher instead

## 6. Escape and badge wiring

- [x] 6.1 Add the open-switcher branch ahead of fullscreen exit in the panel's capture-phase Escape handler, consuming the key
- [x] 6.2 Cover the precedence chain (switcher → selection transcript → fullscreen exit → pass-through) with a unit test over the pure routing helper
- [x] 6.3 Confirm the Terminal tab output badge fires for output from hidden attached panes, not only the visible one

## 7. Verification

- [x] 7.1 Add an E2E in `tests/e2e/` covering auto-attach: several detached sessions, panel opens, all attach, no chooser
- [x] 7.2 Add an E2E covering the touch switcher: one pane visible, switch to another terminal, create a new terminal, take over an attached-elsewhere session explicitly
- [x] 7.3 Extend `terminal-collision.e2e.ts` for the reconcile path under auto-attach: a window whose saved pane reference was claimed by another window lands on the decision surface rather than re-attaching
- [x] 7.4 Update the E2E specs that encoded the old always-ask rule (`terminal-session-manager.e2e.ts`), then run `bun test` and `bun test:e2e`
- [x] 7.5 Validate the change with `openspec validate add-terminal-auto-attach-switcher --strict`

Suite status at the end of implementation: `bunx tsc --noEmit` clean; `bun test`
1287 pass / 0 fail; every terminal E2E spec passes (13/13 across
`terminal-session-manager`, `terminal-collision`, `terminal-switcher`). The full
`bun test:e2e` run reported 5 failures, all in specs this change does not touch
(`find`, `document-tree`, `change-overview`, `personal-state`). A stashed
baseline run of those same four specs reproduced `find` and `document-tree`
failures without any of this change's code, and re-running them on the branch
leaves only `find` — i.e. pre-existing order- and timing-sensitive tests, not
regressions from this work. `find.e2e.ts:96` (⌘G stepping) fails identically
with and without the change and is worth a separate look.

The branch is `feat/terminal-auto-attach-switcher`. Land it through a PR with a
`feat(terminal):` subject describing the change; auto-attach and the touch
switcher are new user-visible behavior on top of the latest stable release, so
they belong in the release notes as-is with no override.
