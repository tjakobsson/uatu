# file-facts Specification

## Purpose
Surface per-file facts (size, line count, git provenance, freshness) as a strip in the preview's Source and Diff views, and signal in-place updates when the active document changes on disk.
## Requirements
### Requirement: File facts ride the document render payload
The server SHALL compute file facts for every document render and attach them to the `/api/document` payload. Facts SHALL include line count and byte size of the on-disk file. For documents inside a git root, facts SHALL additionally include the last commit touching the file (author name, author date, short SHA, subject) and whether the working tree differs from HEAD for that path. Facts SHALL be recomputed on every render so live-reload keeps them current.

#### Scenario: Document in a git root
- **WHEN** the client fetches `/api/document` for a committed file in a git-backed root
- **THEN** the payload includes line count, byte size, last-commit author, author date, short SHA, and a clean/dirty flag

#### Scenario: Document in a non-git root
- **WHEN** the client fetches `/api/document` for a file in a watched root that is not a git repository
- **THEN** the payload includes line count, byte size, and the file's modification time, with no git fields

#### Scenario: File never committed
- **WHEN** the file exists in a git root but has no commit touching it
- **THEN** the payload carries no last-commit fields and marks the file as uncommitted

#### Scenario: Git lookup fails
- **WHEN** the git subprocess errors or times out during facts collection
- **THEN** the document render still succeeds, and facts degrade to the non-git shape

### Requirement: Facts strip is shown only in Source and Diff views
The preview SHALL render a file facts strip when the active document is displayed in Source or Diff view, and SHALL NOT render it in Rendered view. Text/code files, which are always source-rendered, SHALL always show the strip.

#### Scenario: Markdown flipped to Source view
- **WHEN** the user switches a markdown document from Rendered to Source view
- **THEN** the facts strip appears above the source body

#### Scenario: Markdown in Rendered view
- **WHEN** a markdown document is displayed in Rendered view
- **THEN** no facts strip is rendered (the frontmatter metadata card remains the only metadata surface)

#### Scenario: Plain text file selected
- **WHEN** the user selects a text/code file (always source-rendered)
- **THEN** the facts strip is shown

### Requirement: Source-view strip content
In Source view, the strip SHALL show, in order: last-commit author, a freshness segment (see freshness requirement), short SHA, line count, and human-readable byte size. In a non-git root the strip SHALL show only line count, byte size, and the file modification time. All values SHALL be HTML-escaped before reaching the DOM.

#### Scenario: Committed file in Source view
- **WHEN** a committed, unmodified file is shown in Source view
- **THEN** the strip reads like `Tobias Jakobsson · Nov 4, 2025 · dfe9088a · 214 lines · 8.2 KB`

#### Scenario: Author name contains markup
- **WHEN** the last-commit author name contains HTML-special characters
- **THEN** the strip renders them as escaped text, never as live markup

### Requirement: Diff-view strip content
In Diff view, the strip SHALL show the compare base ref, the additions and deletions of the active file against that base, and the last-commit author and short SHA. Additions and deletions SHALL be visually distinguished (added vs. removed styling).

#### Scenario: Modified file in Diff view
- **WHEN** a file with changes against the compare target is shown in Diff view
- **THEN** the strip reads like `vs main · +12 −4 · Tobias Jakobsson · dfe9088a`

### Requirement: Freshness segment reflects uncommitted state
When the working tree differs from HEAD for the active file (or the file has never been committed), the strip's date segment SHALL show the file's modification time as a relative time with an `uncommitted` marker, instead of the last-commit date. When the file is clean, the segment SHALL show the last-commit author date.

#### Scenario: File with uncommitted edits
- **WHEN** the active file has uncommitted working-tree changes and is shown in Source view
- **THEN** the freshness segment reads `modified 2m ago · uncommitted` (relative time) instead of the last-commit date

#### Scenario: Clean file
- **WHEN** the active file matches HEAD
- **THEN** the freshness segment shows the last-commit date with no `uncommitted` marker

### Requirement: On-disk change signal
When the actively viewed document changes on disk and the preview live-reloads in place, the UI SHALL signal the update. In Source and Diff views the signal SHALL be a pulse on the facts strip's freshness segment. In Rendered view the signal SHALL be a transient indicator in the preview header that disappears after a short interval. The signal SHALL respect `prefers-reduced-motion` by substituting a non-animated presentation.

#### Scenario: Active file changes while in Source view
- **WHEN** a file event for the active document triggers an in-place reload in Source view
- **THEN** the freshness segment updates to `modified just now · uncommitted` and pulses

#### Scenario: Active file changes while in Rendered view
- **WHEN** a file event for the active document triggers an in-place reload in Rendered view
- **THEN** a transient "Updated" indicator appears in the preview header and clears itself after a short interval

#### Scenario: Navigating away clears the signal
- **WHEN** the user selects a different document while the signal is visible
- **THEN** the signal is cleared immediately

### Requirement: Change signal stays calm under rapid events
When file events for the active document arrive in rapid succession (e.g., an agent streaming writes), the signal SHALL remain continuously lit rather than restarting its animation per event, and SHALL settle once events stop.

#### Scenario: Rapid successive writes
- **WHEN** multiple file events for the active document arrive within the signal's display interval
- **THEN** the signal stays lit without strobing and fades only after events stop arriving
