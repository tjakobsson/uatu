# mono-font — delta

## MODIFIED Requirements

### Requirement: Single CSS variable governs every monospace surface

The stylesheet SHALL define a single CSS custom property `--mono-font-family` on `:root` whose value is the bundled-font stack (Hack Nerd Font Mono → OS monospace → generic monospace). Every monospace surface in the app — including but not limited to rendered Markdown code blocks, AsciiDoc code blocks, the source view, the diff view, file-path labels, the build badge, and metadata card label rows — SHALL resolve its `font-family` to `var(--mono-font-family)`. No surface SHALL hardcode its own monospace stack, and no configuration file SHALL override the variable.

#### Scenario: Default value renders the bundled face

- **WHEN** the page loads
- **THEN** `getComputedStyle(:root).getPropertyValue("--mono-font-family")` starts with `"Hack Nerd Font Mono"`
- **AND** every monospace surface listed above resolves its `font-family` to a value that starts with `"Hack Nerd Font Mono"`

#### Scenario: No surface hardcodes a monospace stack

- **WHEN** a maintainer greps `src/styles.css` for hardcoded monospace stacks (e.g., `font-family:` lines that contain `monospace` but do NOT contain `var(--mono-font-family)`)
- **THEN** the only matching lines are the `--mono-font-family` definition itself, the `--terminal-font-family` definition (which references `--mono-font-family`), and any deliberately-excluded surfaces documented inline with a comment explaining why

## REMOVED Requirements

### Requirement: `.uatu.json mono.fontFamily` overrides the variable globally
**Reason**: Font choice is reader taste, not a repository fact; repository config no longer carries presentation overrides. The bundled stack is the single default.
**Migration**: Delete any `mono` block from `.uatu.json`; it is no longer read. A per-user font setting may return later through hub user settings, not repository config.

### Requirement: `terminal.fontFamily` is the narrower override that wins inside the panel
**Reason**: Both override sources (`mono.fontFamily`, `terminal.fontFamily`) are removed with their `.uatu.json` blocks; the fall-through chain `--terminal-font-family` → `--mono-font-family` → bundled face remains as the only behavior.
**Migration**: Delete any `terminal` font keys from `.uatu.json`; they are no longer read.
