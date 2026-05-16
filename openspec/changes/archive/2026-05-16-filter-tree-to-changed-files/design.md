## Context

`@pierre/trees`' public API has no built-in "filter by status" primitive. Its filtering mechanism is the path set: whatever `paths` array is handed to `new FileTree({ paths })` or `tree.resetPaths(paths, ...)` is what the library renders. The library does ship `setSearch(value)` for name-based search, but that's a substring-match UX (highlighting + focusing matches), not a hide-non-matches UX. Wrong tool for "show only changed files." So the filter is implemented in uatu by computing a reduced `paths` array client-side and calling `resetPaths`.

The recent `harmonize-untracked-presentation` change established the *change set* as the union `reviewLoad.changedFiles ∪ reviewLoad.ignoredFiles`. The tree's row annotations already source from this union. The filter must source from the same union so reviewers' mental model — *"rows with a status letter"* ↔ *"what the filter shows"* — stays coherent.

There are three existing pieces of machinery the filter has to interact with:

1. **Manual expansion state preservation.** `tree-view.ts` already preserves the user's expanded folders across filesystem-driven `resetPaths` calls via `readExpandedPaths()` + the `initialExpandedPaths` option. The filter toggle is conceptually a similar boundary — we must preserve "what the user expanded in the full-tree view" across filter-on cycles and back.

2. **Reveal on selection.** `tree-view.ts:revealAndSelect` opens ancestor directories of the active document and marks it selected. The filter must not fight this; in fact when follow auto-switches to a path that isn't in the filtered set, the filter has to make the path visible *and* reveal its ancestors. Reveal-via-temporary-membership rather than reveal-via-defeat-the-filter.

3. **Per-Mode pane state.** `sidebar-shell` already persists pane visibility, collapse, and height per Mode (the `SIDEBAR_PANES_KEY_PREFIX${mode}` localStorage keys). Filter state follows the same per-Mode pattern.

## Goals / Non-Goals

**Goals:**

- One binary chip in the Files-pane header that toggles between "everything in the tree" and "only what's in the change set + ancestor folders, auto-expanded".
- Per-Mode default state and per-Mode persistence (Review defaults `Changed`, Author defaults `All`).
- The active document is always visible in the tree, even if it's not in the change set — follow-mode crossing the filter boundary reveals the active path only.
- The full-tree view's expansion state survives a filter on/off cycle.
- The file count display tells the truth about the filter: `12 of 1,840 files` when reduced, `1,840 files` otherwise.
- Empty state when filter is on and the change set is empty: actionable, naming the resolved review base.
- All filtering is client-side. No server work; the full path set continues to ship over the wire.

**Non-Goals:**

- Sub-toggles for category (untracked-only, modified-only, etc.). Binary chip first.
- Filter scope beyond the Files pane (Selection Inspector, Change Overview, etc. continue to operate on full data).
- A per-root chip when uatu watches multiple roots. One global chip applies to all roots (per-root scope would multiply the configuration surface for a feature whose value is fast triage).
- Replacing pierre's tree with a custom renderer to gain finer filter affordances. We stay on the library and reduce the path set.
- A search box co-located with the chip. `setSearch` exists on the library and could be combined later, but conflating "filter by status" and "find by name" in one UI is a separate design call.

## Decisions

### D1. Filter is a reduced path set passed to `resetPaths`

**Decision**: when `Changed` is active, `tree-view.ts` computes the filtered `paths` array (change set ∪ ancestor dirs of each change-set leaf, with ancestor dirs added to `initialExpandedPaths`) and calls `this.tree.resetPaths(filteredPaths, { initialExpandedPaths: ... })`. When toggling to `All`, it calls `resetPaths` again with the full path set.

**Why**: this is the API pierre exposes for "rendering a different set". `setSearch` is the wrong primitive (highlight, not hide). Custom row decoration via `renderRowDecoration` could hide a row but only by emptying its contents — the row itself would still occupy space in the virtualized list, which is visually wrong. `resetPaths` is what the library expects.

**Alternatives considered**:

- *Repurpose `setSearch` with a synthetic query* — conflates concerns; library's search UX is wrong; rejected.
- *Custom decoration that visually hides rows* — virtualization still allocates space; rejected.

