## 1. Dependency and license

- [x] 1.1 Add `@asciidoctor/core` to `dependencies` in `package.json` and run `bun install`
- [x] 1.2 Run `bun run check:licenses` and confirm `@asciidoctor/core` and its transitive deps clear the existing allowlist

## 2. Document kind and classifier

- [x] 2.1 Extend `DocumentKind` in `src/shared.ts` to include `"asciidoc"`
- [x] 2.2 Add `isAsciidocPath(filePath: string): boolean` (matching `.adoc` and `.asciidoc` only — not `.asc`, which is dominantly PGP ASCII-armored content) in `src/file-classify.ts`
- [x] 2.3 In `classifyFile`, return `"asciidoc"` when `isAsciidocPath` matches, before the existing text/binary checks
- [x] 2.4 Update `src/file-classify.test.ts` to cover the AsciiDoc extension cases, including a test that confirms `.asc` files are NOT classified as AsciiDoc (deliberate divergence from GitHub)

## 3. AsciiDoc render module

- [x] 3.1 Create `src/asciidoc.ts` exporting `renderAsciidocToHtml(source: string): string`
- [x] 3.2 Inside the renderer, invoke `@asciidoctor/core` with `safe: 'secure'` and an empty attributes map (also `showtitle: true` so the level-0 doctitle renders as `<h1>`, matching GitHub)
- [x] 3.3 Apply `hast-util-from-html` → `hast-util-sanitize` (extended schema) → `hast-util-to-html` to the Asciidoctor output
- [x] 3.4 Extend the sanitize schema to whitelist the structural classes: `admonitionblock`, `note`, `tip`, `important`, `caution`, `warning`, `listingblock`, `title`, `content`, `colist`, `conum` (className list is prepended so it shadows the default schema's narrower allowlist)
- [x] 3.5 Normalize Asciidoctor's listing shape (`<pre class="highlight"><code class="language-X" data-lang="X">…</code></pre>`) into the Markdown shape (`<pre><code class="language-X">…</code></pre>`) before the highlight pass
- [x] 3.6 Reuse the highlight.js post-pass from `src/markdown.ts` (`highlightCodeBlocks` + `escapeHtml` exported) so the same `<pre><code class="hljs language-X">` output is produced for AsciiDoc listings
- [x] 3.7 Apply the 1 MB size threshold: above the limit, render the source as plain escaped text inside `<pre><code class="hljs">` and skip Asciidoctor

## 4. Mermaid handling

- [x] 4.1 The shape-normalization in 3.5 turns `[source,mermaid]` listings into `<pre><code class="language-mermaid">…</code></pre>` — the same shape the Markdown pipeline produces. The shared `highlightCodeBlocks` already skips `language-mermaid`. No special-case in the AsciiDoc renderer is needed; the existing client-side `replaceMermaidCodeBlocks` handles it uniformly.
- [x] 4.2 Verified — bare `[mermaid]` (literal block, not a listing) does NOT match the listing-shape regex, so it stays as a `<pre>` literal block, matching GitHub
- [x] 4.3 Add a renderer-level test that confirms a bare `[mermaid]` block renders as a literal block (not a diagram), matching GitHub

## 5. Dispatch and preview

- [x] 5.1 Update the server render dispatch (`src/server.ts` and any preview helper that branches on `DocumentKind`) to route `asciidoc` documents through `renderAsciidocToHtml`
- [x] 5.2 Update the preview header type chip to read `asciidoc` for AsciiDoc documents
- [x] 5.3 Update the file-icon registry in `src/file-icons.ts` with an entry for `.adoc` and `.asciidoc`

## 6. Single-file watch and CLI

- [x] 6.1 Verify `uatu watch foo.adoc` accepts the path (no rejection in the CLI's "non-binary file" startup check) and starts a single-file scope session
- [x] 6.2 Add a CLI test (or extend the existing one) to cover the AsciiDoc single-file path case

## 7. Styling

- [x] 7.1 Add minimal admonition styling in `src/styles.css` keyed off `admonitionblock.note/tip/important/caution/warning`
- [x] 7.2 Add minimal callout (`conum`, `colist`) styling in `src/styles.css`
- [x] 7.3 Add minimal listing-block title styling

## 8. Tests

- [x] 8.1 Create `src/asciidoc.test.ts` covering: basic section/list/table rendering, admonition class survival, `[source,LANG]` highlight, `[source,mermaid]` → client-side `<div class="mermaid">` hydration, bare `[mermaid]` stays literal, `include::` directive does not resolve under SECURE, sanitize neutralizes `<script>`/`onerror`/`javascript:`, oversized input falls back to plain text. Also covers full heading depth (`=` → `<h1>` … `======` → `<h6>`), TOC structure, and `<<xref>>` cross-references.
- [x] 8.2 No new shared helper extracted — `highlightCodeBlocks` and `escapeHtml` from `src/markdown.ts` are reused directly. Existing Markdown tests already cover their behavior.
- [x] 8.3 Add `testdata/watch-docs/asciidoc-cheatsheet.adoc` as a comprehensive cheat-sheet fixture (headings L0–L5, TOC, inline formatting, lists incl. nested/description/checklist, tables, source listings with callouts, mermaid (both forms), all five admonitions, quote/sidebar blocks, footnotes, dropped `include::`). Existing `"3 files"` and `"4 files"` count assertions in the E2E suite are bumped to `"4 files"` and `"5 files"`.
- [x] 8.4 Extend Playwright E2E (`tests/e2e/uatu.e2e.ts`) to select the AsciiDoc cheat sheet and assert the `asciidoc` chip, full h1-h6 heading depth, TOC anchor links, two admonition kinds, the highlighted code, the mermaid SVG, and the quote/sidebar blocks

## 9. Documentation

- [x] 9.1 Update `README.md` Features list to mention AsciiDoc rendering with the same feature surface (code highlight, mermaid via `[source,mermaid]`, GitHub-aligned subset)
- [x] 9.2 Mention SECURE safe mode (no `include::`) explicitly so users aren't surprised

## 10. Validation

- [x] 10.1 Run `bun test` — all unit/integration tests pass (108 passed, was 84)
- [x] 10.2 Run `bun run check:licenses` — no copyleft licenses introduced (audited 219 packages)
- [x] 10.3 Run `bun run build` — standalone binary builds (`dist/uatu`)
- [x] 10.4 Run `bun run test:e2e` — Playwright E2E suite passes (28 tests, including the new AsciiDoc fixture)

## 11. TOC navigation fix (post-cheat-sheet)

- [x] 11.1 Add `rewriteInPageAnchors` to `src/asciidoc.ts` that rewrites bare in-page hrefs (`href="#X"`) to match sanitize's `user-content-` prefix on heading ids, so TOC entries and `<<xref>>` cross-references actually navigate. Cross-document hrefs (`other.adoc#X`) and external URLs are left alone.
- [x] 11.2 Update `src/asciidoc.test.ts` with renderer tests for the rewrite (in-page prefix, no double-prefix, no rewrite of cross-document fragments, no rewrite of external URLs) and update the TOC and cross-reference assertions to expect the prefixed shape
- [x] 11.3 Update the E2E TOC-link assertions in `tests/e2e/uatu.e2e.ts` to use the prefixed `href` shape
- [x] 11.4 Expand the AsciiDoc spec requirement and add scenarios for heading depth (`=`–`======` → `<h1>`–`<h6>`) and clickable TOC navigation
- [x] 11.5 Add an E2E test (`clicking a Table of Contents link…`) that asserts the target heading is below the fold before the click and in-viewport after — full round-trip coverage of render → sanitize → href rewrite → click → in-page navigation

## 12. In-page anchor click handler (post-real-browser-test)

- [x] 12.1 In `src/app.ts`, install a delegated click handler on the preview element that intercepts `<a href="#X">` clicks, finds the matching id inside the preview, and `scrollIntoView()`s it. Without this, fragment links resolve against the per-document `<base href>` (set to the doc's directory so relative image paths work) and trigger full navigation to e.g. `/guides/`, which the server's static fallback returns 404 for. Modifier-clicks (cmd/ctrl/shift/alt) are passed through to the browser.
- [x] 12.2 Add a regression E2E test (`TOC link click in a nested-directory AsciiDoc doc does NOT navigate to a 404`) that exercises a nested `.adoc` fixture with `:toc:`, asserts the base href points at the subdirectory (the precondition that triggers the bug), then clicks a TOC entry and asserts (a) the URL pathname is unchanged, (b) the uatu app shell is still rendered, and (c) the target heading scrolled into view.
- [x] 12.3 Add a spec scenario for the subdirectory case so the behavior is part of the contract
