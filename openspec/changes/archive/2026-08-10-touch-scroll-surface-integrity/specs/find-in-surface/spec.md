## MODIFIED Requirements

### Requirement: Find shortcut routes to the active surface

`⌘F` (`Ctrl+F` on non-Apple platforms) SHALL open find on the active surface and
SHALL prevent the host's native find from acting. `⌘G` and `⇧⌘G` SHALL advance to
the next and previous match on the same surface. When the active surface has no
find implementation, the shortcut SHALL fall through to the preview. Before the
bar is mounted, the shortcut SHALL bring the target surface forward when that
surface is not currently visible — in touch mode, where only the active tab's
surface renders, invoking preview find from the Files tab SHALL activate the
Preview tab first. The bar MUST NOT be mounted into a hidden surface while the
host's native find stays suppressed, because that leaves the user with neither.

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

#### Scenario: Find from the Files tab in touch mode

- **WHEN** the Files tab is active in touch mode and the user presses `⌘F` on a hardware keyboard
- **THEN** the Preview tab becomes active
- **AND** the find bar mounts on the now-visible preview with its input focused

#### Scenario: Find is not routed to a hidden surface

- **WHEN** `⌘F` resolves to the preview engine while the preview is not the visible surface
- **THEN** the preview is made visible before the bar is opened, so the suppressed native find is always replaced by a usable bar
