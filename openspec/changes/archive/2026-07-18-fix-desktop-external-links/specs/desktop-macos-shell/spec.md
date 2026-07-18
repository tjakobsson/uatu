# Delta: desktop-macos-shell — external links + navigation chrome

## ADDED Requirements

### Requirement: External links open outside the embedded WebView
The app SHALL route link activations that target a new browsing context (`target="_blank"` anchors, `window.open()` calls, terminal OSC 8 hyperlink activation) out of the embedded WebView to the operating system: `http(s)` URLs open in the user's default browser; other schemes are handed to their registered system handler. The WebView MUST NOT silently drop such activations.

#### Scenario: External link in a rendered document

- **WHEN** the user clicks an external `https://` link in a rendered
  Markdown document
- **THEN** the URL opens in the user's default browser and the uatu window
  keeps its current document

#### Scenario: Hyperlink printed by a terminal program

- **WHEN** a TUI in the embedded terminal emits an OSC 8 hyperlink and the
  user activates it
- **THEN** the URL opens in the user's default browser

#### Scenario: Non-http scheme

- **WHEN** the user clicks a `mailto:` link
- **THEN** the system's registered mail handler opens

### Requirement: Window chrome exposes Back and Forward for the embedded SPA
The app SHALL provide Back and Forward controls — menu commands with `⌘[` and `⌘]` shortcuts and window-toolbar buttons — that navigate the embedded page's back-forward history. Controls MUST be disabled when the corresponding direction has no history entry or no server is running.

#### Scenario: Back returns to the previously selected document

- **WHEN** the user selects document A, then document B, then invokes Back
- **THEN** the preview shows document A again, and Forward becomes enabled

#### Scenario: Controls disabled at history edges

- **WHEN** a window has just loaded its first page
- **THEN** both Back and Forward controls are disabled
