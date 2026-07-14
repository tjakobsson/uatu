## RENAMED Requirements

- FROM: `### Requirement: Facts strip is shown only in Source and Diff views`
- TO: `### Requirement: Facts strip is shown in all document views`

## MODIFIED Requirements

### Requirement: Facts strip is shown in all document views
The preview SHALL render a file facts strip when the active document is displayed in Rendered, Source, or Diff view. Text/code files, which are always source-rendered, SHALL also show the strip. The strip SHALL remain preview chrome separate from the Rendered view's frontmatter metadata card.

#### Scenario: Markdown flipped to Source view
- **WHEN** the user switches a markdown document from Rendered to Source view
- **THEN** the facts strip remains visible above the source body

#### Scenario: Markdown in Rendered view
- **WHEN** a markdown document is displayed in Rendered view
- **THEN** the facts strip is visible above the rendered body
- **AND** any frontmatter metadata card remains available as a separate document metadata surface

#### Scenario: Plain text file selected
- **WHEN** the user selects a text/code file that is always source-rendered
- **THEN** the facts strip is shown

#### Scenario: Split layout selected
- **WHEN** a document is displayed with Source and Rendered panes side by side or stacked
- **THEN** one file facts strip is shown in shared preview chrome without duplication in either pane

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
