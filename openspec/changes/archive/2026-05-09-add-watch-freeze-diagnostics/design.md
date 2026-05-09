## Context

[Issue #40](https://github.com/tjakobsson/uatu/issues/40) captured a single hard freeze of `uatu watch` after ~1h35m of runtime on macOS 26.4.1. The `sample` output is unambiguous: the JS event loop is dead, every Bun worker thread is parked on `__ulock_wait2`, and both the main thread and the chokidar "File Watcher" thread are stuck on the same `_os_unfair_lock` site inside uatu. Process at 0% CPU. The freeze is consistent with a known class of native deadlock between chokidar's JS consumer and the FSEvents producer thread on recent macOS releases.

Two operational constraints fall out of this:

1. **Anything in-process is wedged with everything else.** A JS-side `setInterval` watchdog cannot fire when the loop is dead. A Bun `Worker` cannot help either — the sample shows worker pool threads themselves blocked on the same scheduler primitive. This rules out the obvious "watchdog timer" pattern.
2. **The user has no escape.** With a JS-installed `SIGINT` handler in place but no event loop to dispatch it on, Ctrl+C silently disappears. The user is forced to escalate to `kill -9` from another terminal.

We don't yet know the *trigger* for the freeze. The instrumentation this change adds is what we need in place *before* the next incident in order to learn anything from it. This change does **not** attempt to fix the underlying chokidar/fsevents deadlock.

## Goals / Non-Goals

**Goals:**
- After the next freeze, the developer has on disk: counter trends from the minutes leading up to the wedge, a fresh `sample` dump, an `lsof` snapshot, and a simple cause indicator — without needing to be at the keyboard when it happened.
- The `uatu watch` process is reliably killable from its own terminal via Ctrl+C, regardless of internal event-loop state.
- The instrumentation overhead is negligible when `--debug` is off (counters incremented but not flushed; heartbeat is a single fs.utimes call per second).
- The watchdog requires no new runtime dependencies and no separate binary — uatu re-execs itself in `--watchdog` mode.

**Non-Goals:**
- Fixing the chokidar/fsevents native deadlock. That's a follow-up informed by the data this change collects.
- A general-purpose metrics/observability platform. Counters here are scoped to the freeze hypothesis: watcher events, refresh lifecycle, git execs, fd count, PTY count.
- Streaming metrics to any remote system. All data is local-only.
- Crash-reporting / telemetry. Nothing is sent off-machine.

## Decisions

### D1. Watchdog as a sibling subprocess (single binary, re-execed with `--watchdog`)

Spawn a child process at `uatu watch` startup using `Bun.spawn([process.execPath, '--watchdog', String(process.pid), heartbeatPath, dumpDir])`. The watchdog process imports a minimal entry point (no chokidar, no terminal stack, no HTTP server) and does only: read heartbeat mtime in a 1s loop, on staleness invoke `sample` and `lsof`, then `kill -9` the parent.

**Why:**
- Same binary keeps distribution simple; no second artifact, no PATH lookup.
- Sibling rather than parent so killing the watchdog itself doesn't tear down uatu, and the parent uatu PID is what users already see.
- Out-of-process is the only design that keeps working when the parent's event loop is dead — see Context point 1.

**Alternatives considered:**
- *Same-process Bun Worker.* Rejected: the [issue #40](https://github.com/tjakobsson/uatu/issues/40) sample shows all 13 Bun pool threads blocked on the same scheduler primitive that the main thread is, so the wedge halts workers too.
- *POSIX `setitimer` / `SIGALRM` re-armed each tick.* Cheap and works while wedged, but Bun does not expose `setitimer` and a reliable signal-driven `_exit` from native code requires a small native shim. Higher cost than spawning a second process.
- *External watchdog (launchd plist, separate package).* Heavier setup burden on the user and platform-specific. Out of scope.

### D2. Heartbeat via file mtime, not a socket

Main process touches `~/.cache/uatu/heartbeat-<pid>` every 1s via `fs.utimes`. Watchdog `stat`s it every 1s. If `now - mtime > UATU_HEARTBEAT_TIMEOUT_MS` (default 30000), it counts as stale.

**Why:** mtime survives across event-loop pauses gracefully. A unix socket would require a connected reader and recovery logic if the writer hung mid-write. `fs.utimes` is a single syscall on the writer side, fast enough to skip in the common case but fast enough to keep tight if needed.

**Alternatives considered:**
- *Unix domain socket with framed pings.* Stronger semantics (we'd see partial writes), but adds a connect/reconnect state machine to the watchdog. Not worth it for a 1Hz heartbeat where mtime tells us everything we need.
- *Shared memory / named semaphore.* Overkill.

### D3. Threshold of 30s for staleness, with override

Default `UATU_HEARTBEAT_TIMEOUT_MS=30000`. Long enough to absorb an unusual GC pause, a slow `scanRoots` over a giant repo, or a stop-the-world Bun internal. Short enough that a real freeze costs the user at most ~30s of wait before the watchdog acts.

A `--watchdog-timeout=<ms>` flag and the env var let the user tune it. Disabling the watchdog entirely is `--no-watchdog` (rarely needed, but the escape hatch matters when the watchdog itself misbehaves).

### D4. Counters are always incremented; only flushed when `--debug` is on

The counter registry (`src/debug-metrics.ts`) lives in-process unconditionally — the increment is a property bump on a plain object, so the cost is invisible. What's gated by `--debug` is:
- The 1-second NDJSON flush to disk
- The `/debug/metrics` HTTP route
- The 5-second fd/rss sampling pass (uses `lsof` / `process.memoryUsage()` and is non-trivial)

This means counters are *available* to the watchdog regardless of mode (the watchdog can read the latest snapshot from a small JSON file the main process always writes). Verbose history requires opt-in.

**Why not always-on flushing:** disk write + JSON serialization once per second is fine but constitutes background noise users don't need by default.

### D5. NDJSON ring buffer, not append-forever

`~/.cache/uatu/debug-<pid>.ndjson`. One JSON line per second. When the file exceeds 10MB (~1h at typical sizes), the writer truncates the oldest 50% in place. This avoids unbounded growth and keeps the most recent history — which is what matters for autopsy — intact.

**Alternatives considered:**
- *Daily rotation.* More files, more cleanup. Overkill for a debug aid.
- *Streaming to a SQLite DB.* Overkill, adds a dep.

### D6. Forensic dump bundle on freeze (cross-platform with per-OS adapters)

When the watchdog detects staleness, before killing the parent it writes (in `~/.cache/uatu/`):
- `dump-<pid>-<timestamp>.stack.txt` — captured via a platform adapter
- `dump-<pid>-<timestamp>.fds.txt` — captured via a platform adapter
- `dump-<pid>-<timestamp>.metrics-tail.ndjson` — last 1000 lines of the live NDJSON if `--debug` was on, else the snapshot file
- `dump-<pid>-<timestamp>.cause.json` — `{ reason, pid, lastHeartbeatMs, ageMs, platform }`

Then force-kills the parent. We don't try SIGTERM first — a wedged process won't service it, and the data is already captured.

The capture is split into two interfaces (`captureStack(pid)` and `captureFds(pid)`) with per-platform implementations:

| Platform | Stack capture | FD listing | Force-kill |
|---|---|---|---|
| macOS (`darwin`) | `sample <pid> 5` (5s cap) | `lsof -Pan -p <pid>` (5s cap) | `process.kill(pid, 'SIGKILL')` |
| Linux | read `/proc/<pid>/stack`, `/proc/<pid>/wchan`, `/proc/<pid>/syscall`, `/proc/<pid>/status` | read `/proc/<pid>/fd/` directly via `fs.readdir` + `fs.readlink` | `process.kill(pid, 'SIGKILL')` |
| Windows (`win32`) | not implemented — write a "stack capture not available on win32" sentinel | not implemented — same sentinel | `process.kill(pid)` (Bun maps to `TerminateProcess`) |

Rationale for the split:
- The watchdog *loop* (heartbeat staleness detection, dump orchestration, force-kill, exit-when-parent-gone) is identical across platforms and uses only Bun/Node built-ins.
- The two adapters are <30 LOC each and independently testable.
- Linux's `/proc` reads do not require any external command — a small win for portability and for not requiring `lsof` to be installed.
- Windows fidelity is intentionally lower for v1. The kill-and-reap path still works (Bun.spawn → Bun.kill → kernel reaps PTYs), just without forensic data. We can revisit when there's a Windows-native incident to motivate it.

A subdirectory cleanup pass on `uatu watch` startup deletes dumps older than 14 days.

### D7. Remove the JS-side `SIGINT` handler entirely

Currently `cli.ts` registers a SIGINT handler that schedules graceful shutdown via the event loop. When the loop is dead this handler is unreachable, so Ctrl+C is silently dropped.

We remove the handler. Default OS termination kills uatu immediately on SIGINT. The PTY children currently torn down via `terminalServer.disposeAll()` get reaped by the kernel anyway: when the parent process dies the master PTY fd closes, the kernel sends SIGHUP to the child group. The user-visible outcome ("PTYs cleaned up on exit") is preserved.

**Trade-off accepted:** we lose the graceful chokidar `watcher.close()` and SSE-subscriber `close()` calls. Both are best-effort cleanup that the OS does for us. No load-bearing logic runs in the SIGINT path today.

**Why this over a "double-tap Ctrl+C":** double-tap requires the JS handler to actually run on the *first* SIGINT to start a 1s timer — but that handler is exactly what doesn't run when wedged. Doesn't help the failure mode we're fixing.

### D8. `awaitWriteFinish.pollInterval` 25ms → 250ms

Independent of the freeze story. Current setting causes chokidar to `fs.stat` each pending file every 25ms until 100ms of stability — under heavy churn that's hundreds of stats/sec from the main thread. Loosening to 250ms cuts that 10× with a worst-case 250ms latency increase on the "save → re-render" path that the user will not perceive.

This is bundled into this change because it's a one-line tweak in the same code region we're already touching, and reducing main-thread fs pressure is plausibly a freeze contributor (we don't know yet — see [issue #40](https://github.com/tjakobsson/uatu/issues/40)).

## Risks / Trade-offs

- **Risk:** Watchdog itself becomes a flake — false positives (kills a healthy uatu mid–slow-scan) or zombies (parent died but watchdog lingers).
  **Mitigation:** Default 30s timeout is generous. Watchdog `kill(0, parentPid)` checks reachability each tick and exits cleanly when the parent is gone. A `--no-watchdog` flag exists for the rare case where it misbehaves.

- **Risk:** Removing the SIGINT handler regresses something subtle in PTY teardown that wasn't covered by tests.
  **Mitigation:** The only documented scenario in `embedded-terminal/spec.md` for shutdown is "every live PTY is terminated as part of shutdown" — which OS-level reaping satisfies. If we discover a regression (e.g., a child shell needing explicit `SIGHUP` for a clean prompt log), we can install a minimal SIGINT handler that only does `terminalServer.disposeAll()` synchronously then `process._exit(130)` — but that handler still won't fire when wedged, so we'd be back to today's hang. Keep the simpler version.

- **Risk:** `lsof` on a busy system is slow and outputs a lot. The watchdog runs it on a wedged-but-still-running process, so locks held inside the parent could affect lsof. In practice `lsof` reads from `/proc`-equivalents and process tables that don't depend on the parent's userspace state, so this should be fine — but worth verifying empirically.
  **Mitigation:** Cap `lsof` runtime at 5s; if it exceeds, write a "lsof timed out" marker and skip.

- **Risk:** Forensic dumps leak repo paths if the user shares them upstream.
  **Mitigation:** Document this in the help text for `--debug` and in any "how to file a bug report" section. Optionally, future enhancement: redact paths before writing. Out of scope for this change.

- **Trade-off:** The watchdog adds ~5MB of process memory (a second Bun process, even minimal). Acceptable for a developer tool.

- **Trade-off:** `~/.cache/uatu/` becomes a user-visible directory. Worth following XDG conventions (`$XDG_CACHE_HOME` first, fall back to `~/.cache`) so it lands in the conventional spot on Linux and is unobtrusive on macOS.

## Migration Plan

This is additive within `uatu watch`:

1. Existing users see no behavior change other than: Ctrl+C now exits *immediately* instead of running the (mostly invisible) graceful path. That's an improvement, not a regression.
2. The watchdog spawns by default. If it causes problems, `--no-watchdog` disables it without requiring a redeploy.
3. `--debug` is off by default. NDJSON files only appear when explicitly enabled.
4. No database / persistent state to migrate. Old `~/.cache/uatu/` (if any) is left untouched; new files are siblings.

Rollback: revert the change. No on-disk state is required for normal operation.

## Resolved Decisions (initially open)

- **Flag name `--debug`** — confirmed. Short, natural for "I'm trying to understand a freeze."
- **`awaitWriteFinish` loosening is unconditional** — applies whether or not `--debug` is set. It's a sensible default regardless of debug mode.
- **`/debug/metrics` does not require an auth token** — counters expose no information beyond what other 127.0.0.1 endpoints already do. If sensitive data is ever added to this endpoint, this decision is revisited.
- **Watchdog is cross-platform, with per-OS forensic adapters** — see D6. The watchdog *itself* is portable; only the stack/FD capture commands branch on `process.platform`.

## Open Questions

- **Auto-open dumps in editor / Finder when one is produced?** Nice-to-have, not core. Skip for v1.
- **Windows forensic fidelity** — v1 ships without stack/FD capture on win32. Worth filing a follow-up issue if a Windows freeze is ever observed, but not blocking.
