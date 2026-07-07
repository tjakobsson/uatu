## 1. Measure first (instrumentation baseline)

- [x] 1.1 Add per-phase timing capture to `getDocumentDiff` in `src/document/diff.ts` (base-resolve, file diff, rename scan, blob fetch) reported through the `src/debug/` metrics module alongside `git.execs_total`
- [x] 1.2 Record a baseline timing on a large repo (open Diff on a large modified file, note phase timings) to validate the cost ranking before optimizing

## 2. Server: rename-scan gating

- [x] 2.1 Reorder `getDocumentDiff` to run the file-scoped `git diff -M -- <path>` before any rename detection
- [x] 2.2 Gate `detectRenameOldPath` on the patch presenting as a pure addition (or empty-for-untracked); when a prior path is found, re-run the file-scoped diff with both paths
- [x] 2.3 Unit tests in `src/document/diff.test.ts`: modified file executes no repo-wide `--name-status` scan; renamed file still returns a single rename diff with `oldPath`

## 3. Server: base-resolution cache + parallelization

- [x] 3.1 Add a per-repoRoot cache for `{settings, ReviewBase}` validated by a `git rev-parse HEAD` probe and a ~30 s TTL (in `src/document/diff.ts` or a small sibling module)
- [x] 3.2 Parallelize the independent post-patch work (blob fetch alongside patch bookkeeping) with `Promise.all`
- [x] 3.3 Unit tests: warm request skips the resolution chain (assert via git-call spy/counter); HEAD change and TTL expiry both re-resolve

## 4. Client: loading signal

- [x] 4.1 Add busy state to the Diff segment (`aria-busy` + CSS pulse in `src/styles.css`), set/cleared in `applyDiffForActiveDocument` in `src/preview/diff.ts`
- [x] 4.2 Add the delay-gated (~200 ms show, ~300 ms minimum display) indeterminate indicator overlaying the preview pane without hiding existing content
- [x] 4.3 Verify all three triggers inherit the signal (view-mode click, compare-target switch in `src/shell/events.ts` path, file-select while Diff active via `src/preview/mount.ts`)
- [x] 4.4 Unit tests for the delay-gate timing logic (no indicator under threshold, minimum display once shown)

## 5. Client: no premature blank + paint yield

- [x] 5.1 Restructure `renderDiffIntoPreview` / `renderDocumentDiff` so Pierre module + highlighter (+ language) are awaited before `previewElement` is cleared
- [x] 5.2 Yield a frame (`requestAnimationFrame`) between showing the loading state and invoking the synchronous Pierre render
- [x] 5.3 Verify pane content stays untouched until the render-ready point on the Pierre path (verified in the browser via the slow-fetch e2e — `#preview` asserted non-empty while the loading bar shows; the Pierre path cannot run honestly under linkedom)

## 6. Client: prewarm

- [x] 6.1 Export `prewarmDiffView()` from `src/preview/diff-view.ts` reusing `getPierre()` + `ensureHighlighter()`
- [x] 6.2 Trigger prewarm from `requestIdleCallback` after boot only when the workspace is git-backed, and from `mouseenter`/`focus` on the Diff segment in `src/preview/view-mode.ts`
- [x] 6.3 Unit tests: prewarm populates the module/highlighter caches once; fallback renders still never import Pierre themselves

## 7. Client: highlight cap + fallback chunking

- [x] 7.1 Add exported `DIFF_MAX_HIGHLIGHT_BYTES` (default 128 KB) to `src/preview/diff-view.ts`; force `text` language and render the size notice when the payload meets it while staying under the Pierre cutoffs
- [x] 7.2 Chunk `renderLightweightFallback` output into ~500-line divs with `content-visibility: auto` + `contain-intrinsic-size` styles
- [x] 7.3 Unit tests: tier selection across the three size bands (highlighted Pierre / plaintext Pierre / lightweight fallback); chunked output preserves line classification

## 8. Verification

- [x] 8.1 Run `bun test` and fix regressions (733 pass / 0 fail)
- [x] 8.2 E2E check: slow-diff loading indicator appears and clears (throttled or delayed fetch), fast diff shows no flash; extended `tests/e2e/diff-view.e2e.ts` (full e2e suite: 198 passed; note: the loading-signal test blocks the pass-through service worker, since `page.route` cannot intercept SW-mediated fetches)
- [x] 8.3 Re-measure phase timings from task 1.2 on the same large repo and record the before/after in the PR description (synthetic 3000-file repo, 400 changed files, ~150 KB modified doc: 75.7 ms → 24.7 ms per request; git spawns 9 → 3; rename scan eliminated for modified files; base-resolve 39.6 ms → 6.8 ms)
- [x] 8.4 Real-app pass: large-file signal-then-plaintext-tier and the no-blank-pane behavior are driven end-to-end in Chromium by the new e2e tests; the subjective "first open feels instant after idle prewarm" check on `bun run dev` remains a human eyeball item
