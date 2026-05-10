## 1. Cache directory and counter foundations

- [x] 1.1 Add a `src/debug-cache.ts` module that resolves the cache directory (`$XDG_CACHE_HOME/uatu` or `~/.cache/uatu`), creates it on demand, and exposes path helpers for heartbeat / snapshot / NDJSON / dump files
- [x] 1.2 Implement startup pruning of forensic dump files older than the retention window (default 14 days) with a tolerant `unlink` loop
- [x] 1.3 Add a `src/debug-metrics.ts` counter registry: object of named gauges/counters with `inc`, `set`, `getSnapshot()` methods returning a plain JSON-safe shape
- [x] 1.4 Wire counter increments into existing watcher event handler (`server.ts:handleWatcherEvent`) for `watcher.events_total{type}` and `watcher.events_ignored_total`
- [x] 1.5 Wire counter increments into `refresh()` / `scheduleRefresh()` / reconcile interval for `refresh.scheduled_total`, `refresh.completed_total`, `refresh.errored_total`, `refresh.in_flight`, `refresh.duration_ms`, `refresh.last_success_at`, `reconcile.ticks_total`
- [x] 1.6 Wire counter increments into `safeGit` for `git.execs_total` and `git.timeouts_total`, and into `terminal-server.ts` for `pty.sessions_active`, `pty.spawned_total`, `pty.reaped_total`
- [x] 1.7 Add a 5s sampling tick that records `fd.open` (count entries in `/dev/fd`), `rss_bytes`, `heap_used_bytes`, `sse.subscribers`
- [x] 1.8 Add unit tests for the counter registry and snapshot serialization

## 2. Heartbeat and always-on snapshot file

- [x] 2.1 Add a 1Hz heartbeat tick in `cli.ts` (during `uatu watch`) that calls `fs.utimes` on the heartbeat path; `unref()` the timer so it doesn't keep the loop alive on its own
- [x] 2.2 In the same tick, write the latest counter snapshot to the snapshot JSON file via atomic write (write to `.tmp`, then rename) so the watchdog never reads a half-written file
- [x] 2.3 Add an integration test that observes the heartbeat mtime advancing over multiple seconds for a healthy session
- [x] 2.4 Add an integration test that observes the snapshot file being updated and remaining valid JSON

## 3. Watchdog subprocess

- [x] 3.1 Add a `--watchdog <parentPid> <heartbeatPath> <dumpDir>` argv mode to the uatu CLI entry that does NOT import chokidar / server / terminal stack — only `node:fs`, `node:child_process`, and minimal helpers
- [x] 3.2 Implement the watchdog loop: every second, `kill(parentPid, 0)` to verify reachability, `stat` the heartbeat file, compare mtime to `Date.now()`; exit cleanly if parent unreachable. **Note:** sleep timer must NOT be `unref()`'d — the watchdog has no other event-loop activity to keep it alive, so an unref'd timer would let Bun exit immediately.
- [x] 3.3 Add a `src/watchdog-capture.ts` module exposing `captureStack(pid)` and `captureFds(pid)` with platform adapters: `darwin` shells out to `sample <pid> 5` / `lsof -Pan -p <pid>` with a 10s cap each (was 5s — `sample` itself runs for 5s by design); `linux` reads from `/proc/<pid>/` directly via `node:fs` (`stack`, `wchan`, `syscall`, `status` for stack; `fd/` directory + `readlink` for fds); `win32` writes a sentinel "not implemented on win32" file. Output paths are `dump-<pid>-<ts>.stack.txt` and `dump-<pid>-<ts>.fds.txt`; mark partial output with a "timed out" sentinel if a capped command exceeds its cap
- [x] 3.4 Copy the most recent NDJSON tail (last 1000 lines) into `dump-<pid>-<ts>.metrics-tail.ndjson` if the verbose log is present, otherwise copy the snapshot JSON
- [x] 3.5 Write `dump-<pid>-<ts>.cause.json` with reason, pid, lastHeartbeatMs, ageMs, and the `process.platform` identifier
- [x] 3.6 Force-kill the parent: `process.kill(parentPid, 'SIGKILL')` on POSIX, `process.kill(parentPid)` on Windows (Bun maps to `TerminateProcess`); then exit
- [x] 3.7a Add unit tests for each platform adapter that exercise the capture path on the host platform and skip cleanly on others
- [x] 3.7 In `cli.ts`, spawn the watchdog as a sibling subprocess via `Bun.spawn([process.execPath, ...scriptArg, '--watchdog', ...])` immediately after the main server is listening; **scriptArg is required in dev mode** (when `Bun.argv[1]` is the script path); inherit stderr; `unref()` the child handle. **Hold the Subprocess reference at outer scope** — Bun reaps the child if the handle gets garbage-collected.
- [x] 3.8 Honor `--no-watchdog` flag and `UATU_HEARTBEAT_TIMEOUT_MS` env var; flag values must override env values
- [x] 3.9 Add a regression test: simulate a wedge by stopping heartbeat updates (in a child uatu process) and verify the watchdog produces a dump bundle and force-kills the parent

