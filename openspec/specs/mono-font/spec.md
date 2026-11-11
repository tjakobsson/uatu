## Purpose

Define a single, app-wide monospace surface story for uatu: one CSS custom property (`--mono-font-family`) that governs every monospace surface in the UI, with the bundled Hack Nerd Font Mono stack as its only source — no configuration overrides it. Vendor stylesheets (notably `github-markdown-css`) are overridden via specificity, not `!important`.
## Requirements
### Requirement: Single CSS variable governs every monospace surface

The stylesheet SHALL define `--mono-font-family` on `:root` as the single bundled stack (Hack Nerd Font Mono → OS monospace → generic monospace). Every monospace surface SHALL use `var(--mono-font-family)`; no surface SHALL hardcode its own monospace stack, and no configuration file SHALL override the variable.

#### Scenario: Monospace surfaces share the root font stack
- **WHEN** the app renders a monospace surface
- **THEN** every such surface — including rendered Markdown code blocks, AsciiDoc code blocks, the source view, the diff view, file-path labels, the build badge, and metadata card label rows — SHALL resolve its `font-family` to `var(--mono-font-family)`
- **AND** no surface SHALL hardcode its own monospace stack, and no configuration file SHALL override the variable

#### Scenario: Default value renders the bundled face

- **WHEN** the page loads
- **THEN** `getComputedStyle(:root).getPropertyValue("--mono-font-family")` starts with `"Hack Nerd Font Mono"`
- **AND** every monospace surface listed above resolves its `font-family` to a value that starts with `"Hack Nerd Font Mono"`

#### Scenario: No surface hardcodes a monospace stack

- **WHEN** a maintainer greps `src/styles.css` for hardcoded monospace stacks (e.g., `font-family:` lines that contain `monospace` but do NOT contain `var(--mono-font-family)`)
- **THEN** the only matching lines are the `--mono-font-family` definition itself, the `--terminal-font-family` definition (which references `--mono-font-family`), and any deliberately-excluded surfaces documented inline with a comment explaining why

### Requirement: Code-block selectors from vendor stylesheets are overridden without `!important`

The stylesheet SHALL include rules that win on CSS specificity against `github-markdown-css`'s `font-family` declarations on `.markdown-body pre`, `.markdown-body code`, `.markdown-body pre code`, `.markdown-body samp`, `.markdown-body tt`, and `.markdown-body kbd`. The overriding rules SHALL set `font-family: var(--mono-font-family)` and SHALL NOT use `!important`.

#### Scenario: Markdown code block resolves to the mono variable

- **WHEN** a rendered Markdown document containing a fenced code block (e.g., ```` ```ts ... ``` ````) is loaded
- **AND** the browser computes the code block's `font-family`
- **THEN** the resolved family contains the current value of `--mono-font-family` (Hack Nerd Font Mono by default, or the `.uatu.json` override)

#### Scenario: Override path requires no `!important`

- **WHEN** a maintainer greps `src/styles.css` for `!important` near `font-family`
- **THEN** the only such usages are pre-existing (not introduced by this change)
