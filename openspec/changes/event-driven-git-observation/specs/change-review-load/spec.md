## MODIFIED Requirements

### Requirement: Provide bounded git commit log context
The system SHALL provide a bounded recent commit log for each detected git repository. Each commit entry MUST include at minimum the short SHA, subject, full commit message and commit time, plus the author when available. The commit time SHALL be an absolute timestamp so that clients can show a commit's age that stays current. Entries SHALL keep carrying the relative-time text for compatibility with older clients; current clients SHALL derive displayed ages from the commit time. The log MUST be contextual information only and MUST NOT alter the changed-files context.

#### Scenario: Repository has recent commits
- **WHEN** a watched repository has git commits
- **THEN** the system exposes a bounded list of recent commits
- **AND** each commit entry includes a short SHA, subject, full commit message and absolute commit time

#### Scenario: Elapsed time alone does not change the commit log
- **WHEN** the same commits are collected again later and only wall-clock time has passed
- **THEN** each entry's commit time is unchanged
- **AND** the commit log is not treated as changed repository data

#### Scenario: Commit log cannot be read
- **WHEN** git log data is unavailable or a repository has no commits
- **THEN** the watch session remains usable
- **AND** the system reports an empty or unavailable commit-log state for that repository
