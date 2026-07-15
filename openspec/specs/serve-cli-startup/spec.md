# serve-cli-startup Specification

## Purpose

Define the CLI startup surface of uatu under the canonical `serve` verb: how a session is started (positional paths, git preflight, `--force`, `--no-gitignore`), the bare-invocation default, the deprecated `watch` alias's transition behavior, browser/follow startup behavior, and the diagnostic startup flags. Supersedes the retired `watch-cli-startup` capability (archived with change `rename-watch-to-serve`).

## Requirements
### Requirement: Start a local document serve session
The system SHALL provide a `uatu serve [PATH...]` command that accepts zero or more positional paths. Each path MAY be either a directory (served as a root group) or a non-binary file (served as a single-file root). When no paths are provided, the system MUST use the current working directory as the only served root. An invocation whose first argument is not a recognized command or flag — including a bare `uatu` with no arguments — MUST behave exactly as `uatu serve` with those arguments. Paths that resolve to binary files MUST be rejected with a clear error before the server or watcher starts. Paths that do not exist on disk MUST also be rejected with a clear error before the server or watcher starts. By default, every served path MUST be inside a git worktree; paths outside a git worktree MUST be rejected with a clear error before the server or watcher starts. The command SHALL accept a `--force` flag that permits non-git paths anyway and prints a warning that indexing may be slow. Starting the command SHALL launch a local browser UI server and print its URL to standard output after the initial session is ready. When standard output is a TTY, the command SHALL show an indexing status while initial indexing is in progress, then replace it with the ASCII `uatu` logo with the tagline "I observe. I follow. I render." above the URL once startup is ready. When standard output is not a TTY, the command SHALL omit both the indexing status and ASCII logo so only the URL is printed to standard output. The command SHALL accept a `--no-gitignore` flag that disables `.gitignore` filtering for the session. Startup error messages SHALL use serve-session vocabulary (e.g. "root does not exist"), not watch-session vocabulary.

#### Scenario: No paths defaults to the current git directory
- **WHEN** a user runs `uatu serve` with no positional paths from inside a git worktree
- **THEN** the current working directory is used as the only served root
- **AND** the local browser URL is printed after the initial session is ready

#### Scenario: Bare invocation defaults to serve
- **WHEN** a user runs `uatu` with no arguments from inside a git worktree
- **THEN** the behavior is identical to `uatu serve`

#### Scenario: Bare invocation with a path defaults to serve
- **WHEN** a user runs `uatu docs` and `docs` is a directory inside a git worktree
- **THEN** the behavior is identical to `uatu serve docs`

#### Scenario: Help is still reachable
- **WHEN** a user runs `uatu --help` or `uatu -h`
- **THEN** the usage text is printed and no session starts

#### Scenario: Multiple positional paths become separate served roots
- **WHEN** a user runs `uatu serve docs notes`
- **AND** both paths are inside git worktrees
- **THEN** `docs` and `notes` are both registered as served roots
- **AND** the browser UI shows them as separate root groups

#### Scenario: A non-Markdown text file path starts a single-file entry when it is inside git
- **WHEN** a user runs `uatu serve script.py`
- **AND** `script.py` is inside a git worktree
- **THEN** the session is scoped to that single file
- **AND** the sidebar shows only that file
- **AND** changes to other files outside the file's directory do not appear

#### Scenario: A Markdown file path starts a single-file entry when it is inside git
- **WHEN** a user runs `uatu serve README.md`
- **AND** `README.md` is inside a git worktree
- **THEN** the session is scoped to that single Markdown file
- **AND** the sidebar shows only that document
- **AND** changes to other files outside the file's directory do not appear

#### Scenario: A binary file path is rejected
- **WHEN** a user runs `uatu serve logo.png`
- **THEN** the command exits with a clear error naming the unsupported path
- **AND** no server or watcher is started

#### Scenario: A non-existent path is rejected
- **WHEN** a user runs `uatu serve nope-not-a-real-file`
- **THEN** the command exits with a clear error naming the missing path
- **AND** no server or watcher is started

