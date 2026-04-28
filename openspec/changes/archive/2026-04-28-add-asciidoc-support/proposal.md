## Why

uatu currently renders Markdown documents through a GitHub-styled pipeline (micromark + sanitize + highlight.js + client-side Mermaid) and falls back to syntax-highlighted code for every other text file. AsciiDoc (`.adoc`, `.asciidoc`) is a first-class README format on GitHub, but in uatu these files render as plain code listings rather than as formatted documents. Adding AsciiDoc rendering closes that gap and makes uatu useful for AsciiDoc-first projects, while keeping the rendering surface aligned with what authors already see on GitHub.

## What Changes

- Recognize `.adoc` and `.asciidoc` as a new document kind (`asciidoc`) sibling to the existing `markdown`/`text`/`binary` kinds, with its own render path and its own header type chip. (GitHub also registers `.asc` for AsciiDoc, but `.asc` is overwhelmingly used for PGP ASCII-armored signatures and keys; the AsciiDoc community itself recommends against `.asc` for AsciiDoc files. uatu deliberately diverges from GitHub here and treats `.asc` as ordinary text — see design.md.)
- Render AsciiDoc through `@asciidoctor/core` (MIT) running in `secure` safe mode. SECURE matches GitHub's posture and disables `include::`, filesystem reads, URI reads, and author-controlled `source-highlighter`/`docinfo`/`backend` attributes.
- Run the Asciidoctor HTML output through the same `hast-util-sanitize` allowlist used for Markdown, with a few additional structural classes whitelisted so admonitions and listings can be styled (`admonitionblock`, `listingblock`, `title`, `content`, and the admonition kind classes `note`/`tip`/`important`/`caution`/`warning`).
- Apply highlight.js to `[source,LANG]` listings on the server, matching the Markdown post-pass. Normalize Asciidoctor's `<pre class="highlight"><code class="language-X" data-lang="X">` shape into the same `<pre><code class="hljs language-X">` shape we already produce for Markdown so the existing client-side code-block features (copy control, theming) work unchanged.
- Render Mermaid diagrams from `[source,mermaid]` listings only (matching GitHub; not the bare `[mermaid]` block) by emitting `<div class="mermaid">…</div>` for that one language, then letting the existing client-side Mermaid runtime take over.
- Apply a 1 MB size threshold (parallel to `SYNTAX_HIGHLIGHT_BYTES_LIMIT`) above which AsciiDoc input is rendered as plain escaped text in `<pre><code class="hljs">` instead of being parsed by Asciidoctor, keeping the browser responsive on large files.
- Allow `uatu watch foo.adoc` (single-file scope) for AsciiDoc files, the same way single-file scope already works for Markdown and other text files.
- Add file-icon entries for the AsciiDoc extensions so they get a recognizable icon in the sidebar tree instead of the generic fallback.
- Add minimal uatu-owned CSS for the AsciiDoc-specific structures we keep (admonitions, listing block titles, callouts). Do **not** ship Asciidoctor's default stylesheet — match GitHub's restraint.
- Update follow mode, pin mode, the sidebar dispatch, and the preview header chip to treat AsciiDoc files as a first-class previewable document kind alongside Markdown.

Out of scope for this change:
- The `include::` directive (GitHub disables; we do too via SECURE).
- STEM/math notation (GitHub doesn't render either).
- A general renderer-plugin framework. The dispatch stays a parallel switch in this change. Once a third concrete renderer (e.g. a JSON prettifier) gives the abstraction a real shape to fit, that becomes its own change.

## Capabilities

### New Capabilities

(none — AsciiDoc rendering belongs inside the existing `document-watch-browser` capability, alongside Markdown rendering. Adding a parallel capability would split a single user-facing surface across two specs.)

### Modified Capabilities

- `document-watch-browser`: adds a new requirement parallel to "Render GitHub-style Markdown in light mode" covering the AsciiDoc render path (parser, sanitize allowlist deltas, highlight.js post-pass, mermaid handling, size threshold). Updates a small set of existing requirements where they currently say "Markdown" but really mean "any renderable document": the dispatch sentence in "Browse supported documents from watched roots", the previewable-kind references in "Follow the latest changed non-binary file", "Pin the session to a single non-binary file", and "Show the active file's type in the preview header" (chip can also read `asciidoc`). The mermaid requirement is broadened so that `[source,mermaid]` listings in AsciiDoc render as diagrams alongside Markdown's `mermaid` fenced blocks.

## Impact

- **Code**:
  - `src/shared.ts` — `DocumentKind` gains `"asciidoc"`.
  - `src/file-classify.ts` — recognize `.adoc` and `.asciidoc` and return the new kind.
  - `src/asciidoc.ts` (new) — AsciiDoc render path, mirroring `src/markdown.ts`.
  - `src/markdown.ts` — extract the highlight.js post-pass and sanitize-schema bits into a small shared module so AsciiDoc and Markdown share them without copy-paste.
  - `src/preview.ts` — extend mermaid replacement to also match Asciidoctor's `language-mermaid` listing shape.
  - `src/file-icons.ts` — icon entries for AsciiDoc extensions.
  - `src/server.ts` / dispatch site — route `asciidoc` kind to the new render path.
  - `src/styles.css` — minimal admonition/callout/listing-block styling.
  - Browser UI header chip — read `asciidoc` for AsciiDoc documents.
- **Dependencies**: adds `@asciidoctor/core` (MIT). The license audit (`src/license-check.ts`) already accepts MIT; no allowlist change needed.
- **Bundle size**: `@asciidoctor/core` is a transpiled Ruby runtime via Opal (~2 MB). The standalone `uatu` binary is already ~60+ MB; this is rounding error for the binary and stays out of the browser bundle (rendering happens server-side in bun).
- **Security**: SECURE safe mode keeps AsciiDoc inside the same posture as the existing static-asset fallback (no path traversal, no filesystem reads beyond the watched roots).
- **Tests**: parallel `src/asciidoc.test.ts` covering the same shapes as `src/markdown.test.ts` (basic rendering, sanitize, highlight, mermaid, size threshold, secure-mode `include::` is dropped). Existing Markdown tests should remain unchanged.
- **Spec**: a single new requirement plus targeted edits to a handful of existing requirements in `openspec/specs/document-watch-browser/spec.md`. No changes to `repository-workflows`.
- **Validation commands**: `bun test`, `bun run check:licenses`, `bun run build`, `bun run test:e2e` continue to be the gate; AsciiDoc adds new fixtures under `testdata/` for E2E coverage.
