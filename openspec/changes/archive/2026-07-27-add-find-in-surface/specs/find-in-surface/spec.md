## ADDED Requirements

### Requirement: Active surface is tracked from user interaction, not DOM focus

The app SHALL maintain a single active-surface value with exactly three states:
`preview`, `terminal`, and `browser`. The value SHALL be updated only by
user-initiated interaction with a surface, and SHALL NOT be derived from
`document.activeElement`. The sidebar is not a surface: interacting with it
SHALL resolve the active surface to `preview`, because selecting a document is
an act about the document. The initial value SHALL be `preview`.

#### Scenario: Boot with no interaction

- **WHEN** the app finishes booting and the user has not interacted with any surface
- **THEN** the active surface is `preview`

#### Scenario: Clicking the preview

- **WHEN** the user clicks or focuses anywhere inside the preview
- **THEN** the active surface becomes `preview`

#### Scenario: Clicking a terminal pane

- **WHEN** the user clicks or focuses a terminal pane
- **THEN** the active surface becomes `terminal`

#### Scenario: Selecting a file in the sidebar tree

- **WHEN** the user clicks a file in the document tree while the active surface is `terminal`
- **THEN** the active surface becomes `preview`
- **AND** keyboard focus remains inside the tree, so arrow-key browsing continues to work

#### Scenario: Sidebar interaction that is not a document selection

- **WHEN** the user clicks a sidebar pane header, resizer, or filter chip
- **THEN** the active surface becomes `preview`

### Requirement: Find shortcut routes to the active surface

`⌘F` (`Ctrl+F` on non-Apple platforms) SHALL open find on the active surface and
SHALL prevent the host's native find from acting. `⌘G` and `⇧⌘G` SHALL advance to
the next and previous match on the same surface. When the active surface has no
find implementation, the shortcut SHALL fall through to the preview.

#### Scenario: Find with the preview active

- **WHEN** the user presses `⌘F` while the active surface is `preview`
- **THEN** the preview find bar opens with its input focused
- **AND** the host browser's native find does not open

#### Scenario: Find with the terminal active

- **WHEN** the user presses `⌘F` while the active surface is `terminal`
- **THEN** terminal find opens against the focused terminal pane
- **AND** the preview find bar does not open

#### Scenario: Find after selecting a file from the tree

- **WHEN** the user clicks a file in the tree and then presses `⌘F`
- **THEN** the preview find bar opens
- **AND** no find opens over the sidebar

### Requirement: Preview find bar reports position and navigates matches

The preview find bar SHALL search incrementally as the query changes, SHALL
report the ordinal of the current match and the total match count, and SHALL
navigate matches in document order with wrap-around at both ends. `Enter` and
`⇧Enter` SHALL be equivalent to next and previous. When the query has no
matches, the bar SHALL say so rather than reporting `0 of 0` ambiguously.

#### Scenario: Incremental match with a counter

- **WHEN** the user types a query matching 12 places in the document
- **THEN** the bar reports `1 of 12` and the first match is revealed and marked current

#### Scenario: Advancing past the last match

- **WHEN** the current match is the last one and the user presses `Enter`
- **THEN** the first match becomes current and is scrolled into view

#### Scenario: Retreating past the first match

- **WHEN** the current match is the first one and the user presses `⇧Enter`
- **THEN** the last match becomes current and is scrolled into view

#### Scenario: Query with no matches

- **WHEN** the user types a query that matches nothing
- **THEN** the bar reports no results and no highlight is painted

### Requirement: Find matches text that spans element boundaries

Matching SHALL be performed over the concatenated text of the searched
subtree's text nodes, so a match SHALL be found even when it spans multiple
elements — as syntax-highlighted code invariably does. Matching SHALL NOT be
performed against serialized HTML, and SHALL NOT match text belonging to
markup rather than content.

#### Scenario: Match spanning highlight spans

- **WHEN** the document contains a highlighted code block rendering `const foo` as adjacent `<span>` elements and the user searches for `const foo`
- **THEN** the match is found and highlighted across both elements

#### Scenario: Attribute text is not matched

- **WHEN** the user searches for a string that appears only inside an element attribute, such as a class name
- **THEN** no match is reported

### Requirement: Find does not mutate the preview DOM

Match highlighting SHALL be applied with the CSS Custom Highlight API over
`Range` objects. The find implementation SHALL NOT insert, remove, or reorder
nodes in the preview, so that rendered output, mermaid diagrams, anchor
targets, and code-block decorations are unaffected by searching.

#### Scenario: Highlighting leaves the document intact

- **WHEN** a query highlights matches inside a rendered document
- **THEN** the preview's element structure is byte-for-byte what it was before the query

