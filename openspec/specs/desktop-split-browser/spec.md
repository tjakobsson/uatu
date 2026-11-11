# desktop-split-browser Specification

## Purpose

Define the in-app split browser of UatuCode Desktop: a per-window, resizable pane with its own internal tabs that catches external http(s) links by default, with browser chrome (back/forward/reload, editable address bar with search fallback, eject to system browser), persistent login state, and session-scoped tabs.

## Requirements

### Requirement: Each window offers a split browser pane with internal tabs
Each UatuCode Desktop window SHALL offer a right-hand, resizable split pane hosting one or more browser tabs in a custom tab strip. Tabs are independent WebKit pages: switching tabs MUST NOT reload pages, and each tab keeps its own back-forward history. Closing the last tab closes the split.

#### Scenario: Toggling the split

- **WHEN** the user invokes Toggle Split Browser (`⌘⇧B`)
- **THEN** the split opens (with an empty new tab if none exist) or closes,
  and the uatu pane resizes to fill the freed space

#### Scenario: Switching tabs preserves page state

- **WHEN** two tabs are open and the user switches between them
- **THEN** each page appears in the state it was left in, without reloading

#### Scenario: Closing the last tab

- **WHEN** the user closes the split's only tab
- **THEN** the split closes

#### Scenario: Reordering tabs by drag

- **WHEN** the user drags a tab along the tab strip
- **THEN** the tab moves to the hovered position and the new order persists
  for the session

### Requirement: External links route into the split by default
With the in-app default active, activating an external `http(s)` link in the uatu UI SHALL open it in the split: if a tab already shows that exact URL, that tab is focused; otherwise a new focused tab opens; if the split is closed, it opens first. `⌘`-click SHALL always open in the system browser instead. Non-`http(s)` schemes SHALL always go to the system handler.

#### Scenario: Non-web popup link inside a browser page

- **WHEN** a page open in the split contains a `target="_blank"` `mailto:` link and the user clicks it
- **THEN** the system mail handler opens and no new tab is created

#### Scenario: First link opens the split

- **WHEN** the split is closed and the user clicks an external link in a
  rendered document
- **THEN** the split opens with a focused tab showing that URL

#### Scenario: Duplicate URL focuses the existing tab

- **WHEN** a tab already shows exactly `https://example.com/docs` and the
  user clicks a link to that same URL
- **THEN** the existing tab is focused and no new tab opens

#### Scenario: Command-click escapes to the system browser

- **WHEN** the user `⌘`-clicks an external link
- **THEN** the URL opens in the default browser and the split is unchanged

### Requirement: Tabs carry browser chrome with an editable address bar

Each browser tab SHALL expose navigation, an editable address bar, and Eject. Address input SHALL resolve to web navigation, an external scheme handler, or a default-engine search; Eject SHALL open the current URL externally and close the tab.

#### Scenario: Resolve committed address input
- **WHEN** address-bar input is committed
- **THEN** a parsed `http(s)` URL loads in the tab, with `https://` prepended to a bare host or host:port
- **AND** a non-web scheme such as `mailto:` goes to its system handler without tab navigation; other input searches with the default engine

#### Scenario: Browser controls remain available per tab
- **WHEN** a browser tab is displayed
- **THEN** it exposes Back, Forward, Reload, an editable address bar, and Eject
- **AND** activating Eject opens its current URL in the system browser and closes the tab

#### Scenario: Non-web scheme in the address bar

- **WHEN** the user types `mailto:user@example.com` and commits
- **THEN** the system mail handler opens and the tab does not navigate

#### Scenario: Navigating by URL

- **WHEN** the user types `example.com` in the address bar and commits
- **THEN** the tab loads `https://example.com`

#### Scenario: Searching from the address bar

- **WHEN** the user types `bun test filter` and commits
- **THEN** the tab loads a search-results page for that query

#### Scenario: Ejecting a tab

- **WHEN** the user activates the eject control on a tab showing a page
- **THEN** that URL opens in the default browser and the tab closes

### Requirement: Login state persists across relaunch; open tabs do not
Browser tabs SHALL share one persistent website data store, separate from the uatu WebView's store, so cookies and logins survive app relaunch. The set of open tabs SHALL NOT be restored: each app session starts with the split closed.

#### Scenario: Login survives relaunch

- **WHEN** the user logs into a site in a browser tab, quits, and relaunches
- **THEN** revisiting that site in a new tab finds the session still active

#### Scenario: Tabs do not survive relaunch

- **WHEN** the user quits with three browser tabs open and relaunches
- **THEN** the window opens with the split closed and no tabs

### Requirement: The split browser provides find over its selected tab

The split browser SHALL provide per-tab find over the selected page with match reveal, found/not-found, and forward/backward wrapping. It SHALL offer case sensitivity but SHALL NOT offer whole-word, regex, count, or position. Switching tabs SHALL NOT transfer matches; closing a tab SHALL discard its find state. `WKFindConfiguration` offers backwards, case sensitivity, and wrapping; `WKFindResult` only `matchFound`, so external-page find intentionally offers less than in-document find.

#### Scenario: Navigate and discard tab-local find state
- **WHEN** a search is active in the selected browser tab
- **THEN** forward/backward navigation reveals matches with wrap-around and the bar reports whether a match was found
- **AND** closing that tab discards its query and match state rather than transferring them to another tab

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

### Requirement: Browser tabs present JavaScript dialogs and the file chooser natively

Split-browser `alert()`, `confirm()`, and `prompt()` SHALL use native window-attached panels and return the user's answer. The split MUST NOT silently answer on the page's behalf. File inputs SHALL open the system open panel and return chosen files. A non-selected tab's dialog MUST NOT appear over another page: it waits, with the page, until its tab is selected. No window-attachment rule is added for file panels.

#### Scenario: Return each JavaScript dialog's native response
- **WHEN** a split-browser tab presents a JavaScript dialog
- **THEN** alert returns after dismissal, confirm returns true only on confirmation, and prompt returns entered text or null on Cancel, matching the embedded WebView's semantics

#### Scenario: Select files from a browser page
- **WHEN** a split-browser page activates a file input
- **THEN** the system open panel returns the files chosen by the user to that page

#### Scenario: A confirmation in a browser tab works
- **WHEN** a page in the selected browser tab calls `confirm()` before an action
- **THEN** a native dialog appears in the window
- **AND** confirming returns true so the page's action proceeds, and cancelling returns false

#### Scenario: An alert in a browser tab is shown
- **WHEN** a page in the selected browser tab calls `alert()`
- **THEN** a native panel shows the message and the page continues after dismissal

#### Scenario: A background tab's dialog waits for its tab
- **WHEN** a page in a non-selected tab calls `confirm()`
- **THEN** no dialog appears over the selected tab
- **AND** selecting that tab presents the dialog, and answering it returns the answer to the page
