## ADDED Requirements

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
