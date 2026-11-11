# serve-cli-startup Specification

## Purpose

Define how a uatu session child starts: the internal `serve` command the hub spawns for each workspace. A session child is an invocation that carries the hub's child marker (`--exit-on-stdin-close`), or one run from source by the repository's own harness; any other `serve`, `watch`, or bare invocation is user-shaped and is refused with the hub bootstrap steps. The capability covers which invocations are accepted, positional paths, git preflight, `--force`, `--no-gitignore`, browser and follow startup behavior, the diagnostic flags, supervision through standard input, and the base path. Supersedes the retired `watch-cli-startup` capability (archived with change `rename-watch-to-serve`).

## Requirements

### Requirement: Configure startup browser behavior

Session startup SHALL default to browser opening and Follow, with flags to disable either and a printed URL regardless of browser success. Direct-document SPA boots MUST override Follow to off, and usage text MUST advertise only supported flags.

#### Scenario: Override browser and Follow defaults before startup
- **WHEN** a session is configured
- **THEN** `--no-open` and `--no-follow` MUST be available to disable automatic browser opening and Follow before startup
- **AND** the local browser URL MUST print whether browser opening succeeds or fails

#### Scenario: Boot a known document rather than the root
- **WHEN** SPA boot `location.pathname` resolves to a known non-binary document other than `/`
- **THEN** Follow MUST be off for the session regardless of the CLI default, as specified by follow-mode's "Follow defaults to ON; URL direct links force OFF on boot"

#### Scenario: Default startup opens the browser with follow enabled
- **WHEN** a session child is started with `docs`
- **THEN** the system attempts to open the browser automatically
- **AND** the session starts with follow mode enabled
- **AND** the local browser URL is printed

#### Scenario: Startup flags disable auto-open and follow
- **WHEN** a session child is started with `docs --no-open --no-follow`
- **THEN** the system does not attempt to open the browser
- **AND** the session starts with follow mode disabled
- **AND** the local browser URL is printed

#### Scenario: SPA boot at the root URL honors the CLI follow default
- **WHEN** a user opens the browser to `http://127.0.0.1:NNNN/`
- **AND** the session child was started without `--no-follow`
- **THEN** the SPA boots with follow mode enabled

### Requirement: Configure startup diagnostic behavior

Session startup SHALL support debug history, watchdog suppression, and heartbeat-timeout overrides through the specified flags and environment variables. Flags MUST win conflicts with environment values, and diagnostics options SHALL NOT change user-visible startup output.

#### Scenario: Select verbose history and watchdog behavior
- **WHEN** a session receives diagnostic options
- **THEN** `--debug` enables verbose on-disk metrics history, and any non-empty `UATU_DEBUG` MUST have the same effect
- **AND** `--no-watchdog` suppresses the companion as an escape hatch; `--watchdog-timeout=<ms>` overrides heartbeat staleness, as MUST a set `UATU_HEARTBEAT_TIMEOUT_MS`

#### Scenario: Resolve diagnostic precedence without changing startup presentation
- **WHEN** diagnostic flags conflict with environment values or are used alone
- **THEN** flags MUST win conflicts, and the URL line, optional ASCII banner, and indexing status SHALL remain unchanged

#### Scenario: --debug enables verbose metrics history
- **WHEN** a session child is started with `--debug`
- **THEN** the session starts normally and prints its URL
- **AND** the verbose NDJSON metrics file appears in the cache directory shortly after startup

#### Scenario: UATU_DEBUG env var is equivalent to --debug
- **WHEN** a session child is started with `UATU_DEBUG=1` in its environment
- **THEN** the verbose NDJSON metrics file appears in the cache directory shortly after startup
- **AND** the behavior is otherwise identical to passing `--debug`

#### Scenario: --no-watchdog suppresses the watchdog subprocess
- **WHEN** a session child is started with `--no-watchdog`
- **THEN** no watchdog subprocess is spawned during startup
- **AND** no heartbeat file is created in the cache directory

