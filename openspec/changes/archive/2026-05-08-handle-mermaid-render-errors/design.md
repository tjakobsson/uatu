## Context

`renderMermaidDiagrams` (src/preview.ts:16) calls `mermaid.run({ nodes })`, which by default rejects on the first parse failure it hits. In the watch loop the rejection bubbles through `applyDocumentPayload` (src/app.ts:1316) and the many `void loadDocument(...)` callers, and surfaces in dev as Bun's red unhandled-rejection overlay covering the preview. Mermaid 11 (already pinned in package.json: `^11.14.0`) accepts `suppressErrors: true` on `run()`, which logs the error to the console and renders Mermaid's own inline error indicator (the "syntax error" SVG) for the failing node while continuing through the rest of the batch.

## Goals / Non-Goals

**Goals:**
- Editing a Mermaid diagram with mid-edit invalid syntax never produces an unhandled promise rejection.
- One bad diagram does not block other diagrams in the same document from rendering.
- The user can see *that* the diagram failed at the diagram's own location in the preview, without leaving the preview pane.

**Non-Goals:**
- Designing a custom error UI for failed diagrams. Mermaid's built-in syntax-error SVG is acceptable; the preview already crops oversize diagrams via the existing sizing rules.
- Changing the global unhandled-rejection handler in `app.ts`. The fix targets the source. (We can revisit a defensive top-level handler separately if other render paths show the same shape.)
- Pre-validating the diagram source ourselves with `mermaid.parse` before rendering — adds latency and duplicates `run`'s own parser.

## Decisions

**1. Use `mermaid.run({ nodes, suppressErrors: true })`, not a `try/catch` around the call.**

A `try/catch` would catch the rejection but mermaid still aborts the whole batch on the first bad node — every later diagram in the document would silently disappear. `suppressErrors: true` is the API mermaid exposes specifically for this: errors are logged, the bad node gets the syntax-error SVG, and the loop continues. This is exactly the behavior we want, with no custom error-UI plumbing.

Alternatives considered:
- *Wrap each node in its own `mermaid.run({ nodes: [node] })`*: rejected — slow (re-enters mermaid's pipeline per node), and the per-call init/teardown pattern fights `lastThemeInputs` caching.
- *Pre-call `mermaid.parse(source, { suppressErrors: true })` per node and skip nodes that return `false`*: rejected — duplicates parsing work, and the `<div class="mermaid">` content is HTML-escaped, so we'd have to un-escape before parsing or reach into mermaid internals. Adds complexity for a worse outcome (no inline error indicator).

**2. Keep the `MermaidRuntime` shape as a hand-written local type, just add the new optional field.**

`MermaidRuntime` exists because we lazy-load mermaid via a `<script>` tag and mermaid's own types don't help across that boundary. We add `suppressErrors?: boolean` to the `run` signature so the call site type-checks. We don't import mermaid's types — that would pull mermaid into the type graph and undo the lazy-load motivation.

**3. Regression test asserts that a batch with one bad node still resolves and the good node still renders.**

Mock the runtime so `run` simulates `suppressErrors`-style behavior: it inserts a stub error SVG into the bad node, an OK SVG into the good node, and resolves. The test then asserts `await renderMermaidDiagrams(...)` does not reject and both nodes have SVGs after the call. We are not testing mermaid itself — we are pinning the contract that our code passes the option and tolerates partial failure.

## Risks / Trade-offs

- **Risk:** A truly broken mermaid runtime (e.g., script-load corruption) could throw before `suppressErrors` even applies, since it's a per-call option. → Mitigation: not addressed here. The `mermaidLoadPromise` already rejects cleanly when the script tag fails to load, and that path is independent of run-time parse errors. If needed later, a top-level `addEventListener('unhandledrejection', ...)` guard in `app.ts` is a small follow-up.
- **Trade-off:** Mermaid logs the parse error to `console.error`. We accept that; it's helpful while authoring and not user-visible in production. We won't suppress the log.
- **Risk:** Mermaid's inline error indicator visually replaces the diagram, so the user might not realize their *previous* render is gone. → Acceptable: the file is mid-edit, the next save renders again, and the error SVG itself reads "Syntax error in graph" which is a clearer signal than a stale render.
