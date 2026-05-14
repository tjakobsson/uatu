## Purpose

Define the per-document Source / Rendered view toggle and layout chooser in the preview header for documents with a non-trivial rendered representation (Markdown, AsciiDoc), including global persisted preferences and the rendering rules for Source and split views.

## Requirements

### Requirement: Per-document Source/Rendered view toggle in the preview header

The preview header SHALL expose a Source / Rendered view toggle for documents that have a non-trivial rendered representation (Markdown, AsciiDoc). The toggle MUST be a two-segment control labeled "Source" and "Rendered" with the same visual language as the existing Mode toggle. The toggle SHALL NOT appear for non-document previews (commit views, review-score views, empty state) and SHALL NOT appear for documents whose rendered view is identical to their source view (text / source files such as `.ts`, `.py`, `.json`, etc.). The toggle SHALL also be hidden whenever the active layout is **side-by-side** or **stacked**, because both representations are already visible in those layouts; the toggle SHALL reappear when the layout returns to **single**.

#### Scenario: Toggle appears for Markdown documents
- **WHEN** the active preview is a Markdown document
- **AND** the active layout is single
- **THEN** the preview header displays the Source / Rendered toggle

#### Scenario: Toggle appears for AsciiDoc documents
- **WHEN** the active preview is an AsciiDoc document
- **AND** the active layout is single
- **THEN** the preview header displays the Source / Rendered toggle

#### Scenario: Toggle is hidden for source / text files
- **WHEN** the active preview is a text or source file (for example `.ts`, `.py`, `.json`)
- **THEN** the Source / Rendered toggle is not rendered in the preview header

#### Scenario: Toggle is hidden for non-document previews
- **WHEN** the active preview is a commit view, review-score view, or the empty state
- **THEN** the Source / Rendered toggle is not rendered in the preview header

#### Scenario: Toggle is hidden in split layouts
- **WHEN** the active layout is side-by-side or stacked
- **THEN** the Source / Rendered toggle is not rendered in the preview header

#### Scenario: Toggle reappears when returning to single layout
- **WHEN** the active layout returns to single from side-by-side or stacked
- **AND** the active preview is a Markdown or AsciiDoc document
- **THEN** the Source / Rendered toggle is rendered in the preview header

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

When the user is in Source view (single layout) or when the Source pane is visible in a split layout, the affected region SHALL render the active document's verbatim on-disk text as a single `<pre><code>` block, syntax-highlighted by file kind, with the line-number gutter implementation already used for source files (see `attachLineNumbers` at `src/app.ts:1393`). No Markdown / AsciiDoc parsing or transformation MAY be applied to the displayed content. The whole-file `<pre>` element MUST carry a distinguishing class so other parts of the UI (in particular the Selection Inspector pane) can identify it unambiguously and distinguish it from fenced code blocks rendered inside Markdown / AsciiDoc body content. This distinguishing class MUST be applied in both single Source view and the Source pane of split layouts.

#### Scenario: Markdown source view shows raw markdown text
- **WHEN** a user views a Markdown document in single Source view
- **THEN** the preview body shows a `<pre><code>` block containing the file's raw text, including markup tokens (`#`, `**`, `[..](..)`, fences, etc.)
- **AND** a line-number gutter is rendered beside the code

#### Scenario: AsciiDoc source view shows raw asciidoc text
- **WHEN** a user views an AsciiDoc document in single Source view
- **THEN** the preview body shows a `<pre><code>` block containing the file's raw text, including markup tokens
- **AND** a line-number gutter is rendered beside the code

#### Scenario: Whole-file source `<pre>` is distinguishable
- **WHEN** the source view is rendered for any file kind, in single Source view or in the Source pane of a split layout
- **THEN** the whole-file `<pre>` element carries a distinguishing class (or equivalent attribute) that does not appear on fenced code blocks rendered inside Markdown / AsciiDoc body content

#### Scenario: Source pane in a split layout shows raw text with the line-number gutter
- **WHEN** a user views a Markdown or AsciiDoc document in side-by-side or stacked layout
- **THEN** the Source pane shows a `<pre><code>` block containing the file's raw text
- **AND** a line-number gutter is rendered beside the code

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

### Requirement: Layout chooser in the preview header

