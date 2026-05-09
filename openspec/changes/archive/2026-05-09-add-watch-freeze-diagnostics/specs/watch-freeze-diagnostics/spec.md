## ADDED Requirements

### Requirement: Watchdog subprocess detects and recovers from a wedged uatu watch
A `uatu watch` process SHALL spawn a sibling watchdog subprocess at startup. The main process MUST refresh a heartbeat file mtime at least once per second. The watchdog MUST stat the heartbeat file at least once per second and MUST treat the heartbeat as stale when its mtime is older than the configured staleness threshold (default 30 seconds). When the heartbeat goes stale, the watchdog MUST capture a forensic dump bundle (see "Forensic dump bundle" below) and then SHALL force-terminate the main process with `SIGKILL`. The watchdog MUST exit cleanly when the main process is no longer reachable, regardless of cause. The watchdog MUST be a single re-execution of the same uatu binary (no separate executable, no new runtime dependency).

#### Scenario: Healthy heartbeat keeps uatu alive
- **WHEN** `uatu watch` is running normally
- **AND** the main process refreshes its heartbeat file every second
- **THEN** the watchdog observes a fresh heartbeat each tick
- **AND** the main process is not signalled

#### Scenario: Stale heartbeat triggers force-kill after dump capture
- **WHEN** the main process stops refreshing its heartbeat file
- **AND** the heartbeat mtime is older than the staleness threshold
- **THEN** the watchdog writes a forensic dump bundle to the cache directory
- **AND** the watchdog sends SIGKILL to the main process

#### Scenario: Watchdog exits cleanly when uatu exits normally
- **WHEN** `uatu watch` shuts down (Ctrl+C, normal exit, or crash)
- **THEN** the watchdog detects that the main process PID is no longer reachable
- **AND** the watchdog exits without writing a dump

#### Scenario: Watchdog timeout is configurable
- **WHEN** a user runs `uatu watch --watchdog-timeout=60000`
- **THEN** the watchdog treats heartbeat staleness only at age greater than 60 seconds
- **AND** an environment variable `UATU_HEARTBEAT_TIMEOUT_MS` MUST be honored as an alternative override

#### Scenario: Watchdog can be disabled
- **WHEN** a user runs `uatu watch --no-watchdog`
- **THEN** no watchdog subprocess is spawned
- **AND** no heartbeat file is written
- **AND** `uatu watch` operates exactly as it did before this capability was introduced (modulo other features in this change)

### Requirement: Forensic dump bundle is written when the watchdog detects a freeze
When the watchdog acts on a stale heartbeat, it SHALL write a dump bundle into the cache directory before terminating the main process. The bundle MUST include: a stack-state capture of the wedged process, a file-descriptor listing, the most recent counter history available (verbose NDJSON tail when verbose metrics are enabled, otherwise the always-on counter snapshot file), and a small JSON cause file naming the watchdog reason, recording the heartbeat age at detection, and recording the platform under which the dump was taken. Stack and FD capture MUST be implemented as platform adapters: on macOS via `sample` and `lsof`; on Linux via direct reads of `/proc/<pid>/`; on Windows the capture MAY be omitted and a sentinel file written instead. Each external command MUST be capped at 5 seconds; if a command exceeds the cap the partial output MUST still be written and MUST be marked with a "timed out" sentinel. Dump filenames MUST encode the wedged PID and a timestamp so multiple dumps can coexist without collision. Force-termination of the wedged process MUST work on every supported platform regardless of the fidelity of the stack/FD capture step.

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
Independent of any debug flag, `uatu watch` SHALL maintain an in-process registry of diagnostic counters (watcher events by type, refresh lifecycle, reconcile ticks, git execs, SSE subscribers, PTY sessions) and MUST persist a small snapshot JSON file in the cache directory. The snapshot MUST be updated at least once per second while the process is healthy. The snapshot is what the watchdog reads when verbose metrics are off, so even non-debug freezes leave behind the most recent counters.

#### Scenario: Snapshot file exists during healthy operation
- **WHEN** `uatu watch` is running with no debug flags
- **THEN** a counter snapshot JSON file is present in the cache directory
- **AND** its contents reflect counter values updated within the last few seconds

#### Scenario: Snapshot is captured into the dump bundle when verbose metrics are off
- **WHEN** the watchdog detects a freeze
- **AND** verbose NDJSON metrics were not enabled for the wedged process
- **THEN** the dump bundle contains the most recent counter snapshot from disk

### Requirement: Verbose NDJSON metrics log is opt-in via debug flag
When `--debug` is set or `UATU_DEBUG=1` is in the environment, `uatu watch` SHALL append one JSON object per second to a per-process NDJSON file in the cache directory containing the full counter snapshot at that tick. The NDJSON file SHALL be ring-buffered: when its size exceeds a soft cap (default 10 megabytes) the writer MUST truncate the oldest portion to keep the most recent history. When the debug flag is not set, no NDJSON file is written.

