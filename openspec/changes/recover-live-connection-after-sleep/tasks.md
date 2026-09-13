## 1. Keep the page able to recover

- [x] 1.1 Change `createLifecycleRecovery`'s `pagehide` handling in `src/shell/recovery.ts` so no lifecycle event triggers permanent teardown, replacing the `discard` callback with a reversible release; verify by a unit test asserting that an unpersisted `pagehide` followed by a `visibilitychange` to visible runs recovery
- [x] 1.2 Replace the `recovery.test.ts` case "a discarded page tears the channel down; a frozen one does not" with cases covering the new contract, including that the wake-up listeners remain registered after an unpersisted `pagehide`
- [x] 1.3 Wire `src/shell/live.ts` to release rather than dispose on that signal, keeping `disposeLiveChannel` available for explicit teardown and hub navigation; verify by a unit test asserting subscriptions and cursors survive the release and are re-presented on the next connect
- [x] 1.4 Delete the Chat teardown on an unpersisted `pagehide` in `src/chat/ui.ts`, keeping only the draft flush; verify by a test in `src/chat/lifecycle.test.ts` asserting Chat's inventory and conversation streams are delivering again after that event plus a return to visible, and that the draft written before the event is still present

## 2. Bound every recovery task

- [x] 2.1 Give the state reconciliation fetch in `src/shell/events.ts` a timeout and abort signal, matching the Chat client's read budget pattern; verify by a unit test asserting the fetch rejects rather than hanging when the response never arrives
- [x] 2.2 Add a ceiling in `src/shell/recovery.ts` that clears the in-flight guard when a recovery exceeds it; verify by a unit test asserting a never-settling `recover` does not prevent the next wake-up signal from starting a new recovery

## 3. Give the user a way back

- [x] 3.1 Add one `requestManualRecovery()` to `src/shell/live.ts` that recovers in place, waits a bounded window for the channel to confirm live, and otherwise reloads, ignoring calls while an attempt is in flight; verify by unit tests covering the recovering, the falling-back, and the already-in-flight paths with an injected reload
- [x] 3.2 Add a Reconnect action to Chat's connection-interruption status line in `src/chat/ui.ts` that calls it; verify by a unit test asserting the action is present while interrupted, absent otherwise, and that recovering in place preserves the draft and timeline position
- [x] 3.3 Make the connection indicator a button in `src/index.html`, `src/styles.css`, and `src/shell/connection.ts` with an accessible name for the reconnect action and a touch-mode hit target, calling the same recovery; verify by a unit test asserting the accessible name, that it is inert while confirmed live, and that an in-flight attempt is communicated

## 4. Prove it in the running app

- [x] 4.1 Add an e2e case in `tests/e2e/` driving an unpersisted `pagehide` then a return to visible, asserting the indicator returns to `Connected` without a reload
- [x] 4.2 Add an e2e case asserting Chat's Reconnect action recovers a stalled page in place, and one asserting the indicator button does the same
- [x] 4.3 Save screenshots of Chat's interruption line with its Reconnect action, the indicator button, and an in-flight attempt, in touch mode, to `openspec/changes/recover-live-connection-after-sleep/screenshots/`
