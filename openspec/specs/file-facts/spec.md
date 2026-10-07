# file-facts Specification

## Purpose
Surface per-file facts (size, line count, git provenance, freshness) as a strip in every document view, and signal in-place updates when the active document changes on disk.
## Requirements
### Requirement: File facts ride the document render payload
The server SHALL compute filesystem facts for every document render and attach them to the `/api/document` payload when available. Facts SHALL include the line count and byte size for the rendered source and its observed modification time. Source and Rendered content delivery MUST NOT wait for Git subprocesses. For documents inside a Git root, the client SHALL obtain the last commit touching the file and its clean, dirty, or uncommitted state independently and enrich the facts strip when available. Pending, stale, and unavailable Git facts SHALL be distinguishable from verified clean or uncommitted facts. Filesystem facts SHALL refresh with every render, and Git enrichment SHALL be scoped to the selected document, content revision, and repository generation. Obsolete enrichment MUST NOT replace newer facts. Git failure SHALL leave the document and filesystem facts usable.

#### Scenario: Document in a git root
- **WHEN** the client fetches a committed document
- **THEN** it can display rendered content and filesystem facts before Git lookup finishes
- **AND** matching Git facts subsequently supply author, date, short SHA, and clean or dirty state

#### Scenario: Document in a non-git root
- **WHEN** the client fetches a file from a non-Git watched root
- **THEN** the payload includes line count, byte size, and modification time with no Git fields
- **AND** no indefinite Git-loading indicator is displayed

#### Scenario: File never committed
- **WHEN** independent Git lookup confirms that no commit touches the selected file
- **THEN** the facts strip marks it uncommitted with no last-commit fields
- **AND** a pending lookup alone is not treated as that confirmation

#### Scenario: Git lookup fails
- **WHEN** a Git subprocess errors, times out, or remains pending
- **THEN** document rendering and file-change reloads continue without waiting for it
- **AND** the facts strip reports unavailable or pending provenance alongside filesystem facts

#### Scenario: Old facts arrive after another save
- **WHEN** an enrichment request for an older file revision finishes after a new save or navigation
- **THEN** it cannot overwrite the current strip or cause another document render

### Requirement: Facts strip is shown in all document views
The preview SHALL render a file facts strip when the active document is displayed in Rendered, Source, or Diff view. Text/code files, which are always source-rendered, SHALL also show the strip. The strip SHALL remain preview chrome separate from the Rendered view's frontmatter metadata card.

#### Scenario: Markdown flipped to Source view
- **WHEN** the user switches a markdown document from Rendered to Source view
- **THEN** the facts strip remains visible above the source body

#### Scenario: Markdown in Rendered view
- **WHEN** a markdown document is displayed in Rendered view
- **THEN** the facts strip is visible above the rendered body
- **AND** any frontmatter metadata card remains available as a separate document metadata surface

#### Scenario: Document in Diff view
- **WHEN** a document is displayed in Diff view
- **THEN** the facts strip is visible above the diff body

#### Scenario: Plain text file selected
- **WHEN** the user selects a text/code file that is always source-rendered
- **THEN** the facts strip is shown

#### Scenario: Split layout selected
- **WHEN** a document is displayed with Source and Rendered panes side by side or stacked
- **THEN** one file facts strip is shown in shared preview chrome without duplication in either pane

### Requirement: Document-view strip content
In Rendered and Source views, the strip SHALL show, in order: last-commit author, a freshness segment (see freshness requirement), short SHA, line count, and human-readable byte size. In a non-git root the strip SHALL show only line count, byte size, and the file modification time. All values SHALL be HTML-escaped before reaching the DOM.

#### Scenario: Committed file in a document view
- **WHEN** a committed, unmodified file is shown in Rendered or Source view
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
When the actively viewed document changes on disk and the preview live-reloads in place, the UI SHALL signal the update. In Rendered, Source, and Diff views with a visible facts strip, the signal SHALL highlight the strip's freshness segment. If file facts are unavailable and no strip can be shown, the signal SHALL fall back to a transient indicator in the preview header. The signal SHALL disappear after a short interval and SHALL respect `prefers-reduced-motion` by substituting a non-animated presentation.

#### Scenario: Active file changes while in Source view
- **WHEN** a file event for the active document triggers an in-place reload in Source view
- **THEN** the freshness segment updates to `modified just now · uncommitted` and is highlighted

#### Scenario: Active file changes while in Rendered view
- **WHEN** a file event for the active document triggers an in-place reload in Rendered view
- **THEN** the visible facts strip updates to the latest freshness state and its freshness segment is highlighted
- **AND** the fallback header indicator remains hidden

#### Scenario: Facts unavailable during an active-file reload
- **WHEN** a file event reloads the active document but no file facts are available to render a strip
- **THEN** a transient `Updated` indicator appears in the preview header and clears itself after a short interval

#### Scenario: Navigating away clears the signal
- **WHEN** the user selects a different document while the signal is visible
- **THEN** the signal is cleared immediately

### Requirement: Change signal stays calm under rapid events
When file events for the active document arrive in rapid succession (e.g., an agent streaming writes), the signal SHALL remain continuously lit rather than restarting its animation per event, and SHALL settle once events stop.

#### Scenario: Rapid successive writes
- **WHEN** multiple file events for the active document arrive within the signal's display interval
- **THEN** the signal stays lit without strobing and fades only after events stop arriving
