## Context

Today's AsciiDoc pipeline (`src/asciidoc.ts`) treats `[mermaid]` and `[source,mermaid]` very differently:

- `[source,mermaid]` → Asciidoctor emits `<pre class="highlight"><code class="language-mermaid" data-lang="mermaid">…</code></pre>`. The post-render `normalizeAsciidoctorListings` regex rewrites that to `<pre><code class="language-mermaid">…</code></pre>`, sanitize preserves the `language-mermaid` class, and the client-side `replaceMermaidCodeBlocks` (in `src/preview.ts`) converts it to `<div class="mermaid">…</div>` for Mermaid to render.
- `[mermaid]` → Asciidoctor emits `<pre>…</pre>` with **no language hint**. Nothing in the pipeline can recover the block-style intent from the HTML, so the block renders as literal preformatted text.

The current `mermaid-rendering` spec asserts this asymmetry as a deliberate GitHub-parity decision. This change reverses that.

## Goals / Non-Goals

**Goals:**
- `[mermaid]` and `[source,mermaid]` produce identical Mermaid diagrams in the preview.
- Downstream pipeline (sanitize, fullscreen viewer, theme application, per-block error tolerance) reuses the existing code paths unchanged — no new code on the client.
- The implementation hooks at the layer Asciidoctor itself documents for diagram blocks, not at HTML post-processing.

**Non-Goals:**
- Adding support for other diagram block styles (`[plantuml]`, `[graphviz]`, `[ditaa]`). Out of scope.
- Server-side rasterization (Asciidoctor Diagram's PNG/SVG output mode). uatu's renderer stays client-side via `mermaid.js`.
- Changing how `[source,mermaid]` renders. Existing files keep working.
- Surfacing a fallback message on unsupported diagram block styles. Separate UX concern.

## Decisions

### Decision 1: Use an Asciidoctor block processor extension

Asciidoctor.js exposes `Extensions.create()` → `.block()` → `.named("mermaid")` + `.onContext([...])` + `.process(...)`. The processor receives the block's reader and returns a freshly built AST node. We register one such processor that intercepts blocks with style `mermaid` and replaces them with a synthetic listing block tagged as `source`/`mermaid` — the same shape `[source,mermaid]` parses into.

**Alternatives considered:**

- **Regex pre-process the `.adoc` source** before passing to `Asciidoctor.load()`, rewriting `[mermaid]\n----\n…\n----` to `[source,mermaid]\n----\n…\n----`. Rejected: brittle against delimited-block variations (`....`, `--`, leading attributes, conditionals, attribute substitution in the block style name), and it operates on raw source which is the wrong layer.
- **HTML post-process** the Asciidoctor output, looking for some discriminator on `[mermaid]` blocks. Rejected: Asciidoctor strips the block-style attribute from the rendered HTML; there is no reliable discriminator. We could attach a `role` via a tree processor, but at that point a block processor is strictly simpler.

### Decision 2: Emit a parsed listing block, not raw HTML

The processor calls `this.createBlock(parent, "listing", lines, { style: "source", language: "mermaid" })`. Asciidoctor then renders that block exactly as a `[source,mermaid]` block — same `<pre class="highlight"><code class="language-mermaid">…</code></pre>` HTML. The existing `normalizeAsciidoctorListings` regex, sanitize allowlist, and client-side `replaceMermaidCodeBlocks` apply with **zero changes**.

**Why not emit raw HTML directly:** It would mean a second code path that produces the listing shape, increasing the test surface and risking divergence with `[source,mermaid]`. The whole point of going through `createBlock` is that there is exactly one shape downstream.

### Decision 3: Build the extension registry once at module load

`asciidoctor.ts` already holds `const asciidoctor = Asciidoctor();` as a module singleton. We add an analogous module-level registry built once:

```ts
const extensionRegistry = asciidoctor.Extensions.create(function () {
  this.block(function () {
    this.named("mermaid");
    this.onContext(["listing", "literal", "open"]);
    this.process(function (parent, reader) {
      return this.createBlock(parent, "listing", reader.getLines(), {
        style: "source",
        language: "mermaid",
      });
    });
  });
});
```

…and pass `extension_registry: extensionRegistry` in the `asciidoctor.load()` call.

**Why not per-render registry:** The block processor is referentially transparent and stateless. Per-render instantiation costs allocations per preview render with no isolation benefit. (Asciidoctor extensions only mutate the document being parsed.)

**Why `onContext(["listing", "literal", "open"])`:** Authors might write `[mermaid]` above either `----` (listing), `....` (literal), or `--` (open) delimiters. The Asciidoctor Diagram extension itself accepts all three; matching its surface keeps muscle memory portable.

### Decision 4: Scope to mermaid only

Other diagram block styles (`[plantuml]`, `[graphviz]`, `[ditaa]`) continue to render as literal blocks. Adding them would require either bundling additional client-side renderers (currently uatu ships only `mermaid`) or shipping an explicit "this diagram type isn't supported" placeholder. Both are scope expansions worth a separate change.

## Risks / Trade-offs

- **Behavior change for existing `.adoc` files using `[mermaid]`**: Files that previously rendered the block as preformatted source text (perhaps unintentionally) now render it as a diagram. If the contents are not valid Mermaid, the per-block error tolerance requirement in the current spec means the failing block shows Mermaid's inline error indicator instead of literal text. → Mitigation: call this out in the CHANGELOG entry for the change. No silent breakage because the rest of the document continues to render.
- **Asciidoctor extension API surface**: We're now depending on `Asciidoctor.Extensions.create` / `block` / `createBlock`. These are part of Asciidoctor.js's stable public API (Asciidoctor Diagram and many downstream extensions use the same surface). → Mitigation: pin to the existing `@asciidoctor/core` major; surface a single small test asserting `[mermaid]` produces a `language-mermaid` listing, which would catch any regression on upgrade.
- **Sanitize allowlist drift**: The new path produces HTML byte-identical to `[source,mermaid]`'s, so the existing allowlist applies. No new sanitize-bypass surface. → No mitigation needed.
- **Source-highlighter interaction**: uatu does not set a `source-highlighter` document attribute (it post-processes via `highlightCodeBlocks`), and `highlightCodeBlocks` has a `language === "mermaid"` early-return at `src/markdown.ts:99`. So the synthetic listing's `language-mermaid` survives the highlight pass untouched. → No risk; mentioned here so it's not re-investigated later.

## Migration Plan

- No data migration. No user-facing config flag. Existing `[source,mermaid]` files are unaffected.
- CHANGELOG entry under the next release noting the new behavior and the spec reversal.
- The archived `mermaid-rendering` spec gets one scenario removed and one requirement broadened (handled by the specs/ delta in this change).
