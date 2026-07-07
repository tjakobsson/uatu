## 1. Baseline

- [x] 1.1 Record the current mount timings on `testdata/render-benchmarks/markdown-large.md` (42 diagrams) in Chromium and WebKit via a Playwright probe (click → content visible, real vs stubbed mermaid) for the PR's before/after table

## 2. Lazy render engine (`src/render/preview.ts`)

- [x] 2.1 Add the FIFO render queue: one diagram per pass via `mermaid.run({ nodes: [node] })`, `requestAnimationFrame` yield between passes, generation tag invalidated on new-container installs
- [x] 2.2 Add the IntersectionObserver wiring (`rootMargin: "50% 0px"`, unobserve on enqueue) with a render-all-through-queue fallback when `IntersectionObserver` is unavailable
- [x] 2.3 Add the in-memory SVG cache keyed by trimmed source + serialized theme inputs (post-normalize markup, ~200-entry insertion-order eviction); cache hits clone the SVG + wrap the trigger without invoking mermaid; failed renders are not cached
- [x] 2.4 Repoint `renderMermaidDiagrams` to install lazy rendering (resolve on setup, not completion); export `__drainMermaidQueueForTests()` awaiting queue quiescence
- [x] 2.5 Unit tests: queue ordering + yield between passes, generation abandonment on re-install, cache hit/miss/theme-miss/error-not-cached, fallback path renders all nodes

## 3. Mount + styles integration

- [x] 3.1 Update `src/preview/mount.ts` (both call sites: single view and split rendered pane) for the no-longer-awaited semantics
- [x] 3.2 Placeholder styling in `src/styles.css`: `min-height` reservation and pending-diagram affordance on un-rendered `.mermaid` nodes, cleared once rendered
- [x] 3.3 Verify fragment navigation (`scrollToFragment` after load and anchor clicks) lands acceptably with placeholders below the fold; adjust the observer margin if drift is noticeable

## 4. Test-suite adaptation

- [x] 4.1 Update `tests/e2e/mermaid.e2e.ts` (and any other e2e that assumes render-at-mount) to wait for the specific diagram SVG or drain the queue
- [x] 4.2 Add an e2e scenario: many-diagram document mounts fast, off-screen diagram renders on scroll into view
- [x] 4.3 Run the full unit suite and the mermaid/preview e2e specs; fix regressions

## 5. Verification

- [x] 5.1 Re-run the task 1.1 probe; record before/after mount times (target: near mermaid-stubbed baseline) in the PR description
- [x] 5.2 Real-app pass: driven via Playwright against the served app in both engines — mount at the mermaid-free floor, scroll-reveal renders (verified Chromium + WebKit), viewer/error-tolerance covered by the passing mermaid e2e suite; subjective jank check on `bun run dev` remains a human eyeball item