#### Scenario: A non-git root is rejected by default
- **WHEN** a user runs `uatu serve ~/Downloads`
- **AND** `~/Downloads` is not inside a git worktree
- **THEN** the command exits with a clear error naming `~/Downloads`
- **AND** the error explains that `--force` can serve it anyway
- **AND** no server or watcher is started

#### Scenario: Multiple non-git roots are all reported
- **WHEN** a user runs `uatu serve ~/Downloads /tmp/scratch`
- **AND** both paths are outside git worktrees
- **THEN** the command exits with a clear error naming both non-git paths
- **AND** no server or watcher is started

#### Scenario: `--force` permits a non-git root with a warning
- **WHEN** a user runs `uatu serve ~/Downloads --force`
- **AND** `~/Downloads` is not inside a git worktree
- **THEN** the command starts the session anyway
- **AND** a warning is printed that non-git indexing may be slow
- **AND** the local browser URL is printed after the initial session is ready

#### Scenario: Interactive startup shows indexing before the ASCII banner
- **WHEN** `uatu serve` is run with standard output attached to a terminal
- **AND** all startup preflight checks pass
- **THEN** an indexing status is shown while the initial session is being prepared
- **AND** the indexing status is replaced by the ASCII `uatu` logo and its tagline before the URL is printed

#### Scenario: Piped startup omits indexing status and banner
- **WHEN** `uatu serve` is run with standard output redirected to a pipe or file
- **THEN** only the URL is printed to standard output, without indexing status or the ASCII banner

#### Scenario: `--no-gitignore` is accepted as a startup flag
- **WHEN** a user runs `uatu serve . --no-gitignore`
- **AND** `.` is inside a git worktree
- **THEN** the session starts without applying `.gitignore` patterns to the indexed file set
- **AND** the local browser URL is printed after the initial session is ready

#### Scenario: `--force` is accepted as a startup flag
- **WHEN** a user runs `uatu serve . --force`
- **THEN** the session permits served roots that are outside git worktrees
- **AND** git-backed roots continue to use the normal indexing behavior

### Requirement: Deprecated `watch` alias
For one release after this change ships, `uatu watch [ARGS...]` MUST behave identically to `uatu serve [ARGS...]` in every respect, additionally emitting a single one-line deprecation warning to stderr (`warning: 'uatu watch' is deprecated; use 'uatu serve'`) before startup output. The warning MUST go to stderr so piped stdout consumers are unaffected. In the release following that one, the `watch` token MUST lose its command meaning and be treated as an ordinary positional path under the bare-invocation default.

#### Scenario: `uatu watch` forwards to serve with a warning
- **WHEN** a user runs `uatu watch docs` during the deprecation-window release
- **THEN** the session starts exactly as `uatu serve docs` would
- **AND** stderr contains `warning: 'uatu watch' is deprecated; use 'uatu serve'` exactly once

#### Scenario: The alias warning does not pollute stdout
- **WHEN** a user runs `uatu watch --no-open` with stdout redirected to a file
- **THEN** the file contains only the URL line
- **AND** the deprecation warning appears on stderr only

#### Scenario: `watch` is an ordinary path after the deprecation window
- **WHEN** a user runs `uatu watch` after the deprecation-window release has shipped
- **AND** no file or directory named `watch` exists in the current directory
- **THEN** the command exits with a clear error naming the missing path `watch`

### Requirement: Configure startup browser behavior
The system SHALL attempt to open the browser automatically and SHALL start with follow mode enabled by default. The command MUST provide flags to disable browser auto-open (`--no-open`) and to disable follow mode (`--no-follow`) before the session starts. The local browser URL MUST be printed whether or not the browser is opened successfully. When the SPA boots with `location.pathname` resolving to a known non-binary document (anything other than `/`), the SPA MUST disable follow mode for the session regardless of the CLI default — see the `follow-mode` capability's "Follow defaults to ON; URL direct links force OFF on boot" requirement for the full rule. The usage text MUST list only flags the parser actually honors.

