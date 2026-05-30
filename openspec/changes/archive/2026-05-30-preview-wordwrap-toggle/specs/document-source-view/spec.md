## MODIFIED Requirements

### Requirement: Source view renders the file's raw text with the line-number gutter

When the user is in Source view (single layout) or when the Source pane is visible in a split layout, the affected region SHALL render the active document's verbatim on-disk text as a syntax-highlighted code block (highlighted by file kind), with a line-number gutter. No Markdown / AsciiDoc parsing or transformation MAY be applied to the displayed content. The whole-file source block MUST carry a distinguishing class so other parts of the UI (in particular the Selection Inspector pane) can identify it unambiguously and distinguish it from fenced code blocks rendered inside Markdown / AsciiDoc body content. This distinguishing class MUST be applied in both single Source view and the Source pane of split layouts.

When the global Wrap preference is **off** (the default), long lines SHALL scroll horizontally and each logical line occupies one visual row, as before. When Wrap is **on**, long lines SHALL soft-wrap within the available width and the line-number gutter SHALL remain **truthful to the code**: each line number SHALL align to the start of its own logical line, continuation rows of a wrapped line SHALL carry no number, and the next line's number SHALL align to where that next logical line begins. The gutter MUST NOT renumber wrapped continuation rows and MUST NOT desynchronize from the code. Line numbers MUST remain excluded from copy-to-clipboard and from text selection in both wrapped and unwrapped modes, and copied source text MUST preserve the file's real line breaks without inserting breaks at soft-wrap points.

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