The preview header SHALL expose a **layout chooser** alongside the existing Source / Rendered toggle for documents that have a non-trivial rendered representation (Markdown, AsciiDoc). The chooser MUST be a three-segment radio control with the states **single**, **side-by-side**, and **stacked**, using the same visual language as the existing Mode and Source / Rendered toggles. The chooser SHALL NOT appear for non-document previews (commit views, review-score views, empty state) and SHALL NOT appear for documents whose rendered view is identical to their source view (text / source files such as `.ts`, `.py`, `.json`, etc.). When the chooser is hidden, the existing Source / Rendered toggle visibility is unaffected by this requirement.

#### Scenario: Layout chooser appears for Markdown documents
- **WHEN** the active preview is a Markdown document
- **THEN** the preview header displays the layout chooser with three segments (single, side-by-side, stacked)

#### Scenario: Layout chooser appears for AsciiDoc documents
- **WHEN** the active preview is an AsciiDoc document
- **THEN** the preview header displays the layout chooser with three segments (single, side-by-side, stacked)

#### Scenario: Layout chooser is hidden for source / text files
- **WHEN** the active preview is a text or source file (for example `.ts`, `.py`, `.json`)
- **THEN** the layout chooser is not rendered in the preview header

#### Scenario: Layout chooser is hidden for non-document previews
- **WHEN** the active preview is a commit view, review-score view, or the empty state
- **THEN** the layout chooser is not rendered in the preview header

### Requirement: Layout preference is global and persisted

The user's choice between **single**, **side-by-side**, and **stacked** layouts SHALL be a single global preference, not per-document. The preference MUST be persisted to `localStorage` under a key distinct from the Source / Rendered preference and MUST default to **single** on first visit. Activating a layout-chooser segment MUST update the persisted preference immediately and MUST take effect both for the currently-displayed document and for every subsequent document opened, including across page reloads.

#### Scenario: First visit defaults to single layout
- **WHEN** the user opens UatuCode for the first time on a fresh `localStorage`
- **AND** opens a Markdown document
- **THEN** the document is shown in the single layout
- **AND** the layout chooser indicates single is active

#### Scenario: Layout preference persists across reload
- **WHEN** the user activates side-by-side layout
- **AND** reloads the page
- **THEN** the active document is shown in side-by-side layout
- **AND** the layout chooser indicates side-by-side is active

#### Scenario: Layout preference applies across documents
- **WHEN** the user activates stacked layout while document A is open
- **AND** then opens document B (Markdown or AsciiDoc) via the Files pane
- **THEN** document B is shown in stacked layout

### Requirement: Split layouts render Source and Rendered together with a draggable resizer

When the layout is **side-by-side** or **stacked**, the preview body SHALL render both the Source view and the Rendered view of the active document at the same time, in two adjacent panes, separated by a draggable resizer. In **side-by-side** the Source pane is on the left and the Rendered pane is on the right; the resizer is vertical and dragging adjusts horizontal allocation. In **stacked** the Source pane is on top and the Rendered pane is below; the resizer is horizontal and dragging adjusts vertical allocation. The two panes MUST scroll independently — scrolling one pane MUST NOT cause the other pane to scroll in response. The Source pane MUST apply the same rendering rules as the single Source view (raw text in a `<pre><code>` block with the line-number gutter and the same distinguishing class on the whole-file `<pre>`). The Rendered pane MUST apply the same rendering rules as the single Rendered view. Each pane MUST retain at least a minimum size (no smaller than 160 CSS pixels) along the split axis during drag.

#### Scenario: Side-by-side renders source on the left and rendered on the right
- **WHEN** a user is viewing a Markdown document
- **AND** activates the side-by-side layout
- **THEN** the preview body shows two panes: Source on the left, Rendered on the right
- **AND** a vertical resizer is rendered between them

#### Scenario: Stacked renders source above rendered
- **WHEN** a user is viewing a Markdown document
- **AND** activates the stacked layout
- **THEN** the preview body shows two panes: Source on top, Rendered below
- **AND** a horizontal resizer is rendered between them

#### Scenario: Dragging the resizer reallocates space between panes
- **WHEN** the layout is side-by-side
- **AND** the user drags the resizer to the right
- **THEN** the Source pane grows wider
- **AND** the Rendered pane shrinks by the same amount
- **AND** neither pane shrinks below its minimum size

#### Scenario: Panes scroll independently in split layouts
- **WHEN** the layout is side-by-side or stacked
- **AND** the user scrolls one of the two panes
- **THEN** the other pane's scroll position is unchanged