#### Scenario: Clearing the query removes highlighting

- **WHEN** the user clears the query or dismisses the find bar
- **THEN** all find highlights are removed and no residual markup remains

### Requirement: Find searches the current view and survives re-render

Find SHALL search the text visible in the preview's current view mode. In split
view it SHALL search both panes, ordering matches by document order across the
panes. Because the preview is replaced wholesale on live reload, find SHALL
recompute its matches whenever the preview is remounted, preserving the query
and, where the same match still exists, the current match.

#### Scenario: Switching view mode with the find bar open

- **WHEN** the find bar is open with an active query and the user switches from Rendered to Source view
- **THEN** matches are recomputed against the source view and the counter updates

#### Scenario: Live reload while searching

- **WHEN** the watched file changes and the preview remounts while the find bar is open
- **THEN** the query is retained and matches are recomputed against the new content

#### Scenario: Split view searches both panes

- **WHEN** the preview is in split view and the query matches text in both panes
- **THEN** all matches are reported in a single ordered sequence

### Requirement: Find offers case, whole-word, and regular-expression matching

The find bar SHALL offer case-sensitive, whole-word, and regular-expression
toggles. Toggle state SHALL persist for the session. An invalid regular
expression SHALL be reported in the bar without throwing or clearing the query,
and a pattern that matches the empty string SHALL NOT produce an unbounded
match list.

#### Scenario: Case-sensitive matching

- **WHEN** the case-sensitive toggle is on and the user searches for `Preview`
- **THEN** occurrences of `preview` are not matched

#### Scenario: Invalid regular expression

- **WHEN** the regex toggle is on and the user types an unterminated group
- **THEN** the bar reports the pattern as invalid, keeps the typed text, and paints no highlights

#### Scenario: Zero-length regex match

- **WHEN** the regex toggle is on and the user types a pattern that can match the empty string
- **THEN** match enumeration terminates and the reported count is finite

### Requirement: Find seeds from the selection and dismisses to the document

Opening find while a non-empty selection exists inside the searched surface
SHALL seed the query with the selected text and select it in the input, so
typing replaces it. `Escape` SHALL dismiss the bar, clear highlighting, and move
keyboard focus to the preview scroll container positioned at the current match.

#### Scenario: Seeding from a selection

- **WHEN** the user selects a word in the preview and presses `⌘F`
- **THEN** the find bar opens with that word as the query, selected in the input

#### Scenario: Dismissing returns focus to the document

- **WHEN** the user presses `Escape` while viewing match 7 of 12
- **THEN** the find bar closes, highlights clear, and the preview scroll container holds keyboard focus at that position

### Requirement: The preview scroll container can hold keyboard focus

The preview scroll container SHALL be focusable so that it can receive keyboard
focus and respond to `Space`, `Shift+Space`, `PageUp`, `PageDown`, `Home`, and
`End`. Focus SHALL NOT be moved into the preview automatically as a side effect
of document selection, live reload, or follow-mode activity; it SHALL be
acquired only by user action or by dismissing the find bar.

#### Scenario: Keyboard scrolling after focusing the document

- **WHEN** the user clicks the preview and presses `Space`
- **THEN** the document scrolls down by a page

#### Scenario: Focus is not stolen on document change

- **WHEN** the user is typing in the terminal and the preview loads a different document
- **THEN** keyboard focus remains in the terminal

### Requirement: Terminal find searches the focused pane's buffer

Find on the terminal surface SHALL search the scrollback buffer of the focused
terminal pane only, SHALL reveal and highlight matches within that pane, and
SHALL support next and previous navigation with the same keys as preview find.

#### Scenario: Searching one pane of a split terminal

- **WHEN** the terminal is split into two panes and the user searches from the right-hand pane
- **THEN** only the right-hand pane's buffer is searched and highlighted

#### Scenario: Match in scrollback

- **WHEN** the query matches text scrolled above the visible region
- **THEN** the pane scrolls to reveal the match and marks it current

### Requirement: Split-browser find uses the host's native find

When the active surface is `browser`, find SHALL be performed by the host
application against the page loaded in the selected browser tab, using the
platform's own find facility rather than the SPA's find bar. Where no host
find facility exists, the shortcut SHALL have no effect rather than searching
an unrelated surface.

#### Scenario: Finding in an external page

- **WHEN** the split browser is focused on a tab showing an external page and the user presses `⌘F`
- **THEN** a native find bar opens over that tab and searches its content

#### Scenario: Preview find is not opened for the browser surface

- **WHEN** the active surface is `browser` and the user presses `⌘F`
- **THEN** the SPA's preview find bar does not open