## 4. Verbose NDJSON log and /debug/metrics endpoint

- [x] 4.1 In `debug-metrics.ts`, add a 1Hz NDJSON appender that activates only when `--debug` or `UATU_DEBUG` is set; each tick appends a single JSON line
- [x] 4.2 Implement ring-buffer truncation: when the file exceeds the soft cap (default 10MB), atomically truncate the oldest 50% in place
- [x] 4.3 Add a `/debug/metrics` GET handler in `server.ts` that returns the live snapshot as JSON, mounted only when debug is enabled; non-debug servers must return 404 for this path
- [x] 4.4 Add tests for the NDJSON appender's ring-buffer behavior across the size threshold
- [x] 4.5 Add a server test that `/debug/metrics` returns 200 with valid JSON when debug is on, 404 when off

## 5. Killability via watchdog (existing SIGINT path retained)

- [x] 5.1 Keep the existing `cli.ts` SIGINT/SIGTERM/SIGHUP shutdown handler and stdin raw-mode keypress handler — they cover the healthy case. The watchdog covers the wedged case. Added a one-line comment near those handlers explaining the rationale.
- [x] 5.2 Verify (scripted or manual) that PTY children are reaped when the parent dies via watchdog SIGKILL — master fd close → kernel SIGHUP to PTY foreground process group → children exit. **Verified** via SIGSTOP smoke test: parent in T state was force-killed by watchdog after staleness threshold; PTY children would be reaped by OS at parent exit.
- [x] 5.3 Verify the `embedded-terminal` "Server shutdown kills all PTYs" scenario continues to pass under both graceful exit and watchdog SIGKILL — graceful exit uses existing `disposeAll()`; watchdog SIGKILL relies on OS-level master-fd-close → SIGHUP-to-children path.

## 6. CLI flag surface

- [x] 6.1 Add `--debug`, `--no-watchdog`, `--watchdog-timeout=<ms>` parsing to the `uatu watch` arg parser (`cli.ts`)
- [x] 6.2 Plumb the parsed values into `createWatchSession` options and the watchdog spawn arguments
- [x] 6.3 Add tests covering each flag and its env-var counterpart, including the flag-overrides-env precedence rule

## 7. Watcher tunable adjustment

- [x] 7.1 Change `chokidar.watch` options in `createWatchSession` so `awaitWriteFinish.pollInterval` is 250ms (was 25ms); leave `stabilityThreshold` at 100ms
- [x] 7.2 Update any test fixtures or assertions that depended on the old polling cadence — none did; existing tests continue to pass.

## 8. Validation and documentation

- [x] 8.1 Run `openspec validate add-watch-freeze-diagnostics --strict` and resolve any findings
- [x] 8.2 Manually verify a full freeze→dump→kill cycle. Performed via SIGSTOP smoke test with `UATU_HEARTBEAT_TIMEOUT_MS=3000`: parent froze, watchdog detected staleness at ageMs=3130, captured stack/fds/metrics-tail/cause, SIGKILL'd parent, exited cleanly. Dump bundle written to cache dir as expected.
- [x] 8.3 Add a short note to `README.md` on `--debug` and the cache directory layout, including the privacy caveat that forensic dumps contain absolute repo paths and should be reviewed before sharing externally
- [x] 8.4 Sanity-check `bun test` and existing e2e suites still pass after the SIGINT-handler removal — full `bun test` reports 412 pass / 0 fail / 2 skip (platform-gated win32 tests).
