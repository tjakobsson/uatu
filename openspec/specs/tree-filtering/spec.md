# tree-filtering Specification

## Purpose
TBD - created by syncing change replace-tree-with-pierre. Update Purpose after archive.
## Requirements
### Requirement: Apply built-in defaults that hide common build/dependency directories
The system SHALL maintain a built-in set of default exclude patterns that are applied to every watched root regardless of project configuration. The defaults MUST cover at minimum the directory names `node_modules`, `.git`, `dist`, `build`, `.next`, `.turbo`, `.cache`, `coverage`, and `.DS_Store`. The defaults SHALL apply at any depth (matching the gitignore-compatible directory semantics). The defaults MUST NOT be silently extensible at runtime; changes to the default list are an intentional uatu decision and MUST be encoded in source. User patterns from `.uatu.json ignore.exclude` are additive on top of the defaults — i.e. user patterns can hide additional files, but the defaults always apply.

#### Scenario: `node_modules/` is hidden in a project with no `.uatu.json`
- **WHEN** the watch root contains `node_modules/` and no `.uatu.json` exists
- **THEN** the sidebar tree does not list `node_modules/` or any of its descendants

#### Scenario: A nested `.git/` directory is hidden
- **WHEN** the watch root contains `tools/repos/example/.git/`
- **THEN** the sidebar tree does not list that nested `.git/` directory

#### Scenario: Defaults still apply when `.uatu.json` is silent on excludes
- **WHEN** the watch root has a `.uatu.json` whose `ignore.exclude` field is empty or absent
- **THEN** the built-in defaults still hide `node_modules/`, `dist/`, `build/`, etc.

### Requirement: Apply user-provided patterns from `.uatu.json ignore.exclude`
The system SHALL read the watch root's `.uatu.json` at session start and apply patterns listed in `ignore.exclude` (a string array of gitignore-compatible patterns) as additional excludes on top of the built-in defaults and `.gitignore`. The patterns MUST support gitignore-compatible syntax including `!` negation. The system SHALL re-read `.uatu.json` when the file changes on disk so edits take effect on the next refresh without requiring the session to be restarted. Patterns in `ignore.exclude` MUST take precedence over patterns inherited from `.gitignore`, mirroring the precedence the retired `.uatuignore` previously had over `.gitignore`. When a watched root is a single file path rather than a directory, `.uatu.json ignore.exclude` SHALL NOT be consulted for that root. Per-directory nested `.uatu.json` files within the watch root SHALL be ignored in this version. Files filtered by `ignore.exclude` MUST NOT appear in the sidebar tree, MUST NOT be eligible to change the active preview under follow mode, and MUST NOT be served by the static-fallback handler.

#### Scenario: An `ignore.exclude` pattern hides a file from the tree
- **WHEN** the watch root's `.uatu.json` lists `bun.lock` in `ignore.exclude`
- **AND** the watch root contains a `bun.lock` file
- **THEN** the sidebar tree does not list `bun.lock`
- **AND** modifying `bun.lock` does not change the active preview under follow mode

#### Scenario: An `ignore.exclude` negation un-excludes something `.gitignore` excluded
- **WHEN** the watch root's `.gitignore` excludes `*.log`
- **AND** the watch root's `.uatu.json` lists `!debug.log` in `ignore.exclude`
- **THEN** the sidebar tree lists `debug.log`
- **AND** every other `.log` file remains hidden

#### Scenario: Single-file watch roots ignore `ignore.exclude`
- **WHEN** the watch session is started with `uatu watch script.py`
- **AND** a `.uatu.json` with an `ignore.exclude` field exists in `script.py`'s directory
- **THEN** that `ignore.exclude` does not affect the session
- **AND** the watched file is shown in the sidebar regardless of the exclude patterns

#### Scenario: Nested `.uatu.json` files are not consulted
- **WHEN** the watch root contains a subdirectory `docs/` with its own `.uatu.json`
- **THEN** the patterns in `docs/.uatu.json` do not affect filtering
- **AND** only the root-level `.uatu.json` is read

#### Scenario: Editing `.uatu.json` at runtime reapplies the new patterns
- **WHEN** a watch session is running and the sidebar tree lists `package-lock.json`
- **AND** the user adds `package-lock.json` to the watch root's `.uatu.json ignore.exclude`
- **THEN** the next refresh MUST drop `package-lock.json` from the sidebar tree

#### Scenario: Invalid `ignore.exclude` shape produces a warning
- **WHEN** the watch root's `.uatu.json` has an `ignore.exclude` value that is not a string array
- **THEN** the session emits a settings warning naming the file and the field
- **AND** the session falls back to applying no user-provided excludes

