## Purpose

Define the per-document Source / Rendered view toggle and layout chooser in the preview header for documents with a non-trivial rendered representation (Markdown, AsciiDoc), including global persisted preferences and the rendering rules for Source and split views.

## Requirements

### Requirement: Per-document Source/Rendered view toggle in the preview header

The preview header SHALL expose a per-document segmented radio chooser using the existing Mode toggle's visual language: Rendered/Source/Diff for Markdown and AsciiDoc, and Source/Diff only for text/source files. The chooser SHALL remain usable in split layouts and respect the preview-kind and preference-fallback rules below.

#### Scenario: View segments reflect document kind and preview context
- **WHEN** the active document is text/source (for example `.ts`, `.py`, `.json`)
- **THEN** Rendered SHALL NOT appear because there is no separate rendered representation

#### Scenario: Non-document and binary previews suppress view segments
- **WHEN** a non-document commit view, review-score view, empty state, or binary "preview unavailable" preview is active
- **THEN** the chooser SHALL NOT appear

#### Scenario: An unavailable view preference falls back for any document kind
- **WHEN** a document kind cannot provide the persisted preferred view
- **THEN** it SHALL fall back to the first segment (Source for text/source, Rendered for Markdown/AsciiDoc) without overwriting the preference

#### Scenario: A split view keeps Diff and future single-view choices reachable
- **WHEN** side-by-side or stacked layout is active
- **THEN** the chooser SHALL remain visible so Diff can replace both panes
- **AND** clicking Source or Rendered SHALL update the persisted preference for the next return to single layout without changing visible split content

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

Rendered/Source/Diff SHALL be one global preference, not per-document. It MUST persist to `localStorage`, default to Rendered on first visit, and update immediately when the chooser switches, taking effect for the current and every subsequently opened document across reloads. Persisted values SHALL be `"rendered"`, `"source"`, or `"diff"`; other values MUST be treated as missing and use the default.

#### Scenario: Stored view mode is outside the supported enum
- **WHEN** `localStorage` contains a view preference other than `"rendered"`, `"source"`, or `"diff"`
- **THEN** it MUST be treated as missing and fall back to Rendered

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

### Requirement: Source view renders the file's raw text with the line-number gutter

Single Source view and split Source panes SHALL display the active document's verbatim on-disk text as a file-kind-highlighted code block with line-number gutter, without Markdown/AsciiDoc parsing or transformation. Whole-file identification, wrapping, line-number alignment, and copying SHALL follow the rules below.

#### Scenario: A whole-file Source block is mounted in single or split layout
- **WHEN** Source is rendered in either layout
- **THEN** its whole-file block MUST carry a distinguishing class so controls such as word-wrap can unambiguously distinguish it from fenced code blocks inside Markdown/AsciiDoc body content

#### Scenario: Wrap changes visual rows without changing logical lines
- **WHEN** global Wrap is off (the default)
- **THEN** long lines SHALL scroll horizontally with one visual row per logical line

#### Scenario: Wrap on preserves logical line numbering
- **WHEN** global Wrap is on
- **THEN** long lines SHALL soft-wrap within available width, with each number aligned to its logical line's start, unnumbered continuation rows, and the next number aligned to the next logical line's start
- **AND** the gutter MUST NOT renumber continuations or desynchronize from code

#### Scenario: Source text is selected or copied with either Wrap setting
- **WHEN** the user selects or copies wrapped or unwrapped Source
- **THEN** line numbers MUST be excluded from selection and clipboard content
- **AND** copied source MUST preserve real file line breaks without inserting breaks at soft-wrap points

#### Scenario: Markdown source view shows raw markdown text
- **WHEN** a user views a Markdown document in single Source view
- **THEN** the preview body shows a syntax-highlighted code block containing the file's raw text, including markup tokens (`#`, `**`, `[..](..)`, fences, etc.)
- **AND** a line-number gutter is rendered beside the code

#### Scenario: AsciiDoc source view shows raw asciidoc text
- **WHEN** a user views an AsciiDoc document in single Source view
- **THEN** the preview body shows a syntax-highlighted code block containing the file's raw text, including markup tokens
- **AND** a line-number gutter is rendered beside the code

#### Scenario: Whole-file source block is distinguishable
- **WHEN** the source view is rendered for any file kind, in single Source view or in the Source pane of a split layout
- **THEN** the whole-file source block carries a distinguishing class (or equivalent attribute) that does not appear on fenced code blocks rendered inside Markdown / AsciiDoc body content

#### Scenario: Source pane in a split layout shows raw text with the line-number gutter
- **WHEN** a user views a Markdown or AsciiDoc document in side-by-side or stacked layout
- **THEN** the Source pane shows a code block containing the file's raw text
- **AND** a line-number gutter is rendered beside the code

#### Scenario: Wrap off scrolls long lines horizontally
- **WHEN** the global Wrap preference is off and a source file has lines wider than the pane
- **THEN** those lines do not wrap and the region scrolls horizontally
- **AND** each line number aligns one-to-one with a single visual row

