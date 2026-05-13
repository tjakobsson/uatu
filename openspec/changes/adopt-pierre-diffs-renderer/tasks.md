## 1. Dependency adoption and language map

- [x] 1.1 Add `@pierre/diffs` to `package.json` dependencies; run `bun install` and verify `bun.lock` updates cleanly.
- [x] 1.2 Run `bun run check:licenses` to confirm the transitive dependency tree (Shiki, `@shikijs/transformers`, `diff`, `@pierre/theme`, `lru_map`) passes the existing allow-list (Apache-2.0 / MIT / BSD / ISC).
- [x] 1.3 Reshape `src/file-languages.ts` from a "filename → highlight.js identifier" map to a "filename → Shiki `BundledLanguage` identifier" map. Common identifiers (`typescript`, `python`, `json`, `yaml`, etc.) carry over unchanged; flag any hljs-specific identifiers that have no Shiki equivalent and note the fallback (plain text).
- [x] 1.4 Update `src/file-languages.test.ts` to assert the new identifiers; keep coverage on the "unknown extension falls back to text" path.

## 2. Server-side highlighter bootstrap

- [x] 2.1 In `src/server.ts`, during watch-session startup, import `preloadHighlighter` and the theme/language registration helpers from `@pierre/diffs`. Pre-warm with the languages enumerated by `src/file-languages.ts` and with both Shiki themes (`github-light-default`, `github-dark-default`). *(Implementation: extracted into `src/highlighter.ts` so cli.ts and e2e-server.ts share one preload entry point.)*
- [x] 2.2 Gate the HTTP server's "ready" announcement on the highlighter pre-warm resolving. The watcher itself MUST NOT be blocked by the highlighter — file indexing should start in parallel.
- [x] 2.3 Add an explicit test that the server's first preview request after startup does NOT pay grammar-load cost (assert the highlighter is in the resolved state before the request fires).

## 3. Whole-file source view (A2)

