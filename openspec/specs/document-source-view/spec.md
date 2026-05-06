## Purpose

Define the per-document Source / Rendered view toggle in the preview header for documents with a non-trivial rendered representation (Markdown, AsciiDoc), including its global persisted preference and the rendering rules for Source view.

## Requirements

### Requirement: Per-document Source/Rendered view toggle in the preview header

The preview header SHALL expose a Source / Rendered view toggle for documents that have a non-trivial rendered representation (Markdown, AsciiDoc). The toggle MUST be a two-segment control labeled "Source" and "Rendered" with the same visual language as the existing Mode toggle. The toggle SHALL NOT appear for non-document previews (commit views, review-score views, empty state) and SHALL NOT appear for documents whose rendered view is identical to their source view (text / source files such as `.ts`, `.py`, `.json`, etc.).

#### Scenario: Toggle appears for Markdown documents
- **WHEN** the active preview is a Markdown document
- **THEN** the preview header displays the Source / Rendered toggle

#### Scenario: Toggle appears for AsciiDoc documents
- **WHEN** the active preview is an AsciiDoc document
- **THEN** the preview header displays the Source / Rendered toggle

#### Scenario: Toggle is hidden for source / text files
- **WHEN** the active preview is a text or source file (for example `.ts`, `.py`, `.json`)
- **THEN** the Source / Rendered toggle is not rendered in the preview header

#### Scenario: Toggle is hidden for non-document previews
- **WHEN** the active preview is a commit view, review-score view, or the empty state
- **THEN** the Source / Rendered toggle is not rendered in the preview header

### Requirement: View-mode preference is global and persisted

The user's choice between Source and Rendered SHALL be a single global preference, not per-document. The preference MUST be persisted to `localStorage` and MUST default to Rendered on first visit. Switching the toggle MUST update the persisted preference immediately and MUST take effect both for the currently-displayed document and for every subsequent document opened, including across page reloads.

#### Scenario: First visit defaults to Rendered
- **WHEN** the user opens UatuCode for the first time on a fresh `localStorage`
- **AND** opens a Markdown document
- **THEN** the document is shown in Rendered view
- **AND** the Source / Rendered toggle indicates Rendered is active

#### Scenario: View-mode persists across reload
- **WHEN** the user switches the view to Source
- **AND** reloads the page
- **THEN** the active document is shown in Source view
- **AND** the toggle indicates Source is active

#### Scenario: View-mode applies across documents
- **WHEN** the user switches the view to Source while document A is open
- **AND** then opens document B (Markdown or AsciiDoc) via the Files pane
- **THEN** document B is shown in Source view

### Requirement: Source view renders the file's raw text with the line-number gutter

When the user is in Source view, the preview body SHALL render the active document's verbatim on-disk text as a single `<pre><code>` block, syntax-highlighted by file kind, with the line-number gutter implementation already used for source files (see `attachLineNumbers` at `src/app.ts:1393`). No Markdown / AsciiDoc parsing or transformation MAY be applied to the displayed content. The whole-file `<pre>` element MUST carry a distinguishing class so other parts of the UI (in particular the Selection Inspector pane) can identify it unambiguously and distinguish it from fenced code blocks rendered inside Markdown / AsciiDoc body content.

#### Scenario: Markdown source view shows raw markdown text
- **WHEN** a user views a Markdown document in Source view
- **THEN** the preview body shows a `<pre><code>` block containing the file's raw text, including markup tokens (`#`, `**`, `[..](..)`, fences, etc.)
- **AND** a line-number gutter is rendered beside the code

#### Scenario: AsciiDoc source view shows raw asciidoc text
- **WHEN** a user views an AsciiDoc document in Source view
- **THEN** the preview body shows a `<pre><code>` block containing the file's raw text, including markup tokens
- **AND** a line-number gutter is rendered beside the code

#### Scenario: Whole-file source `<pre>` is distinguishable
- **WHEN** the source view is rendered for any file kind
- **THEN** the whole-file `<pre>` element carries a distinguishing class (or equivalent attribute) that does not appear on fenced code blocks rendered inside Markdown / AsciiDoc body content

### Requirement: Toggling view does not change the active document or navigation

Toggling Source ↔ Rendered MUST NOT change which document is selected, MUST NOT push a new history entry, MUST NOT alter Pin / Follow state, and MUST NOT switch the Mode toggle. The toggle SHOULD apply without a full document reload — switching between Source and Rendered MUST NOT cause an "Document unavailable" or empty-preview flash.

#### Scenario: Active path stays the same after toggle
- **WHEN** a user is viewing document A in Rendered view
- **AND** toggles to Source view
- **THEN** the preview-path label still shows document A's path
- **AND** the Files-pane selection still highlights document A

#### Scenario: Toggle does not flash an empty state
- **WHEN** a user toggles Rendered → Source on a document already loaded
- **THEN** the preview body updates to the source representation directly
- **AND** the preview does not show "Document unavailable" or any equivalent empty state during the transition
