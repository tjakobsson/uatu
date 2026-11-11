# watch-freeze-diagnostics Specification

## Purpose
Detect and recover from wedged session-child processes (the internal `serve` process defined by `serve-cli-startup`) through suspend-safe heartbeat monitoring, bounded forensic capture, diagnostic counters, force termination, and self-pruning XDG cache storage.
## Requirements
### Requirement: Watchdog subprocess detects and recovers from a wedged session child

A session child SHALL spawn a sibling watchdog. It MUST be one re-execution of the same binary without a separate executable or new runtime dependency. Staleness MUST use consecutive observed ticks, not suspended wall-clock time. On staleness, the watchdog MUST capture a dump, then SHALL force-terminate the main process with `SIGKILL`. It MUST exit cleanly whenever the main process is unreachable.

#### Scenario: Start the independent watchdog without another dependency
- **WHEN** a session child starts
- **THEN** it spawns a sibling watchdog that MUST be one re-execution of the same uatu binary, with no separate executable or new runtime dependency

#### Scenario: Maintain periodic heartbeat monitoring
- **WHEN** the session child is running
- **THEN** the main process MUST refresh heartbeat-file mtime at least once per second
- **WHEN** the watchdog is running
- **THEN** it MUST stat the heartbeat file at least once per second

#### Scenario: Count consecutive observed stale ticks
- **WHEN** heartbeat mtime fails to advance over watchdog ticks
- **THEN** staleness MUST require consecutive stale ticks equivalent to the configured threshold, defaulting to 30 seconds of observed ticks
- **AND** staleness MUST NOT come from wall-clock comparison; suspend/resume time MUST NOT count because ticks accumulate only while the watchdog runs

#### Scenario: Recover in dump-before-kill order and end with the parent
- **WHEN** the heartbeat becomes stale
- **THEN** the watchdog MUST capture a forensic dump bundle before it SHALL force-terminate the main process with `SIGKILL`
- **WHEN** the main process becomes unreachable for any cause
- **THEN** the watchdog MUST exit cleanly

#### Scenario: Healthy heartbeat keeps uatu alive
- **WHEN** a session child is running normally
- **AND** the main process refreshes its heartbeat file every second
- **THEN** the watchdog observes an advancing heartbeat mtime each tick
- **AND** the main process is not signalled

#### Scenario: Stale heartbeat triggers force-kill after dump capture
- **WHEN** the main process stops refreshing its heartbeat file
- **AND** the heartbeat mtime remains unchanged for the configured threshold's worth of consecutive watchdog ticks
- **THEN** the watchdog writes a forensic dump bundle to the cache directory
- **AND** the watchdog sends SIGKILL to the main process

#### Scenario: System sleep and wake does not kill a healthy uatu
- **WHEN** the machine suspends with a session child and its watchdog both running
- **AND** the machine resumes after an interval longer than the staleness threshold
- **THEN** the watchdog does not treat the pre-sleep heartbeat mtime as stale on its first post-wake ticks
- **AND** the main process refreshes the heartbeat within its next tick, resetting the stale-tick count
- **AND** the main process is not signalled and no dump is written

#### Scenario: Watchdog exits cleanly when uatu exits normally
- **WHEN** a session child shuts down (the hub's SIGTERM, its standard input closing, Ctrl+C in a source-run child's terminal, normal exit, or crash)
- **THEN** the watchdog detects that the main process PID is no longer reachable
- **AND** the watchdog exits without writing a dump

#### Scenario: Watchdog timeout is configurable
- **WHEN** a session child is started with `--watchdog-timeout=60000`
- **THEN** the watchdog requires 60 seconds' worth of consecutive stale ticks before declaring the heartbeat stale
- **AND** an environment variable `UATU_HEARTBEAT_TIMEOUT_MS` MUST be honored as an alternative override

#### Scenario: Watchdog can be disabled
- **WHEN** a session child is started with `--no-watchdog`
- **THEN** no watchdog subprocess is spawned
- **AND** no heartbeat file is written
- **AND** the session child operates exactly as it did before this capability was introduced (modulo other features in this change)

### Requirement: Forensic dump bundle is written when the watchdog detects a freeze

Before terminating a stale parent, the watchdog SHALL write collision-safe forensic artifacts with platform-specific stack/FD capture, recent counters, and a small JSON cause file. External capture commands MUST be time-bounded with partial-output sentinels; limited capture fidelity MUST NOT prevent termination.

#### Scenario: Preserve the available evidence before killing a stale parent
- **WHEN** the watchdog acts on a stale heartbeat
- **THEN** it writes a cache-directory bundle before termination, with filenames that MUST encode wedged PID and timestamp to avoid collisions
- **AND** the bundle MUST include stack state, FD listing, the latest verbose NDJSON tail or otherwise the always-on counter snapshot, and a small JSON cause file naming reason, heartbeat age at detection, and platform