#### Scenario: A retired `tree` block is not read
- **WHEN** the watch root's `.uatu.json` contains only a legacy `tree` block
- **THEN** the session applies built-in defaults and `.gitignore` as if no exclude configuration existed

### Requirement: Honor `.gitignore` by default with opt-outs via `.uatu.json` or CLI
The system SHALL honor `.gitignore` at each watch root by default. Two opt-outs SHALL be supported: the per-session CLI flag `--no-gitignore`, and the per-project setting `ignore.respectGitignore: false` in `.uatu.json`. When both opt-outs are present, the CLI flag wins for the duration of that session. The hardcoded directory denylist (the built-in defaults) MUST continue to apply regardless of either opt-out. The `ignore.respectGitignore` field SHALL default to `true` when omitted.

#### Scenario: Default behavior honors `.gitignore`
- **WHEN** a session starts with no `.uatu.json` and no CLI flag
- **THEN** `.gitignore` is honored

#### Scenario: `.uatu.json` opts out via `ignore.respectGitignore: false`
- **WHEN** the watch root's `.uatu.json` sets `ignore.respectGitignore: false`
- **AND** the session starts without `--no-gitignore`
- **THEN** `.gitignore` is NOT honored for that session
- **AND** the built-in defaults still apply

#### Scenario: CLI flag wins over `.uatu.json`
- **WHEN** the watch root's `.uatu.json` sets `ignore.respectGitignore: true` (default)
- **AND** the session starts with `--no-gitignore`
- **THEN** `.gitignore` is NOT honored for that session

#### Scenario: Invalid `ignore.respectGitignore` shape produces a warning
- **WHEN** the watch root's `.uatu.json` has an `ignore.respectGitignore` value that is not a boolean (for example, the string `"true"` or a number)
- **THEN** the session emits a settings warning naming the file and the field
- **AND** the session falls back to the default (honor `.gitignore`)

### Requirement: Surface `.uatu.json` configuration warnings in the session
The session SHALL surface every `.uatu.json` configuration warning — read
failures other than the file being absent, JSON parse failures, and the
`ignore` shape-validation warnings — in the repository snapshot's config
warnings, where the Change Overview displays them. Warnings SHALL be read
from each directory watch root's `.uatu.json` — the file that controls
filtering — not from the repository top level; when a watch root sits below
the repository top level, its warnings SHALL be prefixed with the root's
repository-relative path so multiple roots stay distinguishable. Watched
roots outside a git repository SHALL surface their warnings the same way.
Single-file watch roots read no ignore configuration and SHALL produce no
config warnings. A `.uatu.json` that exists but is empty (zero-byte or
whitespace-only) SHALL be treated as malformed JSON and produce the parse
warning rather than being silently accepted as valid. One underlying problem
SHALL be reported as one warning, even though more than one subsystem reads
the file.

#### Scenario: Empty `.uatu.json` produces a parse warning
- **WHEN** the watch root's `.uatu.json` exists but is zero bytes or contains only whitespace
- **THEN** the session's config warnings include an "Invalid .uatu.json" parse warning

#### Scenario: Shape-validation warnings reach the Change Overview
- **WHEN** the watch root's `.uatu.json` has an `ignore.exclude` value that is not a string array
- **THEN** the settings warning naming the file and the field appears in the repository snapshot's config warnings
- **AND** the session falls back to applying no user-provided excludes

#### Scenario: A watch root below the repository top level warns about its own file
- **WHEN** the watch root is `<repo>/docs` and `<repo>/docs/.uatu.json` is malformed while `<repo>/.uatu.json` is absent or valid
- **THEN** the session's config warnings report the watch root's file, prefixed with its repository-relative path (`docs: …`)
- **AND** the repository top level's `.uatu.json` produces no warning, because the ignore engine does not read it

#### Scenario: A non-git watch root still surfaces its warnings
- **WHEN** a watched directory outside any git repository has a malformed `.uatu.json`
- **THEN** the non-git repository snapshot carries the parse warning and the Change Overview displays it

#### Scenario: A single-file watch root produces no config warnings
- **WHEN** the watch session is started with `uatu serve script.py` and a malformed `.uatu.json` exists in `script.py`'s directory
- **THEN** the session's config warnings are empty, matching the engine's rule that single-file roots read no ignore configuration

#### Scenario: A missing `.uatu.json` produces no warning
- **WHEN** the watch root has no `.uatu.json`
- **THEN** the session's config warnings contain no `.uatu.json` entry

#### Scenario: One problem is reported once
- **WHEN** the watch root's `.uatu.json` is malformed JSON
- **THEN** the session's config warnings contain exactly one parse warning for it, even though both the warning collector and the ignore engine read the file

