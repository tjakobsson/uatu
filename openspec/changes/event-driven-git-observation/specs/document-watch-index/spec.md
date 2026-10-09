## MODIFIED Requirements

### Requirement: Repository work is independent of file delivery

Repository snapshots SHALL refresh independently of file indexing and file-update delivery. A slow or failed repository refresh MUST NOT delay publication of file changes or Source and Rendered previews. Repository results SHALL carry their own freshness state and SHALL preserve the last successful result while a replacement is pending or fails. Git-only changes SHALL remain observable, including commits, index changes, branch switches and fetched remote refs with no document edit.

While at least one client is subscribed, the system SHALL learn about Git-only changes from filesystem events on the repository's Git metadata. That covers the top level of the Git directory and, for a linked worktree, of the shared Git directory, plus the ref files of the current branch and the resolved compare base. The Git directory MUST NOT be watched recursively. Lock files, object storage and fsmonitor cookie files SHALL NOT trigger a refresh. When a watch root is narrower than its repository, the system SHALL also observe the repository's working tree outside that root, so that edits there update repository data. That observation excludes the Git directory and paths the repository's top-level `.gitignore` excludes, and it never adds those files to the document index. Clients MUST NOT drive repository collection with periodic requests. Periodic polling SHALL be used only where native observation is unavailable or failed, or when the session runs in polling mode. No Git metadata observation, polling or repository collection SHALL run while no client is subscribed.

A repository collection SHALL start promptly after the first trigger that follows a quiet period. Under sustained triggers, successive collections SHALL start no closer together than a minimum interval. Triggers that arrive in the meantime SHALL coalesce into one follow-up collection that reflects the latest state. Repository reads MUST NOT write to the repository, including Git's opportunistic index refresh.

A refresh whose result matches the published result SHALL publish nothing and keep its generation. Text that varies only with wall-clock time, such as a relative commit age, does not count as a difference. Repository data SHALL be marked stale only if collection is still in progress after a short grace period of about one second. Repository refreshes MUST NOT initiate document-tree rescans or replay a previous Follow target.

#### Scenario: Git stalls while the active document changes
- **WHEN** repository collection is blocked and the active file is saved
- **THEN** the file update reaches the client and its Source or Rendered preview shows the new bytes without waiting for repository collection
- **AND** once the grace period passes, the existing repository data is identified as stale rather than silently represented as fresh

#### Scenario: A commit changes only repository metadata
- **WHEN** an external commit updates HEAD and the index without changing document bytes
- **THEN** repository information updates without requiring a document edit and without waiting for a polling interval
- **AND** the update neither switches Follow selection nor rescans the file index

#### Scenario: A commit in a linked worktree is observed
- **WHEN** the watched root is a linked worktree and a commit is made in it
- **THEN** repository information updates, although the branch ref lives in the shared Git directory outside the watched root

#### Scenario: An edit outside a narrow watched root
- **WHEN** the watch root is a subdirectory of its repository and a tracked file outside that subdirectory is modified
- **THEN** repository information updates without a client request and without waiting for a polling interval
- **AND** the modified file does not appear in the document index

#### Scenario: Ignored output outside a narrow watched root
- **WHEN** the watch root is a subdirectory of its repository and a path that the repository's `.gitignore` excludes changes outside it
- **THEN** no repository collection is triggered by that change

#### Scenario: A page with Git views open sends no periodic requests
- **WHEN** a page shows the Change Overview, the Git Log or a Diff and nothing changes for several minutes
- **THEN** the page sends no repository refresh requests

#### Scenario: A fetch moves the compare base
- **WHEN** a fetch updates the remote ref that the compare base resolves through
- **THEN** the changed-files context is recollected against the new base

#### Scenario: An idle repository costs nothing
- **WHEN** a client is subscribed and neither files nor Git metadata change
- **THEN** no repository collection runs and no Git process is started

#### Scenario: Reading the repository does not trigger another refresh
- **WHEN** repository collection runs while tracked files have changed metadata but unchanged content
- **THEN** the Git index file is not rewritten
- **AND** no follow-up refresh is triggered by the collection itself

#### Scenario: Sustained edits pace repository collection
- **WHEN** files change continuously for several seconds
- **THEN** successive repository collections start no closer together than the minimum interval
- **AND** after the edits stop, one collection reflects the final state

#### Scenario: A refresh that finds nothing new is invisible
- **WHEN** a repository refresh produces the same result as the one already published, apart from wall-clock-relative text
- **THEN** no repository update is published and the repository generation does not change
- **AND** clients show no refreshing notice

#### Scenario: Native Git observation is unavailable
- **WHEN** the session runs in polling mode or native observation of the Git metadata or working tree fails
- **THEN** Git-only changes are still observed through periodic polling while a client is subscribed
- **AND** for a narrow watch root, each poll also collects repository data, so edits outside the root still appear

#### Scenario: The last client leaves
- **WHEN** the last subscribed client disconnects
- **THEN** Git metadata observation and polling stop, and no further repository collection is scheduled
