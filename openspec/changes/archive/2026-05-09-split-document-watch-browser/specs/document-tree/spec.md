## ADDED Requirements

### Requirement: Show a file-type icon next to each document in the tree
The sidebar document tree SHALL display a small icon next to each tree leaf — both clickable and non-clickable — that reflects its file type, so readers can visually distinguish file types at a glance. The icon rendering SHALL be keyed by file extension and MUST be trivially extensible (one entry per extension) so additional types can be added without churn. A generic fallback icon MUST be used for any extension that has no dedicated icon. Binary entries MUST also display an icon (using their extension where mapped, otherwise the generic icon).

#### Scenario: Markdown documents show a markdown icon in the tree
- **WHEN** the sidebar lists a `.md` or `.markdown` file
- **THEN** the tree row shows a file-type icon to the left of the file name

#### Scenario: Unknown extensions fall back to a generic file icon
- **WHEN** a file extension is not in the icon registry
- **THEN** the tree row still shows an icon (a generic file glyph) rather than an empty gap

#### Scenario: Binary entries also show an icon
- **WHEN** the sidebar lists a binary file (e.g. `logo.png`)
- **THEN** the tree row shows the file-type icon for that extension (or the generic icon if not mapped)
- **AND** the row remains non-clickable

### Requirement: Preserve manual directory open/closed state in the document tree
Directories in the sidebar tree SHALL render collapsed (closed) by default, matching the conventions of common file trees (VS Code, Finder, GitHub). When a user clicks a directory's summary to open or close it, that explicit choice SHALL persist for the rest of the session across document selections and sidebar re-renders triggered by file changes, overriding the default until the user toggles that directory again. When the active document changes (initial default, follow-mode auto-switch, or user click), the system SHALL reveal the path to that document by opening every ancestor directory between the watched root and the document. The reveal MUST be purely additive — it opens ancestors but never closes any directory the user has opened. The session-level override state MAY reset on page reload.

#### Scenario: Directories start collapsed
- **WHEN** the document tree is first rendered and the default document is at a watched root with no ancestor directories
- **THEN** nested directories render collapsed and only top-level documents are visible until the user expands a directory

#### Scenario: Follow-mode auto-switch reveals the path to the newly active document
- **WHEN** follow mode is enabled and a Markdown file inside a nested directory changes on disk
- **THEN** the preview switches to that file
- **AND** each ancestor directory from the watched root down to the file renders open

#### Scenario: Reveal is purely additive — it never closes anything
- **WHEN** the active document changes (initial default, follow-mode auto-switch, or user click)
- **THEN** directories the user has opened remain open
- **AND** only the new document's ancestor directories are added to the open set

#### Scenario: A manually opened directory stays open across file selections
- **WHEN** a user opens a directory by clicking its summary
- **AND** then selects a different Markdown file in the tree
- **THEN** the directory remains open

#### Scenario: Manual open/closed state survives sidebar re-renders
- **WHEN** a user opens a directory and a Markdown file is modified on disk, triggering a sidebar re-render
- **THEN** the directory remains open

### Requirement: Show last-modified time on each tree row
The sidebar tree SHALL display a small relative-time label next to every tree row (file leaves AND directories), reflecting how recently activity occurred at that path. For file leaves the label SHALL reflect the file's last-modified time on disk. For directory rows the label SHALL reflect the most recent last-modified time among any descendant file (recursively), so users can spot active subtrees without expanding them. The label SHALL use compact units (`now`, `5s`, `12m`, `2h`, `3d`, `4w`, `6mo`) and MUST be visually muted relative to the filename so it does not compete for attention. The label SHALL update in real time at approximately one-second resolution so the elapsed values tick visibly while the user watches.

#### Scenario: A recently modified file shows a small relative-time label
- **WHEN** the sidebar lists a file that was modified seconds ago
- **THEN** that tree row contains a relative-time label with a value like `now` or `5s`

#### Scenario: A directory row reflects the newest descendant file's modified time
- **WHEN** the sidebar lists a directory whose most recently modified descendant file was modified seconds ago
- **THEN** the directory row contains a relative-time label matching that descendant's relative time (e.g. `5s`)
- **AND** other descendants with older modified times do NOT influence the label

#### Scenario: Relative-time labels tick live without requiring a server event
- **WHEN** the user watches a tree row whose label currently reads `4s` and no file changes occur
- **THEN** within a few seconds the same label reads a larger value (e.g. `7s`, `10s`)

### Requirement: Display sidebar file count breakdown
The sidebar SHALL display a file count for the current scope. The count SHALL always show the total number of files visible in the tree. When the visible set contains binary files, the count SHALL additionally show how many are binary. When the watched roots contain files filtered by `.uatuignore` or `.gitignore`, the count SHALL additionally show how many were hidden by those user-controlled filters. The hardcoded directory denylist (e.g. `node_modules/`, `.git/`) MUST NOT contribute to the hidden count.

#### Scenario: Counter shows only the total when the tree is uniform
- **WHEN** the watched roots contain only viewable text and Markdown files with no `.uatuignore` or `.gitignore` filtering
- **THEN** the sidebar counter reads `N files` (e.g. `3 files`)

#### Scenario: Counter surfaces the binary subcount
- **WHEN** the watched roots contain a mix of viewable and binary files
- **THEN** the sidebar counter reads `N files · M binary` where M is the number of binary entries in the tree

#### Scenario: Counter surfaces the hidden subcount
- **WHEN** the watch root's `.uatuignore` filters out 2 files
- **AND** no binary files are present
- **THEN** the sidebar counter reads `N files · 2 hidden`

#### Scenario: Counter does not count denylisted directories as hidden
- **WHEN** the watch root contains `node_modules/` (in the hardcoded denylist) but no `.uatuignore` or `.gitignore` matches
- **THEN** the sidebar counter does not include a `· hidden` segment

### Requirement: Render directory rows in the file tree with a folder icon
When the `Files` pane renders the full-tree fallback, each directory row SHALL include a folder icon next to the directory name. The icon SHALL be visually consistent with the existing file-type icons used on file rows.

#### Scenario: Directory rows include a folder icon in the fallback tree
- **WHEN** the `Files` pane renders the full-tree fallback
- **THEN** each directory row displays a folder icon next to the directory name
