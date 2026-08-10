## ADDED Requirements

### Requirement: Surface `.uatu.json` configuration warnings in the session
The session SHALL surface every `.uatu.json` configuration warning — read
failures other than the file being absent, JSON parse failures, and the
`ignore` shape-validation warnings — in the repository snapshot's config
warnings, where the Change Overview displays them. A `.uatu.json` that exists
but is empty (zero-byte or whitespace-only) SHALL be treated as malformed JSON
and produce the parse warning rather than being silently accepted as valid.
One underlying problem SHALL be reported as one warning, even though more than
one subsystem reads the file.

#### Scenario: Empty `.uatu.json` produces a parse warning
- **WHEN** the watch root's `.uatu.json` exists but is zero bytes or contains only whitespace
- **THEN** the session's config warnings include an "Invalid .uatu.json" parse warning

#### Scenario: Shape-validation warnings reach the Change Overview
- **WHEN** the watch root's `.uatu.json` has an `ignore.exclude` value that is not a string array
- **THEN** the settings warning naming the file and the field appears in the repository snapshot's config warnings
- **AND** the session falls back to applying no user-provided excludes

#### Scenario: A missing `.uatu.json` produces no warning
- **WHEN** the watch root has no `.uatu.json`
- **THEN** the session's config warnings contain no `.uatu.json` entry

#### Scenario: One problem is reported once
- **WHEN** the watch root's `.uatu.json` is malformed JSON
- **THEN** the session's config warnings contain exactly one parse warning for it, even though both the warning collector and the ignore engine read the file
