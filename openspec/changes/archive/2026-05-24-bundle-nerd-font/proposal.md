## Why

The embedded terminal currently relies on a locally-installed Nerd Font to render the glyphs that shell prompts (powerline, starship, p10k, devicon prompts, git status icons, etc.) emit. When the user has none installed, the prompt renders as TOFU squares. Worse, Safari does not expose user-installed system fonts to web pages — even users who *do* have a Nerd Font installed see TOFU in Safari and the PWA on macOS. The result: the same shell prompt that looks crisp in iTerm looks broken inside uatu's terminal panel.

Bundling a small full Nerd Font with the binary and serving it from the app gives every browser — Safari included — a guaranteed default face for the terminal, with no user setup. Users who want a different face can still override via `.uatu.json`.

## What Changes

- Add a bundled web font asset (`HackNerdFontMono-Regular.woff2`) under `src/assets/fonts/` and import it into the binary the same way other static assets are (`with { type: "file" }`).
- Serve the font from a stable route under `/assets/fonts/...` via `buildRoutes` in `src/server/routes.ts`, with a long-lived `Cache-Control` header.
- Register a `@font-face` declaration in `src/styles.css` whose `src` lists `local("Hack Nerd Font Mono")` first (so a locally-installed copy still wins where the browser allows it) and the bundled URL second (so Safari and Nerd-Font-less machines fall through to it automatically).
- Replace `--terminal-font-family`'s long list of "hope the user installed one of these" Nerd Font face names with a short stack rooted in the bundled face: `"Hack Nerd Font Mono", ui-monospace, monospace`.
- Pick a font whose license permits embedding and redistribution in a downloadable binary. Hack Nerd Font Mono ships under MIT + SIL OFL 1.1; both are acceptable but the OFL component is not yet allowlisted by `bun run check:licenses` — that needs updating.
- Keep the bundle small: target ≤ 1.5 MB on disk for the WOFF2 file. Hack Nerd Font Mono's WOFF2 lands at ~1.2 MB once the full Nerd Font icon patch is included.
- Preserve `.uatu.json terminal.fontFamily` as the override path: a user-supplied family wins over the default, exactly as today.

## Capabilities

### New Capabilities
- `bundled-fonts`: the contract for shipping fonts inside the uatu binary — where they live in the tree, how they are served, the `@font-face` rules they register, and the size and license guarantees they make. This is the home for any future bundled face (UI Inter, etc.) and keeps the embedded-terminal spec from growing a second responsibility.

### Modified Capabilities
- `embedded-terminal`: the requirement "Terminal honors `.uatu.json` font configuration" changes its assertion about the default font stack. Today the spec says the default stack "prefers locally-installed Nerd Fonts ... without bundling a font". After this change the terminal's default font SHALL be the bundled Hack Nerd Font Mono face, served by uatu itself, used in every browser including Safari. The `.uatu.json terminal.fontFamily` override behavior is unchanged.

## Impact

- **Code**: new `src/assets/fonts/` directory; one new import line in `src/cli.ts`; a new `RouteAssets` field plus a route in `src/server/routes.ts`; an `@font-face` block and a simplified stack in `src/styles.css`; the e2e harness (`tests/e2e/server.ts`) needs the same asset wired through `buildRoutes`.
- **Binary size**: roughly 1.2 MB added to the compiled `dist/uatu` binary. Smaller than the already-bundled `mermaid.min.js` (~3.2 MB) and acceptable given uatu's existing binary footprint.
- **Licensing**: the bundled font ships under MIT + SIL OFL 1.1; `bun run check:licenses` must continue to pass once OFL-1.1 is added to the allowlist, and the attribution must be reachable from the running app.
- **Tests**: a unit/E2E check that `/assets/fonts/<file>.woff2` returns 200 with the correct content-type and is referenced by `styles.css`; an e2e check that the terminal renders both ASCII and at least one icon glyph (e.g.,  / `U+E0B0`) without TOFU in a clean browser profile; an e2e check that `.uatu.json terminal.fontFamily` still overrides the default.
- **Docs**: `ARCHITECTURE.md` asset section gets the new entry; `CLAUDE.md`'s `src/` folder map mentions the fonts directory; no README user-facing doc changes (the bundled default is transparent — users only notice when icons stop being broken).
- **No breaking changes**: the override path is untouched; users with `.uatu.json terminal.fontFamily` set see no change. Users without that setting transparently move from "whatever the OS monospace is, with broken icons" to "Hack Nerd Font Mono with working icons".
