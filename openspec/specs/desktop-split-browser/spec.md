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
Each tab SHALL expose back/forward/reload controls, an editable address bar, and an eject control. Committing address-bar input that parses as a URL (or as a bare host, which gets `https://` prefixed) SHALL load it; other input SHALL run a web search with a default engine. Eject SHALL open the tab's current URL in the system browser and close the tab.

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
