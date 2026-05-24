## Why

We bundle a Hack Nerd Font Mono with the binary and use it for the embedded terminal, but every other monospace surface in the app — Markdown code blocks, AsciiDoc code blocks, the source view, the diff view, file paths in the metadata card, the build badge, the burden meter, score preview, the diff fallback `<pre>`, etc. — still falls back to whatever OS monospace happens to be installed. That's seven-plus independent font-family stacks hardcoded across `src/styles.css`, all subtly different. Users who want a consistent face across the app have nowhere to set it, and Safari users who see Hack in the terminal panel see something else everywhere else.

A single `--mono-font-family` CSS variable, defaulting to the bundled Hack Nerd Font Mono, lets us collapse those stacks into one source of truth. A new `.uatu.json mono.fontFamily` field gives users a single knob to override every monospace surface at once. The terminal keeps its existing `terminal.fontFamily` as a narrower override that wins inside the panel only — so a user who wants, say, Inter Mono everywhere but Berkeley Mono in the terminal can have both.

## What Changes

- Add a `--mono-font-family` CSS variable on `:root` defaulting to the bundled face: `"Hack Nerd Font Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace`.
- Replace the seven-plus ad-hoc monospace stacks in `src/styles.css` with `var(--mono-font-family)`. The existing `--mono-font` reference on the diff-fallback `<pre>` becomes a regular use of the new variable.
- Add CSS rules that win on specificity against `github-markdown-css`'s `.markdown-body pre code` and similar, so code blocks in rendered Markdown also pick up `--mono-font-family`.
- Add a new optional `mono` block to `.uatu.json`: `{"mono": {"fontFamily": "<string>"}}`. When present and valid, the server forwards it via `/api/state.monoConfig.fontFamily`, and the client sets `--mono-font-family` on `:root` at boot. Validation rules mirror `terminal.fontFamily` (non-empty string, trimmed).
- Keep `terminal.fontFamily` working unchanged. It continues to override the xterm font specifically — when both `mono.fontFamily` and `terminal.fontFamily` are set, mono applies everywhere except the terminal panel, where terminal wins.
- Update the `embedded-terminal` and `bundled-fonts` specs to reflect that `--terminal-font-family` is now layered on top of `--mono-font-family` (terminal references mono, then adds its own override).

## Capabilities

### New Capabilities
- `mono-font`: the shared monospace face contract — the `--mono-font-family` CSS variable, the list of surfaces governed by it, the `.uatu.json mono.fontFamily` override, the `/api/state.monoConfig` wire shape, the precedence relationship with `terminal.fontFamily`.

### Modified Capabilities
- `embedded-terminal`: the requirement "Terminal honors `.uatu.json` font configuration" gains a precedence clause — `terminal.fontFamily` is now the *narrower* override that wins inside the panel even when `mono.fontFamily` is also set, and the terminal's default cascade is rewired so `--terminal-font-family` falls through to `--mono-font-family` rather than carrying its own stack.

(The `bundled-fonts` spec is unaffected: it governs *registering* the bundled face — the file, the route, the `@font-face` rule, the license — not which CSS surfaces resolve to that family. The surface-scope expansion lives entirely in the new `mono-font` spec.)

## Impact

- **Code**:
  - `src/styles.css`: add `--mono-font-family` to `:root`; replace ~7 hardcoded stacks; add a small block of specificity-winning overrides for `github-markdown-css` code-block selectors.
  - `src/mono/config.ts` (new) + `src/mono/config.test.ts`: parser + warnings mirroring `terminal/config.ts`.
  - `src/cli.ts` + `tests/e2e/server.ts`: load and forward the mono config alongside the terminal config.
  - `src/server/session.ts`: extend the state payload with `monoConfig` (mirroring `terminalConfig`).
  - `src/shell/state.ts` or `src/shell/boot.ts`: apply `monoConfig.fontFamily` to `document.documentElement.style.setProperty("--mono-font-family", value)` at boot and on state changes.
- **Tests**: unit tests for the mono config parser; a route/state-payload test for `monoConfig`; an e2e test that overriding `.uatu.json mono.fontFamily` propagates to the code-block computed style; an e2e test that `terminal.fontFamily` still wins inside the terminal panel.
- **Docs**: `README.md` `.uatu.json` example + brief explanation. `ARCHITECTURE.md` mono-font line in the asset section.
- **No breaking changes**: users with `terminal.fontFamily` keep the exact behavior they had. Users with no `.uatu.json` mono block get the bundled Hack Nerd Font Mono everywhere instead of OS monospace — visually a change, but a coherent one (matches what they already see in the terminal).
