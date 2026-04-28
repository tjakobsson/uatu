# Tasks — fix cross-document links

## Renderer

- [x] Pass `relfilesuffix: ".adoc"` to `asciidoctor.convert` in `src/asciidoc.ts` so cross-document `xref:` and `<<>>` shorthand keep their `.adoc` extension.
- [x] Add unit tests in `src/asciidoc.test.ts` covering: `xref:` to sibling, `xref:` to subdir, `xref:` with fragment, `<<other.adoc#sec,…>>` shorthand, `link:` macro, `.asciidoc` extension, bare `xref:id[]` in-doc anchor, external URL guard.
- [x] Add a Markdown unit test in `src/markdown.test.ts` locking in micromark's existing pass-through.

## Browser UI

- [x] Add `initCrossDocAnchorHandler` in `src/app.ts` that intercepts cross-document anchor clicks and routes them through `loadDocument`.
- [x] Add `findDocumentByRelativePath` and `scrollToFragment` helpers (mirroring sanitize's `user-content-` id prefix).
- [x] Skip interception for: modifier-clicks, `target` other than `_self`, fragment-only hrefs, external origins, non-http(s) protocols, binary documents, off-root paths.
- [x] After `loadDocument` resolves, scroll to the URL fragment if present.

## Fixtures

- [x] Add `testdata/watch-docs/links-demo.md` linking to existing fixtures.
- [x] Add `testdata/watch-docs/links-demo.adoc` with `xref:`, `<<>>`, and `link:` shapes plus a subdirectory case.
- [x] Add `testdata/watch-docs/guides/notes.adoc` as the subdirectory target.

## E2E

- [x] Update existing E2E file-count assertions (4 → 7 baseline; "5 files" extras → "8 files"; ".uatuignore" hidden test → "8 files · 2 hidden").
- [x] Add E2E test asserting AsciiDoc cross-doc hrefs are `.adoc` (not `.html`).
- [x] Add E2E test asserting Markdown cross-doc hrefs are `.md` (not `.html`).
- [x] Add E2E test clicking an AsciiDoc cross-doc link and asserting the SPA preview swaps without a full navigation.
- [x] Add E2E test for the AsciiDoc subdirectory case (`xref:guides/notes.adoc[…]`).
- [x] Add E2E test clicking a Markdown cross-doc link and asserting the same SPA swap behavior.

## Spec

- [x] Add `## ADDED Requirements` block with *Navigate cross-document anchor clicks inside the preview*.
- [x] Add `## MODIFIED Requirements` block clarifying that AsciiDoc cross-document `xref:` shapes preserve the original file extension in the rendered href.

## Project hygiene

- [x] Add `"bin": { "uatu": "./src/cli.ts" }` to `package.json` for `bun link` global install.
- [x] Densify the README's Features section and add an "Install globally with `bun link`" section.

## Validation

- [x] `bun test` — 117 pass.
- [x] `bun run test:e2e` — 35 pass.
- [x] `bun run check:licenses` — verify no new license rejections.
- [x] `bun run build` — verify the standalone binary still builds.
