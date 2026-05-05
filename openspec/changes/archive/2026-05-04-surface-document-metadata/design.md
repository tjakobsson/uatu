## Context

uatu's preview pipeline currently treats document-top metadata as a pipeline accident.

For Markdown, `src/markdown.ts` calls `micromark` with `gfm()` only — there is no frontmatter extension wired in. CommonMark interprets a `---` line as a thematic break, so a typical Jekyll/Hugo/Eleventy/Antora YAML frontmatter block (`---\nkey: value\n---`) renders as `<hr />` + a paragraph of raw `key: value` text + `<hr />`. The reader sees broken-looking output.

For AsciiDoc, `src/asciidoc.ts` calls `asciidoctor.convert(source, { standalone: false, … })`. With `standalone: false`, Asciidoctor parses the document header — the `:author:`, `:description:`, `:keywords:`, `:revnumber:`, `:revdate:` attributes, the optional second-line author entry, and the optional third-line revision entry — but it does not emit any HTML for them. Substitution into the body still works (`{author}` resolves), but the metadata never appears in the preview.

Both formats follow the same authoring idiom: a metadata block at the top of the file. uatu's stated rendering posture (sanitize schema "modeled on GitHub", mermaid bare-block "matches GitHub", Asciidoctor SECURE "matches GitHub") suggests we should treat that idiom as a first-class concept rather than two unrelated parser quirks. GitHub's own preview now renders YAML frontmatter as a small metadata table; AsciiDoc rendering on GitHub surfaces the title and author/revision in similar contexts. Today uatu does neither — and the two failure modes have different shapes (visible garbage vs invisible silence), which masks that the underlying problem is one shared concept.

The preview already passes all rendered HTML through `hast-util-sanitize` with a GitHub-modeled allowlist. Whatever surface we build for metadata must reuse that allowlist so the security posture stays consistent.

## Goals / Non-Goals

**Goals:**

- Stop rendering Markdown YAML/TOML frontmatter as `<hr />` + body text.
- Make AsciiDoc header attributes, author line, and revision line visible to the reader.
- Present extracted metadata through one shared surface — a "metadata card" — so authors and reviewers see a consistent shape regardless of source format.
- Keep the existing security posture: every metadata value reaches the DOM as escaped text or via the same sanitize allowlist that already governs body HTML.
- Add a `testdata/watch-docs/metadata/` fixture matrix that exercises the well-formed, malformed, and absent cases for both formats so regressions are caught.

**Non-Goals:**

- Editing or writing back metadata. uatu is a watch UI; this change is read-only surfacing.
- Validating metadata against a schema (e.g. JSON-schema). We display what the author wrote.
- Parsing dates into a canonical format. We display the string verbatim.
- Resolving cross-document metadata references (e.g. linking to a doc by `id`).
- Supporting MDX, Org-mode, reStructuredText, or any format outside the two render pipelines we already operate.
- Migrating the existing `:toc:` / `showtitle` AsciiDoc behavior — those continue to work as before.

## Decisions

### Metadata extraction is a parser-level concern, not a regex pass

For Markdown we add `micromark-extension-frontmatter` (YAML + TOML) to the existing micromark pipeline. The extension is part of the same ecosystem we already depend on (`micromark-extension-gfm`), it parses the frontmatter delimiters out of the token stream so the body parse is no longer corrupted by the leading `---`, and the YAML/TOML payload is then parsed by the canonical `yaml` package (for `---`) or a small inline parser (for `+++`). Real-world frontmatter routinely contains nested mappings, multi-line strings, and quoted scalars; using `yaml` instead of a hand-rolled parser handles those without each new edge case requiring code changes. Nested mappings flatten into dot-notation keys (`metadata.author`, `metadata.version`) so the metadata card stays a flat key/value surface.

For AsciiDoc we switch from `asciidoctor.convert(...)` to `asciidoctor.load(...)` followed by `doc.convert()`. `load(...)` returns the parsed `Document` model, from which we read `getDocumentTitle()`, the numbered `author_N` / `email_N` attribute family, `getRevisionNumber()`, `getRevisionDate()`, `getRevisionRemark()`, and `getAttributes()`. The body HTML is produced by `doc.convert()` — byte-identical to what `convert()` produces today, since that's how `convert()` is implemented internally.

