## ADDED Requirements

### Requirement: The find shortcut reaches the surface that has focus

The wrapper SHALL ensure no menu item silently claims `⌘F`, `⌘G`, or `⇧⌘G` on
behalf of a responder that cannot act on them. Because `NSMenu` performs the
first matching key equivalent even when the item is disabled, the wrapper SHALL
NOT rely on menu-item enablement to express focus-dependent routing; routing
SHALL be resolved at press time from the window's first responder.

#### Scenario: Find in the embedded SPA

- **WHEN** the embedded uatu web view has focus and the user presses `⌘F`
- **THEN** the key reaches the page and uatu's own find opens

#### Scenario: Find in the split browser

- **WHEN** the split browser has focus and the user presses `⌘F`
- **THEN** the wrapper's native find bar opens over the browser tab and the page's find does not

#### Scenario: Stock text-finding menu items do not intercept

- **WHEN** the app's menu bar is built
- **THEN** no inherited text-editing Find item is left bound to `⌘F` targeting a responder that ignores it

### Requirement: Menu bar exposes find commands for the focused surface

The Edit menu SHALL expose Find, Find Next, and Find Previous with their
standard key equivalents, so the shortcuts are discoverable. These items SHALL
be enabled whenever a window with a running server is focused, and their action
SHALL resolve the target surface when invoked rather than when the menu was
last rebuilt.

#### Scenario: Find is discoverable in the menu

- **WHEN** the user opens the Edit menu with a running window focused
- **THEN** Find, Find Next, and Find Previous are present and enabled with their standard shortcuts

#### Scenario: Menu action follows focus changes

- **WHEN** the user moves focus from the SPA to the split browser and then chooses Edit ▸ Find
- **THEN** find opens over the split browser, not the SPA
