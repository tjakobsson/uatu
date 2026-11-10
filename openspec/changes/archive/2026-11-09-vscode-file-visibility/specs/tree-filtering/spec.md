## MODIFIED Requirements

### Requirement: Apply user-provided patterns from `.uatu.json ignore.exclude`
The system SHALL read each directory watch root's `.uatu.json ignore.exclude` as a string array of gitignore-compatible patterns, supporting negation and applying them in order. Explicit positive Uatu exclusions SHALL remove files and folders from discovery, watching, on-demand listing, browsing, Follow, static serving, and media delivery, regardless of Show ignored files. Negations SHALL retain their existing ability to reveal specific Gitignored paths when ignored visibility is off, but MUST NOT bypass the built-in exclusions. Root-level configuration SHALL be reread when changed, including repair of watch coverage where necessary. Single-file roots SHALL not consult this configuration, and nested `.uatu.json` files SHALL not be read. Invalid shape SHALL produce one configuration warning and apply no user exclusions. A root `.uatu.json` that still contains `ignore.include` SHALL produce one configuration warning stating that the key has no effect, and the key SHALL NOT change exposure or visibility.

#### Scenario: An `ignore.exclude` pattern hides a file from the tree
- **WHEN** `ignore.exclude` contains `bun.lock`
- **THEN** that file is not listed, followed, or served even with Show ignored files enabled

#### Scenario: A project hides its environment files
- **WHEN** `ignore.exclude` contains `.env*` and `*.pem`
- **THEN** matching files are not listed, previewed, searched, or served

#### Scenario: An `ignore.exclude` negation un-excludes something `.gitignore` excluded
- **WHEN** Git ignores `*.log`, `ignore.exclude` contains `!debug.log`, and ignored visibility is off
- **THEN** `debug.log` remains visible while other ignored logs are hidden

#### Scenario: A negation keeps one render folder visible
- **WHEN** Git ignores `/build*/`, `ignore.exclude` contains `!build/renders/**`, and ignored visibility is off
- **THEN** known files under `build/renders/` are listed while the rest of `build/` is hidden

#### Scenario: A leftover `ignore.include` key is reported
- **WHEN** `.uatu.json` contains `"include": ["build/renders"]` in its ignore block
- **THEN** one configuration warning says `ignore.include` has no effect
- **AND** what is listed and served is the same as without the key

#### Scenario: Single-file watch roots ignore `ignore.exclude`
- **WHEN** the child is launched for a single allowed file
- **THEN** adjacent `.uatu.json ignore.exclude` does not remove that launched file

#### Scenario: Nested `.uatu.json` files are not consulted
- **WHEN** a subdirectory contains its own `.uatu.json`
- **THEN** only the watched root's configuration determines the Uatu exclusions

#### Scenario: Editing `.uatu.json` at runtime reapplies the new patterns
- **WHEN** `package-lock.json` is added to `ignore.exclude` while the session is running
- **THEN** policy reconciliation removes it from the index and delivery without a session restart

#### Scenario: Invalid `ignore.exclude` shape produces a warning
- **WHEN** `ignore.exclude` is not an array of strings
- **THEN** a configuration warning is surfaced and no user exclusions are applied

#### Scenario: A retired `tree` block is not read
- **WHEN** `.uatu.json` contains only a retired tree block
- **THEN** it does not affect current defaults or the ignored-visibility preference

## REMOVED Requirements

### Requirement: Generated-output includes are narrow validated configuration
**Reason**: `build` and `dist` are no longer built-in exclusions, so a key that only opened named subtrees beneath them has nothing left to do. The key never shipped in a stable release.
**Migration**: Remove `ignore.include` from `.uatu.json`. Ignored output folders are listed and can be expanded without configuration. To keep one Gitignored output folder visible while ignored files are hidden, add a negation such as `!build/renders/**` to `ignore.exclude`.

### Requirement: Apply built-in defaults that hide common build/dependency directories
**Reason**: Replaced by "Built-in exclusions match VS Code's defaults". Uatu no longer hides dependency, build, cache, or secret-like paths by name; Git-ignore visibility and on-demand folder listing take over that role.
**Migration**: Projects that want a folder out of Uatu entirely add it to `.uatu.json ignore.exclude`, for example `node_modules/` or `build/`.

## ADDED Requirements

### Requirement: Built-in exclusions match VS Code's defaults
The system SHALL hide only the names VS Code's `files.exclude` hides by default, at any depth: the VCS metadata directories `.git`, `.svn`, `.hg`, and `.jj`, and the OS files `.DS_Store` and `Thumbs.db`. These SHALL be the only built-in exclusions. They SHALL be encoded in source, SHALL apply whether or not project configuration exists, and SHALL NOT be bypassed by a visibility preference or by a negation in project configuration. No other directory name, file name, suffix, or secret-like pattern SHALL be excluded by default. Dependency, build, cache, virtual-environment, editor-temporary, and secret-like paths SHALL be governed by Git-ignore visibility and explicit project exclusions like any other path.

#### Scenario: A nested `.git/` directory is hidden
- **WHEN** the root contains `tools/repos/example/.git/`
- **THEN** the nested Git directory is not traversed, indexed, listed, or served

#### Scenario: OS litter is hidden
- **WHEN** a folder contains `.DS_Store` or `Thumbs.db`
- **THEN** neither file is indexed, listed, or served

#### Scenario: Generated audio under `build/` is browsable without configuration
- **WHEN** an unconfigured Git root ignores `/build*/` and contains `build/renders/test.wav`
- **THEN** `build/` is listed as a muted ignored folder
- **AND** expanding down to `build/renders/` lists `test.wav`, which can be previewed and played

#### Scenario: `node_modules/` is shown like VS Code shows it
- **WHEN** a Git root ignores `node_modules/` and has no `.uatu.json`
- **THEN** `node_modules/` is listed as a muted ignored folder whose contents are read only when it is expanded

#### Scenario: Former default names are no longer special
- **WHEN** a root contains tracked files under `coverage/`, `.cache/`, or `dist/`
- **THEN** they are indexed, listed, and served as ordinary tracked files

#### Scenario: A project hides a folder explicitly
- **WHEN** `ignore.exclude` contains `node_modules/`
- **THEN** no files under any `node_modules` directory are listed, followed, or served, even with Show ignored files on
