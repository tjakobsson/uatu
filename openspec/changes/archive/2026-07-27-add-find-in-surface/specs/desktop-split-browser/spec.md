## ADDED Requirements

### Requirement: The split browser provides find over its selected tab

The split browser SHALL provide a find bar that searches the page loaded in the
selected tab, reveals the match, reports whether a match was found, and supports
forward and backward navigation with wrap-around. Find state SHALL belong to the
tab: switching tabs SHALL NOT carry one tab's match onto another, and closing a
tab SHALL discard its find state.

The bar SHALL offer case sensitivity. It SHALL NOT offer whole-word or
regular-expression matching, and SHALL NOT report a match count or position —
`WKFindConfiguration` exposes only backwards, case sensitivity, and wrapping,
and `WKFindResult` exposes only `matchFound`. The split browser hosts pages uatu
does not render, so it offers less than the in-document find rather than
simulating the difference.

#### Scenario: Finding in an external page

- **WHEN** the user presses `⌘F` with the split browser focused on a loaded page
- **THEN** a find bar opens over that pane and the first match is revealed and selected

#### Scenario: No count is claimed

- **WHEN** a search in the split browser finds matches
- **THEN** the bar reports the match as found without asserting a position or total

#### Scenario: Switching tabs clears the previous tab's match

- **WHEN** the user searches in one tab and then selects a different tab
- **THEN** the first tab's match selection is cleared rather than persisting behind the second tab's content

#### Scenario: Find does not act on an empty pane

- **WHEN** the split browser is open with no selected tab and the user presses `⌘F`
- **THEN** no find bar opens and no other surface is searched

### Requirement: Split-browser find dismisses back to the page

`Escape` SHALL close the split browser's find bar, clear the match selection,
and return keyboard focus to the browser tab's web view so the page remains
scrollable. It SHALL do so whether focus is in the find field or the page.

#### Scenario: Dismissing the browser find bar

- **WHEN** the user presses `Escape` with the split browser find bar open
- **THEN** the bar closes, the match selection clears, and the tab's web view holds focus
