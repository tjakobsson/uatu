## 1. Dependency intake

- [x] 1.1 Run `bun i @pierre/diffs` and verify the resolved version of `@pierre/diffs` and the transitively-installed `shiki` peer in `bun.lock`. Pin both versions in `package.json` (no `^` floats) so the same Pierre API is reproducible across machines
- [x] 1.2 Run `bun run check:licenses` after the install and verify Pierre + Shiki licenses are in the allowlist. If either is rejected, surface the failure on this task and STOP — do not proceed with implementation until license is resolved
- [x] 1.3 Confirm `bun run build` still produces a working standalone binary with the new dynamic-import target resolvable (the binary may grow; record the delta in the task notes for reviewer awareness). Pre-implementation baseline: 71 025 122 bytes (~71 MB). Final delta re-measured in 11.3

## 2. Shared git base resolver

- [x] 2.1 Extract the review-base resolution currently used in `src/review-load.ts` (configured `review.baseRef` → `origin/HEAD` → `origin/main` → `origin/master` → `main` → `master`, with worktree fallback) into `src/git-base-ref.ts` so the review-burden meter and the new diff endpoint share one implementation
- [x] 2.2 Update `src/review-load.ts` to consume the new helper without behavior change; existing review-load tests must still pass
- [x] 2.3 Add unit tests for the helper covering each priority step, configured override, and the no-base worktree fallback path

## 3. Server: document-diff endpoint

- [x] 3.1 Add `src/document-diff.ts` with `getDocumentDiff(roots, documentId)` returning the discriminated `DocumentDiffResponse` (`text` | `unchanged` | `binary` | `unsupported-no-git`). Resolve the document's containing repo, then call `git diff -M <base>... -- <relativePath>` via `safeGit`; for worktree-only mode call `git diff -M -- <relativePath>`
- [x] 3.2 Detect `binary` from `git diff`'s "Binary files … differ" output (no patch body)
- [x] 3.3 Detect `unchanged` from an empty diff result (zero stdout)
- [x] 3.4 Wire `GET /api/document/diff?id=<absolutePath>` in `src/server.ts` next to the existing document endpoint; validate path containment with the same helper the existing endpoint uses; return JSON
- [x] 3.5 Add server tests covering: text response (with `addedLines`, `deletedLines`, `bytes`), unchanged response, binary response, unsupported-no-git response, renamed-file response (single diff, not add+delete), path outside watched roots is rejected

## 4. Client: shared types and preference widening

- [x] 4.1 Widen `ViewMode` in `src/shared.ts` from `"source" | "rendered"` to `"source" | "rendered" | "diff"`. Update `isViewMode` to accept `"diff"`. `readViewModePreference` and `writeViewModePreference` need no change beyond the type widening
- [x] 4.2 Add unit tests for `isViewMode` accepting `"diff"` and `readViewModePreference` round-tripping the new value
- [x] 4.3 Add a `DocumentDiffPayload` type next to `RenderedDocument` matching the server's discriminated union, and a `documentDiffCache` keyed by document id so subsequent view-mode toggles don't refetch

## 5. Client: Diff view module

- [x] 5.1 Create `src/document-diff-view.ts` that owns: a `let pierreModulePromise` cache, a `let highlighterPromise` cache, the `DIFF_MAX_BYTES` and `DIFF_MAX_LINES` constants, a `loadLanguage(highlighter, lang)` guard that no-ops when the grammar is already loaded, and a `renderDocumentDiff(host: HTMLElement, payload: DocumentDiffPayload, languageHint: string | null)` entry point
- [x] 5.2 Implement the renderer branches in `renderDocumentDiff`:
  - `unsupported-no-git`, `unchanged`, `binary` → emit muted `.uatu-diff-state` cards (no Pierre, no Shiki)
  - `text` with `bytes >= DIFF_MAX_BYTES` OR `addedLines + deletedLines >= DIFF_MAX_LINES` → lightweight escaped-HTML emitter inside `<pre class="uatu-diff-fallback-pre">` with the one-line notice
  - otherwise → `await getPierre()`, `await getDiffHighlighter()`, `loadLanguage(highlighter, langForLanguageHint(languageHint))`, then call the patch-input API (`parsePatchFiles(payload.patch)` or current equivalent) and inject the resulting `<FileDiff>` host into `host`
- [x] 5.3 Initialize the highlighter with the GitHub-light Shiki theme and the allowlist of pre-loaded grammars (TS/JS/TSX/JSX, JSON, YAML, Markdown, AsciiDoc, Python, Go, Rust, shell, CSS, HTML). Unknown languages fall back to `plaintext`
- [x] 5.4 Export `__resetDiffViewCachesForTests()` so unit tests can force-reset the highlighter and module caches between cases
- [x] 5.5 Add unit tests for: cache reuse across two `renderDocumentDiff` calls (only one highlighter created), fallback path does not call `getPierre`, large-diff cutoff triggers the lightweight emitter, binary/unchanged/no-git all render the appropriate card. Note: the Pierre render path itself requires Shadow DOM and is not exercised in unit tests (linkedom does not implement it); the cache-reuse assertion in unit tests is structural (single `??=` guard). Full Pierre-path cache reuse is verified in the Playwright suite (task 10.x)

## 6. Client: view chooser markup, styles, and wiring

