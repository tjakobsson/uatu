## ADDED Requirements

### Requirement: Diff view follows only repository changes that can affect the active diff
After a repository update, the Diff view SHALL re-fetch the active file's diff only when that update can change the diff. That is the case when the file's entry in the changed-files context changed, the resolved compare base changed, or `HEAD` moved. Any other repository update MUST NOT re-fetch the diff, re-render it, or show the Diff loading indicator. This requirement does not affect refreshing when the active file itself changes on disk.

#### Scenario: Another file changes
- **WHEN** the Diff view is active for file A
- **AND** a repository update reflects a change to file B only
- **THEN** file A's diff is neither re-fetched nor re-rendered
- **AND** the Diff loading indicator does not appear

#### Scenario: A commit moves HEAD
- **WHEN** the Diff view is active for a file
- **AND** a repository update reports that `HEAD` moved
- **THEN** the Diff view re-fetches and re-renders the file's diff

#### Scenario: The compare base moves
- **WHEN** the Diff view is active for a file
- **AND** a repository update reports a different resolved compare base
- **THEN** the Diff view re-fetches and re-renders the file's diff against the new base

#### Scenario: The active file's change entry changes
- **WHEN** the Diff view is active for a file
- **AND** a repository update changes that file's entry in the changed-files context, for example after staging or a rename
- **THEN** the Diff view re-fetches and re-renders the file's diff
