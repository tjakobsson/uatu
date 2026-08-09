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

## 8. Review follow-ups

- [x] 8.1 Stop per-pane activation during a batch attach — activating each pane overwrote the saved `lastPtyId` before `resolveActiveSessionId` read it, so "last-active wins" always degraded to "newest wins"; snapshot the saved id as well
- [x] 8.2 Add the regression E2E for 8.1 and verify it fails against the pre-fix code
- [x] 8.3 Track switcher openness in closure state claimed synchronously, and re-check it after every await, so a second tap toggles instead of rendering a second sheet and an in-flight refresh cannot reopen a dismissed sheet
- [x] 8.4 Declare that flag with the panel's other state — `initTerminalKeybar` reads it during setup, and a `let` declared later in the closure throws a TDZ `ReferenceError` that aborts boot (app hangs at "Connecting")
- [x] 8.5 Dismiss the switcher when the panel minimizes, in both CSS and state, so Escape cannot consume keys for an invisible sheet
- [x] 8.6 Honor the sheet's `aria-modal` with a Tab wrap inside it
- [x] 8.7 Dismiss the switcher when the active touch tab leaves Terminal — the panel stays mounted there by design, so nothing else marked the sheet gone: it kept claiming Escape on Preview, absorbed refreshes into invisible repaints, and reappeared on return
- [x] 8.8 Replace the `hidden`-attribute checks that stood in for visibility with `terminalSurfaceShowing()`, and gate the switcher's Escape claim on the terminal actually being on screen
- [x] 8.10 Scope the touch single-pane rule to real PTY panes (`[data-session-id]`) — the paste-token form and origin diagnostic reuse `.terminal-pane` but are never stamped active, so the rule hid them and left a blank Terminal tab with no way to reconnect once credentials expired
- [x] 8.11 Treat a pane whose session was taken over as not held: it now lists as attached-elsewhere with a working Take over, and its Kill sends a real DELETE instead of quietly dropping the local pane while the session kept running in the other window
- [x] 8.14 Hide touch-mode background panes with `visibility`, not `display: none`. Found while writing a test for 8.16: xterm defers `open()` until a ResizeObserver sees a non-zero rect and attach-ready waits on that open, so a `display: none` pane never completed its handshake — only the visible pane was truly attached, the server kept listing the rest as detached (claimable by another window), and no output reached their scrollback. Regression test asserts the server's own attached count, not the DOM
- [x] 8.15 Let a parked pane be reclaimed at the pane cap — reclaiming replaces that pane rather than adding one, and at the cap its own take-back notice is hidden too, so gating on spare capacity stranded it
- [x] 8.16 Sweep panes parked by a takeover whose session was then terminated elsewhere. Nothing else notices (no socket left to close), so they sat invisible holding a pane-cap slot until reload — an invisibility introduced by 8.11
- [x] 8.13 Route every session→pane lookup through one attached-aware helper. Making parked panes actionable rows (8.11) left the row handlers on the old "any pane" notion: selecting revealed the dead pane instead of reconnecting, and Take over minted a second entry for the same session — an orphan that consumed a pane-cap slot permanently and made lookups ambiguous. Re-acquiring now replaces the parked pane, sweeping it *after* the attach lands so the pane count never dips to zero and hides the panel
- [x] 8.12 Correct the pane-cap scenario — detached overflow is listed by the touch switcher and attaches when a slot frees; it is not immediately reachable from the desktop chooser at the cap (follow-up, not a regression)
- [x] 8.9 Correct the unit test that asserted the buggy precedence (an off-tab switcher claiming Escape) and add the desktop-mode counterpart; add the E2E regression, verified to fail against the pre-fix code

Verified by hand on an iPhone through `uatu hub` over Tailscale: auto-attach,
one-pane-at-a-time rendering, the keybar switch action, and the sheet all behave
as specced on a real phone.

Suite status after the review follow-ups: `bunx tsc --noEmit` clean; `bun test`
1288 pass / 0 fail; 38/38 pass across the terminal and touch specs
(`terminal-session-manager`, `terminal-collision`, `terminal-switcher`, `ipad`,
`mobile`). The full `bun test:e2e` run reports 286 pass / 2 fail, both in specs
this change does not touch: `find.e2e.ts:96` (⌘G stepping), which a stashed
baseline run reproduced without any of this change's code, and
`change-overview`, which passes on the baseline and in targeted re-runs — i.e.
pre-existing order- and timing-sensitive tests, not regressions. `find.e2e.ts:96`
is worth a separate look.

The branch is `feat/terminal-auto-attach-switcher`. Land it through a PR with a
`feat(terminal):` subject describing the change; auto-attach and the touch
switcher are new user-visible behavior on top of the latest stable release, so
they belong in the release notes as-is with no override.
