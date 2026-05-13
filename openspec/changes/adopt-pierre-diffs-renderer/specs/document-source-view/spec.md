## MODIFIED Requirements

### Requirement: Source view renders the file's raw text with the line-number gutter

When the user is in Source view, the preview body SHALL render the active document's verbatim on-disk text, syntax-highlighted by file kind, with a line-number gutter. The rendered DOM MUST expose every source line as a discrete element carrying a `data-line` attribute whose value is the 1-indexed source line number (e.g. `<div data-line="1">…</div>`), so that DOM-walking selection logic (the Selection Inspector pane) can derive line numbers from attributes rather than from whitespace counting. The line-number gutter MUST NOT contribute text to the line elements that carry `data-line` — the gutter is rendered in a separate region of the `<pre>` and is visually distinguishable from the code text. No Markdown / AsciiDoc parsing or transformation MAY be applied to the displayed content. The whole-file `<pre>` element MUST carry a distinguishing class so other parts of the UI can identify it unambiguously and distinguish it from fenced code blocks rendered inside Markdown / AsciiDoc body content.

#### Scenario: Markdown source view shows raw markdown text
- **WHEN** a user views a Markdown document in Source view
- **THEN** the preview body shows the file's raw text, including markup tokens (`#`, `**`, `[..](..)`, fences, etc.)
- **AND** a line-number gutter is rendered beside the code

#### Scenario: AsciiDoc source view shows raw asciidoc text
- **WHEN** a user views an AsciiDoc document in Source view
- **THEN** the preview body shows the file's raw text, including markup tokens
- **AND** a line-number gutter is rendered beside the code

#### Scenario: Whole-file source `<pre>` is distinguishable
- **WHEN** the source view is rendered for any file kind
- **THEN** the whole-file `<pre>` element carries a distinguishing class (or equivalent attribute) that does not appear on fenced code blocks rendered inside Markdown / AsciiDoc body content

#### Scenario: Each source line carries a data-line attribute
- **WHEN** a source-view document with N source lines is rendered
- **THEN** the rendered DOM contains N elements carrying `data-line` attributes
- **AND** the `data-line` values run from `"1"` through `"N"` in document order, matching the 1-indexed source line numbers
