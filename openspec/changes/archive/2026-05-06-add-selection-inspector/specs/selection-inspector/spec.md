## ADDED Requirements

### Requirement: Selection Inspector pane is available in Review mode

The browser UI SHALL expose a sidebar pane named **Selection Inspector** registered exclusively in the Review-mode pane lineup, alongside Change Overview, Files, and Git Log. The pane MUST participate in the existing pane infrastructure on equal footing with the other Review-mode panes (visibility control, collapse/expand, vertical resizer). The pane's visibility, collapsed state, and vertical size MUST be persisted to `localStorage` using the existing per-mode mechanism.

#### Scenario: Pane appears in Review mode by default
- **WHEN** a user opens UatuCode in Review mode for the first time on a fresh `localStorage`
- **THEN** the Selection Inspector pane is visible in the sidebar

#### Scenario: Pane visibility persists across reload
- **WHEN** a user is in Review mode and hides the Selection Inspector pane
- **AND** then reloads the page
- **THEN** the pane remains hidden

#### Scenario: Pane collapse and size persist across reload
- **WHEN** a user is in Review mode, collapses the Selection Inspector pane, and adjusts its vertical size
- **AND** then reloads the page in Review mode
- **THEN** the pane returns in the same collapsed state and at the same vertical size as before reload

### Requirement: Selection Inspector pane is hidden in Author mode

The pane MUST NOT be registered or rendered in Author mode. The Author-mode pane-visibility control MUST NOT list "Selection Inspector". Switching from Review to Author MUST hide the pane regardless of its prior visibility, and switching back to Review MUST restore the pane to its persisted Review-mode visibility state.

#### Scenario: Author mode does not expose the pane
- **WHEN** a user is in Author mode
- **THEN** the Selection Inspector pane is not visible
- **AND** the pane-visibility control does not list "Selection Inspector" as a toggle option

#### Scenario: Mode toggle hides and restores the pane
- **WHEN** a user is in Review mode with the pane visible
- **AND** switches the Mode toggle to Author
- **THEN** the pane is no longer rendered
- **WHEN** the user switches back to Review
- **THEN** the pane reappears in its persisted Review-mode visibility state

### Requirement: Pane captures line ranges from Source-view selections

While the pane is visible in Review mode AND the active document is shown in Source view (per the `document-source-view` capability), the pane SHALL capture the user's text selection as a `{ path, startLine, endLine }` record where `path` is the active document's path and `startLine` / `endLine` are 1-indexed source line numbers derived by counting newline characters in the source-view whole-file `<pre><code>` element's `textContent`. The capture MUST update live as the selection changes, without any manual refresh, hotkey, or button press.

#### Scenario: Source-view multi-line selection captures a range
- **WHEN** a user is in Review mode with Source view active for a document
- **AND** marks a span of text covering source lines 5 through 7 (inclusive) inside the source-view `<pre><code>`
- **THEN** the inspector captures `{ path: <document path>, startLine: 5, endLine: 7 }`

#### Scenario: Source-view single-line selection captures a one-line range
- **WHEN** a user marks a span of text entirely within source line 5 of the source-view `<pre><code>`
- **THEN** the inspector captures `{ path: <document path>, startLine: 5, endLine: 5 }`

#### Scenario: Live updates on selection change
- **WHEN** a user has an existing capture shown in the pane
- **AND** extends, shrinks, or replaces the selection without any other interaction
- **THEN** the captured record updates without a manual refresh

### Requirement: Pane displays a Claude-Code-style at-mention reference

When a record is captured, the pane SHALL display a single, copyable reference in Claude Code's at-mention syntax: `@<path>#L<startLine>-<endLine>` for ranges where `startLine !== endLine`, collapsed to `@<path>#L<startLine>` when `startLine === endLine`. The displayed reference MUST be set via `textContent` (never `innerHTML`).

#### Scenario: Multi-line selection renders a range reference
- **WHEN** the captured record is `{ path: "README.md", startLine: 21, endLine: 24 }`
- **THEN** the pane displays `@README.md#L21-24`

#### Scenario: Single-line selection collapses the range
- **WHEN** the captured record is `{ path: "src/app.ts", startLine: 42, endLine: 42 }`
- **THEN** the pane displays `@src/app.ts#L42`

### Requirement: Clicking the reference copies it to the clipboard

The displayed reference SHALL be a clickable, keyboard-accessible control. Activating it (mouse click, Enter, or Space when focused) MUST copy the rendered reference text to the system clipboard and provide a brief visual confirmation that the copy succeeded. The pane MUST NOT collapse or otherwise modify the user's selection in the preview as a side effect of the click.

#### Scenario: Click copies the reference to the clipboard
- **WHEN** the pane displays `@README.md#L21-24`
- **AND** the user clicks the displayed reference
- **THEN** the system clipboard contains `@README.md#L21-24`

#### Scenario: Keyboard activation copies the reference
- **WHEN** the pane displays a captured reference
- **AND** the user focuses the reference control via keyboard and presses Enter or Space
- **THEN** the system clipboard contains the displayed reference

#### Scenario: Click does not collapse the preview selection
- **WHEN** the user has marked text in the preview producing a captured reference
- **AND** clicks the displayed reference
- **THEN** the preview selection remains intact afterward

