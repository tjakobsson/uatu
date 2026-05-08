## 1. Code change

- [x] 1.1 In `src/preview.ts`, add `suppressErrors?: boolean` to the `run` field of the local `MermaidRuntime` type.
- [x] 1.2 In `src/preview.ts`, change the call at line 40 to `await mermaid.run({ nodes, suppressErrors: true })`.

## 2. Regression test

- [x] 2.1 In `src/preview.test.ts`, add a test under the existing `renderMermaidDiagrams` describe block that:
  - sets up a container with two `.mermaid` divs (one with valid source, one with bogus source like `flowchat LR; A-->B;`).
  - mocks `globalThis.mermaid` so `run` reads its `suppressErrors` option, inserts a stub error SVG into the bogus node and a stub OK SVG into the valid node, and resolves.
  - asserts `await renderMermaidDiagrams(...)` does not reject.
  - asserts `run` was called with `suppressErrors: true`.
  - asserts both nodes have an `<svg>` child after the call.

## 3. Verify

- [x] 3.1 Run `bun test src/preview.test.ts` and confirm all tests pass.
- [x] 3.2 Manually reproduce the original bug: start the dev server, open a document with a Mermaid block, edit `flowchart` to `flowchat`, and confirm no Bun unhandled-rejection overlay appears and the rest of the preview renders.
- [x] 3.3 Restore the typo and confirm the diagram renders again on the next save.