### D2. Filter source set: `changedFiles ∪ ignoredFiles`, gitignored excluded

**Decision**: the filter set is exactly the union of `reviewLoad.changedFiles` and `reviewLoad.ignoredFiles`. Files in `reviewLoad.gitIgnoredFiles` are NOT in the filter set.

**Why**: the row annotations after `harmonize-untracked-presentation` source from the same union. The filter and the annotations agreeing on a set means "filter shows me what the dots told me about." `gitIgnoredFiles` is ambient git policy (`core.excludesFile` matches, mostly per-machine settings); those are not part of *this change*, they're noise that happens to live in the tree.

The chip's label is `Changed` — the word "ignored" intentionally does not appear, because the user-facing concept is "files in the change", not "files reported by review-load". The distinction between `changedFiles` (counted toward burden score) and `ignoredFiles` (excluded by `ignoreAreas`) is a score-policy concern, not a change-membership concern.

### D3. Per-Mode default + per-Mode persistence

**Decision**: filter state is keyed by Mode. localStorage key `uatu.filesPaneFilter.${mode}` with values `"all" | "changed"`. Defaults: `"changed"` for Review, `"all"` for Author. The current Mode's value is read on boot and on Mode-switch.

**Why**: Review-mode users came here to review; "Changed" should be on the moment they arrive. Author-mode users are writing; Follow is the existing primary attention mechanism — defaulting `Changed` ON in Author would create surprise (a user expanded a folder in their normal workflow, switches Modes, and the tree visibly changes shape). Matching the existing per-Mode pane-state pattern means there's no new persistence primitive to maintain.

### D4. Follow-override reveal: temporary membership + a visual cue

**Decision**: when follow auto-switches the active document to a path P that is not in the filter set, `tree-view.ts` calls `resetPaths(filteredPaths ∪ {P} ∪ ancestors(P), ...)` and renders that one row with a distinguishing visual cue. The cue is a custom attribute `data-uatu-filter-reveal="true"` set on the row's container post-render (via a `MutationObserver`-like hook inside our wrapper, OR via a `renderRowDecoration` callback if simpler); CSS targets that attribute with subtle italic and lower opacity. When the user clicks another row (or selection changes such that P is no longer active), the next refresh recomputes the filtered set without P and the row disappears.

**Why**: the invariant "the active document is always visible in the tree" is load-bearing — losing it would mean the preview can render content for a file whose tree row is invisible. Reveal-via-temporary-membership achieves visibility without abandoning the filter ("the rest of the tree stays filtered, only this one row is the exception").

The visual cue makes the exception readable: a user sees the dimmed/italic row and understands "this is here because Follow asked, not because this is a change."

**Alternatives considered**:

- *Toggle the filter off when follow lands on an unfiltered path* — surprising; the user's filter setting evaporates without action.
- *Hide the row but keep the preview* — breaks the invariant; user loses orientation.
- *Refuse to follow across the boundary* — defeats Follow's purpose; if a file changes on disk and the user has Follow on, that file *must* surface.

### D5. Expansion state across filter toggles

**Decision**: `tree-view.ts` tracks the user's expansion state for the *full-tree view* separately from any expansion the filtered view auto-applies. Concretely: when the filter goes ON, we snapshot `readExpandedPaths()` and store it in an in-memory variable. When the filter goes OFF, we feed that snapshot back into `resetPaths` as `initialExpandedPaths`. Filter-ON expansions (the auto-expanded ancestors of the change set) are NOT preserved when toggling back to `All` — they were not user choices.

