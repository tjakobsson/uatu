# tree-filtering — delta

## ADDED Requirements

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

## REMOVED Requirements

### Requirement: Apply user-provided patterns from `.uatu.json tree.exclude`
**Reason**: Restated over the renamed `ignore` block (`ignore.exclude`); semantics unchanged. A legacy `tree` block is silently unread like any unknown key.
**Migration**: Rename the `tree` block to `ignore` in `.uatu.json`.

### Requirement: Honor `.gitignore` by default with overrides via `.uatu.json` or CLI
**Reason**: Restated over the renamed `ignore` block (`ignore.respectGitignore`); semantics unchanged.
**Migration**: Rename the `tree` block to `ignore` in `.uatu.json`.