### Requirement: Rendered view shows an active hint, not a captured reference

When the active document is shown in Rendered view, the pane MUST NOT capture line ranges from selections. Instead, the pane MUST display an active hint that explains how to enable line capture: "Switch to Source view to capture a line range." The hint MUST be a clickable, keyboard-accessible control. Activating the hint MUST flip the global view-mode preference to Source.

#### Scenario: Rendered view shows the hint when text is selected
- **WHEN** a user is in Review mode with Rendered view active
- **AND** marks a span of prose text in the rendered preview
- **THEN** the pane displays the hint "Switch to Source view to capture a line range."
- **AND** does not display any `@path#L…` reference

#### Scenario: Activating the hint switches to Source view
- **WHEN** the pane displays the Rendered-view hint
- **AND** the user clicks the hint
- **THEN** the preview body switches to Source view
- **AND** the Source / Rendered toggle indicates Source is active

### Requirement: Selections inside fenced code blocks in Rendered view are ignored

In Rendered view, selections whose `commonAncestorContainer` lies inside a fenced code block (a `<pre><code>` rendered as a descendant of Markdown / AsciiDoc body content, NOT the whole-file source-view `<pre>`) MUST NOT be captured as line ranges. The line numbers from the per-fenced-block gutter at `src/app.ts:1393` are block-relative, not source-relative, so any captured range from such selections would be misleading. Such selections MUST instead be treated like any other Rendered-view selection — i.e. the pane displays the "Switch to Source view" hint.

#### Scenario: Selecting inside a rendered fenced code block does not capture lines
- **WHEN** a user is in Review mode with Rendered view active for a Markdown document containing fenced code blocks
- **AND** selects text inside a fenced code block in the rendered preview
- **THEN** the pane displays the same "Switch to Source view to capture a line range." hint as for prose selections
- **AND** does not display any `@path#L…` reference

### Requirement: Selections outside the source-view code block are ignored

In Source view, the pane MUST only capture selections whose `commonAncestorContainer` is contained by the whole-file source-view `<pre><code>` element. Selections rooted in sidebar panes, the preview header, or any element outside the whole-file source code block MUST NOT update the pane and MUST NOT overwrite a previously captured selection.

#### Scenario: Selection in a sidebar pane is ignored
- **WHEN** the pane currently shows a captured reference
- **AND** the user marks text inside a sidebar pane (e.g., a filename in the Files pane)
- **THEN** the pane continues to show the previously captured reference

#### Scenario: Selection in the preview header is ignored
- **WHEN** the user marks text inside the preview header (title, mode toggle, view toggle, path label)
- **THEN** the pane state does not change

### Requirement: Pane shows a placeholder when there is no preview selection

When there is no active text selection inside the preview — including immediately after a fresh page load, after navigation between documents, after the user collapses an existing selection, or after a view-mode toggle — the pane SHALL display a placeholder ("No selection") and MUST NOT display a captured reference, the Rendered-view hint, or the document path.

#### Scenario: Fresh load shows placeholder
- **WHEN** the user opens UatuCode in Review mode and the pane is visible
- **AND** has not yet selected any text
- **THEN** the pane shows the placeholder "No selection"

#### Scenario: Collapsing the selection returns the pane to placeholder
- **WHEN** the user has a captured reference shown in the pane
- **AND** clicks elsewhere in the preview, collapsing the selection
- **THEN** the pane returns to the "No selection" placeholder

### Requirement: Pane clears on document or view-mode change

When the active document changes (Files-pane click, inline cross-doc link, commit / review-score view switch) or when the view-mode toggle flips between Source and Rendered, the pane MUST be re-evaluated against the new state. A captured reference or Rendered-view hint from the previous state MUST NOT persist across the change. The pane's new content (placeholder, hint, or reference) MUST reflect the new DOM and the latest selection.

#### Scenario: Switching documents in Review mode clears the pane
- **WHEN** the user has a captured reference for document A
- **AND** switches to document B via the Files pane
- **THEN** the pane returns to "No selection" until the user marks text inside document B

#### Scenario: Toggling Rendered → Source clears the hint
- **WHEN** the user has the Rendered-view hint shown for an active selection in Rendered view
- **AND** flips to Source view
- **THEN** the pane is re-evaluated against the new Source-view DOM (showing either a captured reference or the placeholder)

#### Scenario: Toggling Source → Rendered clears a captured reference
- **WHEN** the user has a captured reference shown in Source view
- **AND** flips to Rendered view
- **THEN** the pane is re-evaluated against the new Rendered-view DOM (showing either the Rendered-view hint or the placeholder)

### Requirement: Selection state is not persisted across reloads

The pane's captured record (path, startLine, endLine, derived reference, transient pane mode) is ephemeral. It MUST NOT be written to `localStorage`, `sessionStorage`, cookies, the URL, the server, or any other persistent store. After a page reload, the pane MUST start in the placeholder state regardless of what was previously captured.

#### Scenario: Reload returns the pane to placeholder
- **WHEN** the user has a captured reference shown in the pane
- **AND** reloads the page
- **THEN** the pane shows the placeholder "No selection"
