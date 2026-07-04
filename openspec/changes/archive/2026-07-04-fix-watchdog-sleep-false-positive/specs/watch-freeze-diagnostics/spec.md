# watch-freeze-diagnostics delta — fix-watchdog-sleep-false-positive

## MODIFIED Requirements

### Requirement: Watchdog subprocess detects and recovers from a wedged uatu watch
A `uatu watch` process SHALL spawn a sibling watchdog subprocess at startup. The main process MUST refresh a heartbeat file mtime at least once per second. The watchdog MUST stat the heartbeat file at least once per second and MUST treat the heartbeat as stale only when its mtime has not advanced across a number of consecutive watchdog ticks equivalent to the configured staleness threshold (default 30 seconds of observed ticks). Staleness MUST NOT be derived from comparing the heartbeat mtime against wall-clock time: ticks accumulate only while the watchdog itself is running, so a system suspend/resume cycle — during which both processes are frozen and wall-clock time advances — MUST NOT count toward staleness. When the heartbeat goes stale, the watchdog MUST capture a forensic dump bundle (see "Forensic dump bundle" below) and then SHALL force-terminate the main process with `SIGKILL`. The watchdog MUST exit cleanly when the main process is no longer reachable, regardless of cause. The watchdog MUST be a single re-execution of the same uatu binary (no separate executable, no new runtime dependency).

#### Scenario: Healthy heartbeat keeps uatu alive
- **WHEN** `uatu watch` is running normally
- **AND** the main process refreshes its heartbeat file every second
- **THEN** the watchdog observes an advancing heartbeat mtime each tick
- **AND** the main process is not signalled

#### Scenario: Stale heartbeat triggers force-kill after dump capture
- **WHEN** the main process stops refreshing its heartbeat file
- **AND** the heartbeat mtime remains unchanged for the configured threshold's worth of consecutive watchdog ticks
- **THEN** the watchdog writes a forensic dump bundle to the cache directory
- **AND** the watchdog sends SIGKILL to the main process

#### Scenario: System sleep and wake does not kill a healthy uatu
- **WHEN** the machine suspends with `uatu watch` and its watchdog both running
- **AND** the machine resumes after an interval longer than the staleness threshold
- **THEN** the watchdog does not treat the pre-sleep heartbeat mtime as stale on its first post-wake ticks
- **AND** the main process refreshes the heartbeat within its next tick, resetting the stale-tick count
- **AND** the main process is not signalled and no dump is written

#### Scenario: Watchdog exits cleanly when uatu exits normally
- **WHEN** `uatu watch` shuts down (Ctrl+C, normal exit, or crash)
- **THEN** the watchdog detects that the main process PID is no longer reachable
- **AND** the watchdog exits without writing a dump

#### Scenario: Watchdog timeout is configurable
- **WHEN** a user runs `uatu watch --watchdog-timeout=60000`
- **THEN** the watchdog requires 60 seconds' worth of consecutive stale ticks before declaring the heartbeat stale
- **AND** an environment variable `UATU_HEARTBEAT_TIMEOUT_MS` MUST be honored as an alternative override

#### Scenario: Watchdog can be disabled
- **WHEN** a user runs `uatu watch --no-watchdog`
- **THEN** no watchdog subprocess is spawned
- **AND** no heartbeat file is written
- **AND** `uatu watch` operates exactly as it did before this capability was introduced (modulo other features in this change)

### Requirement: A wedged uatu watch is force-terminated within the watchdog staleness threshold without operator intervention
A user MUST be able to recover from a wedged `uatu watch` without escalating to `kill -9` from a separate terminal. When the JavaScript event loop is unresponsive, the existing JS-side shutdown handlers cannot run; the watchdog subprocess MUST therefore be the killability primitive in that state. From the moment the main process stops refreshing its heartbeat, no more than the configured staleness threshold of watchdog runtime MAY elapse before the watchdog force-terminates the parent; watchdog runtime equals wall-clock time whenever the system is awake, and excludes intervals during which the system is suspended. Resources owned by the process (PTY masters, listening sockets, native watcher handles) MUST be reaped via the operating system's normal process-exit cleanup after force-termination; the change MUST NOT regress the user-visible outcome that PTY children are terminated when `uatu watch` exits.

#### Scenario: Ctrl+C exits a healthy uatu watch immediately
- **WHEN** a user presses Ctrl+C in the terminal running a healthy `uatu watch`
- **THEN** the process exits within the time it takes the existing in-process shutdown path to run

#### Scenario: A wedged uatu watch is force-killed within the staleness threshold
- **WHEN** the JavaScript event loop is wedged while the system stays awake
- **AND** the heartbeat mtime remains unchanged for the configured threshold's worth of consecutive watchdog ticks
- **THEN** the watchdog terminates the wedged process via `SIGKILL`
- **AND** the user is not required to run `kill -9` from a separate terminal

#### Scenario: PTY children are reaped on exit
- **WHEN** `uatu watch` is running with one or more PTY sessions attached
- **AND** the process exits for any reason (graceful or via watchdog SIGKILL)
- **THEN** every PTY child process is terminated by the operating system within a short delay

## ADDED Requirements

### Requirement: Forensic dump cause records observed stale ticks
The `cause.json` file in the forensic dump bundle SHALL include, alongside the existing heartbeat age, the number of consecutive stale watchdog ticks observed at detection time, so a dump reader can distinguish a genuine hang (stale ticks ≈ threshold, age ≈ threshold) from a wall-clock jump (age far exceeding what the tick count implies).

#### Scenario: Cause file distinguishes hang from clock jump
- **WHEN** the watchdog kills the main process after a genuine hang
- **THEN** `cause.json` reports `reason: "stale-heartbeat"`, the heartbeat age, and a stale-tick count consistent with the configured threshold
