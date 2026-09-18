## MODIFIED Requirements

### Requirement: Hub exposes authenticated folder mutation operations
The Hub SHALL expose public authenticated POST operations to create a folder from an absolute parent path and child name, rename a folder from an absolute source path and new sibling name, and remove an absolute folder path. Cookie-authenticated requests MUST pass the Hub's same-origin check. The Hub MUST reject relative paths, invalid names, non-directory or symbolic-link sources, rename destinations that already exist, and removal of any non-empty folder. A mutation MUST NOT recursively delete content or overwrite an existing filesystem entry. Before generic rename, the Hub SHALL reject moves that would invalidate Git worktree dependencies involving linked checkouts, main checkouts, common Git directories or their ancestors, including unregistered linked trees. This safety restriction SHALL apply to all otherwise supported folder-rename flows, even with stop authorization; uncertainty about affected Git dependency safety SHALL fail closed with an actionable explanation. Display-name changes SHALL remain unaffected.

The display-name allowance applies to ordinary/main workspaces. Linked child workspace names SHALL reflect their exact local branch; independent child display-name editing and branch rename are outside this change. This does not relax any folder dependency guard.

#### Scenario: Cross-origin folder mutation is rejected
- **WHEN** a cookie-authenticated cross-origin request attempts to create, rename, or remove a folder
- **THEN** the Hub rejects it without changing the filesystem or workspace registry

#### Scenario: Rename never replaces a destination
- **WHEN** a rename's destination path already names any filesystem entry
- **THEN** the Hub reports a conflict and leaves both source and destination unchanged

#### Scenario: Remove delegates emptiness enforcement to the filesystem
- **WHEN** a remove request names a directory containing a file, hidden entry, or child directory
- **THEN** the operation fails without recursively removing any entry

#### Scenario: Main checkout has an unregistered dependency
- **WHEN** a generic rename would move a main checkout or its ancestor and break links to a worktree not registered in Hub
- **THEN** the Hub refuses before filesystem mutation regardless of stop authorization and preserves registration paths

#### Scenario: Linked checkout or common directory would move
- **WHEN** a generic rename targets a linked checkout, shared Git directory, or containing ancestor whose move would invalidate a worktree dependency
- **THEN** the Hub refuses without attempting automatic Git repair or filesystem rename

#### Scenario: Dependency inspection is inconclusive
- **WHEN** Git dependency inspection cannot establish rename safety
- **THEN** the Hub leaves the filesystem unchanged and explains how to resolve or investigate the blocker
