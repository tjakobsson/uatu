## 1. Introduce `--mono-font-family` in CSS

- [x] 1.1 In `src/styles.css` `:root`, add `--mono-font-family: "Hack Nerd Font Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;` *above* the existing `--terminal-font-family` definition.
- [x] 1.2 Replace the existing `--terminal-font-family` value with `var(--mono-font-family)` so the terminal inherits the mono cascade by default. Keep the comment block explaining the precedence: `mono.fontFamily` → `terminal.fontFamily` → terminal-only override.
- [x] 1.3 Replace each hardcoded monospace stack with `var(--mono-font-family)`. Specifically:
  - `src/styles.css:1396` (the selection-inspector control / similar button background)
  - `src/styles.css:1465` (`.build-badge`)
  - `src/styles.css:1536` (`.burden-meter strong`)
  - `src/styles.css:1821` (`.metadata-card-row-extra .metadata-card-label`)
  - `src/styles.css:1925` (`.score-preview h1` and `.score-preview h2`)
  - `src/styles.css:3134` (`.uatu-diff-fallback-pre`) — drop the legacy `var(--mono-font, …)` fallback chain entirely and just use `var(--mono-font-family)`.
- [x] 1.4 Leave `.terminal-toggle-kbd` (`src/styles.css:759-768`) alone — it deliberately uses a plain OS monospace stack to avoid `font-display: block` FOIT on the keyboard hint label. Add a one-line inline comment noting it intentionally opts *out* of `--mono-font-family`.

## 2. Win specificity against `github-markdown-css`

- [x] 2.1 After the existing `@import "github-markdown-css/...";` lines, add a small block that re-asserts `font-family: var(--mono-font-family)` on `.markdown-body pre, .markdown-body code, .markdown-body pre code, .markdown-body samp, .markdown-body tt, .markdown-body kbd`. No `!important`. Verify with DevTools that the computed style on a rendered Markdown code block resolves to the variable.
- [x] 2.2 Check `highlight.js/styles/github.css` for any `font-family` declarations that might shadow the override. If found, add equally targeted overrides to the same block.

## 3. Parse `.uatu.json mono.fontFamily`

- [x] 3.1 Create `src/mono/config.ts` with `loadMonoConfig(rootPath: string): Promise<{ config: { fontFamily?: string }, warnings: string[] }>` mirroring the shape of `src/terminal/config.ts`.
- [x] 3.2 Validation rules: `fontFamily` SHALL be a non-empty string after trim; whitespace-only or non-string values warn (`Ignored mono.fontFamily because it must be a non-empty string.`) and drop the key.
- [x] 3.3 Create `src/mono/config.test.ts` with cases for: valid value flows through, whitespace-only is rejected with a warning, missing block returns empty config, missing file returns empty config, malformed JSON returns empty config (no double-warn — review-load.ts already surfaces parse warnings).

## 4. Forward mono config through state

- [x] 4.1 In `src/server/session.ts`, extend `WatchSessionOptions` with `monoConfig?: { fontFamily?: string }` (mirror the existing `terminalConfig` field).
- [x] 4.2 Extend `createStatePayload` to include `monoConfig` in the payload when present (mirror the existing `terminalConfig` plumbing — only include when `monoConfig.fontFamily` is set).
- [x] 4.3 In `src/cli.ts`, call `loadMonoConfig(...)` alongside `loadTerminalConfig(...)`, surface its warnings via the same `console.error` loop, and pass the result through to `createWatchSession`.
- [x] 4.4 In `tests/e2e/server.ts`, mirror the same wiring inside `createSession({...})` so the e2e harness picks up `.uatu.json mono.fontFamily` after `__e2e/reset` calls that inject one.

## 5. Apply at boot in the browser

- [x] 5.1 Find the existing path that consumes `state.terminalConfig` (search for `terminalConfig` in `src/shell/` and `src/terminal/`). Identify where the initial state payload is processed at page load.
- [x] 5.2 At that same site (or in `src/shell/boot.ts` if cleaner), read `state.monoConfig?.fontFamily` and, when set, call `document.documentElement.style.setProperty("--mono-font-family", value)`.
- [x] 5.3 On subsequent state-payload updates (SSE), re-apply or clear the property if `monoConfig.fontFamily` changed.

## 6. Tests

- [x] 6.1 Add a unit test under `src/server/session.test.ts` (or wherever state-payload tests live today) asserting that `createStatePayload(..., terminalConfig, monoConfig)` includes `monoConfig` when its `fontFamily` is set, and omits it otherwise.
- [x] 6.2 Add an E2E test in `tests/e2e/terminal-font.e2e.ts` (or a new `mono-font.e2e.ts`) that:
  - resets the workspace with `{"mono": {"fontFamily": "Courier New, monospace"}}`
  - reloads
  - asserts `getComputedStyle(:root).getPropertyValue("--mono-font-family")` is `"Courier New, monospace"`
  - asserts a code block inside a rendered Markdown doc has a computed `font-family` containing `"Courier New"`.
- [x] 6.3 Add an E2E test that exercises the precedence: `{"mono": {"fontFamily": "Berkeley Mono"}, "terminal": {"fontFamily": "JetBrains Mono"}}` — terminal panel computed font contains "JetBrains Mono", code block contains "Berkeley Mono".
- [x] 6.4 Add an E2E test that with neither override set, a code block's computed `font-family` contains `"Hack Nerd Font Mono"` (the bundled default).
- [x] 6.5 Run `bun test` and `bun test:e2e`. Both must pass.

## 7. Documentation

- [x] 7.1 Update the `.uatu.json` example in `README.md` to include `"mono": { "fontFamily": "..." }` alongside the existing `terminal` block. Add a short paragraph explaining: mono applies to every monospace surface; terminal narrows it to just the panel; both can be set together.
- [x] 7.2 Update the bundled-font note in `README.md` to clarify that Hack Nerd Font Mono is now the default for every monospace surface (not just the terminal).
- [x] 7.3 In `ARCHITECTURE.md`, note that `--mono-font-family` is the single source of truth for monospace styling.

## 8. Manual verification

- [x] 8.1 `bun run dev`, open a Markdown doc with a fenced code block — confirm it renders in Hack Nerd Font Mono.
- [x] 8.2 Open the source view of a `.ts` file — confirm Hack Nerd Font Mono.
- [x] 8.3 Open the diff view — confirm Hack Nerd Font Mono. (Required `--diffs-font-family: var(--mono-font-family)` on `:root` to plug into @pierre/diffs's consumer hook; without it the diff body stayed on pierre's SF-Mono fallback.)
- [x] 8.4 Set `.uatu.json` to `{"mono": {"fontFamily": "Menlo"}}`, reload — every monospace surface (including terminal) renders in Menlo.
- [x] 8.5 Set `.uatu.json` to `{"mono": {"fontFamily": "Menlo"}, "terminal": {"fontFamily": "JetBrains Mono"}}`, reload — code/source/diff in Menlo, terminal in JetBrains Mono.
- [x] 8.6 `bun run build`, copy `dist/uatu` to a clean directory — confirm the binary serves the same behavior as dev mode. (Automated smoke-tested: compiled binary forwards `.uatu.json mono.fontFamily` through `/api/state.monoConfig`.)