**Alternative considered:** regex-strip the metadata before handing the body to the renderer. Rejected — fragile against authoring variations (TOML, indented YAML, AsciiDoc continuation lines) and re-implements parsing the renderers already do.

### Metadata is normalized into a curated shape, not passed through raw

We define a single `DocumentMetadata` type that both pipelines populate:

```ts
type DocumentMetadata = {
  title?: string;
  authors?: Array<{ name: string; email?: string }>;
  date?: string;          // verbatim — no Date parsing
  revision?: string;      // version/revnumber/etc.
  description?: string;
  tags?: string[];        // tags or keywords, normalized
  status?: string;        // draft | published | …, free-form
  extras?: Record<string, string>;  // unknown fields, stringified
};
```

Format-specific peculiarities map onto this shape:

| Curated field | Markdown YAML | Markdown TOML | AsciiDoc           |
|---------------|---------------|---------------|--------------------|
| `title`       | `title`       | `title`       | level-0 doctitle   |
| `authors`     | `author`/`authors` | `author`/`authors` | author line + `:author:`/`:authors:` |
| `date`        | `date`        | `date`        | `:revdate:` / revision line |
| `revision`    | `version`     | `version`     | `:revnumber:` / revision line |
| `description` | `description` | `description` | `:description:`    |
| `tags`        | `tags`        | `tags`        | `:keywords:` (split on `,`) |
| `status`      | `status`      | `status`      | `:status:`         |
| `extras`      | everything else | everything else | every other `:attr:` |

**Alternative considered:** expose a generic `Record<string, unknown>` and let the UI decide. Rejected — different shapes for the two formats would push format-awareness into the UI, defeating the unified-card goal. The normalization keeps format-awareness inside the pipeline.

### The card is rendered server-side, alongside the body HTML

The renderer returns `{ html, metadata }` (and we keep the existing `language`/`title` fields). The server endpoint that produces `RenderedDocument` includes the metadata in its response. The browser composes the card from this object — it does not re-parse the document.

**Why server-side parsing**: the parsers (`micromark`, `@asciidoctor/core`) only run on the server. The browser would need its own parsers to derive metadata client-side, which would duplicate code and inflate the bundle. Reusing the server parse is free.

**Alternative considered:** render the card as raw HTML server-side and embed it in `html`. Rejected — couples the data and presentation, and makes it harder for tests to assert on metadata independently of body markup.

### Metadata is sanitized through the same allowlist used for body HTML

Every metadata value is converted to a string and passed through `escapeHtml(...)` (the helper already in `markdown.ts:108`). The card's structural HTML (the `<dl>`, `<dt>`, `<dd>`, etc.) is built from a small fixed template — no author-controlled HTML reaches the DOM unescaped. We do **not** allow author markdown inside metadata fields; a `description: "<script>"` renders as the literal text `<script>`.

**Why this posture**: matches the body-HTML sanitize posture and avoids opening a second sanitize policy for one card. If we later want light formatting in `description` we can pass that single field through the existing sanitize pipeline — out of scope here.

### The card is omitted entirely when no metadata is present

Documents without frontmatter or AsciiDoc header attributes render byte-identical body HTML and no card. This keeps the change additive: every existing fixture (`README.md`, `asciidoc-cheatsheet.adoc`, `diagram.md`, `links-demo.*`, `mermaid-shapes.md`, `guides/*`) continues to render exactly as it does today.

**Why a hard cutoff**: a card with one field looks like a glitch. Rendering only when at least one curated field OR at least one extra is present makes the surface predictable.

### TOML support is included from day one, not deferred

`micromark-extension-frontmatter` supports YAML and TOML in the same call (`frontmatter(['yaml', 'toml'])`). Adding TOML is a one-token change. Authors using Hugo or static-site setups commonly use TOML — deferring it would mean shipping a "supports frontmatter" feature that breaks for half the audience.

