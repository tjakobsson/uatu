## MODIFIED Requirements

### Requirement: Apply GitHub-style syntax highlighting to fenced code blocks
The preview pane SHALL render non-Mermaid fenced code blocks with GitHub-style syntax highlighting that visually matches the light GitHub theme in light mode and the dark GitHub theme in dark mode. Language resolution MUST use the fenced block's info string when provided. The highlighter MUST honor the active light / dark preference so that toggling the preference re-themes the rendered code without requiring a navigation. Mermaid blocks MUST continue to render as diagrams and MUST NOT be syntax-highlighted as code.

#### Scenario: A JavaScript fenced block renders with highlighted tokens
- **WHEN** a selected Markdown file contains a fenced block with info string `js`
- **THEN** the preview renders the block with GitHub-style token coloring for JavaScript

#### Scenario: An unknown-language fenced block still renders readably
- **WHEN** a selected Markdown file contains a fenced block with an unrecognized info string
- **THEN** the preview renders the block as plain code without crashing the preview
- **AND** uses GitHub-style neutral code block styling

#### Scenario: Mermaid blocks are not highlighted as code
- **WHEN** a selected Markdown file contains a fenced block with info string `mermaid`
- **THEN** the block renders as a Mermaid diagram
- **AND** no syntax-highlighting markup is applied to it

#### Scenario: Switching light / dark mode re-themes already-rendered code
- **WHEN** a Markdown document with at least one highlighted fenced code block is currently rendered in the preview
- **AND** the user toggles the active light / dark preference
- **THEN** the code block re-themes to match the new preference without requiring document navigation or a full page reload

### Requirement: Render non-Markdown text files as syntax-highlighted code
The preview pane SHALL render selected text files that are not Markdown as a syntax-highlighted code region whose token coloring uses GitHub-style syntax highlighting matching the active light / dark preference. Language resolution SHALL use the file-extension to language identifier map maintained in `src/file-languages.ts`, with a fallback to plain text for extensions that are not in the map. The map MUST be trivially extensible (one entry per extension). For files at or above 1 MB, the preview MUST render the contents as plain text without invoking syntax highlighting, to keep the browser responsive. Markdown files MUST continue to render through the existing Markdown pipeline and MUST NOT be affected by the code render path.

#### Scenario: A YAML file renders with YAML token coloring
- **WHEN** a user selects a `.yaml` file in the sidebar
- **THEN** the preview renders its contents as syntax-highlighted code
- **AND** YAML tokens are colored using the GitHub-style theme matching the active light / dark preference

#### Scenario: An unknown-extension text file renders readably without highlighting
- **WHEN** a user selects a text file whose extension is not in the language map
- **THEN** the preview renders its contents as plain text
- **AND** the preview does not crash

#### Scenario: A text file at or above 1 MB renders without syntax highlighting
- **WHEN** a user selects a 2 MB JSON file
- **THEN** the preview renders its contents as plain text
- **AND** the syntax highlighter is not invoked on the contents

#### Scenario: Selecting a Markdown file uses the Markdown pipeline
- **WHEN** a user selects a `.md` file in the sidebar
- **THEN** the preview renders the file through the existing Markdown pipeline
- **AND** the rendered output is not wrapped in the source-view code-region structure

### Requirement: Show the active file's type in the preview header
The preview header SHALL display a small chip next to the document title indicating the active file's type. For Markdown files the chip SHALL read `markdown`. For AsciiDoc files the chip SHALL read `asciidoc`. For non-Markdown, non-AsciiDoc text files the chip SHALL read the language identifier from `src/file-languages.ts` when one is mapped (e.g. `yaml`, `python`, `typescript`). When the file's extension does not map to a known language, the chip SHALL read `text`. The chip MUST be hidden when no document is selected.

#### Scenario: A YAML file shows a `yaml` chip
- **WHEN** a user selects a `config.yaml` file
- **THEN** the preview header shows a chip reading `yaml`

#### Scenario: A Markdown file shows a `markdown` chip
- **WHEN** a user selects a `README.md` file
- **THEN** the preview header shows a chip reading `markdown`

#### Scenario: An AsciiDoc file shows an `asciidoc` chip
- **WHEN** a user selects a `README.adoc` file
- **THEN** the preview header shows a chip reading `asciidoc`

#### Scenario: An unmapped text extension shows a `text` chip
- **WHEN** a user selects a text file whose extension is not in the language map
- **THEN** the preview header shows a chip reading `text`

#### Scenario: Empty preview hides the chip
- **WHEN** no document is selected
- **THEN** no preview-header type chip is visible

### Requirement: Show line numbers on non-Markdown code views
The preview pane SHALL render a line-number gutter on the code region produced by the non-Markdown code render path. Line numbers SHALL start at 1 and increment by 1 per line of source content. Markdown fenced code blocks (those that originate from a Markdown document's ` ``` ` fences) MUST NOT show a line-number gutter, matching the conventions of GitHub's README rendering. The line-number gutter MUST be visually distinguishable from the code, MUST NOT be selectable as part of the code text (i.e. CSS `user-select: none` or equivalent), and MUST NOT be included when the code is copied to the clipboard via the copy control.

#### Scenario: A non-Markdown text file shows numbered lines
- **WHEN** a user selects a text file (e.g. `config.yaml`) with three lines of content
- **THEN** the preview's code region displays a line-number gutter with the values `1`, `2`, `3`

#### Scenario: A Markdown fenced code block does not show numbered lines
- **WHEN** a user selects a Markdown document containing a fenced code block
- **THEN** the rendered fenced block has no line-number gutter

#### Scenario: Copying the code excludes the line numbers
- **WHEN** a user activates the copy control on a non-Markdown code view
- **THEN** the clipboard contains the source code only
- **AND** the clipboard contents do not begin with line-number digits

#### Scenario: Line numbers are not selectable as text
- **WHEN** a user attempts to select text starting in the line-number gutter region
- **THEN** the line-number digits are not included in the resulting browser selection
