## ADDED Requirements

### Requirement: Binary bundles a full Nerd Font asset

The uatu binary SHALL include a vendored full Nerd Font file (Hack Nerd Font Mono) under `src/assets/fonts/`, imported with Bun's `with { type: "file" }` so it is embedded in the compiled `dist/uatu` binary. The vendored file SHALL be in WOFF2 format and SHALL be ≤ 1.5 MB on disk. The upstream source URL and the exact upstream release tag SHALL be recorded alongside the font (e.g., a `SOURCE.txt` sibling) so the file can be reproduced from source.

#### Scenario: Compiled binary contains the font

- **WHEN** `bun run build` produces `dist/uatu`
- **THEN** the binary embeds the vendored font file
- **AND** the file size is unchanged from the source under `src/assets/fonts/`

#### Scenario: Font file stays within the size budget

- **WHEN** the repository is checked out
- **AND** the bundled font file is measured on disk
- **THEN** its size is ≤ 1.5 MB

#### Scenario: Source provenance is recorded

- **WHEN** a contributor inspects `src/assets/fonts/`
- **THEN** a sibling file (e.g., `SOURCE.txt`) names the upstream project, the upstream release tag, and the URL from which the font was downloaded

### Requirement: Server serves the bundled font from a stable route

The route table (`src/server/routes.ts` via `buildRoutes`) SHALL expose the bundled font at a stable path under `/assets/fonts/` with `Content-Type: font/woff2` and a long-lived `Cache-Control: public, max-age=31536000, immutable` header. The same route SHALL be wired in both the production CLI server (`src/cli.ts`) and the e2e test harness (`tests/e2e/server.ts`) via the shared `RouteAssets` contract.

#### Scenario: GET returns the font with correct headers

- **WHEN** a client issues `GET /assets/fonts/HackNerdFontMono-Regular.woff2` against a running uatu server
- **THEN** the response status is 200
- **AND** the `content-type` header is `font/woff2`
- **AND** the `cache-control` header contains `immutable`

#### Scenario: Route is wired in both prod and e2e

- **WHEN** the e2e harness in `tests/e2e/server.ts` starts up
- **AND** a test issues `GET /assets/fonts/HackNerdFontMono-Regular.woff2`
- **THEN** the response is identical (status, content-type, body length) to the production server's response

### Requirement: `@font-face` registers the bundled font with local-then-url precedence

The stylesheet SHALL register exactly one `@font-face` declaration for the bundled face. Its `font-family` SHALL match the upstream family name (`"Hack Nerd Font Mono"`). Its `src` SHALL list `local("Hack Nerd Font Mono")` first and a `url(...) format("woff2")` second — pointing at the vendored WOFF2 via a path the CSS bundler can resolve at build time (in practice, a path relative to `src/styles.css`, which Bun's CSS bundler chunkifies into a content-hashed asset URL at runtime) — so a locally-installed copy is used where the browser permits and the bundled copy is fetched otherwise.

#### Scenario: `@font-face` declares local then url

- **WHEN** the browser loads `styles.css`
- **THEN** exactly one `@font-face` declaration appears with `font-family: "Hack Nerd Font Mono"`
- **AND** its `src` value lists `local("Hack Nerd Font Mono")` before a `url(...) format("woff2")` entry that resolves (via the CSS bundler) to the vendored `HackNerdFontMono-Regular.woff2`

#### Scenario: Browser without access to local install fetches the bundled URL

- **WHEN** the browser does not have access to a locally-installed Hack Nerd Font Mono (e.g., Safari, a machine with no Nerd Font installed)
- **AND** the page renders text using `font-family: "Hack Nerd Font Mono"`
- **THEN** the browser fetches the bundled WOFF2 via whichever asset URL the CSS bundler exposes at runtime
- **AND** the rendered text uses the bundled glyphs

### Requirement: Bundled font license is allowlisted and shipped with the binary

`src/shared/license-check.ts` SHALL include SIL OFL 1.1 in its permissive-license allowlist so `bun run check:licenses` continues to pass with the bundled font in place. The OFL entry is load-bearing because the patched glyph data incorporates icons from upstream icon fonts that ship under SIL OFL 1.1 (e.g., FontAwesome, Weather Icons), even though the immediate upstream projects we vendor from are MIT-licensed. The upstream license texts (MIT for Hack itself, MIT for the Nerd Fonts patching utility) SHALL be vendored alongside the font under `src/assets/fonts/`, accompanied by a NOTICES file that enumerates the per-icon-source licenses; all SHALL be reachable from the running app (either via a dedicated route or by being included in an existing third-party-notices surface).

#### Scenario: License check accepts SIL OFL 1.1

- **WHEN** a developer runs `bun run check:licenses`
- **AND** the bundled font's package metadata (or the project's own font allowlist entry) declares `OFL-1.1`
- **THEN** the check exits successfully without flagging the font as forbidden

#### Scenario: License texts are vendored next to the font

- **WHEN** a contributor inspects `src/assets/fonts/`
- **THEN** the MIT license text for the Hack typeface and the MIT license text for the Nerd Fonts patching utility are both present as sibling files
- **AND** a NOTICES file enumerates the per-icon-source licenses (FontAwesome under SIL OFL 1.1, Material Design Icons under Apache 2.0, etc.)
- **AND** each license file's content matches its canonical upstream text

#### Scenario: Licenses are reachable from the running app

- **WHEN** an end user wants to inspect attribution for fonts shipped in the binary
- **THEN** the license texts and the NOTICES file are reachable through the running app — either at documented routes under the server, or through whatever existing about/credits surface uatu provides
- **AND** the surface clearly attributes the font to its upstream projects (Hack typeface, Nerd Fonts patch) and to the icon source fonts
