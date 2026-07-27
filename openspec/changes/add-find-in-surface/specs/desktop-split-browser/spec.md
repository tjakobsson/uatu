## ADDED Requirements

### Requirement: The split browser provides find over its selected tab

The split browser SHALL provide a find bar that searches the page loaded in the
selected tab, highlights matches, reports the current match and total count, and
supports forward and backward navigation. Find state SHALL belong to the tab:
switching tabs SHALL NOT carry one tab's matches onto another, and closing a tab
SHALL discard its find state.

#### Scenario: Finding in an external page

- **WHEN** the user presses `⌘F` with the split browser focused on a loaded page
- **THEN** a find bar opens over that pane and matches are highlighted in the page

#### Scenario: Switching tabs clears the previous tab's matches

- **WHEN** the user searches in one tab and then selects a different tab
- **THEN** the first tab's highlights are not shown over the second tab's content

#### Scenario: Find does not act on an empty pane

- **WHEN** the split browser is open with no selected tab and the user presses `⌘F`
- **THEN** no find bar opens and no other surface is searched

### Requirement: Split-browser find dismisses back to the page

`Escape` SHALL close the split browser's find bar, clear its highlights, and
return keyboard focus to the browser tab's web view so the page remains
scrollable.

#### Scenario: Dismissing the browser find bar

- **WHEN** the user presses `Escape` with the split browser find bar open
- **THEN** the bar closes, highlights clear, and the tab's web view holds focus
