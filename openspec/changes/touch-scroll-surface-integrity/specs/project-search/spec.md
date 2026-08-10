## MODIFIED Requirements

### Requirement: Project search is global and ignores the active surface

`⇧⌘F` (`Ctrl+Shift+F` on non-Apple platforms) SHALL open project search and focus
its query input regardless of which surface is active. Unlike `⌘F`, it SHALL NOT
be routed by the active surface, because the tree is not a surface the user can
be "in". Opening SHALL reveal the pane however it is currently hidden — a
collapsed sidebar, a hidden or collapsed pane, or a touch-mode session whose
active tab is not Files — so that the shortcut never focuses an input inside a
`display: none` subtree.

#### Scenario: Opening project search from the terminal

- **WHEN** the user is typing in the terminal and presses `⇧⌘F`
- **THEN** the Search pane opens with its query input focused

#### Scenario: Opening project search from the preview

- **WHEN** the active surface is `preview` and the user presses `⇧⌘F`
- **THEN** the Search pane opens rather than the preview find bar

#### Scenario: Search pane is revealed if hidden

- **WHEN** the user has hidden the Search pane and presses `⇧⌘F`
- **THEN** the pane is shown and expanded before its input takes focus

#### Scenario: Search pane is revealed from a non-Files touch tab

- **WHEN** the Preview or Terminal tab is active in touch mode and the user presses `⇧⌘F` on a hardware keyboard
- **THEN** the Files tab becomes active, showing the Search pane with its query input focused and its results visible
