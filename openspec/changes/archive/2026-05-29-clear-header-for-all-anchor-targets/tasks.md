## 1. Fixtures

- [x] 1.1 Add a sibling target AsciiDoc doc under `testdata/watch-docs/` with a deep section (`===`/`====`) carrying a stable id, long enough that the deep section would sit behind the header without the inset. (Reuse `asciidoc-cheatsheet.adoc` as the deep-section target if it already has a suitable deep heading; otherwise add a small dedicated `xref-targets.adoc`.)
- [x] 1.2 Add a fixture AsciiDoc doc (e.g. `xref-demo.adoc`) containing: a non-heading block (a table or `[source]` listing) with an Asciidoctor `[#block-id]` anchor, an intra-document cross-reference to that block (`<<block-id>>` near the top of the doc), and an inter-document cross-reference into the deep section of the 1.1 target (`xref:<target>.adoc#deep-section[…]`).
- [x] 1.3 Confirm the new fixtures render without errors via the dev server (`bun run src/cli.ts watch testdata/watch-docs --port <free> --no-open`) and that the intra-doc xref resolves to the block id and the inter-doc xref keeps its `.adoc` extension with the `#deep-section` fragment.

## 2. Fix

- [x] 2.1 In `src/styles.css`, add `scroll-padding-top: 7.5rem` to the `.preview-shell` scroll-container rule (around `src/styles.css:400`).
- [x] 2.2 In `src/styles.css`, remove the now-redundant `.preview :is(h1,h2,h3,h4,h5,h6), .preview :is(.sect1,.sect2,.sect3,.sect4,.sect5)[id] { scroll-margin-top: 7.5rem }` rule (around `src/styles.css:2144`), including its explanatory comment.

## 3. Verify with screenshots

- [x] 3.1 Boot the dev server with `--no-open`, drive Playwright to click the intra-doc cross-reference to the non-heading block, and confirm (measurement + screenshot) the block's top edge is at/below the sticky header bottom.
- [x] 3.2 Drive Playwright to click the inter-document deep-fragment cross-reference, wait for the in-app load, and confirm the resolved target lands clear of the header.

## 4. Regression coverage

- [x] 4.1 In `tests/e2e/asciidoc.e2e.ts`, add a scenario clicking the intra-document non-heading-block cross-reference and asserting the target block's `boundingBox().y >= header bottom - tolerance` (mirror the polling pattern at `asciidoc.e2e.ts:218`).
- [x] 4.2 In `tests/e2e/asciidoc.e2e.ts`, add a scenario clicking the inter-document deep-fragment cross-reference, awaiting the document swap, then asserting the resolved target lands clear of the header.
- [x] 4.3 Run `bun test:e2e` and confirm the new scenarios pass AND the existing TOC/heading clearance scenarios still pass.

## 5. Close out

- [x] 5.1 Run `bun test` (unit) and `bun run check:licenses` to confirm nothing else regressed.
- [x] 5.2 Run `openspec validate clear-header-for-all-anchor-targets` and confirm the change is valid before archiving.