**Alternative considered:** YAML only. Rejected — same fixture matrix would need to grow later, same UI path, no real cost saving.

### Author/revision lines are AsciiDoc's positional metadata; we honor them

AsciiDoc allows the second line of the document to be an author entry (`Tobias Jakobsson <tobias@example.com>; Jane Doe`) and the third line to be a revision entry (`v1.2, 2026-05-04: notes`). We extract these via the document API rather than parsing them ourselves. If both attributes (`:author:`) and the positional line are present, the attribute wins — that's what Asciidoctor itself does.

### Malformed YAML/TOML degrades to "no metadata"

If `micromark-extension-frontmatter` cannot parse the block, the parser falls through and the body is rendered as if no frontmatter existed (i.e. the leading `---` again becomes a thematic break). We do not surface a parse error in the UI — uatu is a viewer, not a linter. The fixture matrix includes a malformed-YAML case to lock this in.

**Alternative considered:** show a warning banner. Rejected — false positives on legitimate `---`-delimited content (e.g. front-matter-shaped sections inside larger docs) would be more annoying than the current silent fallthrough.

## Risks / Trade-offs

- **Risk:** A document that intentionally opens with `---\nfoo\n---` as a thematic-break + heading idiom would change rendering once the frontmatter extension is enabled. **Mitigation:** the extension only treats it as frontmatter at the very start of the file and only when the closing `---` is followed by a blank line; CommonMark thematic-break shapes elsewhere in the doc are unaffected. The fixture matrix includes a "leading thematic break" case to verify the boundary.

- **Risk:** AsciiDoc files that already use `:author:` etc. for body substitution but have never been seen with metadata-card UI may suddenly grow a card the author did not anticipate. **Mitigation:** acceptable — those attributes are public document metadata in AsciiDoc semantics, and the card is visually subdued. The author can suppress fields by removing them.

- **Risk:** Keys collision — a Markdown YAML doc with a top-level `extras` key would collide with the curated shape. **Mitigation:** the curated shape is the post-normalization view; raw author keys go through normalization first. An author key called `extras` lands inside `extras.extras` (or, equivalently, is treated as an unknown field).

- **Trade-off:** TOML brings a YAML-for-the-other-tribe parser into the dependency tree. Its surface is small and isolated to the metadata block, so the blast radius is limited.

- **Trade-off:** The metadata shape is opinionated — `tags` vs `keywords`, `revision` vs `version` are normalized away. Authors who want their original key visible can rely on the `extras` map, but the *display order* will not match their source. Acceptable: the card's value is editorial, not archival.

- **Trade-off:** Asciidoctor's `load(...) + convert()` is a small overhead on top of `convert(...)` because we now hold the document model alongside the rendered HTML. Negligible at the document sizes we render (we already bypass the pipeline above 1 MB).

## Migration Plan

No data migration required. Rollout is a single code change:

1. Land parser, normalization, and renderer changes behind no flag — the change is additive and inert for documents without metadata.
2. Update unit tests (`markdown.test.ts`, `asciidoc.test.ts`, `server.test.ts`) to cover the new pipeline shape.
3. Add fixtures under `testdata/watch-docs/metadata/` and at least one E2E spec asserting the card appears for a known-good fixture and is absent for a known-empty one.
4. Update the spec deltas in `openspec/specs/document-watch-browser/spec.md`.

Rollback is a code revert; no persisted state is touched.

## Open Questions

- Should the metadata card be collapsible by default? **Resolved:** collapsed by default, using HTML5 `<details>`/`<summary>` for native disclosure semantics. The closed-state summary shows a compact teaser ("Title · Author · N fields") so the card hints at what it contains without dominating the preview.
- Should the card surface a "view source" disclosure that shows the raw frontmatter / AsciiDoc header block? Defer — out of scope for this change.
- Should `description` be allowed to contain inline Markdown/AsciiDoc formatting? Defer — start with literal text and revisit if author feedback warrants it.
