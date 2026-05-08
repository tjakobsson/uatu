## Why

When a watched document contains a Mermaid block with invalid syntax (e.g., a typo like `flowchat` instead of `flowchart`), `mermaid.run()` rejects and the rejection bubbles up through `renderMermaidDiagrams` → `applyDocumentPayload` → `loadDocument` callers that fan it out as `void`. In dev this surfaces as Bun's red "Unhandled Promise Rejection" overlay covering the preview; in production callers it silently aborts the rest of the document apply step. Users editing diagrams hit this every time their syntax is mid-edit, which makes authoring diagrams in the preview unusable.

## What Changes

- Tell Mermaid to log render errors instead of throwing, and let it keep its inline error indicator for the failing diagram so the rest of the preview continues to render.
- Tighten the `MermaidRuntime` type so the option is part of the `run` signature.
- Add a regression test covering a failing diagram in a batch of nodes — the promise resolves, other diagrams still render.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `document-watch-browser`: extend the existing "Render Mermaid diagrams from fenced code blocks" requirement with behavior for invalid diagram source — render the rest of the preview, surface the error inline at the failing diagram, never throw an unhandled rejection.

## Impact

- `src/preview.ts` — `renderMermaidDiagrams` call to `mermaid.run` and the local `MermaidRuntime` type.
- `src/preview.test.ts` — new regression test.
- No API surface changes; no dependency changes (Mermaid 11 already supports the option).
- Affects every preview render path that contains Mermaid blocks (Markdown fenced `mermaid` and AsciiDoc `[source,mermaid]`).
