## MODIFIED Requirements

### Requirement: Per-document Source/Rendered view toggle in the preview header

The preview header SHALL expose a per-document view chooser as a segmented radio control with up to three segments — **Rendered**, **Source**, and **Diff** — using the same visual language as the existing Mode toggle. The set of segments shown SHALL depend on the active document's kind:

- For **Markdown** and **AsciiDoc** documents the chooser SHALL display all three segments: Rendered, Source, Diff.
- For **text / source** documents (for example `.ts`, `.py`, `.json`) the chooser SHALL display two segments: Source, Diff. The Rendered segment SHALL NOT appear because text / source files have no separate rendered representation.

The chooser SHALL NOT appear for non-document previews (commit views, review-score views, empty state) and SHALL NOT appear for binary "preview unavailable" previews. The chooser SHALL remain visible in side-by-side and stacked layouts so the Diff segment stays reachable — Diff replaces both panes and would otherwise be unreachable from a split layout; clicking Source or Rendered while in split updates the persisted preference for the next return to single layout but does not change the visible content. When the persisted view preference is not in the set of segments available for the active document's kind, the system SHALL fall back to the first available segment (Source for text / source files, Rendered for Markdown and AsciiDoc) without overwriting the persisted preference.

#### Scenario: Chooser appears with three segments for Markdown documents
- **WHEN** the active preview is a Markdown document
- **AND** the active layout is single
- **THEN** the preview header displays the view chooser with Rendered, Source, and Diff segments

#### Scenario: Chooser appears with three segments for AsciiDoc documents
- **WHEN** the active preview is an AsciiDoc document
- **AND** the active layout is single
- **THEN** the preview header displays the view chooser with Rendered, Source, and Diff segments

#### Scenario: Chooser appears with Source and Diff for text / source files
- **WHEN** the active preview is a text or source file (for example `.ts`, `.py`, `.json`)
- **THEN** the preview header displays the view chooser with Source and Diff segments only
- **AND** the Rendered segment is not shown

#### Scenario: Chooser is hidden for non-document previews
- **WHEN** the active preview is a commit view, review-score view, or the empty state
- **THEN** the view chooser is not rendered in the preview header

#### Scenario: Chooser stays visible in split layouts so Diff remains reachable
- **WHEN** the active layout is side-by-side or stacked
- **AND** the active preview is a Markdown or AsciiDoc document
- **THEN** the view chooser is rendered in the preview header with all three segments
- **AND** the Diff segment is clickable

#### Scenario: Clicking Source or Rendered while in split updates the preference without changing visible content
- **WHEN** the active layout is side-by-side or stacked
- **AND** the user clicks the Source or Rendered segment in the view chooser
- **THEN** the persisted view-mode preference updates to the clicked segment
- **AND** the visible split content does NOT change (both panes remain rendered)

#### Scenario: Persisted preference not available for kind falls back to first available segment
- **WHEN** the persisted view preference is Rendered
- **AND** the active document is a text / source file (no Rendered segment is shown)
- **THEN** the chooser indicates Source is active
- **AND** the persisted preference value is unchanged

### Requirement: View-mode preference is global and persisted

The user's choice between Rendered, Source, and Diff SHALL be a single global preference, not per-document. The preference MUST be persisted to `localStorage` and MUST default to Rendered on first visit. Switching the chooser MUST update the persisted preference immediately and MUST take effect both for the currently-displayed document and for every subsequent document opened, including across page reloads. The persisted value SHALL be one of `"rendered"`, `"source"`, or `"diff"`; values outside this set MUST be treated as missing and fall back to the default.

#### Scenario: First visit defaults to Rendered
- **WHEN** the user opens UatuCode for the first time on a fresh `localStorage`
- **AND** opens a Markdown document
- **THEN** the document is shown in Rendered view
- **AND** the view chooser indicates Rendered is active

#### Scenario: View-mode persists across reload
- **WHEN** the user switches the view to Source
- **AND** reloads the page
- **THEN** the active document is shown in Source view
- **AND** the chooser indicates Source is active

