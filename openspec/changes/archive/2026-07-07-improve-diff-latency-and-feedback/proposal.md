## Why

Clicking **Diff** on a large file can take seconds with zero feedback ([#104](https://github.com/tjakobsson/uatu/issues/104)): the previous view stays frozen during the server fetch, then the pane is wiped blank before the diff library and highlighter have even loaded. Worse, most of that latency is avoidable — the server runs a repo-wide rename scan on every request, re-resolves the review base from scratch each time, and the client synchronously highlights up to 400 KB of source on the main thread.

## What Changes

- **Loading feedback**: the Diff segment shows a busy state immediately on click, and a delay-gated (~200 ms) indeterminate indicator appears over the preview pane so fast diffs stay flash-free while slow ones visibly work. The pane is no longer blanked before the diff library and highlighter are ready.
- **Rename scan demoted to the rare case**: the repo-wide `git diff -M --name-status` runs only when the single-file patch shows a pure addition (the only case a rename can masquerade as), instead of on every request.
- **Base resolution cached per repo**: the rev-parse → settings → symbolic-ref → merge-base chain is cached per repo root and invalidated when `HEAD` changes, collapsing 4–5 sequential git spawns to zero on warm requests; remaining independent git/fs calls run in parallel.
- **Highlighter prewarm**: Pierre + Shiki load off the critical path (idle after boot and/or on Diff-button hover), eliminating the first-open freeze. Lazy-loading semantics stay: never in the eager bundle, never loaded if Diff is never reachable.
- **Syntax-highlight cap**: above a new size threshold (below the existing Pierre cutoffs), the diff renders through Pierre with plaintext instead of full grammar highlighting, keeping structure, word-diffs, and chevrons while avoiding multi-second synchronous tokenizing.
- **Lightweight-fallback chunking**: the >5000-line escaped-HTML fallback wraps line runs in `content-visibility: auto` chunks so offscreen layout is skipped.
- **Endpoint timing instrumentation**: per-phase timings for the diff endpoint surface through the existing debug/metrics module, so the wins are measured, not assumed.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `document-diff-view`: adds a loading-feedback requirement (busy segment, delay-gated indicator, no blank pane before render-ready); relaxes the lazy-load requirement to permit idle/hover prewarm; adds a plaintext-highlighting tier between full Pierre rendering and the lightweight fallback; requires the endpoint to skip repo-wide rename detection unless the file-scoped patch is a pure addition and to reuse cached base resolution until `HEAD` changes.

## Impact

- **Server**: `src/document/diff.ts` (request pipeline reorder, rename-scan gating, parallelization), `src/document/git-base-ref.ts` (base-resolution cache), `src/debug/` (phase timings).
- **Client**: `src/preview/diff.ts` (loading signal, no premature blank), `src/preview/diff-view.ts` (prewarm export, highlight cap, fallback chunking), `src/preview/view-mode.ts` (hover prewarm hook), `src/styles.css` (indicator + chunking styles).
- **No API shape changes**: the `/api/document/diff` payload is unchanged; all endpoint behavior changes are latency-internal.
- **Tests**: unit tests for rename-scan gating, cache invalidation, and highlight-cap selection; e2e coverage for the loading indicator on a slow fetch.
