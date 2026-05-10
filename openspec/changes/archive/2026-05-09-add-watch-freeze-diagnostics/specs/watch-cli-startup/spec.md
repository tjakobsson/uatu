## ADDED Requirements

### Requirement: Configure startup diagnostic behavior
The `uatu watch` command SHALL accept a `--debug` flag that enables verbose on-disk metrics history for the session. The same effect MUST be triggered when the environment variable `UATU_DEBUG` is set to a non-empty value. The command SHALL accept a `--no-watchdog` flag that suppresses the companion watchdog subprocess (intended as an escape hatch). The command SHALL accept a `--watchdog-timeout=<ms>` flag that overrides the default heartbeat staleness threshold; the same effect MUST be triggered when the environment variable `UATU_HEARTBEAT_TIMEOUT_MS` is set. None of these flags SHALL change the user-visible startup output (the URL line, the optional ASCII banner, the indexing status). Conflicting values between the flag and the environment variable MUST resolve in favor of the flag.

#### Scenario: --debug enables verbose metrics history
- **WHEN** a user runs `uatu watch --debug`
- **THEN** the watch session starts normally and prints its URL
- **AND** the verbose NDJSON metrics file appears in the cache directory shortly after startup

#### Scenario: UATU_DEBUG env var is equivalent to --debug
- **WHEN** a user runs `UATU_DEBUG=1 uatu watch`
- **THEN** the verbose NDJSON metrics file appears in the cache directory shortly after startup
- **AND** the behavior is otherwise identical to passing `--debug`

#### Scenario: --no-watchdog suppresses the watchdog subprocess
- **WHEN** a user runs `uatu watch --no-watchdog`
- **THEN** no watchdog subprocess is spawned during startup
- **AND** no heartbeat file is created in the cache directory

#### Scenario: --watchdog-timeout overrides the default staleness threshold
- **WHEN** a user runs `uatu watch --watchdog-timeout=60000`
- **THEN** the watchdog subprocess uses a 60-second staleness threshold for the duration of the session

#### Scenario: Flag value overrides environment variable
- **WHEN** the environment has `UATU_HEARTBEAT_TIMEOUT_MS=10000`
- **AND** a user runs `uatu watch --watchdog-timeout=60000`
- **THEN** the watchdog subprocess uses the 60-second value from the flag

#### Scenario: Diagnostic flags do not change the user-visible startup output
- **WHEN** a user runs `uatu watch --debug` from an interactive terminal
- **THEN** the indexing status, ASCII banner, and URL are printed exactly as they would be without `--debug`