#### Scenario: Diff preference persists across reload
- **WHEN** the user switches the view to Diff
- **AND** reloads the page
- **THEN** the active document is shown in Diff view
- **AND** the chooser indicates Diff is active

#### Scenario: View-mode applies across documents
- **WHEN** the user switches the view to Source while document A is open
- **AND** then opens document B (Markdown or AsciiDoc) via the Files pane
- **THEN** document B is shown in Source view

### Requirement: Toggling view does not change the active document or navigation

Toggling between Rendered, Source, and Diff MUST NOT change which document is selected, MUST NOT push a new history entry, MUST NOT alter Pin / Follow state, and MUST NOT switch the Mode toggle. The toggle SHOULD apply without a full document reload — switching between any pair of view segments MUST NOT cause an "Document unavailable" or empty-preview flash.

#### Scenario: Active path stays the same after toggle
- **WHEN** a user is viewing document A in Rendered view
- **AND** toggles to Source view
- **THEN** the preview-path label still shows document A's path
- **AND** the Files-pane selection still highlights document A

#### Scenario: Toggling to Diff preserves the active document
- **WHEN** a user is viewing document A in Rendered view
- **AND** toggles to Diff view
- **THEN** the preview-path label still shows document A's path
- **AND** the Files-pane selection still highlights document A

#### Scenario: Toggle does not flash an empty state
- **WHEN** a user toggles Rendered → Source on a document already loaded
- **THEN** the preview body updates to the source representation directly
- **AND** the preview does not show "Document unavailable" or any equivalent empty state during the transition

### Requirement: Layout chooser in the preview header

The preview surface SHALL expose a **layout chooser** above the document body — rendered inline inside the preview surface (specifically as a sibling above the `#preview` element in the preview shell) rather than as a control inside the pinned preview header pill — for documents that have a non-trivial rendered representation (Markdown, AsciiDoc). The chooser MUST be a three-segment radio control with the text-labeled states **Single**, **Side by side**, and **Stacked**, using the same segmented-pill visual primitive as the header view chooser and the Diff view's Unified / Split toggle so all in-content segmented controls in the app read as one primitive. The chooser SHALL NOT appear for non-document previews (commit views, review-score views, empty state) and SHALL NOT appear for documents whose rendered view is identical to their source view (text / source files such as `.ts`, `.py`, `.json`, etc.). The chooser SHALL additionally be hidden whenever the active view-mode is **Diff**, because the split layouts in this capability pair Source and Rendered only — Diff is a single-pane view and has no split orientation in this version. When the view-mode returns to Rendered or Source, the layout chooser SHALL reappear for Markdown / AsciiDoc documents.

#### Scenario: Layout chooser appears for Markdown documents
- **WHEN** the active preview is a Markdown document
- **AND** the active view-mode is Rendered or Source
- **THEN** an inline layout chooser is rendered above the document body with three segments (Single, Side by side, Stacked)

#### Scenario: Layout chooser appears for AsciiDoc documents
- **WHEN** the active preview is an AsciiDoc document
- **AND** the active view-mode is Rendered or Source
- **THEN** an inline layout chooser is rendered above the document body with three segments (Single, Side by side, Stacked)

#### Scenario: Layout chooser is hidden for source / text files
- **WHEN** the active preview is a text or source file (for example `.ts`, `.py`, `.json`)
- **THEN** no inline layout chooser is rendered above the document body

#### Scenario: Layout chooser is hidden for non-document previews
- **WHEN** the active preview is a commit view, review-score view, or the empty state
- **THEN** no inline layout chooser is rendered above the document body

#### Scenario: Layout chooser is hidden when the active view-mode is Diff
- **WHEN** the active view-mode is Diff for a Markdown or AsciiDoc document
- **THEN** no inline layout chooser is rendered above the document body

#### Scenario: Layout chooser reappears when leaving Diff view-mode
- **WHEN** the active view-mode changes from Diff to Rendered or Source
- **AND** the active preview is a Markdown or AsciiDoc document
- **THEN** the inline layout chooser is rendered above the document body