#### Scenario: --watchdog-timeout overrides the default staleness threshold
- **WHEN** a session child is started with `--watchdog-timeout=60000`
- **THEN** the watchdog subprocess uses a 60-second staleness threshold for the duration of the session

#### Scenario: Flag value overrides environment variable
- **WHEN** the environment has `UATU_HEARTBEAT_TIMEOUT_MS=10000`
- **AND** a session child is started with `--watchdog-timeout=60000`
- **THEN** the watchdog subprocess uses the 60-second value from the flag

#### Scenario: Diagnostic flags do not change the user-visible startup output
- **WHEN** a session child is started with `--debug` from an interactive terminal
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
- **WHEN** a source-run session child runs without the flag and its standard input closes
- **THEN** the server keeps running

#### Scenario: Flag is documented
- **WHEN** a user runs `uatu --help`
- **THEN** the usage text lists `--exit-on-stdin-close` with its supervising-wrapper purpose

### Requirement: Serve accepts a base path flag

The session command SHALL accept a normalized absolute base-path prefix, defaulting to root, and include it in every startup URL. Invalid prefixes SHALL fail with a usage error, and the flag SHALL compose with existing startup options without unrelated behavior changes.

#### Scenario: Normalize and print an absolute base path
- **WHEN** `--base-path <prefix>` is supplied or omitted
- **THEN** the default is `/`; supplied values require a leading slash and accept and normalize a trailing slash
- **AND** both TTY-banner and single piped-stdout startup URLs include the normalized prefix for supervisors

#### Scenario: Reject invalid prefixes without interacting with other startup options
- **WHEN** a prefix lacks a leading slash, contains embedded whitespace, or has path traversal segments
- **THEN** startup fails with a usage error
- **WHEN** a valid prefix is combined with `--no-open`, `--exit-on-stdin-close`, or port selection
- **THEN** no behavior changes beyond the URL shape

#### Scenario: Prefixed URL is printed for supervisors
- **WHEN** a session child `uatu serve <folder> --no-open --exit-on-stdin-close --base-path /s/uatu/` starts with piped stdout
- **THEN** the single URL line printed includes the `/s/uatu/` prefix

#### Scenario: Invalid base path fails fast
- **WHEN** a session child is started with `<folder> --base-path relative/path`
- **THEN** the process exits non-zero with a usage error before any server starts

#### Scenario: Omitted flag preserves today's output
- **WHEN** a session child is started with `<folder>` and no `--base-path`
- **THEN** startup output and the session URL are identical to behavior before this flag existed

### Requirement: Session children start only for the hub

The system SHALL provide internal `uatu serve [PATH...]` only for Hub-marked or source-run invocations; user-shaped commands MUST NOT start sessions and SHALL exit non-zero with Hub bootstrap guidance on stderr. `uatu --help` and `uatu --version` SHALL remain reachable; usage SHALL advertise only Hub commands. Accepted sessions SHALL support the path, preflight, flag, browser-server, and stdout contract below; startup errors SHALL use serve-session, not watch-session, vocabulary.

#### Scenario: Classify accepted and user-shaped invocations
- **WHEN** the CLI receives a session invocation
- **THEN** only `--exit-on-stdin-close` (the Hub child marker) or source execution via `bun run src/cli.ts serve …` permits startup; all other shapes are user-shaped
- **AND** `uatu serve`, `uatu watch`, bare `uatu`, and `uatu <path>` MUST NOT start a session and SHALL print user configuration, `uatu hub`, dashboard, add-folder, and self-hosting-documentation steps to stderr before non-zero exit

#### Scenario: Resolve the full positional-path contract
- **WHEN** an accepted session receives zero or more positional paths
- **THEN** each path MAY be a directory served as a root group or a non-binary file served as a single-file root
- **AND** with no paths the current working directory MUST be the only served root