#### Scenario: Wrap on keeps line numbers truthful to the code
- **WHEN** the global Wrap preference is on and a source line is wide enough to wrap across multiple visual rows
- **THEN** that line keeps its own number aligned to the start of the line
- **AND** the continuation rows of that line carry no number
- **AND** the following line's number aligns to where the following logical line begins (numbers do not drift or point at the wrong line)

#### Scenario: Copying wrapped source excludes line numbers and soft-wrap breaks
- **WHEN** the global Wrap preference is on and the user copies the source via the copy control
- **THEN** the copied text contains the file's code without any line-number text
- **AND** the copied text preserves the file's real line breaks and contains no breaks inserted at soft-wrap points

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

Markdown/AsciiDoc previews SHALL expose an inline layout chooser above the body as a sibling above `#preview` in the preview shell, not inside the pinned header pill. It MUST be a three-segment radio control labelled **Single**, **Side by side**, and **Stacked**, using the same segmented-pill primitive as the header view chooser and Diff Unified/Split toggle. Visibility SHALL follow the rules below.

#### Scenario: Preview kind or view mode determines layout-chooser visibility
- **WHEN** a non-document preview (commit view, review-score view, empty state) or a text/source document with identical rendered/source views (such as `.ts`, `.py`, `.json`) is active
- **THEN** the layout chooser SHALL NOT appear

#### Scenario: Diff suppresses layout orientation until another view is selected
- **WHEN** Diff is active
- **THEN** the layout chooser SHALL be hidden because Diff is single-pane with no split orientation in this version; these split layouts pair Source and Rendered only
- **WHEN** the view returns to Rendered or Source for a Markdown/AsciiDoc document
- **THEN** the layout chooser SHALL return

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

### Requirement: Layout preference is global and persisted

The **single**/**side-by-side**/**stacked** choice SHALL be one global preference, not per-document. It MUST persist to `localStorage` under a key distinct from Source/Rendered and default to **single** on first visit. Activating a segment MUST immediately persist the choice and apply it to the current and all subsequently opened documents across reloads.

#### Scenario: Layout choice is saved independently of view mode
- **WHEN** a user activates a layout-chooser segment
- **THEN** the layout MUST be persisted under a `localStorage` key distinct from Source/Rendered, without becoming a per-document choice

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

Side-by-side and stacked layouts SHALL simultaneously render the active document's Source and Rendered views in adjacent panes separated by a draggable resizer. The panes MUST scroll independently without one pane's scrolling moving the other. Orientation, rendering parity, and minimum sizing SHALL follow the rules below.

#### Scenario: A split is oriented and resized
- **WHEN** side-by-side is active
- **THEN** Source SHALL be left and Rendered right, with a vertical resizer adjusting horizontal allocation

#### Scenario: A stacked split is oriented and resized
- **WHEN** stacked is active
- **THEN** Source SHALL be above Rendered with a horizontal resizer adjusting vertical allocation

#### Scenario: Either split orientation enforces a minimum pane size
- **WHEN** a pane is dragged in either split orientation
- **THEN** each pane MUST retain a minimum size no smaller than 160 CSS pixels along the split axis during drag

#### Scenario: Split panes render their respective representations
- **WHEN** a split layout renders the active document
- **THEN** Source MUST follow single Source rendering rules: raw text in `<pre><code>`, line-number gutter, and the same distinguishing class on the whole-file `<pre>`
- **AND** Rendered MUST follow single Rendered rendering rules

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

Split ratios SHALL persist independently in `localStorage` for **side-by-side** and **stacked**. Each MUST be numeric, represent Source's fraction of available split-container size along the active axis, and be clamped to respect minimum pane size. Both MUST default to 0.5 on first visit. Dragging and orientation changes MUST save and restore ratios as below.

#### Scenario: A drag is followed by an orientation change
- **WHEN** the resizer is dragged
- **THEN** the current orientation's persisted ratio MUST update immediately

#### Scenario: An orientation switch restores its own ratio without another drag
- **WHEN** the user switches to side-by-side or stacked
- **THEN** switching to side-by-side MUST restore its last ratio, and switching to stacked MUST restore its last ratio, independently

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

If stored layout is **side-by-side** but available preview-body width is below the readable two-pane threshold (no smaller than `2 × minPaneSize` plus resizer width), the system SHALL render **stacked** without changing the stored preference. Above that threshold again, it SHALL restore side-by-side without user action.

#### Scenario: Available width determines automatic fallback
- **WHEN** side-by-side cannot fit two readable panes
- **THEN** the fallback threshold SHALL be no smaller than `2 × minPaneSize` plus resizer width, and the fallback MUST NOT overwrite the stored layout preference

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

Activating a layout segment MUST NOT change selected document, push history, alter Pin/Follow, switch Mode, or change Source/Rendered preference. It SHOULD apply without a full document reload and MUST NOT flash "Document unavailable" or an empty preview when representations are already in the in-memory document view cache. Missing representations SHALL follow the fetch rule below.

#### Scenario: A layout change requires an uncached representation
- **WHEN** only Source or Rendered is cached and the new layout requires the other
- **THEN** the missing representation MAY be fetched through the existing document API
- **AND** previously rendered content MUST remain visible during the fetch, without an empty-state flash

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
