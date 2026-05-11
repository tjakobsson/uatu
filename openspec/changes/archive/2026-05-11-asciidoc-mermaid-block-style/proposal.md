## Why

The AsciiDoc preview silently renders `[mermaid]` blocks as plain literal text. The current `mermaid-rendering` spec made this choice deliberately to match GitHub's limited AsciiDoc support, but `[mermaid]` is the *canonical* block style used by the upstream Asciidoctor Diagram extension — authors following the documented AsciiDoc toolchain reach for `[mermaid]` first and see nothing render. The `[source,mermaid]` form that uatu does support is semantically "syntax-highlight this as mermaid source code," repurposed for diagram rendering — workable, but not the form most AsciiDoc authors will write. uatu is a local preview tool, not a GitHub mirror; aligning with upstream AsciiDoc conventions matters more here than preserving an artifact of GitHub's renderer limitations.

## What Changes

- The preview SHALL render AsciiDoc bare `[mermaid]` blocks as Mermaid diagrams, alongside the existing `[source,mermaid]` form.
- The rendered diagrams from `[mermaid]` blocks SHALL flow through the same client-side mermaid pipeline (sizing, fullscreen viewer, theme application, per-block error tolerance).
- **BREAKING** (spec-level): Reverses the prior GitHub-parity decision. The existing scenario asserting `[mermaid]` renders as a literal block is replaced by one asserting it renders as a diagram.

## Capabilities

### Modified Capabilities

- `mermaid-rendering`: Broaden the AsciiDoc detection requirement to cover both `[mermaid]` and `[source,mermaid]`. Replace the literal-block scenario with a diagram-rendering one.

## Impact

- `src/asciidoc.ts`: Intercept `[mermaid]` blocks during AsciiDoc parsing so they emit the same tagged listing shape `[source,mermaid]` produces, letting the existing `normalizeAsciidoctorListings` and client-side `replaceMermaidCodeBlocks` pipeline handle them uniformly.
- `src/asciidoc.test.ts`: Add coverage for the bare `[mermaid]` shape — both that the normalized HTML carries `class="language-mermaid"` and that the listing body survives sanitize.
- `openspec/specs/mermaid-rendering/spec.md`: Replace one scenario, broaden one requirement statement.
- No client-side (`src/preview.ts`) changes — that layer keys on `<pre><code class="language-mermaid">`, which the AsciiDoc normalization will now produce for both forms.
- No new dependencies. No user-visible config or migration. Existing `.adoc` files using `[source,mermaid]` continue to render exactly as before.