#### Scenario: Default startup opens the browser with follow enabled
- **WHEN** a user runs `uatu serve docs`
- **THEN** the system attempts to open the browser automatically
- **AND** the session starts with follow mode enabled
- **AND** the local browser URL is printed

#### Scenario: Startup flags disable auto-open and follow
- **WHEN** a user runs `uatu serve docs --no-open --no-follow`
- **THEN** the system does not attempt to open the browser
- **AND** the session starts with follow mode disabled
- **AND** the local browser URL is printed

#### Scenario: SPA boot at the root URL honors the CLI follow default
- **WHEN** a user opens the browser to `http://127.0.0.1:NNNN/`
- **AND** the CLI was started without `--no-follow`
- **THEN** the SPA boots with follow mode enabled

### Requirement: Configure startup diagnostic behavior
The `uatu serve` command SHALL accept a `--debug` flag that enables verbose on-disk metrics history for the session. The same effect MUST be triggered when the environment variable `UATU_DEBUG` is set to a non-empty value. The command SHALL accept a `--no-watchdog` flag that suppresses the companion watchdog subprocess (intended as an escape hatch). The command SHALL accept a `--watchdog-timeout=<ms>` flag that overrides the default heartbeat staleness threshold; the same effect MUST be triggered when the environment variable `UATU_HEARTBEAT_TIMEOUT_MS` is set. None of these flags SHALL change the user-visible startup output (the URL line, the optional ASCII banner, the indexing status). Conflicting values between the flag and the environment variable MUST resolve in favor of the flag.

#### Scenario: --debug enables verbose metrics history
- **WHEN** a user runs `uatu serve --debug`
- **THEN** the session starts normally and prints its URL
- **AND** the verbose NDJSON metrics file appears in the cache directory shortly after startup

#### Scenario: UATU_DEBUG env var is equivalent to --debug
- **WHEN** a user runs `UATU_DEBUG=1 uatu serve`
- **THEN** the verbose NDJSON metrics file appears in the cache directory shortly after startup
- **AND** the behavior is otherwise identical to passing `--debug`

#### Scenario: --no-watchdog suppresses the watchdog subprocess
- **WHEN** a user runs `uatu serve --no-watchdog`
- **THEN** no watchdog subprocess is spawned during startup
- **AND** no heartbeat file is created in the cache directory

#### Scenario: --watchdog-timeout overrides the default staleness threshold
- **WHEN** a user runs `uatu serve --watchdog-timeout=60000`
- **THEN** the watchdog subprocess uses a 60-second staleness threshold for the duration of the session

#### Scenario: Flag value overrides environment variable
- **WHEN** the environment has `UATU_HEARTBEAT_TIMEOUT_MS=10000`
- **AND** a user runs `uatu serve --watchdog-timeout=60000`
- **THEN** the watchdog subprocess uses the 60-second value from the flag

#### Scenario: Diagnostic flags do not change the user-visible startup output
- **WHEN** a user runs `uatu serve --debug` from an interactive terminal
- **THEN** the indexing status, ASCII banner, and URL are printed exactly as they would be without `--debug`

### Requirement: Serve exits when supervised standard input closes
The `serve` command SHALL accept an `--exit-on-stdin-close` flag. When the flag
is set, the process MUST monitor its standard input and, upon end-of-file, run
the same clean shutdown path used for SIGTERM and exit with status 0. When the
flag is not set, standard input reaching end-of-file MUST NOT affect the server's
lifetime. The flag SHALL appear in the usage text, described as intended for
supervising wrapper processes so a crashed supervisor cannot orphan the server.

#### Scenario: Supervisor crash ends the server
- **WHEN** `uatu serve --exit-on-stdin-close` runs as a child of a supervisor holding its stdin pipe
- **AND** the supervisor process dies without signalling the child
- **THEN** the server detects stdin end-of-file and shuts down cleanly

#### Scenario: Default behavior is unchanged
- **WHEN** `uatu serve` runs without the flag and its standard input closes
- **THEN** the server keeps running

#### Scenario: Flag is documented
- **WHEN** a user runs `uatu --help`
- **THEN** the usage text lists `--exit-on-stdin-close` with its supervising-wrapper purpose