#### Scenario: Select the platform's forensic adapter
- **WHEN** stack and FD evidence is captured
- **THEN** adapters MUST use `sample` and `lsof` on macOS and direct `/proc/<pid>/` reads on Linux; Windows MAY omit capture and write a sentinel instead
- **AND** force-termination MUST work on every supported platform regardless of stack/FD capture fidelity

#### Scenario: Keep external forensic commands within five seconds
- **WHEN** an external capture command runs
- **THEN** its runtime MUST be capped at 5 seconds
- **AND** exceeding the cap MUST still write partial output marked with a "timed out" sentinel

#### Scenario: Dump bundle captures stack, fds, metrics tail, and cause
- **WHEN** the watchdog detects a stale heartbeat on a supported platform
- **THEN** four files are written to the cache directory: a stack text dump, an fds text dump, a metrics tail file, and a cause JSON file
- **AND** the cause JSON names the reason as a stale heartbeat, records the observed age, and records the platform identifier

#### Scenario: macOS adapter uses sample and lsof
- **WHEN** the watchdog runs on `darwin` and detects a stale heartbeat
- **THEN** the stack file contains output produced by the `sample` command
- **AND** the fds file contains output produced by the `lsof` command

#### Scenario: Linux adapter uses /proc reads
- **WHEN** the watchdog runs on `linux` and detects a stale heartbeat
- **THEN** the stack file contains content read from `/proc/<pid>/` (such as `stack`, `wchan`, `syscall`, `status`) without invoking external commands
- **AND** the fds file contains a listing of `/proc/<pid>/fd/` resolved via `readlink`

#### Scenario: Windows still kills the wedged process even without forensic capture
- **WHEN** the watchdog runs on `win32` and detects a stale heartbeat
- **THEN** a sentinel stack file and sentinel fds file are written indicating capture is not implemented for this platform
- **AND** the cause JSON is still written
- **AND** the wedged process is force-terminated

#### Scenario: External capture command timing out still produces partial data
- **WHEN** an external capture command does not finish within its time cap during dump capture
- **THEN** whatever output was produced is still written to disk
- **AND** the file content is annotated to indicate the timeout

#### Scenario: Dump filenames are unique across freezes
- **WHEN** two freezes occur in the same cache directory across the lifetime of the user's machine
- **THEN** each freeze produces a distinct set of dump files
- **AND** neither freeze's files overwrite the other's

### Requirement: A counter snapshot is always available on disk
Independent of any debug flag, a session child SHALL maintain an in-process registry of diagnostic counters (watcher events by type, refresh lifecycle, reconcile ticks, git execs, SSE subscribers, PTY sessions) and MUST persist a small snapshot JSON file in the cache directory. The snapshot MUST be updated at least once per second while the process is healthy. The snapshot is what the watchdog reads when verbose metrics are off, so even non-debug freezes leave behind the most recent counters.

#### Scenario: Snapshot file exists during healthy operation
- **WHEN** a session child is running with no debug flags
- **THEN** a counter snapshot JSON file is present in the cache directory
- **AND** its contents reflect counter values updated within the last few seconds

#### Scenario: Snapshot is captured into the dump bundle when verbose metrics are off
- **WHEN** the watchdog detects a freeze
- **AND** verbose NDJSON metrics were not enabled for the wedged process
- **THEN** the dump bundle contains the most recent counter snapshot from disk

### Requirement: Verbose NDJSON metrics log is opt-in via debug flag
When `--debug` is set or `UATU_DEBUG=1` is in the environment, the session child SHALL append one JSON object per second to a per-process NDJSON file in the cache directory containing the full counter snapshot at that tick. The NDJSON file SHALL be ring-buffered: when its size exceeds a soft cap (default 10 megabytes) the writer MUST truncate the oldest portion to keep the most recent history. When the debug flag is not set, no NDJSON file is written.

#### Scenario: Debug flag enables NDJSON history
- **WHEN** a session child is started with `--debug`
- **THEN** a per-process NDJSON file appears in the cache directory
- **AND** new lines are appended at least once per second
- **AND** each line is a single JSON object containing the counter values at that tick

#### Scenario: NDJSON file size is bounded
- **WHEN** the NDJSON file would exceed the configured soft size cap
- **THEN** the writer truncates the oldest portion
- **AND** the most recent history is preserved unchanged

#### Scenario: No NDJSON file when debug is off
- **WHEN** a session child is running without `--debug` and without `UATU_DEBUG`
- **THEN** no per-process NDJSON file is created in the cache directory

