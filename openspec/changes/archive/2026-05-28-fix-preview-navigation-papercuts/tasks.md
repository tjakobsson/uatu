## 1. External links open in a new tab

- [x] 1.1 Add a shared hast pass `markExternalAnchors(tree)` in a new `src/render/external-links.ts` that walks a hast tree and, for every `<a>` whose `href` parses (via `new URL(href)`) into an absolute URL with `protocol` of `http:` or `https:`, sets `target="_blank"` and `rel="noopener noreferrer"`. Handles already-set `rel` values by union (don't drop existing `noopener` etc.).
- [x] 1.2 Extend the Markdown `sanitizeSchema` in `src/render/markdown.ts` so `a` permits `target` and `rel`. Run `markExternalAnchors` on the hast tree between `sanitize` and `toHtml`. (Order matters: marking *after* sanitize avoids the sanitize step stripping the `target`/`rel` attributes we just added.)
- [x] 1.3 Mirror 1.2 in `src/render/asciidoc.ts`: the existing AsciiDoc-specific sanitize schema also needs to allow `target`/`rel` on `<a>`; the same `markExternalAnchors` pass runs between `sanitize` and `toHtml`.
- [x] 1.4 Add unit tests in `src/render/markdown.test.ts` and `src/render/asciidoc.test.ts`:
  - `[example](https://example.com)` → renders an `<a href="https://example.com" target="_blank" rel="noopener noreferrer">`.
  - `<a href="other.adoc">` (relative) → no `target` attribute.
  - `<a href="#section">` (fragment-only) → no `target` attribute.
  - `<a href="mailto:foo@bar">` → no `target` attribute (only http(s) is marked).
  - `<a href="https://example.com" rel="external">` → `rel` becomes `external nofollow noopener noreferrer` (existing tokens preserved, no duplicates).

## 2. Files-pane header — title and meta no longer overlap

- [x] 2.1 In `src/styles.css`, add `.pane-header h2 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 1; }`. Keep the existing `min-width: 0` rule on `.pane-header h2`. Verify `.pane-meta` retains `flex-shrink: 0` and `.pane-actions` retains `flex-shrink: 0` (they already do).
- [x] 2.2 Verify the `.pane-header { gap: 0.5rem; }` rule is unchanged; if a smaller gap is observed in real-world rendering, leave the gap at `0.5rem` so a minimum visual separation remains. (Already `gap: 0.5rem` at `src/styles.css:1249` — left as-is.)
- [x] 2.3 Add an e2e regression in `tests/e2e/sidebar.e2e.ts`: with the default sidebar width, populate the workspace with enough fixtures that the document-count text has non-empty content (the test fixture's existing roots are sufficient — `await expect(documentCount).not.toHaveText("0 files")`). Capture `getBoundingClientRect()` for the `<h2>Files</h2>` element and for the `#document-count` element. Assert `titleRect.right + 4 <= countRect.left` (allowing for 4px of subpixel/gap tolerance below the 8px CSS gap). Repeat the assertion after `await page.evaluate(() => document.documentElement.style.setProperty('--sidebar-width', '320px'))` to cover the minimum width case — at 320px the title may have ellipsised but the rects MUST NOT overlap.

## 3. In-page anchor pushes a history entry

- [x] 3.1 Modify `initInPageAnchorHandler` in `src/preview/anchors.ts`: after `element.scrollIntoView(...)`, compute `const targetUrl = window.location.pathname + window.location.search + "#" + encodeURIComponent(id);` and `const currentUrl = window.location.pathname + window.location.search + window.location.hash;`. If `targetUrl !== currentUrl`, call `window.history.pushState(null, "", targetUrl)`.
- [x] 3.2 Modify `attachPopstateHandler` in `src/shell/history.ts`: at the very top of the handler (before the review-score / commit-preview branches), introduce a `sameDocumentHashOnly()` check that returns true iff `appState.selectedId` is non-null AND `decodeURIComponent(window.location.pathname).replace(/^\/+/, "") === findDocumentById(appState.selectedId)?.relativePath`. When true: if `window.location.hash` is set, call `scrollToFragment(window.location.hash.slice(1))`; else scroll `previewElement` (or `document.scrollingElement` for the actual preview-host) to the top; then `return`. Do NOT disable follow mode, do NOT call `renderSidebar`, do NOT call `loadDocument`.
- [x] 3.3 Unit tests for the URL-construction helper added in `src/preview/anchors.test.ts`. (Extracted `buildInPageAnchorUrl` into `src/preview/anchor-url.ts` so the unit test avoids the DOM-import cascade from `anchors.ts`. The full click handler is covered end-to-end in §3.4.)
- [x] 3.4 Added e2e regression in `tests/e2e/asciidoc.e2e.ts`: "clicking a TOC entry pushes history; browser back returns to the same document at the top". Verifies URL gains the fragment, heading scrolls into view, then on `page.goBack()` the URL drops the fragment, document title is unchanged, and the deep heading is no longer in viewport.

## 4. TOC scroll-target clears the sticky header at every depth

- [x] 4.1 In `src/render/asciidoc.ts`, add `toclevels: 5` to the `attributes` object passed to `asciidoctor.load`. Document-level `:toclevels:` overrides apply automatically via Asciidoctor's normal precedence.
- [x] 4.2 In `src/styles.css`, extend the existing rule at `~line 2144`. Add: `.preview :is(.sect1, .sect2, .sect3, .sect4, .sect5)[id] { scroll-margin-top: 7.5rem; }`. Keep the existing `.preview :is(h1, h2, h3, h4, h5, h6) { scroll-margin-top: 7.5rem; }` rule unchanged.
- [x] 4.3 Extended the AsciiDoc cheatsheet test at `tests/e2e/asciidoc.e2e.ts:14` to assert the TOC now contains the deeper `=== Unordered` and `=== Ordered` entries (visible only when `:toclevels: 5` is in effect).
- [x] 4.4 Added "clicking a deep TOC entry positions the heading clear of the sticky preview header" e2e test in `tests/e2e/asciidoc.e2e.ts`. Compares the section wrapper's `boundingBox()` to `.preview-header`'s `boundingBox()` and polls until the wrapper top is at or below the header bottom (with 2px tolerance).

## 5. Verification

- [x] 5.1 `bun test`: 578 pass, 2 skip, 0 fail. 17 new/updated render and anchor-url unit tests included.
- [x] 5.2 `bun test:e2e`: 156 pass, 13 skipped, 0 fail. The four new regression tests pass: Files-pane geometry (sidebar.e2e.ts), TOC history-push and deep-TOC scroll clearance (asciidoc.e2e.ts), plus the updated cheat-sheet test that asserts `:toclevels: 5` brought `=== Unordered`/`=== Ordered` into the TOC. (A flaky `mono-font.e2e.ts` failure surfaced once under parallel workers but passed cleanly on a single-test re-run AND on the second full-suite run — pre-existing flake, not caused by these changes.)
- [x] 5.3 `openspec validate fix-preview-navigation-papercuts` — valid.
- [ ] 5.4 Manual smoke deferred to the human reviewer. The four regressions are automated above. Recommended sanity check: `bun run dev` against `testdata/watch-docs`, open the cheat sheet, exercise an external link, narrow the sidebar to 320px, and back-button after a TOC click — to visually confirm no surprises beyond the assertion coverage.
