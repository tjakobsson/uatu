## 1. Asciidoctor block extension

- [x] 1.1 In `src/asciidoc.ts`, build a module-level `Extensions.Registry` via `asciidoctor.Extensions.create(...)` that registers a block processor named `mermaid` against contexts `["listing", "literal", "open"]`.
- [x] 1.2 The processor's `process(parent, reader)` MUST call `this.createBlock(parent, "listing", reader.getLines(), { style: "source", language: "mermaid" })` so the synthetic block renders byte-identically to a `[source,mermaid]` block.
- [x] 1.3 Pass the registry to `asciidoctor.load(...)` via the `extension_registry` option in `renderAsciidocToHtml`.

## 2. Tests

- [x] 2.1 In `src/asciidoc.test.ts`, add a test asserting that `[mermaid]` over a `----` listing produces normalized HTML containing `<pre><code class="language-mermaid">` and preserves the body verbatim through sanitize.
- [x] 2.2 Add a test asserting that `[mermaid]` over a `....` literal block produces the same normalized HTML as the `----` form.
- [x] 2.3 Add a test asserting that `[mermaid]` and `[source,mermaid]` produce byte-identical normalized HTML for the same body.
- [x] 2.4 Add a regression test asserting that an AsciiDoc literal block authored WITHOUT the `[mermaid]` style (just a bare `----` block) still renders as a literal block, not a diagram.

## 3. CHANGELOG

- [x] 3.1 Add a CHANGELOG entry under the next release noting that `[mermaid]` blocks in AsciiDoc now render as diagrams, and that this reverses the prior GitHub-parity decision.

## 4. Verification

- [x] 4.1 Run `bun test` — all `asciidoc.test.ts` and `markdown.test.ts` tests pass.
