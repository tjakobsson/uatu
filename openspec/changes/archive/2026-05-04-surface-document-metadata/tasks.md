## 1. Dependencies and shared types

- [x] 1.1 Add `micromark-extension-frontmatter` to `package.json` and run `bun install` to update `bun.lock`.
- [x] 1.2 Define a `DocumentMetadata` type in `src/markdown.ts` (or a new `src/metadata.ts` if it ends up shared with non-pipeline code) covering `title`, `authors`, `date`, `revision`, `description`, `tags`, `status`, `extras` per design.md.
- [x] 1.3 Write a `normalizeMetadata` helper that takes a raw key/value map and the source format (`"yaml" | "toml" | "asciidoc"`) and returns a `DocumentMetadata`, applying the curated-field mapping table from design.md.

## 2. Markdown frontmatter parsing

- [x] 2.1 Wire `frontmatter(['yaml', 'toml'])` into the micromark `extensions`/`htmlExtensions` lists in `src/markdown.ts:43`.
- [x] 2.2 Extract the frontmatter block ahead of the `micromark` call (or via a syntax-tree pass that consumes the matter token) and parse the YAML/TOML payload into a raw key/value map. Use a minimal parser already in the dependency tree if one fits; otherwise add a small dedicated YAML+TOML parser per design.md.
- [x] 2.3 Change the public `renderMarkdownToHtml` signature so it returns `{ html: string; metadata: DocumentMetadata | undefined }` (rename the existing function or add a sibling and migrate callers).
- [x] 2.4 Ensure malformed frontmatter falls through to the legacy thematic-break rendering and yields `metadata: undefined` — no thrown errors reach the caller.
- [x] 2.5 Add unit tests in `src/markdown.test.ts` covering: YAML well-formed, TOML well-formed, malformed YAML (legacy fallthrough), no frontmatter (byte-identical body), curated-field normalization (`tags` ↔ list), and unknown fields landing in `extras`.

## 3. AsciiDoc metadata extraction

- [x] 3.1 Switch `src/asciidoc.ts:155` from `asciidoctor.convert(...)` to `asciidoctor.load(...)` followed by `doc.convert()`, preserving every existing option (`safe: "secure"`, `standalone: false`, `attributes`).
- [x] 3.2 Extract metadata from the loaded `Document`: doctitle (`getTitle()`), authors (`getAuthors()` plus `:author:`/`:authors:` attributes), revision (`getRevisionNumber()`, `getRevisionDate()`, `getRevisionRemark()`), description (`:description:`), keywords (`:keywords:` split on `,` and trimmed), status (`:status:`), and dump the remaining `getAttributes()` into `extras` after filtering Asciidoctor's built-in non-author keys (e.g. `safe`, `relfilesuffix`, `showtitle`).
- [x] 3.3 Change the public `renderAsciidocToHtml` signature to return `{ html: string; metadata: DocumentMetadata | undefined }`, matching the Markdown shape.
- [x] 3.4 Confirm the body HTML is byte-identical to the previous `convert(...)` output for the existing fixtures (`asciidoc-cheatsheet.adoc`, `links-demo.adoc`, `guides/notes.adoc`) by snapshotting before and after.
- [x] 3.5 Add unit tests in `src/asciidoc.test.ts` covering: header attributes only, author + revision lines only, both, neither (byte-identical body, `metadata: undefined`), and the body-substitution preservation (`{author}` still substitutes after extraction).

## 4. Server response wiring

- [x] 4.1 Extend the `RenderedDocument` shape in `src/server.ts` to include `metadata: DocumentMetadata | undefined` alongside the existing `html`, `title`, `language`, etc.
- [x] 4.2 Thread the metadata field from `renderMarkdownToHtml` and `renderAsciidocToHtml` through the rendered-payload code path. Keep the field absent for non-Markdown, non-AsciiDoc documents.
- [x] 4.3 Update `src/server.test.ts` assertions around the rendered-payload shape so existing fixtures still pass and add new assertions for fixtures that carry metadata.