#### Scenario: Debug flag enables NDJSON history
- **WHEN** a user runs `uatu watch --debug`
- **THEN** a per-process NDJSON file appears in the cache directory
- **AND** new lines are appended at least once per second
- **AND** each line is a single JSON object containing the counter values at that tick

#### Scenario: NDJSON file size is bounded
- **WHEN** the NDJSON file would exceed the configured soft size cap
- **THEN** the writer truncates the oldest portion
- **AND** the most recent history is preserved unchanged

#### Scenario: No NDJSON file when debug is off
- **WHEN** `uatu watch` is running without `--debug` and without `UATU_DEBUG`
- **THEN** no per-process NDJSON file is created in the cache directory

### Requirement: Live counters are exposed over HTTP when debug is enabled
When `--debug` is set, the local watch server SHALL expose a `/debug/metrics` route returning the current counter snapshot as a single JSON object. When debug is off, the route MUST NOT be mounted and requests to it MUST return 404. The endpoint MUST NOT include any file-path information beyond what other existing local endpoints already expose.

#### Scenario: Debug-mode server exposes live counters
- **WHEN** `uatu watch --debug` is running
- **AND** a client requests GET `/debug/metrics`
- **THEN** the server responds 200 with a JSON body containing the current counter snapshot

#### Scenario: Non-debug server hides the endpoint
- **WHEN** `uatu watch` is running without `--debug`
- **AND** a client requests GET `/debug/metrics`
- **THEN** the server responds 404

### Requirement: A wedged uatu watch is force-terminated within the watchdog staleness threshold without operator intervention
A user MUST be able to recover from a wedged `uatu watch` without escalating to `kill -9` from a separate terminal. When the JavaScript event loop is unresponsive, the existing JS-side shutdown handlers cannot run; the watchdog subprocess MUST therefore be the killability primitive in that state. From the moment the main process stops refreshing its heartbeat, no more than the configured staleness threshold MAY elapse before the watchdog force-terminates the parent. Resources owned by the process (PTY masters, listening sockets, native watcher handles) MUST be reaped via the operating system's normal process-exit cleanup after force-termination; the change MUST NOT regress the user-visible outcome that PTY children are terminated when `uatu watch` exits.

#### Scenario: Ctrl+C exits a healthy uatu watch immediately
- **WHEN** a user presses Ctrl+C in the terminal running a healthy `uatu watch`
- **THEN** the process exits within the time it takes the existing in-process shutdown path to run

#### Scenario: A wedged uatu watch is force-killed within the staleness threshold
- **WHEN** the JavaScript event loop is wedged
- **AND** the heartbeat goes stale beyond the configured threshold
- **THEN** the watchdog terminates the wedged process via `SIGKILL`
- **AND** the user is not required to run `kill -9` from a separate terminal

#### Scenario: PTY children are reaped on exit
- **WHEN** `uatu watch` is running with one or more PTY sessions attached
- **AND** the process exits for any reason (graceful or via watchdog SIGKILL)
- **THEN** every PTY child process is terminated by the operating system within a short delay

### Requirement: Cache directory follows XDG conventions and self-prunes old dumps
`uatu watch` SHALL store its heartbeat file, counter snapshot, NDJSON history, and forensic dumps under `$XDG_CACHE_HOME/uatu/` when that variable is set, and `~/.cache/uatu/` otherwise. On startup, `uatu watch` MUST prune forensic dump files older than the configured retention window (default 14 days). The prune step MUST tolerate concurrent writers and missing directories without error.

#### Scenario: Cache directory honors XDG_CACHE_HOME when set
- **WHEN** `XDG_CACHE_HOME` is set to a non-empty path
- **AND** `uatu watch` starts
- **THEN** the heartbeat, snapshot, and dumps are written under `$XDG_CACHE_HOME/uatu/`

#### Scenario: Cache directory falls back to ~/.cache/uatu
- **WHEN** `XDG_CACHE_HOME` is unset
- **AND** `uatu watch` starts
- **THEN** the heartbeat, snapshot, and dumps are written under `~/.cache/uatu/`

#### Scenario: Old dumps are pruned at startup
- **WHEN** `uatu watch` starts
- **AND** the cache directory contains forensic dump files older than the retention window
- **THEN** those files are removed before the new session is fully initialized

#### Scenario: Missing cache directory is created on demand
- **WHEN** `uatu watch` starts
- **AND** no cache directory has previously been created
- **THEN** the directory is created with appropriate permissions before the heartbeat is first written
