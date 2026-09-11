## ADDED Requirements

### Requirement: Session children start only for the hub
The system SHALL provide a `uatu serve [PATH...]` session command as the internal session-child contract the hub relies on. It SHALL be accepted only when the invocation carries the hub's child marker (`--exit-on-stdin-close`, which the hub always passes) or when the CLI runs from source (`bun run src/cli.ts serve …`, the repository's own harness); every other invocation shape is user-shaped. A user-shaped invocation — `uatu serve`, `uatu watch`, a bare `uatu`, or `uatu <path>` — MUST NOT start a session: it SHALL print the hub bootstrap steps (configure a user, run `uatu hub`, open the dashboard, add a folder, and where to read about self-hosting) to standard error and exit non-zero. `uatu --help` and `uatu --version` SHALL remain reachable, and the usage text SHALL advertise only the hub commands. When accepted, the session command accepts zero or more positional paths. Each path MAY be either a directory (served as a root group) or a non-binary file (served as a single-file root). When no paths are provided, the system MUST use the current working directory as the only served root. Paths that resolve to binary files MUST be rejected with a clear error before the server or watcher starts. Paths that do not exist on disk MUST also be rejected with a clear error before the server or watcher starts. By default, every served path MUST be inside a git worktree; paths outside a git worktree MUST be rejected with a clear error before the server or watcher starts. The command SHALL accept a `--force` flag that permits non-git paths anyway and prints a warning that indexing may be slow. Starting the command SHALL launch a local browser UI server and print its URL to standard output after the initial session is ready. When standard output is a TTY, the command SHALL show an indexing status while initial indexing is in progress, then replace it with the ASCII `uatu` logo with the tagline "I observe. I follow. I render." above the URL once startup is ready. When standard output is not a TTY, the command SHALL omit both the indexing status and ASCII logo so only the URL is printed to standard output. The command SHALL accept a `--no-gitignore` flag that disables `.gitignore` filtering for the session. Startup error messages SHALL use serve-session vocabulary (e.g. "root does not exist"), not watch-session vocabulary.

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

## REMOVED Requirements

### Requirement: Start a local document serve session
**Reason**: `uatu serve` is no longer a public command, so a requirement that a user can start a session with it (including the bare `uatu` and `uatu <path>` defaults) no longer holds. The session-start behavior the hub relies on is restated as the internal child contract in "Session children start only for the hub", which also specifies how a user-shaped invocation is refused.
**Migration**: Run `uatu hub` and add the folder from its dashboard (`docs/SELF-HOSTING.md`). The changelog's Migration section names `uatu hub` as the replacement for `serve`.

### Requirement: Deprecated `watch` alias
**Reason**: Public `serve` is removed, so there is no command left for `watch` to alias. A user-shaped `uatu watch` is refused with the hub bootstrap steps, like every other user-shaped session invocation.
**Migration**: Run `uatu hub` and add the folder from its dashboard (`docs/SELF-HOSTING.md`). The changelog's Migration section names `uatu hub` as the replacement.

### Requirement: Bare serve invocation warns of deprecation
**Reason**: The removal the warning announced (shipped since `v0.5.0`, across three stable releases) is complete. A user-shaped invocation no longer starts a session to warn about; it is refused with the hub bootstrap steps instead.
**Migration**: Run `uatu hub` and add the folder from its dashboard (`docs/SELF-HOSTING.md`).