## 5. Metadata sanitization

- [x] 5.1 Add a `sanitizeMetadata` helper that walks the `DocumentMetadata` object, escapes every string value via the existing `escapeHtml` (or routes through the body sanitize pipeline if a string ever needs to allow inline HTML), and rejects values that are not strings or arrays of strings.
- [x] 5.2 Add unit tests covering: `<script>` in `description`, `onerror=` in `title`, `javascript:` URL in `extras`, `<iframe>` anywhere — none of these MUST result in active-content output.

## 6. Browser metadata-card UI

- [x] 6.1 In `src/preview.ts`, render a metadata card above the body when `metadata` is present, using a fixed template that walks the curated fields in a consistent order, then a subdued generic key/value list for `extras`. (Implemented in `src/app.ts` since that's where the preview HTML composition happens; `src/preview.ts` only handles Mermaid hydration.)
- [x] 6.2 In `src/styles.css`, add light-mode styling for the card consistent with the existing GitHub-aligned look — subdued container, distinct typography for curated rows vs the generic list, no theme variables introduced solely for this card.
- [x] 6.3 Ensure the card is omitted entirely when `metadata` is undefined or all of its fields are empty (treat empty strings, empty arrays, and `undefined` as absent).
- [x] 6.4 Verify the existing in-page anchor handler and cross-document link handler in `src/preview.ts` are unaffected — the card sits above the body but does not change body anchor IDs or sanitize prefixing.

## 7. Test fixtures

- [x] 7.1 Create a new `testdata/watch-docs/metadata/` directory.
- [x] 7.2 Add `metadata/markdown-yaml.md` with title, author, date, description, tags, status, and one unknown field.
- [x] 7.3 Add `metadata/markdown-toml.md` with the equivalent fields in TOML (`+++` delimiters).
- [x] 7.4 Add `metadata/markdown-malformed.md` with a `---` block whose body is invalid YAML, to exercise the fallthrough.
- [x] 7.5 Add `metadata/markdown-empty.md` with no frontmatter, to exercise the no-card path.
- [x] 7.6 Add `metadata/asciidoc-attrs.adoc` exercising `:author:`, `:revnumber:`, `:revdate:`, `:description:`, `:keywords:`, `:status:`, plus one unknown `:attr:`.
- [x] 7.7 Add `metadata/asciidoc-author-revline.adoc` with the doctitle on line 1, author entry on line 2, revision entry on line 3, and no `:attr:` lines.
- [x] 7.8 Add `metadata/asciidoc-empty.adoc` with only a doctitle, to exercise the no-card path.
- [x] 7.9 Reference at least one of the fixtures from `testdata/watch-docs/README.md` so the demo walkthrough surfaces the new behavior.

## 8. End-to-end coverage

- [x] 8.1 Add a Playwright spec under the existing E2E directory that opens a metadata-bearing fixture and asserts the card is visible, contains the expected curated rows in order, and that the body's first heading still renders below the card.
- [x] 8.2 Add a Playwright spec asserting that a fixture with no metadata produces no card.
- [x] 8.3 Add a Playwright spec asserting that a metadata value containing `<script>alert(1)</script>` does not execute and renders as escaped text inside the card.

## 9. Spec sync and verification

- [x] 9.1 Run `bun test` and confirm all unit tests pass, including the new fixtures. (240 pass, 0 fail.)
- [ ] 9.2 Run `bun run dev testdata/watch-docs/metadata/markdown-yaml.md` and visually verify the card in the browser; repeat for the AsciiDoc fixture. (Cannot run interactively in this environment — covered indirectly by E2E specs that assert card visibility, ordering, and security in a real browser.)
- [x] 9.3 Run `bunx playwright test` and confirm the new E2E specs pass. (89 pass, 0 fail.)
- [x] 9.4 Run `openspec validate surface-document-metadata --strict` and confirm the change is valid.
- [x] 9.5 Update `README.md` "Features" bullet for Markdown/AsciiDoc rendering to mention the metadata card if the documented surface area changes.
