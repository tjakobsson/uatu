# tree-filtering Specification

## Purpose
Apply built-in, `.gitignore`, and validated `.uatu.json` exclusion rules consistently across indexing, follow mode, and static serving while surfacing configuration warnings.

## Requirements

### Requirement: Apply user-provided patterns from `.uatu.json ignore.exclude`
The system SHALL read each directory watch root's `.uatu.json ignore.exclude` as a string array of gitignore-compatible patterns, supporting negation and applying them in order. Explicit exclusions SHALL govern exposure independently of Show ignored files; configuration scope, reload, and warning behavior SHALL follow the scenarios below.

#### Scenario: Exclusions and negations preserve exposure boundaries
- **WHEN** directory-root exclusion patterns are applied
- **THEN** explicit positive Uatu exclusions SHALL remove files and folders from discovery, watching, on-demand listing, browsing, Follow, static serving, and media delivery, regardless of Show ignored files
- **AND** negations SHALL retain their existing ability to reveal specific Gitignored paths when ignored visibility is off, but MUST NOT bypass built-in exclusions

#### Scenario: Root configuration changes or contains invalid and retired settings
- **WHEN** root configuration is read or changes
- **THEN** root-level configuration SHALL be reread when changed, repairing watch coverage where necessary
- **AND** invalid shape SHALL produce one configuration warning and apply no user exclusions
- **AND** a root `.uatu.json` still containing `ignore.include` SHALL produce one configuration warning saying the key has no effect, and the key SHALL NOT change exposure or visibility

#### Scenario: Configuration reads exclude single-file roots and nested files
- **WHEN** configuration sources are selected for any watch root
- **THEN** single-file roots SHALL not consult this configuration, and nested `.uatu.json` files SHALL not be read

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

### Requirement: Surface `.uatu.json` configuration warnings in the session
The session SHALL surface every `.uatu.json` configuration warning — read failures other than the file being absent, JSON parse failures, and `ignore` shape-validation warnings — in the repository snapshot's config warnings, where the Change Overview displays them.

#### Scenario: Warning collection follows watch-root configuration scope
- **WHEN** configuration warnings are collected for watched roots
- **THEN** warnings SHALL be read from each directory watch root's `.uatu.json`, which controls filtering, not from the repository top level
- **AND** a root below the repository top level SHALL prefix its warnings with its repository-relative path so multiple roots stay distinguishable
- **AND** roots outside a git repository SHALL surface warnings the same way
- **AND** single-file watch roots read no ignore configuration and SHALL produce no config warnings

#### Scenario: Empty configuration is one malformed-JSON problem
- **WHEN** a `.uatu.json` exists but is zero-byte or whitespace-only
- **THEN** an empty file SHALL be treated as malformed JSON and produce the parse warning rather than being silently accepted as valid

#### Scenario: Every underlying configuration problem produces one warning
- **WHEN** an underlying configuration problem is reported
- **THEN** it SHALL be reported as one warning, even when more than one subsystem reads the file

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
- **WHEN** a session child is started with `script.py` and a malformed `.uatu.json` exists in `script.py`'s directory
- **THEN** the session's config warnings are empty, matching the engine's rule that single-file roots read no ignore configuration

#### Scenario: A missing `.uatu.json` produces no warning
- **WHEN** the watch root has no `.uatu.json`
- **THEN** the session's config warnings contain no `.uatu.json` entry

#### Scenario: One problem is reported once
- **WHEN** the watch root's `.uatu.json` is malformed JSON
- **THEN** the session's config warnings contain exactly one parse warning for it, even though both the warning collector and the ignore engine read the file

### Requirement: Git-ignore visibility is personal and defaults to show
The system SHALL discover and observe permitted files independently of Git-ignore status and provide per-client Show ignored files across All, Recent, filename/path results, and Follow candidates. Personal visibility SHALL default to show unless explicit legacy defaults select otherwise, without changing exposure permissions or another client's state.

#### Scenario: Classification uses Git semantics without inventing certainty
- **WHEN** files are classified for ignored visibility
- **THEN** known ignored classification SHALL follow Git's standard ignore sources and tracked-file semantics
- **AND** unavailable classification SHALL remain unknown rather than a false ignored/clean claim

