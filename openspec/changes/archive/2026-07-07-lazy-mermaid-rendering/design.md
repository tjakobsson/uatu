## Context

`applyDocumentPayload` mounts the HTML, then `await renderMermaidDiagrams(previewElement, …)` runs `mermaid.run({ nodes })` over every `.mermaid` node in one batch (`src/preview/mount.ts:171-178`, `src/render/preview.ts:16-48`). Measured on the 42-diagram benchmark fixture: ~0.5 s in Chromium, ~2.3 s in WebKit (Safari), fully main-thread, re-paid on every document revisit. Mermaid renders synchronously per diagram and measures SVG text via `getBBox`, which is where WebKit loses.

Existing behavior to preserve (spec `openspec/specs/mermaid-rendering/spec.md`): sizing/centering normalization (`normalizeRenderedDiagram`), the fullscreen-viewer trigger wrapper, `securityLevel: "strict"`, `suppressErrors` tolerance for invalid diagrams, and theme re-initialization when theme inputs change.

## Goals / Non-Goals

**Goals:**

- Mount-to-interactive for diagram-heavy documents ≈ the mermaid-free baseline; diagrams fill in progressively without freezing the page.
- Revisits and view toggles reuse already-rendered SVGs (no re-parse, no re-layout) when source and theme are unchanged.
- No scroll jumps from late-arriving diagrams; fragment navigation still lands correctly.

**Non-Goals:**

- No Web Worker / OffscreenCanvas mermaid execution (mermaid is DOM-bound).
- No server-side mermaid pre-rendering.
- No change to the fullscreen viewer, theme mapping, or the strict security level.
- No persistent (localStorage) SVG cache — in-memory per session only.

## Decisions

### D1: IntersectionObserver with a generous root margin drives rendering

One observer per preview mount watches all placeholder nodes with `rootMargin: "50% 0px"` (half a viewport ahead in both directions). On intersection the node enters the render queue and is unobserved. Above-the-fold diagrams intersect immediately on the first observer callback, so the visible-first experience matches today minus the freeze. Fallback when `IntersectionObserver` is unavailable: render all nodes through the same queue (yielding still prevents the single big freeze).

### D2: A single FIFO render queue with a frame yield between diagrams

All intersecting nodes flow through one queue that renders **one diagram per pass** (`mermaid.run({ nodes: [node] })`) and yields a `requestAnimationFrame` between passes. Per-diagram cost stays (mermaid is synchronous per diagram) but the browser paints and handles input between diagrams. The queue is generation-tagged per mount: a document switch mid-drain abandons stale entries (mirrors the generation guard pattern from the diff loading signal in [#108](https://github.com/tjakobsson/uatu/pull/108)).

### D3: In-memory SVG cache keyed by `(source text, theme inputs)`

Before invoking mermaid for a node, look up the trimmed diagram source + serialized theme inputs in a `Map<string, string>` of rendered SVG markup (post-`normalizeRenderedDiagram`, pre-trigger-wrap). Hit → clone the SVG into the node and wrap with the trigger, skipping mermaid entirely. Miss → render, then store. Cap at ~200 entries with insertion-order eviction (a Map is already insertion-ordered). Theme changes naturally miss (key includes theme); invalid-diagram error nodes are NOT cached (a live-reload fixing the source must re-render).

*Alternative rejected*: caching keyed by document id — breaks on live-reload edits to sibling diagrams and misses cross-document duplicate diagrams (common in docs trees).

### D4: Placeholders reserve space and carry the source

`replaceMermaidCodeBlocks` keeps emitting `<div class="mermaid">source</div>`; CSS gives un-rendered `.mermaid` nodes a `min-height` (~140 px, roughly mermaid's fallback intrinsic size) plus a subtle "diagram" affordance so the slot is visibly pending rather than broken. Exact-height reservation is impossible pre-render (mermaid decides size); the generous observer margin means diagrams are normally rendered by the time they reach the viewport, making residual layout shift rare and small.

### D5: Fragment navigation renders through the queue, not around it

`scrollToFragment` scrolls first; scrolling moves the observer window, which enqueues the revealed diagrams. The ~140 px min-height keeps anchor positions approximately right before render; after the queue drains the revealed region, positions settle. No special-case "render everything above the anchor" pass — the margin + placeholder sizing keeps error small, and the existing scroll-padding tolerances absorb it.

### D6: `renderMermaidDiagrams` keeps its signature; mount stops awaiting completion

The function becomes "install lazy rendering for this container" and resolves once observation is set up (not when all diagrams are done). `mount.ts` semantics change from "await all diagrams" to "diagrams stream in" — callers that need completion (tests) get an exported `__drainMermaidQueueForTests()` awaiting queue quiescence.

## Risks / Trade-offs

- [Layout shift when a rendered diagram's height differs from the placeholder] → generous 50% root margin renders ahead of the viewport; min-height absorbs the common small-diagram case; shift only occurs off-screen or at fast-scroll edges.
- [E2E tests assume diagrams exist right after mount] → tests updated to wait for the specific diagram's SVG (Playwright auto-waiting) or call the drain helper; assertions on diagram *content* are unchanged.
- [Cache staleness if mermaid output depends on ambient state beyond theme] → key includes the full theme-input serialization; mermaid config is otherwise fixed (`securityLevel: "strict"`); initialize() is still re-run on theme change before any render.
- [Observer + queue adds moving parts to a previously linear flow] → both live in `src/render/preview.ts` behind the existing `renderMermaidDiagrams` entry point; unit tests cover queue ordering, generation abandonment, and cache keying in isolation.
- [WebKit still pays ~55 ms per diagram when it eventually renders] → accepted: amortized over scrolling with paint yields between, which is the difference between "slow-ish diagram pop-in" and "frozen tab".

## Open Questions

- Placeholder min-height default (140 px) — tune against the fixture during implementation; not spec-level.
- Whether `mermaid.e2e.ts` needs a dedicated lazy-specific test (scroll-triggered render) or the drain helper suffices — decide while updating the suite.
