## MODIFIED Requirements

### Requirement: Provide a copy-to-clipboard control on every code block
The preview pane SHALL render a copy-to-clipboard control on every `<pre><code>` block, including Markdown fenced code blocks AND the single block produced by the non-Markdown render path. Activating the control SHALL copy the code block's textual contents to the system clipboard and display a brief confirmation. The control MUST NOT appear on Mermaid diagrams (which render as inline SVG, not `<pre><code>`).

#### Scenario: A Markdown fenced code block exposes a copy control
- **WHEN** a Markdown document containing a fenced code block is rendered in the preview
- **THEN** the rendered `<pre>` contains a copy control

#### Scenario: A non-Markdown code render exposes a copy control
- **WHEN** a non-Markdown text file is rendered in the preview
- **THEN** the rendered `<pre>` contains a copy control

#### Scenario: Activating the copy control writes the code to the clipboard
- **WHEN** a user activates a copy control on a code block
- **THEN** the code block's textual contents are written to the system clipboard
- **AND** the control briefly shows a confirmation label before reverting

#### Scenario: Copying a Markdown code block omits the parser-synthesized trailing newline
- **WHEN** a user activates the copy control on a rendered Markdown code block
- **THEN** the single parser-synthesized trailing line break is omitted so single-line commands do not auto-execute when pasted into a terminal
- **AND** internal line breaks and intentional extra trailing blank lines are preserved

#### Scenario: Whole-file source views and AsciiDoc blocks copy verbatim
- **WHEN** a user activates the copy control on a whole-file source view (`pre.uatu-source-pre`) or an AsciiDoc listing or literal block
- **THEN** the clipboard receives the block's verbatim textual contents without stripping a trailing newline

#### Scenario: Mermaid diagrams do not show a copy control
- **WHEN** a Mermaid fenced block is rendered as a diagram
- **THEN** no copy control is added to the diagram
