## Why

Both Markdown and AsciiDoc files commonly carry a metadata block at the top — YAML/TOML frontmatter for Markdown and a header-attribute block for AsciiDoc — and uatu currently mishandles both. Markdown frontmatter renders as a stray `<hr />` plus a paragraph of raw `key: value` text plus a closing `<hr />`, which looks broken to anyone opening a doc that uses Jekyll/Hugo/Eleventy/Antora-style metadata. AsciiDoc header attributes (`:author:`, `:description:`, `:revnumber:`, `:keywords:`, the optional second-line author and third-line revision) are silently consumed by Asciidoctor when running with `standalone: false`, so useful review signal — author, version, status, description — never reaches the reader. Reviewers and authors using uatu lose information on every document that follows the dominant authoring conventions for these two formats.

## What Changes

- Treat YAML and TOML frontmatter in Markdown as a structured metadata block instead of letting it render as `<hr />` + body text. Wire `micromark-extension-frontmatter` into the existing micromark pipeline so the block is parsed out and made available alongside the body HTML.
- Extract document-level metadata from AsciiDoc (the header attributes, the optional author line, the optional revision line) using Asciidoctor's document API rather than relying on the rendered HTML, so metadata that `standalone: false` currently swallows becomes available to the renderer.
- Render extracted metadata as a single, format-agnostic "metadata card" placed above the document body in the preview. The card SHALL surface a curated set of well-known fields — title, author, date/revision, description, tags/keywords, status — falling back to a generic key/value list for fields it does not recognise. Unknown fields render but are visually subdued so curated fields stand out.
- Sanitize metadata values through the existing GitHub-modeled allowlist before they reach the DOM, matching the security posture already applied to body HTML.
- Add a `testdata/watch-docs/metadata/` fixture matrix exercising: no metadata, minimal metadata, full metadata, malformed YAML, TOML frontmatter, AsciiDoc with author + revision lines, and AsciiDoc with only `:attr:` lines — for both formats.
- Document the new behaviour in the existing rendering requirements so the GitHub-alignment story stays consistent.

## Capabilities

### New Capabilities
<!-- None -->

### Modified Capabilities
- `document-watch-browser`: extend the Markdown and AsciiDoc render requirements so they describe how document-level metadata is parsed and surfaced as a metadata card, and add scenarios covering YAML frontmatter, TOML frontmatter, AsciiDoc header attributes, and the malformed/empty cases.

## Impact

- `src/markdown.ts`: add `micromark-extension-frontmatter` (YAML + TOML) to the micromark extensions, split rendering so metadata is extracted before sanitize, and return both the metadata object and the body HTML to the caller.
- `src/asciidoc.ts`: switch from a single `asciidoctor.convert(...)` call to `asciidoctor.load(...)` followed by document-attribute extraction and `doc.convert()`, so the header attributes, author, and revision are available to the renderer.
- `src/server.ts`: thread the parsed metadata through the document-render response shape so the preview can render the metadata card without a second request. Update the rendered-payload contract used by `server.test.ts`.
- `src/preview.ts` + `src/styles.css`: render the metadata card above the body, with light-mode styling consistent with the existing GitHub-aligned look. The card MUST be omitted entirely when no metadata is present so plain documents are unaffected.
- `package.json` / `bun.lock`: add `micromark-extension-frontmatter` (and its YAML peer if not already transitive). No new runtime dependency for AsciiDoc — Asciidoctor's document API is already loaded.
- `testdata/watch-docs/metadata/`: new fixtures (Markdown + AsciiDoc) wired into existing unit tests and at least one E2E walkthrough so regressions are caught.
- `openspec/specs/document-watch-browser/spec.md`: requirement deltas on the Markdown and AsciiDoc render requirements (additive — no behaviour is removed for documents that have no metadata).
- No breaking change for documents without metadata: existing fixtures, including `README.md` and `asciidoc-cheatsheet.adoc`, render byte-identical body HTML; only documents that already had broken or invisible metadata gain the metadata card.