#### Scenario: Initial ignored visibility respects saved and legacy choices
- **WHEN** initial personal visibility is resolved
- **THEN** a saved personal preference SHALL win; otherwise explicit --no-gitignore SHALL select show, explicit `ignore.respectGitignore` SHALL select its inverse, and an omitted/invalid setting SHALL select show
- **AND** invalid legacy-setting shape SHALL still produce a configuration warning

#### Scenario: A visibility toggle affects browsing only
- **WHEN** a client toggles Show ignored files
- **THEN** it SHALL neither reconstruct shared watchers nor command another client, select a preview, clear deliberate deselection, stop playback, or enable Follow

#### Scenario: Hidden open files and direct access remain independent of toggles
- **WHEN** the current browsing preference hides an explicitly open file
- **THEN** that file SHALL remain open without being injected back into results
- **WHEN** otherwise permitted direct authenticated access is requested
- **THEN** visibility alone SHALL NOT deny that access

#### Scenario: An unconfigured workspace shows ignored exports
- **WHEN** no personal visibility or explicit legacy default exists and Git ignores `renders/`
- **THEN** permitted files in that directory appear with ignored styling

#### Scenario: Multiple roots aggregate explicit initial defaults
- **WHEN** personal visibility is absent and --no-gitignore is not supplied
- **THEN** any watched directory root's explicit respectGitignore=true initially hides ignored files
- **AND** explicit false, omitted, and invalid settings in other roots do not override it or prevent startup, regardless of root order
- **AND** root/policy recovery recomputes the fallback from the current roots

#### Scenario: Existing explicit project policy supplies the initial view
- **WHEN** personal visibility is absent and `ignore.respectGitignore` is explicitly true
- **THEN** ignored files initially remain hidden
- **AND** the user can enable Show ignored files without editing project configuration

#### Scenario: CLI supplies a legacy default
- **WHEN** personal visibility is absent, --no-gitignore is supplied, and the project explicitly respects Git-ignore rules
- **THEN** ignored files initially show

#### Scenario: Saved personal preference wins
- **WHEN** a user has saved hidden ignored visibility and a legacy setting defaults to show
- **THEN** that user's next client starts with ignored files hidden

#### Scenario: Invalid legacy setting falls back to the new default
- **WHEN** respectGitignore has an invalid non-boolean value and no personal preference exists
- **THEN** one warning is surfaced and visibility defaults to show

#### Scenario: Hiding ignored files preserves an explicit open destination
- **WHEN** an ignored file is open or playing and the user turns Show ignored files off
- **THEN** it leaves browsing results without replacing the preview or stopping playback

#### Scenario: Ignore rules change at runtime
- **WHEN** Git-ignore policy changes while clients have different visibility preferences
- **THEN** file classifications and each client's eligible results converge without changing the other client's preference
- **AND** ordinary file observation remains available for the permitted superset

#### Scenario: Tracked files match an ignore pattern
- **WHEN** an already tracked file matches a Git-ignore pattern
- **THEN** it is not falsely treated as an ignored untracked export

### Requirement: Built-in exclusions match VS Code's defaults
The system SHALL hide only the names VS Code's `files.exclude` hides by default, at any depth: the VCS metadata directories `.git`, `.svn`, `.hg`, and `.jj`, and the OS files `.DS_Store` and `Thumbs.db`. These SHALL be the only built-in exclusions and SHALL be encoded in source.

#### Scenario: Built-in policy cannot be weakened or silently expanded
- **WHEN** default exclusions are applied, with or without project configuration
- **THEN** they SHALL be encoded in source and SHALL apply whether or not project configuration exists
- **AND** they SHALL NOT be bypassed by a visibility preference or by a negation in project configuration
- **AND** no other directory name, file name, suffix, or secret-like pattern SHALL be excluded by default
- **AND** dependency, build, cache, virtual-environment, editor-temporary, and secret-like paths SHALL be governed by Git-ignore visibility and explicit project exclusions like any other path

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
