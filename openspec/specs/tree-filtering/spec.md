# tree-filtering Specification

## Purpose
TBD - created by syncing change replace-tree-with-pierre. Update Purpose after archive.
## Requirements
### Requirement: Apply built-in defaults that hide common build/dependency directories
The system SHALL maintain a built-in set of default exclude patterns that are applied to every watched root regardless of project configuration. The defaults MUST cover at minimum the directory names `node_modules`, `.git`, `dist`, `build`, `.next`, `.turbo`, `.cache`, `coverage`, and `.DS_Store`. The defaults SHALL apply at any depth (matching the gitignore-compatible directory semantics). The defaults MUST NOT be silently extensible at runtime; changes to the default list are an intentional uatu decision and MUST be encoded in source. User patterns from `.uatu.json tree.exclude` are additive on top of the defaults — i.e. user patterns can hide additional files, but the defaults always apply.

#### Scenario: `node_modules/` is hidden in a project with no `.uatu.json`
- **WHEN** the watch root contains `node_modules/` and no `.uatu.json` exists
- **THEN** the sidebar tree does not list `node_modules/` or any of its descendants

#### Scenario: A nested `.git/` directory is hidden
- **WHEN** the watch root contains `tools/repos/example/.git/`
- **THEN** the sidebar tree does not list that nested `.git/` directory

#### Scenario: Defaults still apply when `.uatu.json` is silent on excludes
- **WHEN** the watch root has a `.uatu.json` whose `tree.exclude` field is empty or absent
- **THEN** the built-in defaults still hide `node_modules/`, `dist/`, `build/`, etc.

### Requirement: Apply user-provided patterns from `.uatu.json tree.exclude`
The system SHALL read the watch root's `.uatu.json` at session start and apply patterns listed in `tree.exclude` (a string array of gitignore-compatible patterns) as additional excludes on top of the built-in defaults and `.gitignore`. The patterns MUST support gitignore-compatible syntax including `!` negation. The system SHALL re-read `.uatu.json` when the file changes on disk so edits take effect on the next refresh without requiring the session to be restarted. Patterns in `tree.exclude` MUST take precedence over patterns inherited from `.gitignore`, mirroring the precedence the retired `.uatuignore` previously had over `.gitignore`. When a watched root is a single file path rather than a directory, `.uatu.json tree.exclude` SHALL NOT be consulted for that root. Per-directory nested `.uatu.json` files within the watch root SHALL be ignored in this version. Files filtered by `tree.exclude` MUST NOT appear in the sidebar tree, MUST NOT be eligible to change the active preview under follow mode, and MUST NOT be served by the static-fallback handler.

#### Scenario: A `tree.exclude` pattern hides a file from the tree
- **WHEN** the watch root's `.uatu.json` lists `bun.lock` in `tree.exclude`
- **AND** the watch root contains a `bun.lock` file
- **THEN** the sidebar tree does not list `bun.lock`
- **AND** modifying `bun.lock` does not change the active preview under follow mode

#### Scenario: A `tree.exclude` negation un-excludes something `.gitignore` excluded
- **WHEN** the watch root's `.gitignore` excludes `*.log`
- **AND** the watch root's `.uatu.json` lists `!debug.log` in `tree.exclude`
- **THEN** the sidebar tree lists `debug.log`
- **AND** every other `.log` file remains hidden

#### Scenario: Single-file watch roots ignore `tree.exclude`
- **WHEN** the watch session is started with `uatu watch script.py`
- **AND** a `.uatu.json` with a `tree.exclude` field exists in `script.py`'s directory
- **THEN** that `tree.exclude` does not affect the session
- **AND** the watched file is shown in the sidebar regardless of the exclude patterns

#### Scenario: Nested `.uatu.json` files are not consulted
- **WHEN** the watch root contains a subdirectory `docs/` with its own `.uatu.json`
- **THEN** the patterns in `docs/.uatu.json` do not affect filtering
- **AND** only the root-level `.uatu.json` is read