#### Scenario: Complete preflight before starting server or watcher
- **WHEN** requested paths include binary files, missing paths, or paths outside Git worktrees
- **THEN** binary and missing paths MUST be rejected with clear errors before server or watcher startup
- **AND** every served path MUST be inside a Git worktree by default; non-Git paths MUST likewise be rejected before startup unless `--force` permits them with a slow-indexing warning

#### Scenario: Start the UI server with the correct stdout presentation
- **WHEN** an accepted session starts
- **THEN** it launches a local browser UI server and prints its URL to stdout once initially ready
- **AND** TTY stdout shows indexing status then replaces it with the ASCII `uatu` logo and "I observe. I follow. I render." tagline above the ready URL; non-TTY stdout omits status and logo and prints only the URL

#### Scenario: Configure ignore filtering and startup vocabulary
- **WHEN** accepted startup uses `--no-gitignore` or reports a path error
- **THEN** that flag disables `.gitignore` filtering for the session, and errors use serve-session wording such as "root does not exist", not watch-session vocabulary

#### Scenario: A user-shaped serve prints the hub bootstrap steps
- **WHEN** a user runs `uatu serve docs` from an installed binary
- **THEN** no session starts
- **AND** standard error names `uatu hub` and lists the steps to configure a user, start the hub, and add a folder from its dashboard
- **AND** the command exits non-zero

#### Scenario: Bare and alias invocations are refused the same way
- **WHEN** a user runs `uatu`, `uatu docs`, or `uatu watch docs` from an installed binary
- **THEN** the command prints the same hub bootstrap steps to standard error and exits non-zero

#### Scenario: The hub's session child starts
- **WHEN** the hub starts a workspace session as `uatu serve <folder> --no-open --exit-on-stdin-close --base-path /s/<id>/`
- **THEN** the session starts and prints its URL once ready

#### Scenario: The source-run harness starts a session
- **WHEN** the repository's own harness runs `bun run src/cli.ts serve <folder> --base-path /s/e2e/`
- **THEN** the session starts as a session child would

#### Scenario: Help is still reachable
- **WHEN** a user runs `uatu --help` or `uatu -h`
- **THEN** the usage text is printed, listing the hub commands only, and no session starts

#### Scenario: No paths defaults to the current git directory
- **WHEN** a session child is started with no positional paths from inside a git worktree
- **THEN** the current working directory is used as the only served root
- **AND** the local browser URL is printed after the initial session is ready

#### Scenario: Multiple positional paths become separate served roots
- **WHEN** a session child is started with `docs notes`
- **AND** both paths are inside git worktrees
- **THEN** `docs` and `notes` are both registered as served roots
- **AND** the browser UI shows them as separate root groups

#### Scenario: A non-Markdown text file path starts a single-file entry when it is inside git
- **WHEN** a session child is started with `script.py`
- **AND** `script.py` is inside a git worktree
- **THEN** the session is scoped to that single file
- **AND** the sidebar shows only that file
- **AND** changes to other files outside the file's directory do not appear

#### Scenario: A Markdown file path starts a single-file entry when it is inside git
- **WHEN** a session child is started with `README.md`
- **AND** `README.md` is inside a git worktree
- **THEN** the session is scoped to that single Markdown file
- **AND** the sidebar shows only that document
- **AND** changes to other files outside the file's directory do not appear

#### Scenario: A binary file path is rejected
- **WHEN** a session child is started with `logo.png`
- **THEN** the command exits with a clear error naming the unsupported path
- **AND** no server or watcher is started

#### Scenario: A non-existent path is rejected
- **WHEN** a session child is started with `nope-not-a-real-file`
- **THEN** the command exits with a clear error naming the missing path
- **AND** no server or watcher is started

