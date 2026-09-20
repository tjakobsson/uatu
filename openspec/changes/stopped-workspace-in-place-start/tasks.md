## 1. The stopped fact, from the hub

- [x] 1.1 In `src/shell/hub-nav.ts`, add a pure `currentSessionRunning(workspaces, currentId): boolean | null` (null when the id is not listed) and a module-level publisher `onCurrentSessionRunning(listener)` that hub-nav feeds wherever `updateChip()` runs; on a non-hub page it never publishes. Verify with `src/shell/hub-nav.test.ts` cases: listed running → true, listed stopped → false, unlisted → null.
- [x] 1.2 When the activity topic reports `running: false` for the current workspace, call the existing `refreshHubState()` before publishing, and publish from the refreshed list; `running: true` publishes at once. Verify with a hub-nav test that activity `running: false` while the hub list still says running publishes `true` (no Stopped), and that the list saying stopped publishes `false`.
- [x] 1.3 Extract the switcher's start routine into `startWorkspaceSession(id)` (POST start, `startFailureNeedsHubUnlock` hand-off to `/`, error surfaced to the caller) and use it for other workspaces' rows exactly as today. Verify `bun test src/shell/hub-nav.test.ts` and the existing `tests/e2e/hub-switcher.e2e.ts` still pass.

## 2. The indicator

- [x] 2.1 In `src/shell/connection.ts`, add a `sessionStopped` input alongside `connectionRawState`; `syncConnectionDisplay()` shows label `Stopped`, title `The workspace session is stopped`, accessible name `Start the workspace session`, class `is-stopped`, and no pulse whenever the flag is set and the channel is not confirmed live. Keep the translation a pure export. Verify with `src/shell/connection.test.ts`: stopped + reconnecting → `Stopped`; stopped + live → `Connected`; flag cleared → back to the channel's word.
- [x] 2.2 Route activation: while `Stopped`, call `startWorkspaceSession(currentId)` and show the attempt (`is-attempting`, `aria-busy`), refusing a second start while one is in flight; otherwise `requestManualRecovery()` as today. Render a refusal message in a new `#connection-error` line (`role="alert"`, hidden by default) beneath the indicator in `src/index.html`, clearing it on the next activation or on `Connected`. Verify with connection tests: a stopped click posts start and does not call `requestManualRecovery`; a 200 leaves the display to the stream; a non-200 shows the message and the control is enabled; a locked refusal navigates to `/`.
- [x] 2.3 Style `.connection-state.is-stopped` and `#connection-error` in `src/styles.css` (static dot in the stopped tone, no animation, `prefers-reduced-motion` unaffected; error line matches the shell's `local-error` idiom) at desktop and touch sizes. Verify by eye in `bun run dev` after stopping the workspace from the dashboard, in light and dark schemes.

## 3. No reload for a stopped session

- [x] 3.1 In `src/shell/live.ts`, give the manual-recovery deps a `sessionStopped: () => boolean` reader (default: hub-nav's published fact) and skip `deps.reload()` on timeout when it returns true, settling the attempt as `timeout` without navigating. Verify with `src/shell/live.test.ts`: an attempt that times out while stopped does not reload; one that times out while not stopped still reloads.
- [x] 3.2 After a 200 from start, if no `live` arrives within `MANUAL_RECOVERY_WINDOW_MS`, drop the attempting state so the indicator shows whatever the channel reports (`Reconnecting`, with its ordinary action). Verify with a connection test that uses the injected clock.

## 4. The switcher's current row

- [x] 4.1 In `renderMenu()`, let the current workspace's row use `startWorkspaceSession` when stopped, with the `starting…` / `unlock in Hub…` words; on success do not navigate. Verify with a hub-nav DOM test (happy-dom, as the existing hub-nav tests use) that the current stopped row posts start and the page location is unchanged.

## 5. End to end

- [x] 5.1 Add `tests/e2e/hub-stopped-session.e2e.ts` on the hub fixtures: open a session with a document previewed and a chat draft typed, stop it through `POST /api/hub/sessions/<id>/stop`, assert the indicator reads `Stopped` (title `The workspace session is stopped`) and the switcher chip is not live without reload, click the indicator, assert `Connected`, the same document previewed, the draft intact, and `page.evaluate(() => performance.navigation.type)` / a boot stamp showing no reload. Verify it passes with `bun test:e2e --grep hub-stopped-session`.
- [x] 5.2 In the same file, cover the start-from-elsewhere path (stop, assert `Stopped`, start through the hub API, assert `Connected` with no click) and the switcher's current-row start (stop, open menu, click current row, assert `Connected`). Capture `Stopped` and the recovered state at desktop and phone sizes through `tests/e2e/evidence.ts`. Verify both pass and the screenshots appear in Playwright's `test-results/`.
- [x] 5.3 Run `bun test` and `bun test:e2e --grep "hub"` and verify `hub-switcher`, `hub-live-stream`, and the new file pass together; `src/shared/app-url-discipline.test.ts` must stay green (the start URL goes through the hub origin, as the switcher's does today).
