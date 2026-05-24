## ADDED Requirements

### Requirement: Single CSS variable governs every monospace surface

The stylesheet SHALL define a single CSS custom property `--mono-font-family` on `:root` whose default value is the bundled-font stack (Hack Nerd Font Mono → OS monospace → generic monospace). Every monospace surface in the app — including but not limited to rendered Markdown code blocks, AsciiDoc code blocks, the source view, the diff view, file-path labels, the build badge, score and burden meters, and metadata card label rows — SHALL resolve its `font-family` to `var(--mono-font-family)`. No surface SHALL hardcode its own monospace stack.

#### Scenario: Default value renders the bundled face

- **WHEN** the page loads with no `.uatu.json mono.fontFamily` override
- **THEN** `getComputedStyle(:root).getPropertyValue("--mono-font-family")` starts with `"Hack Nerd Font Mono"`
- **AND** every monospace surface listed above resolves its `font-family` to a value that starts with `"Hack Nerd Font Mono"`

#### Scenario: No surface hardcodes a monospace stack

- **WHEN** a maintainer greps `src/styles.css` for hardcoded monospace stacks (e.g., `font-family:` lines that contain `monospace` but do NOT contain `var(--mono-font-family)`)
- **THEN** the only matching lines are the `--mono-font-family` definition itself, the `--terminal-font-family` definition (which references `--mono-font-family`), and any deliberately-excluded surfaces documented inline with a comment explaining why

### Requirement: `.uatu.json mono.fontFamily` overrides the variable globally

The server SHALL read an optional `mono` block from `.uatu.json` at the watch root and surface a validated `mono.fontFamily` (string) via `/api/state.monoConfig`. Validation SHALL reject empty or whitespace-only strings with a stderr warning; the rest of the block remains in effect. The browser SHALL apply `monoConfig.fontFamily` to `:root` by setting `--mono-font-family` at boot and on every state update where `monoConfig` changes.

#### Scenario: Valid override flows through state and reaches the variable

- **WHEN** `.uatu.json` contains `{"mono": {"fontFamily": "Berkeley Mono, monospace"}}`
- **AND** the page loads
- **THEN** `/api/state` returns `{"monoConfig": {"fontFamily": "Berkeley Mono, monospace"}}`
- **AND** `getComputedStyle(:root).getPropertyValue("--mono-font-family")` is `"Berkeley Mono, monospace"`
- **AND** every monospace surface resolves its `font-family` to a value containing `"Berkeley Mono"`

#### Scenario: Empty fontFamily is dropped with a warning

- **WHEN** `.uatu.json` contains `{"mono": {"fontFamily": "   "}}`
- **THEN** the server logs a warning about the invalid value
- **AND** `/api/state.monoConfig` is absent (or its `fontFamily` is undefined)
- **AND** the browser falls back to the bundled-font default

#### Scenario: Missing mono block falls back to the default

- **WHEN** `.uatu.json` has no `mono` block (or no `.uatu.json` exists)
- **THEN** `/api/state.monoConfig` is absent
- **AND** `--mono-font-family` keeps its default bundled-face stack

### Requirement: `terminal.fontFamily` is the narrower override that wins inside the panel

When both `mono.fontFamily` and `terminal.fontFamily` are configured in `.uatu.json`, the browser SHALL apply both: `mono.fontFamily` to `:root --mono-font-family` and `terminal.fontFamily` to `:root --terminal-font-family`. The terminal panel SHALL render in the `terminal.fontFamily` face; every other monospace surface SHALL render in the `mono.fontFamily` face. When only `mono.fontFamily` is configured, the terminal SHALL also render in that face (because `--terminal-font-family` falls through to `--mono-font-family`).

#### Scenario: Both knobs set — terminal wins inside the panel, mono wins elsewhere

- **WHEN** `.uatu.json` contains `{"mono": {"fontFamily": "Berkeley Mono, monospace"}, "terminal": {"fontFamily": "JetBrains Mono, monospace"}}`
- **AND** the page loads
- **THEN** a code block in a rendered Markdown document renders in `"Berkeley Mono"`
- **AND** the embedded terminal renders in `"JetBrains Mono"`

#### Scenario: Only mono set — terminal inherits from mono

- **WHEN** `.uatu.json` contains `{"mono": {"fontFamily": "Berkeley Mono, monospace"}}`
- **AND** the page loads
- **THEN** every monospace surface, including the embedded terminal, renders in `"Berkeley Mono"`

#### Scenario: Only terminal set — mono surfaces keep the bundled default

- **WHEN** `.uatu.json` contains `{"terminal": {"fontFamily": "JetBrains Mono, monospace"}}`
- **AND** the page loads
- **THEN** the embedded terminal renders in `"JetBrains Mono"`
- **AND** every other monospace surface renders in the bundled Hack Nerd Font Mono

### Requirement: Code-block selectors from vendor stylesheets are overridden without `!important`

The stylesheet SHALL include rules that win on CSS specificity against `github-markdown-css`'s `font-family` declarations on `.markdown-body pre`, `.markdown-body code`, `.markdown-body pre code`, `.markdown-body samp`, `.markdown-body tt`, and `.markdown-body kbd`. The overriding rules SHALL set `font-family: var(--mono-font-family)` and SHALL NOT use `!important`.

#### Scenario: Markdown code block resolves to the mono variable

- **WHEN** a rendered Markdown document containing a fenced code block (e.g., ```` ```ts ... ``` ````) is loaded
- **AND** the browser computes the code block's `font-family`
- **THEN** the resolved family contains the current value of `--mono-font-family` (Hack Nerd Font Mono by default, or the `.uatu.json` override)

#### Scenario: Override path requires no `!important`

- **WHEN** a maintainer greps `src/styles.css` for `!important` near `font-family`
- **THEN** the only such usages are pre-existing (not introduced by this change)
