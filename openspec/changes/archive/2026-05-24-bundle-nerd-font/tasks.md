## 1. Vendor the font asset

- [x] 1.1 Download the latest stable Hack Nerd Font release from `github.com/ryanoasis/nerd-fonts/releases` and pick `HackNerdFontMono-Regular.ttf` (the `Mono` variant — icons render single-cell, required for a terminal grid).
- [x] 1.2 Convert that TTF to WOFF2 (e.g., `woff2_compress` from `google/woff2`, or any equivalent). Confirm the resulting file is ≤ 1.5 MB.
- [x] 1.3 Create `src/assets/fonts/` and commit the WOFF2 file as `HackNerdFontMono-Regular.woff2`.
- [x] 1.4 Commit the upstream license texts as siblings: the Hack typeface MIT license (`LICENSE.md` from the `source-foundry/Hack` upstream) and the Nerd Fonts patch's SIL OFL 1.1 license (`LICENSE.txt` from `ryanoasis/nerd-fonts`).
- [x] 1.5 Add a `src/assets/fonts/SOURCE.txt` recording: upstream project (`ryanoasis/nerd-fonts`), upstream release tag, the source URL the file was downloaded from, and the `woff2_compress` invocation used.

## 2. Wire the font into the binary

- [x] 2.1 In `src/cli.ts`, add `import hackMonoFontAsset from "./assets/fonts/HackNerdFontMono-Regular.woff2" with { type: "file" };` next to the other asset imports.
- [x] 2.2 Pass `hackMonoFontAsset` through the `assets:` block of the `buildRoutes({...})` call (under a new `fonts: { hackMono: ... }` field).

## 3. Serve the font from the shared route table

- [x] 3.1 In `src/server/routes.ts`, extend `RouteAssets` with `fonts: { hackMono: string }` (keep the JSDoc/comment style consistent with the surrounding entries, including the note about how these are file paths produced by `import x from "…" with { type: "file" }`).
- [x] 3.2 Add a new route entry under `buildRoutes`: `"/assets/fonts/HackNerdFontMono-Regular.woff2": new Response(Bun.file(assets.fonts.hackMono), { headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" } })`.
- [x] 3.3 In `tests/e2e/server.ts`, mirror the production wiring so the e2e harness exposes the same route with the same asset.

## 4. Register `@font-face` and simplify the terminal stack

- [x] 4.1 In `src/styles.css`, add an `@font-face` block at the top of the file (after the `@import` lines):
  ```css
  @font-face {
    font-family: "Hack Nerd Font Mono";
    src: local("Hack Nerd Font Mono"),
         url("/assets/fonts/HackNerdFontMono-Regular.woff2") format("woff2");
    font-weight: normal;
    font-style: normal;
    font-display: block;
  }
  ```
- [x] 4.2 Replace the long `--terminal-font-family` stack in `:root` with: `"Hack Nerd Font Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;`. Update the surrounding comment to explain: bundled face is the default, `.uatu.json terminal.fontFamily` overrides it, generic mono is the last-resort fallback if both the local install and the bundled URL fail.
- [x] 4.3 ~~Add `<link rel="preload" href="/assets/fonts/HackNerdFontMono-Regular.woff2" ...>` to `src/index.html`'s `<head>`.~~ **Skipped during implementation:** Bun's HTMLBundle analyzer tries to resolve absolute-path `<link>` hrefs at build time and fails because the font is a runtime route, not a chunked asset. Instead, the `@font-face` `url()` uses a *relative* path (`./assets/fonts/...`) so Bun's CSS bundler resolves it at build time and emits a content-hashed chunk URL — same model as every other build-time asset. The browser fetches the font through that chunk URL on first reference. The `/assets/fonts/HackNerdFontMono-Regular.woff2` route stays for direct programmatic access and as the contract the bundled-fonts spec names.

## 5. License-check and attribution

- [x] 5.1 In `src/shared/license-check.ts`, add `^OFL-1\.1$` (and a `SIL.OFL` variant if needed) to `permissiveLicensePatterns`.
- [x] 5.2 Add a unit test verifying that the regex matches `"OFL-1.1"` and `"SIL OFL 1.1"` and rejects e.g. `"GPL-3.0"`.
- [x] 5.3 Make the license texts reachable from the running app. Investigation step: grep `src/` for any existing "third-party"/"credits"/"licenses" surface. If one exists, append the bundled-font attribution there. If none exists, expose `/assets/fonts/LICENSE-hack.md` and `/assets/fonts/LICENSE-nerdfonts.txt` via `buildRoutes` and add a one-line attribution comment in the README pointing to them.
- [x] 5.4 Run `bun run check:licenses` and confirm it still passes with the new font and license-check changes in place.

## 6. Tests

- [x] 6.1 Add a unit test (under `src/server/routes.test.ts` if it exists, otherwise a new colocated file) that hits `GET /assets/fonts/HackNerdFontMono-Regular.woff2` against a test server built with `buildRoutes(...)` and asserts `status === 200`, `content-type === "font/woff2"`, `cache-control` contains `immutable`, and `body.length > 0`.
- [x] 6.2 Add a `bun test` assertion that `src/assets/fonts/HackNerdFontMono-Regular.woff2` exists on disk and is ≤ 1.5 MB. Read the file with `Bun.file(...)` and assert `size <= 1.5 * 1024 * 1024`.
- [x] 6.3 Add an E2E test under `tests/e2e/embedded-terminal.e2e.ts` (or a new `terminal-font.e2e.ts`) that opens the terminal panel with no `.uatu.json terminal.fontFamily` override and asserts (a) `document.fonts.check('1em "Hack Nerd Font Mono"')` returns `true`, and (b) writing a PUA byte sequence representing `U+E0B0` renders a non-TOFU cell (canvas pixel sample or visual snapshot).
- [x] 6.4 Add an E2E test that sets `.uatu.json terminal.fontFamily` to a different face (e.g., `"Courier New"`) and asserts the override wins — the xterm computed font-family does not start with `Hack Nerd Font Mono`.
- [x] 6.5 Run `bun test` and `bun test:e2e` and confirm both pass.

## 7. Documentation

- [x] 7.1 Update `ARCHITECTURE.md`'s asset/embedding section (whichever subsection currently lists `mermaid.min.js`, the logo, the icons, the manifest, and `sw.js`) to add the bundled font.
- [x] 7.2 Add a short note to `CLAUDE.md`'s `src/` folder map mentioning that `src/assets/fonts/` exists and what it holds.
- [x] 7.3 If the README has a "Fonts and icons" or `.uatu.json` configuration section, briefly note that the terminal defaults to Hack Nerd Font Mono and that `terminal.fontFamily` overrides it. Don't grow docs speculatively if no such section exists today.

## 8. Manual verification

- [x] 8.1 `bun run dev`, open the app in Safari, open the terminal panel, run a prompt that emits `` (U+E0B0) — confirm both ASCII and the icon glyph render correctly.
- [x] 8.2 Open the app in a fresh Chrome profile (no Nerd Font installed) — confirm both ASCII and icon glyphs render correctly without any local Nerd Font installed.
- [x] 8.3 Set `.uatu.json` with `{"terminal": {"fontFamily": "Menlo"}}`, reload — confirm the terminal renders in Menlo (no icons, since Menlo has no Nerd glyphs), proving the override path still wins.
- [x] 8.4 `bun run build`, copy `dist/uatu` to a clean directory, run it against a sample repo — confirm the font serves and renders identically to dev mode.
