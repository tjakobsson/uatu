# embedded-terminal — delta

## ADDED Requirements

### Requirement: Terminal renders the bundled default font
The terminal's font SHALL be `var(--terminal-font-family)`, which falls through to `var(--mono-font-family)` and ultimately to the bundled Hack Nerd Font Mono face — so that both ASCII and Nerd Font icon glyphs render correctly out of the box in every browser (including Safari, which does not expose user-installed system fonts to web pages). No repository configuration SHALL override the terminal font or size; `.uatu.json` carries no `terminal` block and `/api/state` carries no `terminalConfig` field.

#### Scenario: Terminal renders the bundled default

- **WHEN** the user opens the terminal panel
- **THEN** the rendered xterm instance uses the bundled Hack Nerd Font Mono face (via `--terminal-font-family` → `--mono-font-family`)

#### Scenario: Bundled default renders in Safari with no local Nerd Font installed

- **WHEN** the user opens the terminal panel in Safari
- **AND** the user's machine has no Nerd Font installed
- **THEN** the terminal renders ASCII glyphs using the bundled Hack Nerd Font Mono face
- **AND** the terminal renders the Private-Use-Area codepoint `U+E0B0` (powerline right-arrow) using a real glyph (not TOFU)

#### Scenario: Bundled default renders in a clean Chromium profile

- **WHEN** the user opens the terminal panel in a freshly-installed Chromium with no extra fonts
- **THEN** the terminal renders ASCII and Nerd Font icon glyphs using the bundled face

#### Scenario: A legacy terminal block is not read

- **WHEN** the watch root's `.uatu.json` contains a `terminal` block with `fontFamily` or `fontSize`
- **THEN** `/api/state` contains no `terminalConfig` field
- **AND** the terminal renders with the bundled default face and size

### Requirement: OSC 52 copies are always visible
Accepted OSC 52 writes SHALL always be visible: each write SHALL show a transient pane-scoped toast reporting that the terminal copied N characters. Rapid successive sequences SHALL coalesce so at most one toast is visible per pane. This notify behavior is fixed — no repository configuration selects a different clipboard policy. (A per-user policy choice may return later through hub user settings; it is not configurable from `.uatu.json`.)

#### Scenario: Copy notifies with a toast
- **WHEN** a valid OSC 52 copy is accepted
- **THEN** the text is written to the clipboard
- **AND** a transient toast in the receiving pane reports the number of characters copied

#### Scenario: Rapid copies coalesce into one toast
- **WHEN** multiple valid OSC 52 sequences arrive in quick succession
- **THEN** at most one toast is visible in the pane, reflecting the most recent copy

#### Scenario: A legacy clipboard policy key is not read
- **WHEN** the watch root's `.uatu.json` sets `terminal.clipboard` to any value
- **THEN** the pane behaves with the fixed notify behavior
- **AND** no configuration warning is emitted for the unread block

## MODIFIED Requirements

### Requirement: Terminal bridges OSC 52 copy sequences to the host clipboard
Each terminal pane SHALL register an OSC 52 handler on its `xterm.js` parser (`term.parser.registerOscHandler(52, …)`) that decodes application-initiated copy sequences (`ESC ] 52 ; <selection> ; <base64-data> BEL/ST`) arriving from the PTY and writes the decoded text to the system clipboard via `navigator.clipboard.writeText`. The bridge SHALL be write-only: when the data field is `?` (a clipboard read query), the handler SHALL NOT emit any response sequence and SHALL NOT read the clipboard. The handler SHALL honor the selection parameters `c`, `p`, and `s` (all targeting the single browser clipboard) and SHALL ignore sequences with other selection parameters, invalid base64 data, or a decoded payload larger than 100 KB. `allowProposedApi` SHALL be `true`, enabled solely because search decorations (`registerDecoration`), which terminal find uses to mark every match, are proposed API in xterm 6 and throw without it. The OSC 52 bridge itself SHALL NOT depend on any proposed API.

#### Scenario: TUI select-to-copy reaches the host clipboard
- **WHEN** a program in the terminal (e.g. a mouse-mode TUI reacting to a selection) emits `ESC ] 52 ; c ; <base64 of "hello"> BEL`
- **THEN** `navigator.clipboard.writeText("hello")` is invoked
- **AND** the host clipboard — not any container-local clipboard — receives the text, because the browser executing the write runs on the host

#### Scenario: Clipboard read query is never answered
- **WHEN** a program in the terminal emits `ESC ] 52 ; c ; ? BEL`
- **THEN** no response sequence is written to the PTY
- **AND** `navigator.clipboard.readText` is not invoked

#### Scenario: Oversized payload is dropped and reported
- **WHEN** a program emits an OSC 52 sequence whose decoded payload exceeds 100 KB
- **THEN** the clipboard is not modified
- **AND** the pane shows feedback that the copy was rejected for size

#### Scenario: Invalid base64 is dropped silently
- **WHEN** a program emits an OSC 52 sequence whose data field is not valid base64 and is not `?`
- **THEN** the clipboard is not modified
- **AND** no toast is shown

#### Scenario: Blocked silent write degrades to a Copy button
- **WHEN** `navigator.clipboard.writeText` rejects (e.g. the browser requires user activation)
- **THEN** the pane shows a persistent toast with a Copy control
- **AND** activating the Copy control writes the pending text to the clipboard from within the click gesture

## REMOVED Requirements

### Requirement: Terminal honors `.uatu.json` font configuration
**Reason**: Restated as "Terminal renders the bundled default font". `.uatu.json` carries no `terminal` block; the default font chain (`--terminal-font-family` → `--mono-font-family` → bundled face) is the only behavior.
**Migration**: Delete any `terminal` font keys from `.uatu.json`; they are no longer read. A per-user font setting may return later through hub user settings.

### Requirement: OSC 52 copies are visible and policy-governed via `.uatu.json`
**Reason**: Restated as "OSC 52 copies are always visible". The clipboard policy is fixed at the notify behavior; `confirm`/`silent`/`off` are removed with the `terminal.clipboard` key.
**Migration**: Delete any `terminal.clipboard` key from `.uatu.json`; it is no longer read. A per-user policy choice may return later through hub user settings.
