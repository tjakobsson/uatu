## MODIFIED Requirements

### Requirement: Terminal honors `.uatu.json` font configuration

The server SHALL read the optional `terminal` block from `.uatu.json` at the watch root and surface validated values via `/api/state.terminalConfig`. The browser SHALL apply `terminal.fontFamily` (string) and `terminal.fontSize` (number, 8–32) to the xterm instance when present. Invalid values SHALL be ignored with a warning printed to stderr; the rest of the block remains in effect. The terminal's default font SHALL be `var(--terminal-font-family)`, which falls through to `var(--mono-font-family)` and ultimately to the bundled Hack Nerd Font Mono face when no override is configured — so that both ASCII and Nerd Font icon glyphs render correctly out of the box in every browser (including Safari, which does not expose user-installed system fonts to web pages). A `terminal.fontFamily` value in `.uatu.json` SHALL fully override the terminal's default. When both `mono.fontFamily` and `terminal.fontFamily` are configured, `terminal.fontFamily` is the narrower override that wins inside the terminal panel; `mono.fontFamily` continues to apply to every other monospace surface.

#### Scenario: Override beats the bundled default

- **WHEN** `.uatu.json` contains `{"terminal": {"fontFamily": "FiraCode Nerd Font Mono", "fontSize": 14}}`
- **AND** the user opens the terminal panel
- **THEN** `/api/state` returns `{"terminalConfig": {"fontFamily": "FiraCode Nerd Font Mono", "fontSize": 14}}`
- **AND** the rendered xterm instance uses `FiraCode Nerd Font Mono` (not the bundled Hack Nerd Font Mono)

#### Scenario: Out-of-range fontSize is dropped with a warning

- **WHEN** `.uatu.json` contains `{"terminal": {"fontSize": 9999, "fontFamily": "Hack Nerd Font Mono"}}`
- **THEN** the server logs a warning about the invalid `fontSize`
- **AND** `/api/state.terminalConfig` contains `fontFamily` only

#### Scenario: Missing terminal block falls back to the bundled default

- **WHEN** `.uatu.json` has no `terminal` block (or no `.uatu.json` exists)
- **AND** no `mono.fontFamily` override is configured either
- **THEN** `/api/state.terminalConfig` is absent
- **AND** the browser renders the terminal using the bundled Hack Nerd Font Mono face (via `--terminal-font-family` → `--mono-font-family`)

#### Scenario: Bundled default renders in Safari with no local Nerd Font installed

- **WHEN** the user opens the terminal panel in Safari
- **AND** no `.uatu.json terminal.fontFamily` override is set
- **AND** the user's machine has no Nerd Font installed
- **THEN** the terminal renders ASCII glyphs using the bundled Hack Nerd Font Mono face
- **AND** the terminal renders the Private-Use-Area codepoint `U+E0B0` (powerline right-arrow) using a real glyph (not TOFU)

#### Scenario: Bundled default renders in a clean Chromium profile

- **WHEN** the user opens the terminal panel in a freshly-installed Chromium with no extra fonts
- **AND** no `.uatu.json terminal.fontFamily` override is set
- **THEN** the terminal renders ASCII glyphs using the bundled Hack Nerd Font Mono face
- **AND** the terminal renders Nerd Font icon codepoints using real glyphs (not TOFU)

#### Scenario: terminal.fontFamily wins over mono.fontFamily inside the panel

- **WHEN** `.uatu.json` contains `{"mono": {"fontFamily": "Berkeley Mono, monospace"}, "terminal": {"fontFamily": "JetBrains Mono, monospace"}}`
- **AND** the user opens the terminal panel
- **THEN** the xterm instance uses `"JetBrains Mono"` (the narrower override)
- **AND** code blocks and other non-terminal monospace surfaces use `"Berkeley Mono"`

#### Scenario: Only mono.fontFamily set — terminal inherits from mono

- **WHEN** `.uatu.json` contains `{"mono": {"fontFamily": "Berkeley Mono, monospace"}}` and no `terminal.fontFamily`
- **AND** the user opens the terminal panel
- **THEN** the xterm instance uses `"Berkeley Mono"` (inherited via `--terminal-font-family` → `--mono-font-family`)