#### Scenario: A non-git root is rejected by default
- **WHEN** a session child is started with `~/Downloads`
- **AND** `~/Downloads` is not inside a git worktree
- **THEN** the command exits with a clear error naming `~/Downloads`
- **AND** the error explains that `--force` can serve it anyway
- **AND** no server or watcher is started

#### Scenario: Multiple non-git roots are all reported
- **WHEN** a session child is started with `~/Downloads /tmp/scratch`
- **AND** both paths are outside git worktrees
- **THEN** the command exits with a clear error naming both non-git paths
- **AND** no server or watcher is started

#### Scenario: `--force` permits a non-git root with a warning
- **WHEN** a session child is started with `~/Downloads --force`
- **AND** `~/Downloads` is not inside a git worktree
- **THEN** the command starts the session anyway
- **AND** a warning is printed that non-git indexing may be slow
- **AND** the local browser URL is printed after the initial session is ready

#### Scenario: Interactive startup shows indexing before the ASCII banner
- **WHEN** a session child is run with standard output attached to a terminal
- **AND** all startup preflight checks pass
- **THEN** an indexing status is shown while the initial session is being prepared
- **AND** the indexing status is replaced by the ASCII `uatu` logo and its tagline before the URL is printed

#### Scenario: Piped startup omits indexing status and banner
- **WHEN** a session child is run with standard output redirected to a pipe or file
- **THEN** only the URL is printed to standard output, without indexing status or the ASCII banner

#### Scenario: `--no-gitignore` is accepted as a startup flag
- **WHEN** a session child is started with `. --no-gitignore`
- **AND** `.` is inside a git worktree
- **THEN** the session starts without applying `.gitignore` patterns to the indexed file set
- **AND** the local browser URL is printed after the initial session is ready

#### Scenario: `--force` is accepted as a startup flag
- **WHEN** a session child is started with `. --force`
- **THEN** the session permits served roots that are outside git worktrees
- **AND** git-backed roots continue to use the normal indexing behavior

### Requirement: HTTP readiness precedes background discovery completion

After invocation and path preflight, sessions SHALL serve the shell, state, and live connection before discovery finishes. The printed URL SHALL mean HTTP readiness, while state and UI distinguish indexing, empty, and failed discovery and keep navigation and terminal controls usable.

#### Scenario: Expose HTTP readiness independently of discovery
- **WHEN** invocation and path preflight pass but file discovery or repository collection is incomplete
- **THEN** shell, state API, and live connection are served, and the printed URL signals usable HTTP readiness rather than completed indexing
- **AND** TTY status and banner transition at HTTP readiness, piped stdout remains URL-only, and the Hub accepts and proxies the ready child

#### Scenario: Distinguish discovery states without disabling the shell
- **WHEN** discovery is indexing, complete but empty, or failed
- **THEN** state and browser distinguish those states explicitly
- **AND** shell navigation and available terminal controls stay usable during indexing

#### Scenario: A large workspace opens while indexing
- **WHEN** initial discovery is deliberately held after successful preflight
- **THEN** the child prints its ready URL and the Hub can open the shell and live state
- **AND** the UI shows indexing progress and discovered files without waiting for Git

#### Scenario: An invalid root is rejected before readiness
- **WHEN** a requested root fails existing existence, binary-file, or Git-worktree validation
- **THEN** the child exits with the existing error behavior
- **AND** it does not print a ready URL or start the server or watcher

#### Scenario: A direct link precedes discovery of its file
- **WHEN** an allowed document URL is opened before background discovery reaches that path
- **THEN** the document can be resolved with a bounded path-specific read under the normal exposure rules
- **AND** it is not returned as raw source, declared deleted, or replaced with an unrelated default solely because discovery is incomplete
- **AND** a later discovery event does not duplicate or override that destination

#### Scenario: Shutdown occurs during indexing
- **WHEN** the Hub stops a child whose discovery is incomplete
- **THEN** the server, watcher, queued indexing work, and timers are released
- **AND** late work cannot republish readiness or keep the child alive
