## ADDED Requirements

### Requirement: HTTP readiness precedes background discovery completion

After existing path and invocation preflight checks pass, the session SHALL start serving its shell, state API, and live connection before initial file discovery or repository collection completes. The existing printed URL SHALL signal usable HTTP readiness, not complete indexing. TTY startup status and the banner SHALL transition at HTTP readiness; piped stdout SHALL retain its URL-only contract. State and the browser SHALL explicitly distinguish indexing from a complete empty workspace and a failed discovery. The shell's navigation and available terminal controls SHALL remain usable while indexing runs. The Hub SHALL accept and proxy the ready child during indexing.

#### Scenario: A large workspace opens while indexing
- **WHEN** initial discovery is deliberately held after successful preflight
- **THEN** the child prints its ready URL and the Hub can open the shell and live state
- **AND** the UI shows indexing progress and discovered files without waiting for Git

#### Scenario: An invalid root is rejected before readiness
- **WHEN** a requested root fails existing existence, binary-file, or Git-worktree validation
- **THEN** the child exits with the existing error behavior
- **AND** it does not print a ready URL or start the server or watcher

#### Scenario: A direct link precedes discovery of its file
- **WHEN** an allowed document URL is opened before background discovery reaches that path
- **THEN** the document can be resolved with a bounded path-specific read under the normal exposure rules
- **AND** it is not returned as raw source, declared deleted, or replaced with an unrelated default solely because discovery is incomplete
- **AND** a later discovery event does not duplicate or override that destination

#### Scenario: Shutdown occurs during indexing
- **WHEN** the Hub stops a child whose discovery is incomplete
- **THEN** the server, watcher, queued indexing work, and timers are released
- **AND** late work cannot republish readiness or keep the child alive
