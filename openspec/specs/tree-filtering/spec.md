# tree-filtering Specification

## Purpose
Apply built-in, `.gitignore`, and validated `.uatu.json` exclusion rules consistently across indexing, follow mode, and static serving while surfacing configuration warnings.

## Requirements

### Requirement: Apply built-in defaults that hide common build/dependency directories
The system SHALL maintain source-defined built-in exclusions at any depth for at least node_modules, .git, dist, build, .next, .turbo, .cache, coverage, and .DS_Store. These defaults SHALL apply when project configuration is absent. A root's validated `ignore.include` SHALL permit narrowly named output subtrees beneath build/dist and traversal of only their necessary ancestors. This exception MUST NOT open dependency, VCS, secret, or other mandatory denied paths and MUST NOT override explicit positive Uatu exclusions. A user visibility preference SHALL NOT bypass these exposure rules.

#### Scenario: `node_modules/` is hidden in a project with no `.uatu.json`
- **WHEN** a watch root contains node_modules and no `.uatu.json`
- **THEN** no files beneath node_modules are indexed, listed, or served

#### Scenario: A nested `.git/` directory is hidden
- **WHEN** the root contains `tools/repos/example/.git/`
- **THEN** the nested Git directory is not traversed, indexed, listed, or served

#### Scenario: Defaults still apply when `.uatu.json` is silent on excludes
- **WHEN** project configuration contains no output include
- **THEN** build, dist, dependency directories, and other built-in exclusions remain excluded

#### Scenario: One generated-output subtree is included
- **WHEN** `ignore.include` contains `build/renders` and the root contains `build/renders/test.wav` and `build/objects/test.o`
- **THEN** the render can be discovered, watched, listed, and served
- **AND** `build/objects` remains excluded

### Requirement: Apply user-provided patterns from `.uatu.json ignore.exclude`
The system SHALL read each directory watch root's `.uatu.json ignore.exclude` as a string array of gitignore-compatible patterns, supporting negation and applying them in order. Explicit positive Uatu exclusions SHALL remove files from discovery, watching, browsing, Follow, static serving, and media delivery, regardless of Show ignored files or output includes. Negations SHALL retain their existing ability to reveal specific Gitignored paths when ignored visibility is off, but MUST NOT bypass mandatory denied paths. Root-level configuration SHALL be reread when changed, including repair of watch coverage where necessary. Single-file roots SHALL not consult this configuration, and nested `.uatu.json` files SHALL not be read. Invalid shape SHALL produce one configuration warning and apply no user exclusions.

#### Scenario: An `ignore.exclude` pattern hides a file from the tree
- **WHEN** `ignore.exclude` contains `bun.lock`
- **THEN** that file is not listed, followed, or served even with Show ignored files enabled

#### Scenario: An `ignore.exclude` negation un-excludes something `.gitignore` excluded
- **WHEN** Git ignores `*.log`, `ignore.exclude` contains `!debug.log`, and ignored visibility is off
- **THEN** `debug.log` remains visible while other ignored logs are hidden

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
- **WHEN** a session child is started with `script.py` and a malformed `.uatu.json` exists in `script.py`'s directory
- **THEN** the session's config warnings are empty, matching the engine's rule that single-file roots read no ignore configuration

#### Scenario: A missing `.uatu.json` produces no warning
- **WHEN** the watch root has no `.uatu.json`
- **THEN** the session's config warnings contain no `.uatu.json` entry

#### Scenario: One problem is reported once
- **WHEN** the watch root's `.uatu.json` is malformed JSON
- **THEN** the session's config warnings contain exactly one parse warning for it, even though both the warning collector and the ignore engine read the file

### Requirement: Git-ignore visibility is personal and defaults to show
The system SHALL discover and observe permitted files independently of Git-ignore status and provide per-client Show ignored files across All, Recent, filename/path results, and Follow candidates. Known ignored classification SHALL follow Git's standard ignore sources and tracked-file semantics; unavailable classification SHALL remain unknown rather than a false ignored/clean claim. Missing personal visibility SHALL default to show unless explicit legacy defaults select otherwise. A saved personal preference SHALL win; otherwise explicit --no-gitignore SHALL select show, explicit `ignore.respectGitignore` SHALL select its inverse, and an omitted/invalid setting SHALL select show. Invalid legacy-setting shape SHALL still produce a configuration warning. Toggling visibility SHALL neither reconstruct shared watchers nor command another client, select a preview, clear deliberate deselection, stop playback, or enable Follow. Explicitly open files hidden by that browsing preference SHALL remain open without being injected back into results. Visibility alone SHALL NOT deny otherwise permitted direct authenticated access.

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

### Requirement: Generated-output includes are narrow validated configuration
Directory roots SHALL accept `ignore.include` as an array of literal root-relative directory paths. It SHALL open only the named build/dist output subtrees and necessary traversal ancestors, subject to all higher-priority exposure exclusions. Absolute paths, parent traversal, malformed values, globs, and existing non-directory targets SHALL be rejected with configuration warnings. A missing directory SHALL be accepted as a future output location. Runtime edits SHALL reconcile discovery and watch coverage without restarting the session. Nested configuration and single-file roots SHALL retain their existing rules.

#### Scenario: A future render folder is configured
- **WHEN** `build/renders` is included before that directory exists and a renderer later creates it
- **THEN** its permitted files are discovered and subsequent writes reach clients

#### Scenario: An include attempts to escape
- **WHEN** an include contains an absolute path or `..` traversal
- **THEN** it is rejected with a configuration warning and does not broaden access

#### Scenario: Explicit exclusion wins over an include
- **WHEN** `build/renders` is included and `build/renders/private/**` is explicitly excluded
- **THEN** permitted siblings are available but private descendants remain unindexed and unserved

#### Scenario: An include is removed at runtime
- **WHEN** a project removes its only include for `dist/previews`
- **THEN** those files leave discovery/watch coverage and new direct/media requests are refused