### Requirement: Live counters are exposed over HTTP when debug is enabled
When `--debug` is set, the local watch server SHALL expose a `/debug/metrics` route returning the current counter snapshot as a single JSON object. When debug is off, the route MUST NOT be mounted and requests to it MUST return 404. The endpoint MUST NOT include any file-path information beyond what other existing local endpoints already expose.

#### Scenario: Debug-mode server exposes live counters
- **WHEN** a session child started with `--debug` is running
- **AND** a client requests GET `/debug/metrics`
- **THEN** the server responds 200 with a JSON body containing the current counter snapshot

#### Scenario: Non-debug server hides the endpoint
- **WHEN** a session child is running without `--debug`
- **AND** a client requests GET `/debug/metrics`
- **THEN** the server responds 404

### Requirement: A wedged session child is force-terminated within the watchdog staleness threshold without operator intervention

From heartbeat stoppage, no more than the configured threshold of watchdog runtime MAY elapse before forced termination. Users MUST recover without manual escalation; the watchdog MUST provide killability when JavaScript is unresponsive. After forced exit, OS process-exit cleanup MUST reap owned resources. The change MUST NOT regress PTY-child termination when a session child exits. Watchdog runtime excludes suspension.

#### Scenario: Bound recovery even when JavaScript cannot shut down
- **WHEN** the JavaScript event loop is unresponsive
- **THEN** the independent watchdog MUST provide killability without requiring `kill -9` from another terminal
- **WHEN** the main process stops refreshing its heartbeat
- **THEN** no more than the configured staleness threshold of watchdog runtime MAY elapse before force-termination; runtime equals awake wall-clock time and excludes system suspension

#### Scenario: Reap process-owned resources after forced exit
- **WHEN** the watchdog force-terminates the child
- **THEN** operating-system process-exit cleanup MUST reap PTY masters, listening sockets, and native watcher handles
- **AND** the change MUST NOT regress termination of PTY children when the session child exits

#### Scenario: Ctrl+C exits a healthy source-run session child immediately
- **WHEN** a user presses Ctrl+C in the terminal running a healthy source-run session child
- **THEN** the process exits within the time it takes the existing in-process shutdown path to run

#### Scenario: A wedged session child is force-killed within the staleness threshold
- **WHEN** the JavaScript event loop is wedged while the system stays awake
- **AND** the heartbeat mtime remains unchanged for the configured threshold's worth of consecutive watchdog ticks
- **THEN** the watchdog terminates the wedged process via `SIGKILL`
- **AND** the user is not required to run `kill -9` from a separate terminal

#### Scenario: PTY children are reaped on exit
- **WHEN** a session child is running with one or more PTY sessions attached
- **AND** the process exits for any reason (graceful or via watchdog SIGKILL)
- **THEN** every PTY child process is terminated by the operating system within a short delay

### Requirement: Cache directory follows XDG conventions and self-prunes old dumps
A session child SHALL store its heartbeat file, counter snapshot, NDJSON history, and forensic dumps under `$XDG_CACHE_HOME/uatu/` when that variable is set, and `~/.cache/uatu/` otherwise. On startup, a session child MUST prune forensic dump files older than the configured retention window (default 14 days). The prune step MUST tolerate concurrent writers and missing directories without error.

#### Scenario: Cache directory honors XDG_CACHE_HOME when set
- **WHEN** `XDG_CACHE_HOME` is set to a non-empty path
- **AND** a session child starts
- **THEN** the heartbeat, snapshot, and dumps are written under `$XDG_CACHE_HOME/uatu/`

#### Scenario: Cache directory falls back to ~/.cache/uatu
- **WHEN** `XDG_CACHE_HOME` is unset
- **AND** a session child starts
- **THEN** the heartbeat, snapshot, and dumps are written under `~/.cache/uatu/`

#### Scenario: Old dumps are pruned at startup
- **WHEN** a session child starts
- **AND** the cache directory contains forensic dump files older than the retention window
- **THEN** those files are removed before the new session is fully initialized

#### Scenario: Missing cache directory is created on demand
- **WHEN** a session child starts
- **AND** no cache directory has previously been created
- **THEN** the directory is created with appropriate permissions before the heartbeat is first written

### Requirement: Forensic dump cause records observed stale ticks
The `cause.json` file in the forensic dump bundle SHALL include, alongside the existing heartbeat age, the number of consecutive stale watchdog ticks observed at detection time, so a dump reader can distinguish a genuine hang (stale ticks ≈ threshold, age ≈ threshold) from a wall-clock jump (age far exceeding what the tick count implies).

#### Scenario: Cause file distinguishes hang from clock jump
- **WHEN** the watchdog kills the main process after a genuine hang
- **THEN** `cause.json` reports `reason: "stale-heartbeat"`, the heartbeat age, and a stale-tick count consistent with the configured threshold