#### Scenario: Source pane in split applies the same rendering as single Source view
- **WHEN** the layout is side-by-side or stacked for a Markdown or AsciiDoc document
- **THEN** the Source pane contains a `<pre><code>` block with the file's raw text and a line-number gutter
- **AND** the whole-file `<pre>` carries the same distinguishing class used in single Source view

### Requirement: Split ratio is persisted per orientation

The split ratio between the two panes SHALL be persisted to `localStorage` independently for **side-by-side** and **stacked** orientations. Each stored ratio MUST be a numeric value representing the Source pane's fraction of the available split-container size along the active axis, clamped to a range that respects the minimum pane size. Default ratio for both orientations MUST be 0.5 on first visit. Dragging the resizer MUST update the persisted ratio for the current orientation immediately. Switching between orientations MUST restore each orientation's previously stored ratio (changing to side-by-side restores the last side-by-side ratio; changing to stacked restores the last stacked ratio).

#### Scenario: First visit defaults to a 50/50 ratio
- **WHEN** the user activates side-by-side or stacked layout on a fresh `localStorage`
- **THEN** the Source pane occupies approximately 50% of the available split-container size

#### Scenario: Ratio persists across reload per orientation
- **WHEN** the user drags the side-by-side resizer to set a 30/70 ratio
- **AND** reloads the page
- **AND** the layout preference is side-by-side
- **THEN** the side-by-side layout restores the 30/70 ratio

#### Scenario: Ratios are independent across orientations
- **WHEN** the user sets a 30/70 ratio in side-by-side
- **AND** switches to stacked and sets a 60/40 ratio
- **AND** switches back to side-by-side
- **THEN** side-by-side restores the 30/70 ratio

### Requirement: Side-by-side auto-stacks at narrow widths without overwriting preference

When the user's stored layout preference is **side-by-side** but the preview body's available width is below the threshold needed to render two readable panes (no smaller than `2 × minPaneSize` plus the resizer width), the system SHALL render the **stacked** layout for that document view. The user's stored preference MUST NOT be changed by this fallback. When the preview body's available width grows above the threshold again, the stored preference SHALL be honored and the layout SHALL revert to side-by-side without user action.

#### Scenario: Auto-stack engages at narrow widths
- **WHEN** the layout preference is side-by-side
- **AND** the preview body width drops below the side-by-side threshold (for example because the sidebar is opened, the window is resized, or the terminal is docked side)
- **THEN** the preview body renders in stacked layout
- **AND** the stored layout preference remains side-by-side

#### Scenario: Auto-stack releases when width grows back
- **WHEN** the layout is auto-stacked because of narrow width
- **AND** the preview body width grows above the side-by-side threshold
- **THEN** the preview body renders in side-by-side layout without user action

#### Scenario: Auto-stack does not engage when preference is stacked or single
- **WHEN** the layout preference is stacked or single
- **THEN** the auto-stack fallback has no effect regardless of preview body width

### Requirement: Activating the layout chooser does not change the active document or navigation

Activating any segment of the layout chooser MUST NOT change which document is selected, MUST NOT push a new history entry, MUST NOT alter Pin / Follow state, MUST NOT switch the Mode toggle, and MUST NOT change the Source / Rendered preference. The change SHOULD apply without a full document reload — switching layouts MUST NOT cause an "Document unavailable" or empty-preview flash for documents whose representations are already in the in-memory document view cache. When only one of Source / Rendered is currently cached for the active document and the layout change requires the other, the missing representation MAY be fetched via the existing document API, but the previously rendered content MUST remain visible during that fetch (no empty-state flash).

#### Scenario: Active path stays the same after layout change
- **WHEN** a user is viewing document A in single layout
- **AND** activates side-by-side layout
- **THEN** the preview-path label still shows document A's path
- **AND** the Files-pane selection still highlights document A

#### Scenario: Layout change does not flash an empty state
- **WHEN** a user activates side-by-side or stacked layout on a document whose Source and Rendered representations are both cached
- **THEN** the preview body updates to the split representation directly
- **AND** the preview does not show "Document unavailable" or any equivalent empty state during the transition

#### Scenario: Layout change preserves the Source / Rendered preference
- **WHEN** the Source / Rendered preference is Rendered
- **AND** the user activates side-by-side, then returns to single layout
- **THEN** the document is shown in Rendered view (the preference is unchanged)
