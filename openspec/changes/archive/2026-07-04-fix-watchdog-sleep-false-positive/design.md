# Design — fix-watchdog-sleep-false-positive

## Context

`runWatchdog()` in `src/watchdog/main.ts` loops at `TICK_INTERVAL_MS = 1_000`:
it stats the heartbeat file and kills the parent when
`Date.now() - stat.mtimeMs > timeoutMs` (default 30 000 ms). The parent
refreshes the heartbeat mtime at 1 Hz (`cli.ts`).

During system sleep both processes are suspended and neither timer fires, but
wall-clock time advances. On wake, each process's pending 1-second timer fires
once, in nondeterministic order. If the watchdog's fires first it observes
`ageMs ≈ sleep duration` (minutes), far beyond the 30 s threshold, and
SIGKILLs a healthy parent. Forensic dumps on the reporting machine show five
such kills (`ageMs` 197 s, 859 s ×2, 933 s), two at the identical
`detectedAtMs` — one wake killing two instances simultaneously.

## Goals / Non-Goals

**Goals:**
- Zero false kills across suspend/resume of any duration.
- Unchanged detection latency for genuine hangs: ~`timeoutMs` of awake time.
- No change to CLI flags, env vars, defaults, dump layout, or the
  no-new-dependency constraint.

**Non-Goals:**
- No detection of the *parent* being individually suspended (`SIGSTOP` on the
  parent alone still leads to a kill after the threshold, as today).
- No respawn/supervision of uatu after a legitimate watchdog kill.
- PTY/browser-session persistence (separate change,
  `persist-detached-pty-sessions`).

## Decisions

### D1: Consecutive-stale-ticks instead of wall-clock age
Track the mtime observed on the previous tick. If the current stat's mtime is
unchanged, increment a stale-tick counter; if it advanced, reset the counter
to zero. Declare a hang when the counter reaches
`ceil(timeoutMs / TICK_INTERVAL_MS)` (30 ticks by default).

Why this over the alternatives:
- **Time-jump detection** (compare `Date.now()` across loop iterations; on a
  jump > N seconds, reset the deadline) also works but keeps wall-clock in the
  detection path and needs a tuned jump threshold. Tick counting removes
  wall-clock entirely.
- **Monotonic clocks** (`performance.now()`) don't help by themselves: the
  question isn't "how much time passed" but "was the watchdog running while
  the heartbeat stayed frozen" — which is exactly what a tick count measures.
- Tick counting is also immune to mtime/system-clock skew (NTP steps, manual
  clock changes), which the age comparison is not.

Sleep safety follows from suspension semantics: a suspended watchdog fires at
most one pending tick on wake, so a sleep of any length contributes ≤1 stale
tick, and the parent's own pending heartbeat tick advances the mtime within
~1 s, resetting the counter. A truly wedged parent freezes the mtime while the
watchdog ticks 30 times awake — identical behavior to today.

### D2: Missing-heartbeat handling unchanged
The existing "file missing → wait one tick and re-check" startup grace stays.
A missing file does not increment the stale counter (there is no mtime to
compare); the parent writes the heartbeat before spawning the watchdog, so
persistent absence still surfaces via the stale path once the file appears —
this matches current behavior and keeps the diff minimal.

### D3: `cause.json` gains `staleTicks`
`captureAndKill()` records the observed consecutive stale-tick count next to
the existing `ageMs`. A reader can then distinguish "real hang" (ticks ≈ 30,
age ≈ 30 s) from historical clock-jump artifacts (age ≫ ticks × interval).
Additive field; no dump-layout change.

### D4: Threshold semantics documented as "watchdog runtime"
`--watchdog-timeout` / `UATU_HEARTBEAT_TIMEOUT_MS` keep their unit (ms) and
default. The spec language changes from "mtime older than the threshold" to
"unchanged for the threshold's worth of consecutive ticks" — equal to
wall-clock while awake.

## Risks / Trade-offs

- [Watchdog process individually suspended while parent hangs] → Detection
  pauses with it and resumes on continue; acceptable, since the alternative
  (wall-clock) is what causes false kills. The watchdog has no other wait
  states.
- [First post-wake tick sees an old mtime and counts 1 stale tick] → Harmless:
  29 more consecutive stale ticks would be required, and the parent heartbeats
  within ~1 s of wake.
- [Tests currently fabricate old mtimes to trigger kills] → They must instead
  hold the mtime fixed across N ticks; use a shortened
  `UATU_HEARTBEAT_TIMEOUT_MS` (existing override) to keep tests fast.
- [Very short custom timeouts (< tick interval)] → `ceil()` maps them to 1
  stale tick; a sleep could then theoretically kill on the first post-wake
  tick if it beats the parent's heartbeat. Document that the minimum sensible
  timeout is ≥ 2 × tick interval; the default is 30 ×.
