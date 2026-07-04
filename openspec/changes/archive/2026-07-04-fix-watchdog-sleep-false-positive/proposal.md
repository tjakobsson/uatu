# Fix watchdog sleep false-positive

## Why

The watchdog declares a hang by comparing the heartbeat file's mtime against
wall-clock time (`Date.now() - mtimeMs > timeoutMs` in `src/watchdog/main.ts`).
System sleep suspends both processes but wall-clock keeps advancing, so on wake
the heartbeat looks minutes stale; whichever pending 1-second timer fires first
wins the race, and when the watchdog wins it SIGKILLs a perfectly healthy uatu.
Forensic dumps on this machine confirm it: five `stale-heartbeat` kills with
`ageMs` of ~3, ~14, and ~15 minutes — two of them at the identical millisecond
(one wake killing two instances). Users experience this as "uatu dies when the
laptop sleeps".

## What Changes

- Staleness detection changes from wall-clock heartbeat age to **consecutive
  watchdog ticks during which the heartbeat mtime has not advanced**. Ticks only
  accumulate while the watchdog is actually running, so suspension accumulates
  zero ticks; on wake, the parent's own 1 Hz heartbeat advances the mtime within
  a tick and the counter resets.
- The configured timeout (`--watchdog-timeout` / `UATU_HEARTBEAT_TIMEOUT_MS`,
  default 30 000 ms) keeps its meaning — it maps to
  `ceil(timeoutMs / TICK_INTERVAL_MS)` required consecutive stale ticks, i.e.
  ~30 seconds of *observed* staleness while awake.
- A genuinely wedged process is still killed on the same schedule: frozen mtime
  plus 30 live ticks → dump + SIGKILL, unchanged.
- The forensic `cause.json` gains the observed stale-tick count alongside
  `ageMs` so future dumps distinguish real hangs from clock jumps.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `watch-freeze-diagnostics`: the "Watchdog subprocess detects and recovers from
  a wedged uatu watch" requirement's staleness definition changes from
  mtime-age-vs-wall-clock to consecutive-stale-ticks, and gains a scenario that
  system sleep/resume does not trigger a kill. The "wedged uatu watch is
  force-terminated within the watchdog staleness threshold" requirement is
  clarified: the threshold is measured in watchdog runtime, which equals
  wall-clock time whenever the system is awake.

## Impact

- `src/watchdog/main.ts` — the detection loop in `runWatchdog()` and the
  `cause.json` payload in `captureAndKill()`.
- `src/watchdog/*.test.ts` and `src/debug/` heartbeat integration test —
  staleness tests move from mtime-age fixtures to tick-count fixtures; add a
  simulated-sleep case (old mtime, fresh counter → no kill).
- No CLI surface changes: flags, env var, defaults, and dump layout are
  unchanged apart from the added `cause.json` field.
