## Why

`uatu watch` froze during normal dogfooding ([issue #40](https://github.com/tjakobsson/uatu/issues/40)) — wedging both the browser UI and the controlling terminal simultaneously. The captured `sample` shows the JS event loop fully stuck: main thread, file watcher, and every Bun worker pool thread parked on the same `_os_unfair_lock` inside the chokidar/fsevents bridge on macOS 26.4.1. Once wedged, nothing inside uatu can act: timers don't fire, the SIGINT handler can't run, Ctrl+C is silently swallowed, and the user has to escalate to `kill -9`. The next freeze, by default, will produce no useful data — we need instrumentation in place *before* it happens, and we need uatu to be killable when it does.

## What Changes

- Add an opt-in debug mode (`uatu watch --debug` and `UATU_DEBUG=1`) that records counters and gauges to a rotating NDJSON log on disk so a freeze leaves an autopsy behind.
- Add an always-on companion watchdog subprocess (started by `uatu watch`) that monitors a heartbeat file the main process touches every second; if the heartbeat goes stale beyond a configurable threshold, the watchdog captures stack and file-descriptor state via per-OS adapters (macOS: `sample` + `lsof`; Linux: `/proc` reads; Windows: sentinel) and force-kills the wedged process.
- **BREAKING (operator-visible only)**: remove the JS-side `SIGINT` handler. Ctrl+C now relies on default OS termination, which always works regardless of event-loop state. Terminal PTYs and the chokidar watcher are reaped by the kernel when the process exits; no JS-side teardown runs.
- Loosen `chokidar` defaults: `awaitWriteFinish.pollInterval` from 25ms to 250ms, reducing main-thread `fs.stat` pressure during heavy file churn (a likely contributor though not the root cause).
- Add a `/debug/metrics` endpoint (only enabled with `--debug`) that returns the live counter snapshot as JSON for ad-hoc inspection while the process is healthy.

## Capabilities

### New Capabilities
- `watch-freeze-diagnostics`: covers the diagnostic counters, the on-disk metrics log, the companion watchdog, the forensic dump bundle (sample + lsof + last metrics tail), and the post-wedge killability contract.

### Modified Capabilities
- `watch-cli-startup`: the `uatu watch` command surface gains a `--debug` flag and the documented startup behavior changes to spawn a watchdog subprocess.

## Impact

- **Affected source**: `src/cli.ts` (flags, watchdog spawn, signal handling), `src/server.ts` (counter instrumentation around `createWatchSession`, looser `awaitWriteFinish`, `/debug/metrics` route), new `src/debug-metrics.ts` (counter registry + NDJSON ring writer), new `src/watchdog.ts` (subprocess entry that uatu re-execs with a special argv).
- **No new runtime dependencies**. Watchdog uses Node/Bun built-ins (`Bun.spawn`, `node:fs`, `node:child_process` for `sample` and `lsof`). NDJSON is plain text appended to a file with a size cap.
- **Disk footprint**: opt-in NDJSON log capped at ~10MB rolling (last ~1h at 1Hz). Forensic dumps written only when a freeze is detected, in `~/.cache/uatu/`. A startup pass prunes dumps older than N days.
- **Privacy**: forensic `lsof` output contains absolute file paths from inside the user's repos. Files are local-only; documentation must call out that sharing them externally may leak paths.
- **Behavior change for users**: Ctrl+C terminates immediately rather than running a graceful shutdown. The previously-graceful PTY teardown is now performed by the OS via the dying master fd → child SIGHUP path. End-user-visible outcome (PTY children reaped on shutdown) is unchanged; the mechanism is.
- **Not addressed by this change**: the underlying chokidar/fsevents native deadlock. This proposal is explicitly about *detecting, surviving, and gathering data on* the freeze, not about preventing it. A follow-up change can use the data this one collects to decide between "loosen further", "switch off chokidar", or "report upstream".
