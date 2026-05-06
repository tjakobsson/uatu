## Context

UatuCode renders documents through three pipelines:

- `src/markdown.ts` — Markdown → HTML, no source-line annotations
- `src/asciidoc.ts` — AsciiDoc → HTML, no source-line annotations
- the source / text path that produces a single `<pre><code>` block with the line-number gutter at `src/app.ts:1393`

Of these, only the source path preserves a clean DOM ↔ source-line mapping: each `\n` in `code.textContent` is a real source line, and `attachLineNumbers` already creates a visible gutter that matches.

The first slice of UatuCode's "talk to AI coding agents" surface needs to capture selections as **path + line range** identifiers in Claude Code's at-mention syntax (`@<path>#L<a>-<b>`), the same shape claudecode.nvim emits from a Neovim visual selection. To produce that identifier from a browser selection over Markdown / AsciiDoc, the system needs source-line information that the rendered HTML does not carry.

Two architectural paths were considered:

1. Annotate the Markdown / AsciiDoc render pipelines with `data-source-line` attributes on block-level elements (markdown-it and the asciidoc pipeline both expose source positions during parsing). Walk up from the selection to the nearest annotated ancestor for the line number. Adds a render-pipeline change to two files and still leaves edge cases (rendered images without source positions, metadata cards, multi-block selections, nested fenced code blocks).
2. Add a per-document **Source / Rendered** view toggle. Source view feeds the existing source-rendering pipeline for *any* file kind. The selection inspector then operates exclusively against the source-view DOM, where line counting is exact and uniform.

This change takes path 2. It is less code, keeps the render pipelines clean, makes the line-counting logic uniform across all file kinds, and the toggle is independently useful as a "show me the raw source" affordance.

A prior pass on this change (still on the branch) implemented a text-dump version of the pane without the toggle. That implementation produced reusable infrastructure (Review-only pane registration, Author-mode hidden behavior, `selectionchange` listener pattern, document-swap recompute hook, persistence wiring) but the captured shape (`{ path, text }`), the pane's display, and the lack of click-to-copy / view-mode toggle all need to be redone. This design treats that work as scaffolding to refactor.

## Goals / Non-Goals

**Goals:**
- A per-document Source / Rendered toggle that hides itself for files with no rendered alternative, persists globally, and renders the source via the existing `<pre><code>` + gutter scheme.
- A Review-mode-only Selection Inspector pane that captures `{ path, startLine, endLine }` from Source-view selections and copies a Claude-Code-style at-mention reference to the clipboard on click.
- A discoverable Rendered-view hint that flips to Source on click — surfacing the line-capture flow to users who only ever click "Selection Inspector" and don't know the toggle exists.
- Same Review-only / Author-hidden / pane-state-persistence story as the prior pane-only design.

**Non-Goals:**
- No `data-source-line` annotations on the Markdown / AsciiDoc render pipelines. The toggle replaces this entirely.
- No agent-protocol bridge (Claude Code IDE lock-file, opencode, MCP). Stage 2.
- No alternative reference formats. Claude format only for v1.
- No keyboard shortcut to capture, send, or copy. Click + native keyboard activation are the only interactions.
- No column precision. Lines only.
- No per-document view-mode preference. One global preference.
- No CLI override (`--view=source`) at startup. Easy follow-up if useful.
- No source-view rendering for non-document previews (commit, review-score, empty).

## Decisions

### Decision 1: Source / Rendered toggle is a two-segment control in the preview header
Visually and behaviorally parallel to the existing Mode toggle (`#mode-control` at `src/index.html`). Two segments labeled "Source" and "Rendered". The toggle's wrapping container is `[hidden]` when the active preview kind cannot be source-toggled — non-document preview kinds (`commit`, `review-score`, `empty`) and documents already source-only.

**Alternatives considered:** A floating button in the preview body (more visible but adds chrome); a chip-button like Follow (single-state, less obvious for a binary choice). Two-segment matches Mode's precedent.

### Decision 2: View-mode preference is global and persisted
One `localStorage` key (`uatu:view-mode`), value `"source" | "rendered"`, defaulting to `"rendered"`. Read once at boot, mutated on each toggle, applied to every document load. Mirror the Mode and Follow precedents (`writeModePreference` / `readModePreference` in `src/shared.ts`).

**Alternatives considered:** Per-document preference (more flexible but adds storage complexity and the question "what about documents I haven't visited yet?"); per-mode preference (tied to Author/Review — but a user wanting Source view is a function of *what they're doing*, not a function of which Mode they're in). Keep it simple for v1.

### Decision 3: Source view delegates to the existing source-rendering pipeline
The server-side document-render endpoint is extended with a `view` parameter (`view=source` | `view=rendered`, default `rendered`). When `view=source`, the server returns a payload whose `html` field is a `<pre><code>` block of the file's verbatim text with kind-specific syntax highlighting (the same path used today for text files, generalized to apply for any file kind on request). The client mounts that into `#preview` and calls the existing `attachLineNumbers` to produce the gutter.

**Alternatives considered:** A sibling endpoint (`/api/document/source`); fetching the raw bytes and rendering client-side with a syntax highlighter. Extending the existing endpoint keeps the client's fetch logic uniform and reuses the server's existing highlighter — a single bidirectional dispatch on `view` rather than two parallel code paths.

### Decision 4: Toggle does not refetch when both views are already cached client-side
Keep both representations in a small per-document cache so flipping the view is instantaneous (no network roundtrip, no "Document unavailable" flash). On document swap, drop the cache. This is a small in-memory map keyed by document id, value `{ source?: payload; rendered?: payload }`.

