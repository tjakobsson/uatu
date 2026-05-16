## Why

Per-row git-status annotations made changed files visible, but in a 5,000-file repo with ~10 changes they are still needles in a haystack: reviewers must know *which* folder to expand to see the dots. The recent `harmonize-untracked-presentation` change settled what counts as a change across every surface; this change adds the affordance that scoping question naturally implies — *let me see only the change.* A binary `All ↔ Changed` chip in the Files pane swaps the path set the tree renders, without removing the underlying full-tree view (which remains one chip click away).

## What Changes

- `document-tree`: when the filter is `Changed`, the tree's path set MUST be reduced to the union of `reviewLoad.changedFiles` and `reviewLoad.ignoredFiles` (the same set that drives the row annotations post-harmonization), plus the ancestor directories of those files (auto-expanded so users don't have to click in). Files matched by `reviewLoad.gitIgnoredFiles` MUST NOT be considered part of the change set — gitignored files are ambient git policy, not change content. The filter MUST be implemented as a reduced `paths` argument to `@pierre/trees`' `resetPaths(paths, { initialExpandedPaths })`; uatu MUST NOT mutate the library's internal row visibility or DOM. When follow-mode auto-switches to a path that is not in the filtered set, the tree MUST temporarily include that one path so the active document remains visible (the existing "active document is always visible in the tree" invariant is preserved); the temporarily-revealed row MUST carry a distinguishing visual cue.
- `sidebar-shell`: the `Files` pane header gains a segmented `All ↔ Changed` chip beside the existing file count display. The chip's default state is per-Mode: `Changed` in Review mode, `All` in Author mode. Filter state SHALL persist across reloads independently per Mode, matching the existing per-Mode pane-state pattern. The file count display updates to read `N of M files` when the filter is on (`12 of 1,840`), and the existing `N files · M binary` form remains when the filter is off. When the filter is `Changed` and the change set is empty, the Files pane SHALL render a clear empty state naming the resolved review base.
- No `change-review-load` changes — the data layer already exposes the union (`changedFiles ∪ ignoredFiles`) and the gitignored-exclusion semantics needed.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `document-tree`: the path set fed to `@pierre/trees` is filterable; mandate reveal-on-follow override for the filtered state.
- `sidebar-shell`: add the `All ↔ Changed` chip to the Files-pane header; per-Mode default + persistence; file count format under filter; empty-state copy when no changes exist.

## Impact

- **Code**: `src/app.ts` (filter-state machinery and the chip's render + click handlers in the Files-pane header; file count format; reveal-override logic when follow auto-switches across the filter boundary), `src/tree-view.ts` (accept a filtered path set as an alternative input shape; track and restore expansion state across filter toggles, similar to how it already preserves expansion across filesystem-driven `resetPaths` calls), `src/styles.css` (chip styling + visual cue for the follow-override reveal row).
- **Tests**: e2e coverage for chip toggle, default state per Mode, persistence across reload, filter-set composition (excludes gitignored), follow-override reveal, empty state, file count format under filter.
- **APIs**: no new external APIs. Internally `tree-view.ts`'s `update()` may gain a filter-aware parameter, or a sibling method that takes a pre-reduced path set.
- **Specs**: deltas to `document-tree` and `sidebar-shell`. No new top-level capabilities.
- **Out of scope**: sub-toggles for "untracked only" / "modified only" / etc. (binary chip first; granularity later if reviewers ask). Filter applying outside the Files pane (e.g. to the Selection Inspector). Server-side filtering — the full path set continues to ship over the wire; filtering is purely a client-side rendering reduction. Multi-root behavior other than the single global chip applying to all roots.