**Why**: a user who carefully expanded `src/auth/` and `src/auth/oauth/` to navigate, then toggled `Changed`, then toggled back to `All` expects to find their expansions still in place. The opposite mistake (preserving the filter's auto-expansions when returning to All) would clutter the tree with directories the user never explicitly opened.

### D6. File count display: `N of M files` when filter is on

**Decision**: the file count under the Files-pane header reads:

- Filter `All`, no binary entries: `1,840 files`
- Filter `All`, with binary entries: `1,840 files · 12 binary`
- Filter `Changed`, no binary entries: `12 of 1,840 files`
- Filter `Changed`, with binary entries: `12 of 1,840 files · 2 binary`

`N` is the size of the filtered set (change set ∩ tree paths); `M` is the total tree size. Binary subcount uses the *visible* binary count under the current filter — so when filtered, it says "of the 12 visible, 2 are binary."

**Why**: the truth about the filter is more useful than "12 files" alone, which a user might confuse for "12 total." The `N of M` form is the same shape GitHub uses for filtered PR file lists.

### D7. Empty state when filtered set is empty

**Decision**: when filter is `Changed` and the union `changedFiles ∪ ignoredFiles` is empty (or, more precisely, intersects no tree paths), the Files-pane body renders an inline message: `No changes vs <base>` where `<base>` is the resolved review base from `reviewLoad.base` (e.g. `origin/main` or `dirty worktree only`). When `reviewLoad.status` is not `available` (non-git or unavailable), the message is `Changes filter is unavailable — no git repository`. The tree is hidden in either case to make the message the focal point.

**Why**: "blank tree" is a dead end; users wonder if the filter is broken. Naming the base anchors the user in the right mental model ("nothing has changed since `main`"); naming the unavailable state explains why the filter isn't producing rows.

### D8. Keyboard shortcut: defer

**Decision**: do not ship a keyboard shortcut in this change. The chip is mouse/trackpad-accessible; reviewers can use it from day one. A shortcut can land in a follow-up after we know how often users toggle in practice.

**Why**: every shortcut consumes a key in a finite keyspace. Picking blind risks colliding with future features. The Files-pane chip is two clicks max; the cost of "no shortcut yet" is small.

### D9. Multi-root: one global chip

**Decision**: when uatu watches multiple roots, there is one filter chip; toggling it applies to every root's contribution to the tree.

**Why**: multi-root sessions already share one tree (paths are prefixed by root label). Per-root chips would mean multiple toggles in the same header, which is visually noisier and addresses no use case we have evidence for. If per-root scope ever matters, the chip can grow a dropdown later — but a global chip is reversible.

## Risks / Trade-offs

- **[Risk] `resetPaths` is heavy.** Every toggle recomputes virtualization. → Mitigation: the library is fast for path sets up to tens of thousands; toggle latency should be imperceptible. If it becomes a problem, we can debounce or cache the two snapshots (full vs filtered).
- **[Trade-off] Default `Changed` in Review may surprise on first visit.** A user opening a Review session sees the tree pre-filtered; if they don't notice the chip they might think files are missing. → Mitigation: the chip is visually prominent in the Files-pane header; the `N of M files` count signals "the tree is reduced"; first-time confusion is real but quickly self-correcting.
- **[Risk] Multi-root chip applies globally.** A reviewer with one repo full of changes and another quiet repo might want to keep the first filtered and the second `All`. → Mitigation: deferred. Add per-root scope if asked. The cost of starting global is lower than the cost of starting per-root and consolidating.
- **[Trade-off] Follow-override reveal CSS may need tuning.** A dimmed/italic row inside an otherwise normal tree is a small visual idiom that's easy to overdo or underdo. → Mitigation: ship with one treatment, iterate based on actual use.
- **[Risk] Reveal-override row counts toward `N` in `N of M`.** A reviewer sees `13 of 1,840` when filter has 12 changes + 1 follow-override row, momentarily confusing. → Mitigation: the override row is dimmed and is visually obviously "not a change"; `N` reflects what the user actually sees, which is more honest than counting hidden items. Document the choice in the spec scenarios.

## Migration Plan

None. Filter state is new localStorage keys; absence reads as default-for-Mode. No data migration; no server-side change; rollback is just reverting the diff.

## Open Questions

- Should the filter chip surface a hover tooltip explaining what "Changed" means (e.g. "vs <base>")? Lean: yes for the Review default; the same base info already lives in Change Overview, but a hover-on-chip is cheap and on-context. Implementation detail; defer to the styling task.
- Should the follow-override reveal row also temporarily highlight in the tree (e.g. ring/border), or rely purely on selection styling? Lean: rely on selection styling (the row is already selected because Follow set it active). Add a ring later only if testing shows the dimmed-but-selected row is hard to spot.
- When `reviewLoad` is mid-refresh (between an old result and the next), should the filter render against the old result or briefly clear? Lean: render against the old result; the refresh debounce is short (~150ms) and a flicker would be worse than a stale row or two.