**Alternatives considered:** Always refetch on toggle (simpler but introduces a flash); cache forever (memory leak risk on long sessions). Document-id-keyed with drop-on-swap is the middle ground.

### Decision 5: The whole-file source-view `<pre>` carries a distinguishing class
`pre.uatu-source-pre` (or equivalent), set by the server in the source-view payload, NOT applied to fenced code blocks rendered inside Markdown / AsciiDoc body content. The Selection Inspector uses this class as the single membership check that simultaneously enforces "selection is inside the preview", "selection is inside a code element", and "selection is inside the *whole-file* source — not a fenced block".

**Alternatives considered:** Marker via id (only one element per page, but the inspector code is cleaner if it can use `closest()` over a class); marker via data attribute (works but classes are easier to style and inspect).

### Decision 6: Line counting walks the DOM from the source-`<pre>` to the selection's start/end
For a given Range, compute startOffset / endOffset relative to the whole-file `code` element by walking from `code` and summing `textContent.length` of each preceding child plus the offset within the start/end node. Then `startLine = (count of \n in code.textContent.slice(0, startOffset)) + 1` (1-indexed), same for endLine.

A subtle case: a selection that ends *exactly at* the start of a new line (i.e., immediately after a `\n`) should report endLine as the previous line, not the new one. Match the convention claudecode.nvim uses — endLine is inclusive of the last visible character of the selection, not the newline that follows.

**Alternatives considered:** Use `Range.getBoundingClientRect()` and pixel-mapping. Rejected — fragile, no standard API for "which source line is at this y-coordinate" without a DOM walk anyway.

### Decision 7: Reference format collapses single-line ranges
- Multi-line: `@<path>#L<startLine>-<endLine>`
- Single-line (startLine === endLine): `@<path>#L<startLine>`

Mirrors claudecode.nvim. The path is the document's path relative to the watched root (the same path shown in `#preview-path` in document mode).

### Decision 8: Click-to-copy uses navigator.clipboard.writeText with a fallback
`navigator.clipboard.writeText` is the primary path. Localhost is a secure context so this works in dev. A defensive fallback (hidden `<textarea>` + `document.execCommand('copy')`) covers cases the API is unavailable. Visual confirmation: the button's text or label briefly switches to "Copied" for ~1 second.

The reference is rendered as a `<button>` (semantic + keyboard-accessible). Click and Enter / Space all trigger the copy.

### Decision 9: The pane has three render states sharing one container
- `placeholder`: "No selection"
- `hint`: "Switch to Source view to capture a line range." (button)
- `reference`: `@<path>#L<a>-<b>` (button, with copied confirmation)

One container, one state machine, swap textContent + click handler + role based on state. Avoids three parallel hidden DOM trees.

### Decision 10: Pane stays Review-only (unchanged from the prior design)
Author's Follow auto-switches the active preview, which would routinely yank captures regardless of view mode. Source view doesn't fix this — it just changes how the file is rendered, not whether the active document gets swapped from under the user. Pane stays Review-only.

### Decision 11: View-mode flip and document swap both trigger an inspector recompute
Toggling between Source and Rendered replaces the preview body's DOM, which destroys any in-progress selection. Same for document swap. The inspector's `recompute()` is called from both hooks (the existing document-load hook plus a new view-mode-toggle hook). The inspector's state machine evaluates against the new DOM and produces the right state — placeholder, hint, or reference.

### Decision 12: The inspector module owns the state machine (placeholder / hint / reference)
The pane's render code subscribes to a single state value from the inspector module. The module decides the state based on:
- preview mode (document vs other)
- active view mode (source vs rendered)
- presence of a selection
- whether the selection's commonAncestor is contained by the whole-file source `<pre>`

Centralizing this in the module keeps the pane render trivial (one render function, three branches) and makes the unit tests target the decision logic directly.

## Risks / Trade-offs

- **Risk: server-side source-rendering of large Markdown / AsciiDoc files** could be slow if the highlighter is heavy. → Mitigation: source view runs the same syntax-highlighter path the existing text-file rendering uses; performance characteristics are already known. If profiling shows a problem, add server-side caching keyed by `(documentId, mtime)`.
- **Risk: switching Source ↔ Rendered while the user is mid-selection feels disorienting**. → Mitigation: documented behavior — the toggle is an explicit user action and the pane updates accordingly. No surprise.
- **Risk: clipboard write fails silently** if the browser denies permission or lacks the API. → Mitigation: textarea + execCommand fallback; localhost target avoids most of the constraint.
- **Risk: the Rendered-view hint is noisy** for users who never want to use Source view. → Mitigation: the hint only appears when there *is* a selection; it does not appear in the placeholder state. Users who don't select text never see it.
- **Trade-off: global view-mode** means a user wanting Markdown rendered + TypeScript source-viewed can't have both at once. → Accepted for v1. Per-document preference is a clean follow-up.
- **Trade-off: Claude-Code-only reference format** locks early users into one syntax. → Accepted for v1. Multi-format "Copy as…" is a clean follow-up; getting one format right first is more important than choosing among three.
- **Trade-off: caching both Source and Rendered representations client-side** doubles the per-document memory footprint while a doc is open. → Accepted; payloads are small (HTML + metadata), and the cache drops on document swap.

## Open Questions

- Should the Source-view payload include a flag indicating the file's "natural" view kind (so the client knows whether to *show* the toggle), or should the client infer that from the document metadata it already has? Likely the latter — `DocumentMeta` already carries enough info to decide. Confirm during implementation.
- Should the "Copied" feedback include an aria-live announcement for screen readers? Probably yes; trivial to add.
- For documents with very long lines (e.g., minified JSON), the `<pre><code>` source view will be wide — the existing wrap behavior may need a quick check. Not blocking.