#### Scenario: Editing `.uatu.json` at runtime reapplies the new patterns
- **WHEN** a watch session is running and the sidebar tree lists `package-lock.json`
- **AND** the user adds `package-lock.json` to the watch root's `.uatu.json tree.exclude`
- **THEN** the next refresh MUST drop `package-lock.json` from the sidebar tree
- **AND** when the user removes that pattern from `tree.exclude` again
- **THEN** the next refresh MUST list `package-lock.json` once more
- **AND** the session is not restarted at any point

#### Scenario: Invalid `tree.exclude` shape produces a warning
- **WHEN** the watch root's `.uatu.json` has a `tree.exclude` value that is not a string array (for example, a single string or a number)
- **THEN** the session emits a settings warning naming the file and the field
- **AND** the session continues with the built-in defaults plus `.gitignore` honoring
- **AND** the warning is surfaced through the existing review-load settings warnings path

### Requirement: Honor `.gitignore` by default with overrides via `.uatu.json` or CLI
The system SHALL honor `.gitignore` at each watch root by default. Two opt-outs SHALL be supported: the per-session CLI flag `--no-gitignore`, and the per-project setting `tree.respectGitignore: false` in `.uatu.json`. When both opt-outs are present, the CLI flag wins for the duration of that session. The hardcoded directory denylist (the built-in defaults) MUST continue to apply regardless of either opt-out. The `tree.respectGitignore` field SHALL default to `true` when omitted.

#### Scenario: Default behavior honors `.gitignore`
- **WHEN** a session starts with no `.uatu.json` and no CLI flag
- **THEN** `.gitignore` is honored

#### Scenario: `.uatu.json` opts out via `tree.respectGitignore: false`
- **WHEN** the watch root's `.uatu.json` sets `tree.respectGitignore: false`
- **AND** the session starts without `--no-gitignore`
- **THEN** `.gitignore` is NOT honored for that session
- **AND** the built-in defaults still apply

#### Scenario: CLI flag wins over `.uatu.json`
- **WHEN** the watch root's `.uatu.json` sets `tree.respectGitignore: true` (default)
- **AND** the session starts with `--no-gitignore`
- **THEN** `.gitignore` is NOT honored for that session

#### Scenario: Invalid `tree.respectGitignore` shape produces a warning
- **WHEN** the watch root's `.uatu.json` has a `tree.respectGitignore` value that is not a boolean (for example, the string `"true"` or a number)
- **THEN** the session emits a settings warning naming the file and the field
- **AND** the session falls back to the default (honor `.gitignore`)

### Requirement: Warn about retired `.uatuignore` files on session start
At session start, the system SHALL scan each watched root for a `.uatuignore` file. When one is found, the system MUST emit a single one-line warning to stderr that names the file's absolute path and points users to `.uatu.json tree.exclude`. The warning MUST NOT be repeated on every refresh — it is a startup-time advisory. The contents of `.uatuignore` MUST NOT be parsed or applied to filtering. The presence of `.uatuignore` MUST NOT prevent the session from starting.

#### Scenario: A startup warning is emitted when `.uatuignore` exists
- **WHEN** the watch session is started and a `.uatuignore` file exists at the watch root
- **THEN** the session emits a one-line warning naming that file's absolute path and referencing `.uatu.json tree.exclude`
- **AND** the session continues to start normally

#### Scenario: `.uatuignore` patterns are not applied
- **WHEN** the watch root's `.uatuignore` contains a pattern matching `bun.lock`
- **AND** no `.uatu.json tree.exclude` entry matches `bun.lock`
- **AND** no `.gitignore` rule matches `bun.lock`
- **THEN** the sidebar tree lists `bun.lock`
- **AND** the `.uatuignore` pattern has no effect

#### Scenario: The warning is not repeated on refresh
- **WHEN** the session has emitted the `.uatuignore` startup warning
- **AND** the watch session subsequently refreshes due to a file change
- **THEN** the warning is NOT emitted again for that session

