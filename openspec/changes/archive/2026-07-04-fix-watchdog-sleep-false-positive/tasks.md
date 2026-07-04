# Tasks — fix-watchdog-sleep-false-positive

## 1. Detection loop

- [x] 1.1 In `src/watchdog/main.ts` `runWatchdog()`: replace the
      `now - mtimeMs > timeoutMs` check with a consecutive-stale-tick counter —
      remember the previous tick's mtime, increment on unchanged, reset on
      advance, and kill at `ceil(timeoutMs / TICK_INTERVAL_MS)` ticks.
- [x] 1.2 Keep the missing-heartbeat branch as-is (wait one tick, no counter
      increment); update the loop-invariant comment block at the top of the
      file to describe tick counting and why wall-clock age is not used.
- [x] 1.3 Thread the observed stale-tick count into `captureAndKill()` and add
      `staleTicks` to the `cause.json` payload (keep `ageMs` for context).

## 2. Tests

- [x] 2.1 Update watchdog unit tests: a heartbeat whose mtime is hours old but
      advances on the next tick does NOT trigger a kill (simulated wake).
- [x] 2.2 Add a test that a frozen mtime across the threshold's worth of ticks
      DOES trigger dump + kill, using a small `UATU_HEARTBEAT_TIMEOUT_MS` so
      the test runs in milliseconds.
- [x] 2.3 Verify `cause.json` in the dump-bundle test includes `staleTicks`
      consistent with the configured threshold.
- [x] 2.4 Run the heartbeat integration test in `src/debug/` and the full
      `bun test` suite; fix regressions.

## 3. Docs and spec sync

- [x] 3.1 Update any ARCHITECTURE.md / doc-comment references to
      "heartbeat older than 30s" semantics.
- [x] 3.2 Validate the change (`openspec validate fix-watchdog-sleep-false-positive`).
- [x] 3.3 Archive the change once it has landed (tested + merged).
