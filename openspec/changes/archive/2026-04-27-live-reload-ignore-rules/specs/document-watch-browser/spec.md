## MODIFIED Requirements

### Requirement: Filter the indexed file set with `.uatuignore`
The system SHALL read a `.uatuignore` file at the watch root, when present, and apply its patterns as a filter on top of the hardcoded directory denylist. The file SHALL use gitignore-compatible syntax, including `!` negation patterns. Patterns in `.uatuignore` SHALL take precedence over patterns inherited from `.gitignore`. When a watched root is a single file path rather than a directory, `.uatuignore` SHALL NOT be consulted for that root. Per-directory nested `.uatuignore` files within the watch root SHALL be ignored in this version. Files filtered by `.uatuignore` MUST NOT appear in the sidebar tree, MUST NOT be eligible to change the active preview under follow mode, and MUST NOT trigger live-update broadcasts when changed. Filtering decisions SHALL reflect the current on-disk contents of `.uatuignore`: when the user edits the file mid-session, the next refresh MUST re-read it so newly-added patterns hide their matches and removed patterns restore previously-hidden files, without requiring the session to be restarted.

#### Scenario: A `.uatuignore` pattern hides a file from the tree
- **WHEN** the watch root contains a `.uatuignore` whose patterns match `bun.lock`
- **AND** the watch root contains a `bun.lock` file
- **THEN** the sidebar tree does not list `bun.lock`
- **AND** modifying `bun.lock` does not change the active preview under follow mode

#### Scenario: A `.uatuignore` negation un-ignores something `.gitignore` excluded
- **WHEN** the watch root's `.gitignore` excludes `*.log`
- **AND** the watch root's `.uatuignore` contains `!debug.log`
- **THEN** the sidebar tree lists `debug.log`
- **AND** every other `.log` file remains hidden

#### Scenario: Single-file watch roots ignore `.uatuignore`
- **WHEN** the watch session is started with `uatu watch script.py`
- **AND** a `.uatuignore` file exists in `script.py`'s directory
- **THEN** that `.uatuignore` does not affect the session
- **AND** the watched file is shown in the sidebar regardless of `.uatuignore` patterns

#### Scenario: Nested `.uatuignore` files are not consulted
- **WHEN** the watch root contains a subdirectory `docs/` with its own `.uatuignore`
- **THEN** the patterns in `docs/.uatuignore` do not affect filtering
- **AND** only the root-level `.uatuignore` is read

#### Scenario: Editing `.uatuignore` at runtime reapplies the new patterns
- **WHEN** a watch session is running and the sidebar tree lists `package-lock.json`
- **AND** the user appends `package-lock.json` to the watch root's `.uatuignore`
- **THEN** the next refresh MUST drop `package-lock.json` from the sidebar tree
- **AND** when the user removes that pattern from `.uatuignore` again
- **THEN** the next refresh MUST list `package-lock.json` once more
- **AND** the session is not restarted at any point

### Requirement: Respect `.gitignore` by default with an opt-out flag
The system SHALL read `.gitignore` at each watch root by default and apply its patterns to filter the indexed file set. The system SHALL provide a `--no-gitignore` flag on the `uatu watch` command that disables this behavior for the session. The hardcoded directory denylist (`node_modules`, `.git`, `dist`, `build`, etc.) MUST continue to apply regardless of `--no-gitignore`. Files filtered by `.gitignore` MUST NOT appear in the sidebar tree and MUST NOT be eligible for follow mode. When the session is honouring `.gitignore` (i.e. `--no-gitignore` was not passed), filtering SHALL reflect the current on-disk contents of `.gitignore`: edits made mid-session MUST take effect on the next refresh without requiring the session to be restarted.

#### Scenario: `.gitignore` patterns hide files by default
- **WHEN** the watch root's `.gitignore` excludes `*.log`
- **AND** the watch root contains `debug.log`
- **THEN** the sidebar tree does not list `debug.log`

#### Scenario: `--no-gitignore` exposes gitignored files
- **WHEN** the watch session is started with `uatu watch . --no-gitignore`
- **AND** the watch root's `.gitignore` excludes `*.log`
- **AND** the watch root contains `debug.log`
- **THEN** the sidebar tree lists `debug.log`
- **AND** the hardcoded directory denylist still applies (e.g. `node_modules/` remains hidden)

#### Scenario: Editing `.gitignore` at runtime reapplies the new patterns
- **WHEN** a watch session is running without `--no-gitignore` and the sidebar tree lists `notes.tmp`
- **AND** the user appends `*.tmp` to the watch root's `.gitignore`
- **THEN** the next refresh MUST drop `notes.tmp` from the sidebar tree
- **AND** when the user removes that pattern from `.gitignore` again
- **THEN** the next refresh MUST list `notes.tmp` once more
- **AND** the session is not restarted at any point