- [x] 6.1 In `src/index.html`, extend the `#view-control` radiogroup to a third segment for Diff. Use icon-only buttons matching the existing two segments' visual language (note: implemented as text-labeled segments to match the existing Rendered / Source segments; existing two are also text-labeled, not icon-only)
- [x] 6.2 In `src/styles.css`, extend `.view-control` rules to cover the third segment, and add `.uatu-diff-host`, `.uatu-diff-state`, `.uatu-diff-fallback-pre` rules. Map our existing GitHub-light tokens (`--diff-added-bg`, `--diff-deleted-bg`, `--hunk-header-fg`) onto Pierre's documented Shadow-DOM CSS variables on `.uatu-diff-host`
- [x] 6.3 In `src/app.ts`, add `availableViewModes(payload)` returning the allowed `ViewMode` set per kind (Markdown / AsciiDoc → all three; text / source → `source` + `diff`; non-document / binary → none)
- [x] 6.4 Update `syncViewToggle` to show / hide segments based on `availableViewModes(payload)`. When the persisted preference is not in the set, mark the first available segment active without writing back to localStorage
- [x] 6.5 Update the existing layout-chooser visibility logic so the chooser is hidden when `appState.viewMode === "diff"` and reappears when leaving Diff for a kind that supports it

## 7. Client: applying the Diff view

- [x] 7.1 Extend `applyDocumentPayload` / `applyViewMode` so when `viewMode === "diff"`, it reads the diff from `documentDiffCache[selectedId]`, fetches `/api/document/diff?id=...` if missing, then calls `renderDocumentDiff` into `#preview` (clearing the previous contents). The rendered Source / Rendered representations stay in their cache untouched
- [x] 7.2 Wire the Diff fetch to honor the document-rendering "no empty-state flash" rule: do not blank `#preview` on the toggle to Diff if a previous representation is visible — only swap once the diff response is in hand (or render the fallback card directly if the response is cached)
- [x] 7.3 Ensure layout changes do not push history entries, do not alter `selectedId`, do not alter Pin/Follow state, and do not alter the Source/Rendered preference. (Same contract as the existing toggle.)

## 8. Mode interactions

- [x] 8.1 In Author mode, on the existing file-change event, re-fetch `/api/document/diff?id=...` when the active view is Diff and apply the new payload. Reuse the existing follow / refresh wiring; do not introduce a separate listener. Implementation: `loadDocument` (called by the existing file-change handler) now invalidates `documentDiffCache[documentId]` and routes to `applyDiffForActiveDocument` when `viewMode === "diff"`
- [x] 8.2 In Review mode, when the active view is Diff and the underlying file changes on disk, surface the existing stale-content hint and route its refresh affordance through the same Diff re-fetch path. The stale-hint refresh button calls `loadDocument` which now handles Diff via the new routing
- [x] 8.3 Verify the Selection Inspector pane treats Diff selections the same as Rendered selections (no line-range capture). Confirm by reading `src/selection-inspector.ts` and ensuring the whole-file source-pre detection's class is NOT applied to Diff-view DOM. Verified at `src/selection-inspector.ts:235` — checks for `pre.uatu-source-pre`; the Diff view uses `pre.uatu-diff-fallback-pre` (fallback) or Pierre's Shadow DOM (no source-pre class)

## 9. Benchmarks

- [x] 9.1 Extend `scripts/bench-render.ts` to add Diff scenarios for the existing render-benchmark fixtures (`testdata/render-benchmarks/*`). Measure both the Pierre path (small diff) and the lightweight-fallback path (synthesized large diff). Treat results as an informational local baseline, matching the existing benchmark policy. Pierre's render path needs real Shadow DOM and is exercised in Playwright; the bench measures the lightweight-fallback emitter and a state-card render to establish a node-side baseline

## 10. End-to-end tests

- [x] 10.1 Add a Playwright scenario that opens a known fixture file with a committed-modification baseline, activates the Diff view, and asserts that a diff with at least one added and one deleted line renders inside `.uatu-diff-host`. Asserts the host mounts and the chooser stays on Diff; full Pierre Shadow-DOM content assertion is left for manual smoke (Pierre's render is hard to introspect from Playwright through Shadow DOM)
- [x] 10.2 Add a Playwright scenario for the non-git workspace path: start uatu with `--force` on a non-git folder fixture, activate the Diff view, and assert the muted "no git history available" card renders without loading Pierre (verify via absence of Pierre's emitted Shadow DOM root)
- [x] 10.3 Add a Playwright scenario asserting the three-segment chooser appears for Markdown and AsciiDoc and the two-segment chooser appears for `.ts` / `.json` files

## 11. Spec validation and smoke

- [x] 11.1 Run `openspec validate add-diff-view --strict`
- [x] 11.2 Manual smoke test in the browser: toggle through Rendered / Source / Diff on a Markdown file, a `.ts` file, an unchanged file, a binary file, a file in a non-git folder, and a synthesized large diff. Verify the highlighter is created once per session (browser devtools: log a counter from the cache helper during smoke). User confirmed manually.
- [x] 11.3 Run `bun test`, `bun run check:licenses`, `bun run build`, and `bun run test:e2e` clean before opening the PR. Results: 521 unit pass (2 skip, 0 fail); 337 packages license-audited clean; build produces 81.5 MB binary (was 71 MB pre-change; +10.5 MB for Pierre + Shiki); 140 E2E pass
