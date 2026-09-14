## ADDED Requirements

### Requirement: Shell output reads as the terminal would render it
Where a tool's output carries terminal escape sequences, Chat SHALL interpret them rather than show them: select-graphic-rendition styling — the 16 standard colours, 256-colour and truecolour foreground and background, bold, dim, italic, underline, inverse, and strikethrough — SHALL be rendered as styling; carriage-return overwrites and erase-line sequences SHALL be applied so a line that was rewritten in place shows only its final content; and any other control sequence SHALL be removed from the shown text. Interpreting escapes MUST NOT create active markup or script execution, whatever the sequences or the text around them contain.

A shell command's output block SHALL be presented with the embedded terminal's background, foreground, 16-colour palette, and font, so the same bytes read the same in Chat and in the terminal pane; the palette SHALL be the one central set of terminal colour variables, not a second copy. Lines in a shell output block SHALL NOT be broken mid-token: a line longer than the block scrolls horizontally, as it would in the terminal.

The streaming tail shown while a command runs, and the bounded preview with its way to see the rest once it finishes, SHALL operate on the lines as rendered — after overwrites are applied — so a progress bar that rewrote one line many times counts as one line, not as many.

#### Scenario: Coloured test output renders in colour
- **WHEN** a shell command's output contains `\x1b[32mpass\x1b[0m` and `\x1b[31mfail\x1b[0m`
- **THEN** the block shows "pass" in the terminal's green and "fail" in the terminal's red
- **AND** no bracket-code fragments appear in the text

#### Scenario: A progress bar collapses to its final state
- **WHEN** a running command rewrites one line repeatedly with carriage returns and erase-line sequences
- **THEN** the block shows that line once, with its latest content
- **AND** the streaming tail's line count treats it as one line

#### Scenario: Unknown control sequences are dropped
- **WHEN** a command's output contains cursor-movement or operating-system-command sequences the renderer does not interpret
- **THEN** those sequences do not appear in the shown text
- **AND** the surrounding text is shown intact

#### Scenario: Escapes cannot smuggle markup
- **WHEN** a command's output interleaves escape sequences with `<script>` text or a JavaScript URL
- **THEN** the rendered block contains no active markup and executes nothing

#### Scenario: Shell output uses the terminal's palette and font
- **WHEN** the same coloured output is shown in Chat and typed into the embedded terminal
- **THEN** both use the same background, foreground, colour values and font family
- **AND** changing a terminal colour variable changes both

#### Scenario: Long lines scroll instead of wrapping
- **WHEN** a command prints a table wider than the output block
- **THEN** the columns stay aligned and the block scrolls horizontally
- **AND** no line is broken mid-token

### Requirement: Activity chrome is legible and distinct from prose
The activity chrome — the working line while a turn runs, a finished group's summary line, each member row's label and subject, and the rule and neutral dot that tie a group's members together — SHALL use a colour that is visibly stronger than the surface's secondary-label colour and visibly quieter than assistant prose, in both the light and the dark theme, so steps are readable and told apart from each other and from the answer without being the answer's equal. Status words and outcome indicators (running, failed) keep their own colours.

#### Scenario: Steps are readable in light and dark
- **WHEN** a turn has produced a working line with several member rows, in either theme
- **THEN** the line and its rows meet at least the contrast the surface's body text meets against the same background
- **AND** they remain distinguishable from the assistant prose around them

#### Scenario: Chrome stays quieter than the answer
- **WHEN** a finished group sits between two assistant messages
- **THEN** the group's summary and rows read as secondary to the messages
- **AND** a failed step's status is still shown in the failure colour