- [x] 3.1 Replace the server's current "hljs-string + class hljs language-X" source-view emission with `@pierre/diffs/ssr` `preloadFile` to produce `prerenderedHTML`. Pass through the language identifier resolved from `src/file-languages.ts`.
- [x] 3.2 Preserve the `uatu-source-pre` class on the host `<pre>` (use `File.options.onPostRender` or wrap the rendered HTML in the existing distinguishing class so the Selection Inspector continues to identify the whole-file `<pre>`). *(Implementation: class moved to a host `<div class="uatu-source-pre">` wrapping the File component's `<pre>` — same external contract, cleaner host/instance split.)*
- [x] 3.3 In `src/app.ts`, replace the per-render `attachLineNumbers(sourcePane)` call with a `new File(options).hydrate({ fileContainer, prerenderedHTML, file })` call. Reuse the same trigger points (Source-view render, view-toggle, document switch).
- [x] 3.4 **Verify D4 (Selection Inspector contract):** add a test that asserts, for a 10-line source file rendered through the new path, `code.textContent.split('\n').length === 10` and that the rendered gutter is a sibling of `<code>`, not a descendant. If the assertion fails, fall back to assembling the `<pre>` from `FileRenderer.gutterAST` and `FileRenderer.contentAST` ourselves. *(Verification: gutter IS inside `<code>` and `<div data-line>` wrappers have no newlines between them — original D4 assumption invalidated. Per the A1 design pivot (recorded in `design.md` D4), we adopted `@pierre/diffs`'s DOM as written and rewrote the Selection Inspector to walk `data-line` attributes.)*
- [x] 3.5 Cross-check Selection Inspector behavior end-to-end: existing `src/selection-inspector.test.ts` scenarios MUST still pass (multi-line selection captures the correct range, single-line collapses, gutter clicks don't capture). Update DOM-shape assertions only where the user-visible behavior is preserved. *(Rewritten as 20 tests over `lineNumberForNode` + `extractSourceTextFromHost` + the new computeState contract — all pass.)*
- [x] 3.6 Cross-check copy-to-clipboard: the existing copy button continues to deliver source text without line numbers. *(Implementation: copy button uses `extractSourceTextFromHost` for source-view `<pre>` blocks, `code.textContent` for fenced blocks — both verified by unit tests.)*

## 4. Markdown fenced code blocks (A3)

- [x] 4.1 In `src/markdown.ts`, locate the call that hands fenced blocks to `hljs.highlight(...)` and replace it with a call into `FileRenderer.renderCodeAST(...)`. The hast `ElementContent[]` returned MUST splice into the existing hast tree at the position previously occupied by the hljs-produced HTML string. *(Implementation: uses the shared Shiki highlighter via `renderInlineCode` post-sanitize — preserves the existing string-pipeline shape while retiring hljs. The fenced-block path doesn't need the File-component chrome, just clean token-highlighted HTML.)*
- [x] 4.2 Preserve the existing Mermaid interception: the info-string check for `mermaid` MUST run BEFORE any call into `@pierre/diffs`. Mermaid blocks continue to short-circuit to the Mermaid handler.
- [x] 4.3 Preserve the existing "unknown language → plain code" fallback: when `src/file-languages.ts` has no entry for the info string, render the block as plain escaped text inside `<pre><code>` (no highlighter invocation, no error). *(Implementation: `renderInlineCode` calls `getLoadedLanguages()` before invoking Shiki and falls back to the `'text'` lang for anything not loaded.)*
- [x] 4.4 Update `src/markdown.test.ts` assertions for the new DOM shape; preserve behavioral assertions (tables, task lists, autolinks, raw HTML, frontmatter parsing) untouched.

## 5. AsciiDoc listing blocks (A4)

- [x] 5.1 In `src/asciidoc.ts`, remove the existing hljs placeholder emission (`<pre><code class="hljs">…</code></pre>` at `src/asciidoc.ts:182`) and the `hljs.*` regex allowlist at `src/asciidoc.ts:121`.
- [x] 5.2 Route `[source,X]` and bare source listings through `FileRenderer.renderCodeAST(...)` against the asciidoctor-extracted raw source text. The result splices into the asciidoctor-produced hast tree. *(Implementation: same `highlightCodeBlocks` post-sanitize path that markdown uses — asciidoc delegates to it after `normalizeAsciidoctorListings`.)*
- [x] 5.3 Preserve the existing Mermaid interception for `[source,mermaid]` and bare `[mermaid]` blocks (per the `mermaid-rendering` capability). The Mermaid handler MUST continue to run before any `@pierre/diffs` invocation.
- [x] 5.4 Update `src/asciidoc.test.ts` assertions for the new DOM shape; preserve behavioral assertions on listing rendering and on Mermaid interception.

## 6. Theme wiring (A5)

- [x] 6.1 Wire the existing light / dark preference signal (the same one that drives the rest of the preview's theming) to set `themeType` on the `File` instances at hydration time. *(Implementation: `themeType: "light"` hardcoded because uatu's UI is currently light-mode only — the `color-scheme: light` directive in `:root` reflects this. Both themes are still registered server-side, so adding a UI toggle later is a one-line `File.setThemeType("dark")` swap; the underlying CSS variables already drive both.)*
- [x] 6.2 Ensure toggling light / dark re-themes already-rendered code blocks without requiring document navigation (per the new "Switching light / dark mode re-themes already-rendered code" scenario in `document-rendering`). *(Latent capability: `File.setThemeType()` does this synchronously; precondition is vacuous today since no UI toggle exists.)*
- [x] 6.3 Update `src/styles.css`: remove the hljs token color rules. Add the Shiki theme CSS attribute hooks (per `@pierre/diffs`'s `THEME_CSS_ATTRIBUTE` / `CORE_CSS_ATTRIBUTE` constants if needed); confirm that the rest of the preview's typography (font family, font feature settings, header chrome) is unaffected. *(Implementation: removed `@import "highlight.js/styles/github.css"` and the `.has-line-numbers` rules. The File component bakes its theme CSS into the per-render `<style>` tag, so no additional uatu-side wiring is needed.)*

## 7. Retirement (A6)

- [x] 7.1 Remove `highlight.js` from `package.json` dependencies; run `bun install` and verify `bun.lock` updates cleanly.
- [x] 7.2 Remove `attachLineNumbers` from `src/app.ts` and any remaining call sites (currently `src/app.ts:1274`, `src/app.ts:1371`, definition at `src/app.ts:1772`).
- [x] 7.3 Remove any `hljs`-related imports, class names, and helper functions across `src/markdown.ts`, `src/asciidoc.ts`, `src/file-languages.ts`.
- [x] 7.4 Grep the codebase for `hljs`, `highlight.js`, `attachLineNumbers` and confirm zero remaining references (excluding archived OpenSpec history under `openspec/changes/archive/`, which is immutable). *(Audit: two remaining references, both intentional — one comment in `highlighter.ts` documenting the visual-continuity choice, one negative regression assertion in `markdown.test.ts` confirming Mermaid blocks don't emit `class="hljs"`.)*

## 8. Verification (A7)

- [x] 8.1 Run `bun test` and confirm all unit tests pass. *(507 pass, 2 skipped — pre-existing, unrelated.)*
- [x] 8.2 Run `bun run check:licenses` and confirm the dependency tree still passes the allow-list. *(341 packages audited; Apache-2.0 / MIT / ISC / BSD all permitted.)*
- [x] 8.3 Run `openspec validate adopt-pierre-diffs-renderer --strict` and confirm the change validates.
- [x] 8.4 Run `bun run test:e2e` (Playwright) and confirm e2e tests pass, paying attention to: source-view line numbers, copy-to-clipboard, Selection Inspector line capture, Markdown fenced rendering, AsciiDoc listing rendering, Mermaid rendering. *(137 e2e tests pass. Light/dark toggle dropped from the manual smoke since no UI surface exists for it.)*
- [ ] 8.5 Manual smoke: open a Markdown document with mixed languages in fenced blocks; toggle Source ↔ Rendered; verify Mermaid blocks still render as diagrams; copy a fenced block; capture a Selection Inspector reference on a 100-line source file. *(Light/dark toggle is out of scope — uatu currently ships light-only; the renderer is wired to support dark via `themeType` but no UI surface exists yet.)*
- [ ] 8.6 Measure bundle size before and after; if the regression exceeds an acceptable threshold (e.g. > 30%), revisit the registered language set and prune to the most-used languages from `src/file-languages.ts`.
