## MODIFIED Requirements

### Requirement: Pane captures line ranges from Source-view selections

While the pane is visible in Review mode AND the active document is shown in Source view (per the `document-source-view` capability), the pane SHALL capture the user's text selection as a `{ path, startLine, endLine }` record where `path` is the active document's path and `startLine` / `endLine` are 1-indexed source line numbers derived by walking from the selection's start and end DOM nodes up to the nearest ancestor element carrying a `data-line` attribute, and reading that attribute as the line number. The capture MUST update live as the selection changes, without any manual refresh, hotkey, or button press. A selection whose end boundary sits at the leading edge of a line element (i.e. `range.endOffset === 0` of that element) MUST report the prior line as `endLine`, so a multi-line selection ending "just at the start of line N+1" reports line N as the last covered line.

#### Scenario: Source-view multi-line selection captures a range
- **WHEN** a user is in Review mode with Source view active for a document
- **AND** marks a span of text covering source lines 5 through 7 (inclusive) inside the source-view code region
- **THEN** the inspector captures `{ path: <document path>, startLine: 5, endLine: 7 }`

#### Scenario: Source-view single-line selection captures a one-line range
- **WHEN** a user marks a span of text entirely within source line 5 of the source-view code region
- **THEN** the inspector captures `{ path: <document path>, startLine: 5, endLine: 5 }`

#### Scenario: Selection ending at the start of a new line clamps to the prior line
- **WHEN** a user marks a span that begins inside source line 3 and ends exactly at the leading edge of source line 4
- **THEN** the inspector captures `{ path: <document path>, startLine: 3, endLine: 3 }`

#### Scenario: Live updates on selection change
- **WHEN** a user has an existing capture shown in the pane
- **AND** extends, shrinks, or replaces the selection without any other interaction
- **THEN** the captured record updates without a manual refresh

### Requirement: Selections inside fenced code blocks in Rendered view are ignored

In Rendered view, selections whose `commonAncestorContainer` lies inside a fenced code block (a `<pre>` rendered as a descendant of Markdown / AsciiDoc body content, NOT the whole-file source-view `<pre>`) MUST NOT be captured as line ranges. Line numbers from the per-fenced-block gutter are block-relative, not source-relative, so any captured range from such selections would be misleading. Such selections MUST instead be treated like any other Rendered-view selection — i.e. the pane displays the "Switch to Source view" hint.

#### Scenario: Selecting inside a rendered fenced code block does not capture lines
- **WHEN** a user is in Review mode with Rendered view active for a Markdown document containing fenced code blocks
- **AND** selects text inside a fenced code block in the rendered preview
- **THEN** the pane displays the same "Switch to Source view to capture a line range." hint as for prose selections
- **AND** does not display any `@path#L…` reference
