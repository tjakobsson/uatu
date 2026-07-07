## Why

Opening a diagram-heavy document freezes the preview while mermaid renders **every** diagram in one main-thread batch on mount (`renderMermaidDiagrams` at `src/preview/mount.ts:178`). Measured on `testdata/render-benchmarks/markdown-large.md` (42 diagrams) via Playwright: mermaid accounts for ~0.5 s of mount in Chromium and **~2.3 s in WebKit/Safari** (2700 ms vs 434 ms with mermaid stubbed) — mermaid's layout leans on SVG text measurement, a known WebKit weak spot. The cost recurs on every revisit because the per-selection cache clear re-renders all diagrams, and none of it is visible in the network panel — this is the Safari slowness reported after the diff-latency work landed in [#108](https://github.com/tjakobsson/uatu/pull/108).

## What Changes

- **Viewport-lazy rendering**: diagrams render when they approach the viewport (IntersectionObserver with a generous margin), not all at mount. Off-screen diagrams cost nothing until scrolled toward; a placeholder occupies the slot meanwhile.
- **Yielding pipeline**: multiple diagrams becoming visible at once render one at a time with a frame yield between them, so the page never freezes for a whole batch.
- **Client-side SVG cache** keyed by (diagram source, theme): revisiting a document, toggling views, or a live-reload that didn't touch a diagram's source reuses the rendered SVG instead of re-paying mermaid.
- **Stable placeholders**: un-rendered diagram slots reserve space (intrinsic-size hint) so lazy rendering does not cause scroll jumps.
- Anchor/fragment navigation to a position below un-rendered diagrams still lands correctly (render-on-reveal integrates with the existing scroll-to-fragment flow).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `mermaid-rendering`: the "Render Mermaid diagrams from fenced code blocks" requirement changes from implicit render-all-at-mount to viewport-lazy rendering with placeholders, one-at-a-time yielding, and source+theme-keyed SVG reuse; error tolerance and viewer/theme requirements are unaffected in substance but their trigger point moves from mount-time to reveal-time.

## Impact

- **Client only** — no server or API changes: `src/render/preview.ts` (render scheduling, cache), `src/preview/mount.ts` (mount no longer awaits a full batch), `src/preview/mermaid.ts` / `mermaid-viewer.ts` (unchanged interaction, triggers appear per-diagram), `src/styles.css` (placeholder styling), `src/preview/anchors.ts` interaction verified.
- **Tests**: unit tests for the cache and scheduling seams; e2e updates where specs assume all diagrams are rendered immediately after mount (`tests/e2e/mermaid.e2e.ts`); a probe-based perf assertion is not added (flaky) — before/after numbers recorded in the PR instead.
- **Perf target**: mount-to-interactive for the 42-diagram fixture drops to roughly the mermaid-stubbed baseline (~430 ms in WebKit, ~360 ms in Chromium) with diagrams filling in progressively.
