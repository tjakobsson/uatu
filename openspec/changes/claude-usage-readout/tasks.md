## 1. Baseline

- [x] 1.1 Capture before screenshots of the composer chip and its tooltip at desktop (1400x1000) and phone width, and of the sidebar panels menu; save as `screenshots/before-plan-chip-desktop.png`, `screenshots/before-plan-chip-phone.png`, `screenshots/before-panels-menu.png`, and verify the files exist.

## 2. Data

- [x] 2.1 Widen `PlanUtilization` and add `ContextReportItem.session` in `types.ts` per design D1; verify `bun run tsc --noEmit` (or the project's typecheck) passes.
- [x] 2.2 Extend `normalizePlanUtilization` in `claude/provider.ts` to read subscription, per-model windows, model-scoped buckets, and extra usage, and add a session-totals normaliser; verify with unit tests for a full response, a two-window response, a null `rate_limits`, and malformed fields.
- [x] 2.3 Extend wire validation in `validation.ts` for the new optional fields; verify with unit tests that a superset report passes, a wrong-typed field fails, and an unknown window key is ignored.

## 3. Composer chip and readout

- [x] 3.1 In `composer-status.ts`: rename the label to "Session N% · Week N%", add `planUtilizationLevel`, `planReadoutRows`, and `relativeReset`; verify with unit tests for label, 80% warning threshold, row order with per-model windows, and relative reset formatting.
- [x] 3.2 Replace `#chat-plan-usage` with the `<details>` readout in `index.html` and render rows (meter, percentage, absolute + relative reset), plan name, extra usage, and "This conversation" totals in `ui.ts`; tick relative resets once a minute while open; verify `bun test` passes.
- [x] 3.3 Styles for the readout (floating body like the context breakdown, meters, warning colour on the chip) with touch-mode sizing; verify visually in 5.1 screenshots.

## 4. Usage pane

- [x] 4.1 Add the `usage` pane to `ALL_PANE_DEFS`, defaults, and `index.html` chrome; verify `shell/state.test.ts` covers the hidden default and that stored state without `usage` still boots.
- [x] 4.2 Create `src/chat/usage-pane.ts` rendering rows or the empty state, and call it from `ui.ts` whenever a plan-bearing context report lands on any conversation; verify with a unit test for the empty state and a rendered row set.
- [x] 4.3 Add the "Keep in sidebar" pin to the readout, shown only in desktop mode with the sidebar expanded, revealing the pane through the pane-state owner; verify with an e2e in `sidebar.e2e.ts` that the pane appears and persists across reload.

## 5. End-to-end and screenshots

- [x] 5.1 E2E in `chat-claude-polish.e2e.ts`: push a context report with a full plan through the fake agent and assert the chip label, the warning attribute at 80%, the readout rows including "Week · Fable", and the conversation cost line; verify `bun test:e2e` passes for the chat and sidebar files.
- [x] 5.2 Capture after screenshots: `screenshots/after-plan-chip-desktop.png`, `screenshots/after-plan-readout-desktop.png`, `screenshots/after-plan-readout-warning-desktop.png`, `screenshots/after-usage-pane-desktop.png`, `screenshots/after-plan-readout-phone.png`; verify the files exist and pair with the before shots.
