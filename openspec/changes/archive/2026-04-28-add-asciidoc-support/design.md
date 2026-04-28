## Context

uatu's existing Markdown pipeline (`src/markdown.ts`) does four things in order: parse with `micromark` + `gfm`, parse the resulting HTML to a hast tree, sanitize through a GitHub-modeled allowlist (`hast-util-sanitize`), then post-process `<pre><code class="language-X">` blocks with `highlight.js` (skipping the `mermaid` language so the client-side runtime can pick those up via `<div class="mermaid">` produced in `src/preview.ts`). The dispatch in the server simply chooses between this pipeline and a plain code-render path (`renderCodeAsHtml`) based on `DocumentKind`.

GitHub renders AsciiDoc through the [github-markup](https://github.com/github/markup) library, which delegates `.asciidoc`/`.adoc`/`.asc` to Asciidoctor running in `secure` safe mode (the API default), then sanitizes the output downstream. SECURE mode disables `include::`, filesystem reads, URI reads, and several author-controlled attributes (`source-highlighter`, `docinfo`, `backend`). GitHub also explicitly does NOT recognize the bare `[mermaid]` AsciiDoc block — it requires `[source,mermaid]`. The user has confirmed they want uatu's AsciiDoc behavior to match GitHub.

## Goals / Non-Goals

**Goals:**
- AsciiDoc rendering whose feature surface tracks GitHub's AsciiDoc preview behavior.
- Reuse the existing Mermaid pathway, the existing sanitize allowlist (with small additions), and the existing highlight.js post-pass — i.e. parallel pipelines that share their downstream stages, not a wholesale duplicate.
- Keep the change small enough to land independently of any plugin/renderer abstraction.

**Non-Goals:**
- A renderer-plugin framework. Two renderers do not justify the abstraction; we wait for a third concrete shape (e.g. JSON prettify) before extracting an interface.
- AsciiDoc `include::` support. GitHub disables it; SECURE mode disables it for free.
- STEM/math notation. GitHub doesn't render it.
- Asciidoctor's default stylesheet. GitHub strips most of the structural classes Asciidoctor relies on; we follow that posture.
- Server-side diagram extension (`asciidoctor-diagram` / `asciidoctor-mermaid`). Those pull in heavy Ruby/Puppeteer dependencies. We render Mermaid client-side as we already do for Markdown.

## Decisions

### Library: `@asciidoctor/core` (MIT)

The only credible MIT-licensed AsciiDoc-to-HTML JS library is Asciidoctor.js (`@asciidoctor/core`). Alternatives considered:
- `downdoc` — converts AsciiDoc → Markdown, wrong direction.
- Custom parser — months of work, not justified for an extension.
- Asciidoctor via a Ruby subprocess — adds a Ruby runtime dependency to the standalone binary; rejected.

`@asciidoctor/core` is the de-facto AsciiDoc engine on the JS side, ships as Opal-transpiled JS, has MIT-licensed transitive deps, and clears the existing license audit (`src/license-check.ts`) without any allowlist changes. Bundle impact (~2 MB) is rounding error against the existing ~60+ MB `bun build` output and stays out of the browser bundle since rendering is server-side.

### Safe mode: SECURE

We invoke Asciidoctor with `safe: 'secure'`. This is what GitHub uses and it lines up with uatu's existing security posture (no path traversal in static-asset serving, sanitized HTML before reaching the browser):
- `include::` directives are silently disabled.
- Filesystem and URI reads from within documents are blocked.
- Author cannot override `source-highlighter`, `docinfo`, `backend`.
- Inline/interactive SVG modes are disabled.

Practical effect: uatu does not need to write any include-resolution logic, and it does not need to defend against author-controlled attribute escapes — Asciidoctor refuses them upstream of our sanitizer.

### Output normalization strategy

Asciidoctor's listing output is `<pre class="highlight"><code class="language-X" data-lang="X">…</code></pre>`. The existing Markdown highlight pass matches `<pre><code class="language-X">…</code></pre>` (`CODE_BLOCK_PATTERN` in `src/markdown.ts:8`). Two options:

1. **Normalize before the shared pass**: rewrite Asciidoctor's listing shape into the Markdown shape before highlighting. One regex, one change to share the existing post-pass.
2. **Generalize the regex**: extend `CODE_BLOCK_PATTERN` (or add a sibling) to recognize both shapes.

We pick (1). It keeps the highlight pass single-shape and means the resulting DOM looks identical for Markdown and AsciiDoc code listings, so the existing copy control, line-numbering for non-Markdown code views, and any future code-block enrichments all apply uniformly. The "AsciiDoc-ness" of a listing isn't visible past the renderer boundary.

### Mermaid: `[source,mermaid]` only

Match GitHub. After Asciidoctor produces `<pre class="highlight"><code class="language-mermaid" data-lang="mermaid">…</code></pre>`, the AsciiDoc renderer rewrites that to `<div class="mermaid">…</div>` (the same shape Markdown produces) and skips it during the highlight pass. The existing client-side mermaid replacement in `src/preview.ts` works unchanged because both renderers deliver the same DOM shape.

The bare `[mermaid]` AsciiDoc block (no `source` style) is not matched. It renders as a literal block, exactly as GitHub does.

### Sanitize schema additions

`hast-util-sanitize`'s default schema is GitHub-modeled and already permits `class` on most block elements, so Asciidoctor's structural classes mostly survive. We extend the schema to whitelist:
- `admonitionblock`, `note`, `tip`, `important`, `caution`, `warning` on the admonition `<div>`.
- `listingblock`, `title`, `content` on listing wrappers and titles.
- `colist`, `conum` for callouts (numbered code-block references).

This is the minimum needed to style admonitions and callouts. We do not whitelist Asciidoctor's full default class taxonomy.

### CSS strategy

Match GitHub's restraint: no Asciidoctor default stylesheet. Add a small block to `src/styles.css` covering:
- Admonition tinted-box rendering keyed off `admonitionblock.note/tip/important/caution/warning`.
- Callout numbered chip rendering keyed off `conum`.
- Listing-block title styling.

Everything common (tables, headings, paragraphs, code blocks) inherits the existing GitHub-Markdown-CSS look since the structural HTML overlaps.

### Size threshold

Parallel to `SYNTAX_HIGHLIGHT_BYTES_LIMIT` (1 MB) in `src/markdown.ts`: above this size we skip Asciidoctor entirely and render as plain escaped text inside `<pre><code class="hljs">`. This keeps the browser responsive on outsized inputs and keeps Asciidoctor's parse cost off the request hot path for pathological cases. The constant lives next to the existing one or is shared.

### Single-file watch and DocumentKind

`DocumentKind` becomes `"markdown" | "asciidoc" | "text" | "binary"`. Classifier extension is mechanical: adding `.adoc` and `.asciidoc` to a fast-path before the text/binary checks, mirroring the existing `isMarkdownPath` shortcut. `uatu watch foo.adoc` flows through the existing single-file scope code unchanged.

### Deliberate divergence from GitHub on `.asc`

GitHub's [github-markup](https://github.com/github/markup/blob/master/lib/github/markups.rb) registers `.asc` for AsciiDoc rendering (regex `/adoc|asc(iidoc)?/`). uatu does **not**. The `.asc` extension is overwhelmingly used for PGP ASCII-armored content — release signatures, public keys, clearsigned messages — and the AsciiDoc project itself recommends against using `.asc` for AsciiDoc files because of the conflict. In a watcher context the cost of getting this wrong is high: a `release-1.0.tar.gz.asc` signature run through Asciidoctor would render as a paragraph of escaped armor text, which is worse than the plain-text fallback uatu already produces for unknown text. Authors who genuinely use `.asc` for AsciiDoc can rename to `.adoc` (the community recommendation anyway). Reconsider this decision if a user reports the divergence as a real problem.

## Risks / Trade-offs

- **Asciidoctor.js performance** → micromark renders a 100 KB Markdown file in single-digit ms; Asciidoctor.js is meaningfully slower because it's an Opal-transpiled Ruby VM. **Mitigation**: 1 MB cutoff to plain-text fallback; rendering is server-side and synchronous to a request, so latency lands on a single user's preview, not a hot loop. Parallel-pipeline design also means the Markdown happy path is unchanged.
- **Sanitize allowlist drift** → adding admonition/callout classes risks the next Asciidoctor update emitting new structural class names that we don't whitelist, leaving them un-styled. **Mitigation**: tests pin the structural shape (one E2E with an admonition, one with a callout) so silent regressions become loud.
- **GitHub parity edge cases** → GitHub's downstream sanitizer is more aggressive than ours; some constructs (e.g. STEM blocks, sidebars) render thinly on GitHub and may render differently in uatu. **Mitigation**: explicitly out-of-scope in the proposal; document as known divergence rather than chase parity into a moving target.
- **Standalone binary size** → +~2 MB for Asciidoctor.js + Opal runtime. **Mitigation**: acceptable; the binary is already large and Asciidoctor.js is needed at runtime, not compile-time.
- **Future plugin abstraction** → committing to a parallel switch now means the third renderer (e.g. JSON prettify) likely triggers a small refactor of the dispatch site. **Mitigation**: extract the dispatch into a single named function (`renderForKind`) when adding the AsciiDoc branch, even though the body is still a switch — the future refactor becomes a body change inside one call site.
- **Ifdef/ifndef behavior** → GitHub supports the `ifdef`/`ifndef` directives. Asciidoctor.js supports them out of the box; no extra work, but worth a smoke test in `asciidoc.test.ts`.

## Migration Plan

This is additive. No removal of existing behavior, no schema migration. Rollout is a single PR on the `add-asciidoc-support` branch:

1. Land `@asciidoctor/core` dependency, confirm `bun run check:licenses` still passes.
2. Land the AsciiDoc render module + tests behind no flag (no risk of activation: AsciiDoc files were classified as `text` before, will be classified as `asciidoc` after).
3. Land the dispatch and chip changes.
4. Land minimal CSS for admonitions/callouts.
5. Add E2E fixture under `testdata/` that exercises an AsciiDoc README with code, admonition, and mermaid listing.

Rollback is a single revert.

## Open Questions

- Whether to fold the `SYNTAX_HIGHLIGHT_BYTES_LIMIT` constant into a shared `render-limits.ts` or duplicate it. Tasks should make the cosmetic call at implementation time.
- Whether to expose Asciidoctor's `attributes` map at all (e.g. setting `icons=font`). GitHub uses default attributes only. Recommend: leave attributes empty for v1, revisit if author feedback wants e.g. caption configuration.
