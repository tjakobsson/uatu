## Context

Issue [#104](https://github.com/tjakobsson/uatu/issues/104): opening the Diff view on large files takes a long time with no working signal. Tracing the pipeline found two dead-air phases and three dominant costs:

```
click Diff
  ├─ PHASE 1  fetch /api/document/diff — old view stays, zero signal
  │     ~7-9 sequential git spawns, incl. a repo-wide
  │     `git diff -M --name-status` rename scan on EVERY request
  ├─ PHASE 2  pane blanked at diff.ts:97 BEFORE Pierre/Shiki load
  │     first open: dynamic import + 15-grammar Shiki preload (300ms-1s+)
  └─ PHASE 3  sync Pierre render — Shiki tokenizes up to 2×200KB blobs
        on the main thread; tab freezes, no spinner can help
```

Constraints from the existing spec (`openspec/specs/document-diff-view/spec.md`): Pierre must stay out of the eager bundle and off the fallback paths; the "no empty-state flash" rule (previous view visible until replacement is in hand) is deliberate; the `/api/document/diff` payload shape is load-bearing for the two-blob vs patch-only client paths.

## Goals / Non-Goals

**Goals:**

- The user always gets an immediate, honest signal that the Diff click registered, and a visible working indicator when the wait is non-trivial.
- Remove the avoidable latency: repo-wide rename scan in the common case, per-request base re-resolution, serialized independent git calls, first-open highlighter stall, multi-second synchronous tokenizing.
- Measure, don't assume: per-phase endpoint timings via the existing debug/metrics sink.

**Non-Goals:**

- No change to the `/api/document/diff` response shape or the two-blob / patch-only client contract.
- No Web-Worker offload of Pierre (its render is DOM-coupled; out of proportion for this change).
- No server-side diff HTML rendering.
- No virtualization rewrite of the Pierre path; only the lightweight fallback gets chunking.
- Dark-theme or visual redesign of the diff view.

## Decisions

### D1: Loading signal = busy segment immediately + delay-gated pane indicator

The Diff segment button gets a busy state (`aria-busy`, CSS pulse) the moment `applyDiffForActiveDocument` starts. A thin indeterminate bar overlays the top of the preview pane only if the payload+render isn't done within ~200 ms (single `setTimeout`, cancelled on completion). The old content stays visible underneath — the "no empty-state flash" rule is honored; fast diffs never show the bar.

*Alternatives*: full-pane spinner overlay (rejected: dims content, flash-prone); skeleton diff (rejected: violates the no-flash rule outright). The indicator lives inside `applyDiffForActiveDocument` so all three triggers (view-mode click, compare-target switch, file-select-while-in-diff) are covered for free.

### D2: Never blank the pane before render-ready

`renderDiffIntoPreview` currently wipes `#preview` before `renderDocumentDiff` awaits the Pierre import and highlighter. Reorder: await module + highlighter (+ language) into readiness *first*, then clear the pane and render, with a `requestAnimationFrame` yield in between so the busy indicator actually paints before the synchronous Pierre render freezes the thread.

### D3: Rename scan only for pure-addition patches

`detectRenameOldPath` runs a repo-wide `git diff -M --name-status` per request — the dominant server cost, and useful only when the file-scoped diff would misreport a rename as an add. Reorder the pipeline: run the cheap file-scoped `git diff -M -- <path>` first; only when the resulting patch is a pure addition (or empty-but-tracked) run the rename scan, and if it finds an old path, re-run the file diff with both paths. Ordinary modified files — the overwhelmingly common case — never pay for the scan. Renamed files pay one extra file-scoped diff, which is noise next to the scan they already needed.

*Alternative*: cache the repo-wide scan (rejected as primary: invalidation is touchy — worktree edits, index changes — and gating removes the cost entirely for the common case; caching can layer on later if measurement disagrees).

### D4: Per-repo base-resolution cache keyed on HEAD

`resolveReviewBase` + settings + toplevel re-derive per-request values that only change with HEAD or config. Cache `{settings, ReviewBase}` per `repoRoot`, validated by one cheap `git rev-parse HEAD` per request: HEAD sha unchanged → reuse; changed → re-resolve. Net: 4–5 spawns become 1 on warm requests. `.uatu.json` review-settings edits ride the same invalidation (stale until next HEAD move) — acceptable for a review tool; a small TTL escape hatch (~30 s) bounds staleness.

*Alternative*: hook watch-session file events for invalidation (rejected: couples `document/` to the watcher and `.git` internals; the rev-parse probe is one ~10 ms spawn).

Independent remaining work parallelizes: blob fetch (`fs.readFile` + `git show`) runs concurrently with post-patch bookkeeping via `Promise.all`.

### D5: Prewarm Pierre + Shiki off the critical path

Export a `prewarmDiffView()` from `diff-view.ts` that kicks the existing `getPierre()` + `ensureHighlighter()` chain. Trigger it from (a) `requestIdleCallback` after boot **only when** the app is in a git workspace (Diff is reachable), and (b) `mouseenter`/`focus` on the Diff segment as a belt-and-braces head start. Spec relaxation: the module stays out of the eager bundle and is still loaded via dynamic import, but "first time the Diff view needs to render" becomes "when Diff rendering is plausibly imminent". The "never loaded if Diff is never used" scenario weakens to "never eagerly bundled"; the fallback-paths-don't-import requirement stays.

### D6: Plaintext-highlight tier between full Pierre and the lightweight fallback

New exported cutoff `DIFF_MAX_HIGHLIGHT_BYTES` (default 128 KB, measured against `bytes` + blob sizes when present). Above it — but below `DIFF_MAX_BYTES` / `DIFF_MAX_LINES` — Pierre still renders (structure, word-diffs, chevrons, unified/split toggle) but with the language forced to `text`, skipping grammar tokenization. A one-line notice mirrors the existing fallback notice wording. This converts the phase-3 multi-second freeze into tens of milliseconds for exactly the "large file" population the issue names.

### D7: `content-visibility: auto` chunking in the lightweight fallback

`renderLightweightFallback` groups lines into ~500-line chunk `<div>`s styled `content-visibility: auto` with `contain-intrinsic-size` hints, so offscreen chunks skip layout/paint. Pure CSS + loop restructure; no behavior change to line classification.

### D8: Phase timings through the existing metrics sink

`getDocumentDiff` records per-phase durations (base-resolve, file diff, rename scan when taken, blob fetch) through the `debug/` metrics module alongside the existing `git.execs_total` counter. Cheap, permanent, and settles whether D3/D4 delivered before the change is archived.

## Risks / Trade-offs

- [Rename of a file *plus* large repo delta still pays the repo-wide scan] → Correct by design: that's the only case that needs it; timings from D8 confirm rarity.
- [HEAD-keyed cache misses config edits until next commit] → 30 s TTL bounds staleness; review-base config edits mid-session are rare and self-heal.
- [Idle prewarm loads ~1 MB of grammar/library for users who never open Diff] → Gated on git workspaces (Diff-capable sessions); local tool, local bandwidth; hover trigger alone would cover most of the win if this proves objectionable.
- [Delay-gated indicator can still "flash" on ~250 ms diffs] → 200 ms threshold + minimum-display time (~300 ms once shown) avoids the worst perceived flicker.
- [`content-visibility` scroll-anchoring quirks in huge `<pre>` blocks] → chunks carry explicit `contain-intrinsic-size`; fallback is cosmetic-only so regressions are contained.
- [Plaintext tier removes colors users had yesterday on mid-size diffs] → threshold chosen above typical doc-file sizes; notice line explains why, matching the existing large-diff precedent.

## Open Questions

- Exact `DIFF_MAX_HIGHLIGHT_BYTES` default — start at 128 KB and adjust against D8 timings on a real large repo.
- Whether the busy state on the Diff segment needs an e2e assertion or unit-level DOM test suffices (Playwright suite is serial and slow; lean unit).
