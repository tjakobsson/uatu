# watch-cli-startup Specification

## Purpose
TBD - created by archiving change split-document-watch-browser. Update Purpose after archive.
## Requirements
### Requirement: Start a local document watch session
The system SHALL provide a `uatu watch [PATH...]` command that accepts zero or more positional paths. Each path MAY be either a directory (watched as a root group) or a non-binary file (watched as a single-file root). When no paths are provided, the system MUST use the current working directory as the only watched root. Paths that resolve to binary files MUST be rejected with a clear error before the server or watcher starts. Paths that do not exist on disk MUST also be rejected with a clear error before the server or watcher starts. By default, every watched path MUST be inside a git worktree; paths outside a git worktree MUST be rejected with a clear error before the server or watcher starts. The command SHALL accept a `--force` flag that permits non-git watched paths anyway and prints a warning that indexing may be slow. Starting the command SHALL launch a local browser UI server and print its URL to standard output after the initial watch session is ready. When standard output is a TTY, the command SHALL show an indexing status while initial indexing is in progress, then replace it with the ASCII `uatu` logo with the tagline "I observe. I follow. I render." above the URL once startup is ready. When standard output is not a TTY, the command SHALL omit both the indexing status and ASCII logo so only the URL is printed to standard output. The command SHALL accept a `--no-gitignore` flag that disables `.gitignore` filtering for the session.

#### Scenario: No paths defaults to the current git directory
- **WHEN** a user runs `uatu watch` with no positional paths from inside a git worktree
- **THEN** the current working directory is used as the only watched root
- **AND** the local browser URL is printed after the initial watch session is ready

#### Scenario: Multiple positional paths become separate watched roots
- **WHEN** a user runs `uatu watch docs notes`
- **AND** both paths are inside git worktrees
- **THEN** `docs` and `notes` are both registered as watched roots
- **AND** the browser UI shows them as separate root groups

#### Scenario: A non-Markdown text file path starts a single-file entry when it is inside git
- **WHEN** a user runs `uatu watch script.py`
- **AND** `script.py` is inside a git worktree
- **THEN** the session is scoped to that single file
- **AND** the sidebar shows only that file
- **AND** changes to other files outside the file's directory do not appear

#### Scenario: A Markdown file path starts a single-file entry when it is inside git
- **WHEN** a user runs `uatu watch README.md`
- **AND** `README.md` is inside a git worktree
- **THEN** the session is scoped to that single Markdown file
- **AND** the sidebar shows only that document
- **AND** changes to other files outside the file's directory do not appear

#### Scenario: A binary file path is rejected
- **WHEN** a user runs `uatu watch logo.png`
- **THEN** the command exits with a clear error naming the unsupported path
- **AND** no server or watcher is started

#### Scenario: A non-existent path is rejected
- **WHEN** a user runs `uatu watch nope-not-a-real-file`
- **THEN** the command exits with a clear error naming the missing path
- **AND** no server or watcher is started

#### Scenario: A non-git root is rejected by default
- **WHEN** a user runs `uatu watch ~/Downloads`
- **AND** `~/Downloads` is not inside a git worktree
- **THEN** the command exits with a clear error naming `~/Downloads`
- **AND** the error explains that `--force` can watch it anyway
- **AND** no server or watcher is started

#### Scenario: Multiple non-git roots are all reported
- **WHEN** a user runs `uatu watch ~/Downloads /tmp/scratch`
- **AND** both paths are outside git worktrees
- **THEN** the command exits with a clear error naming both non-git paths
- **AND** no server or watcher is started

#### Scenario: `--force` permits a non-git root with a warning
- **WHEN** a user runs `uatu watch ~/Downloads --force`
- **AND** `~/Downloads` is not inside a git worktree
- **THEN** the command starts the watch session anyway
- **AND** a warning is printed that non-git indexing may be slow
- **AND** the local browser URL is printed after the initial watch session is ready

#### Scenario: Interactive startup shows indexing before the ASCII banner
- **WHEN** `uatu watch` is run with standard output attached to a terminal
- **AND** all startup preflight checks pass
- **THEN** an indexing status is shown while the initial watch session is being prepared
- **AND** the indexing status is replaced by the ASCII `uatu` logo and its tagline before the URL is printed

#### Scenario: Piped startup omits indexing status and banner
- **WHEN** `uatu watch` is run with standard output redirected to a pipe or file
- **THEN** only the URL is printed to standard output, without indexing status or the ASCII banner

#### Scenario: `--no-gitignore` is accepted as a startup flag
- **WHEN** a user runs `uatu watch . --no-gitignore`
- **AND** `.` is inside a git worktree
- **THEN** the session starts without applying `.gitignore` patterns to the indexed file set
- **AND** the local browser URL is printed after the initial watch session is ready

#### Scenario: `--force` is accepted as a startup flag
- **WHEN** a user runs `uatu watch . --force`
- **THEN** the session permits watched roots that are outside git worktrees
- **AND** git-backed roots continue to use the normal indexing behavior

### Requirement: Configure startup browser behavior
The system SHALL attempt to open the browser automatically and SHALL start with follow mode enabled by default. The command MUST provide flags to disable browser auto-open and to disable follow mode before the watch session starts. The command MUST also provide a `--mode=author|review` flag that sets the initial UI Mode for the watch session. When the `--mode` flag is present at startup, it MUST take precedence over any persisted browser-side Mode preference for the initial SPA boot. When `--mode=review` is in effect at startup, follow mode MUST be off for the session regardless of the follow flag and MUST NOT be enabled by the SPA until the user switches Mode back to **Author**. The local browser URL MUST be printed whether or not the browser is opened successfully. When the SPA boots with `location.pathname` resolving to a known non-binary document (anything other than `/`), the SPA MUST disable follow mode for the session regardless of the CLI default — see "Force follow mode off when arriving via a direct document URL" for the full rule.

#### Scenario: Default startup opens the browser with follow enabled
- **WHEN** a user runs `uatu watch docs`
- **THEN** the system attempts to open the browser automatically
- **AND** the watch session starts with follow mode enabled
- **AND** the local browser URL is printed

#### Scenario: Startup flags disable auto-open and follow
- **WHEN** a user runs `uatu watch docs --no-open --no-follow`
- **THEN** the system does not attempt to open the browser
- **AND** the watch session starts with follow mode disabled
- **AND** the local browser URL is printed

#### Scenario: SPA boot at the root URL honors the CLI follow default
- **WHEN** a user opens the browser to `http://127.0.0.1:NNNN/`
- **AND** the CLI was started without `--no-follow`
- **THEN** the SPA boots with follow mode enabled

#### Scenario: Mode flag sets the startup Mode
- **WHEN** a user runs `uatu watch docs --mode=review`
- **THEN** the SPA boots with Mode set to **Review**
- **AND** follow mode is off for the session
- **AND** the persisted browser-side Mode preference is overwritten to **Review** for that origin

#### Scenario: Mode flag overrides persisted browser preference at startup
- **WHEN** the browser has a persisted Mode preference of **Review**
- **AND** the user runs `uatu watch docs --mode=author`
- **THEN** the SPA boots with Mode set to **Author**

#### Scenario: Review mode forces follow off even when --no-follow is omitted
- **WHEN** a user runs `uatu watch docs --mode=review`
- **THEN** the watch session starts with follow mode disabled regardless of the follow flag
- **AND** the Follow control is not rendered in Review (i.e., the chip is hidden, not merely disabled)

