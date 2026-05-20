## Context

uatu currently has two top-level Modes — **Author** and **Review** — that gate substantial UI and behavioral differences: a top-level segmented control, mode-aware brand chrome, per-Mode pane visibility/sizing storage, per-Mode Files-pane filter persistence, mode-dependent Diff-view refresh semantics, and a mode-dependent review-burden headline label. The product also retains the *idea* of "pinning" the session to a single file, originally driven by an in-UI button that has since been removed; today, "pinning" is reachable only by passing a single-file path to `uatu watch` from the CLI.

The boolean `appState.followEnabled` is currently mutated from eight call sites that each have to coordinate with one or more of: `appState.mode`, `payload.scope.kind`, the URL's pathname, and `@pierre/trees`' `onSelectDocument` callback. Because the library's callback fires for both genuine user clicks AND library-driven initial mount, and because boot's six `followEnabled = X` branches all race against that callback, the resulting interleaving is non-deterministic — which is exactly the substrate of the two recurring flaky e2e tests (#45, and the `follow-mode auto-switch` flake observed today on main).

The user has decided the agent-collaboration workflow — *jump me to whichever file the agent just touched* — is the only Follow use case worth optimizing for. The Author / Review distinction is incidental to that workflow, and Review-only sidebar panes (Change Overview, Git Log, Diff) are valuable regardless of which "mode" the user is nominally in.

## Goals / Non-Goals

**Goals:**

- Reduce `followEnabled` write-sites from 8+ to ≤4, each with unambiguous source-of-truth semantics.
- Make `@pierre/trees` initial-mount callbacks distinguishable from real user clicks at the application layer, so the boot path is deterministic.
- Eliminate the Author/Review Mode concept end-to-end: state field, UI chrome, storage keys, CLI flag.
- Preserve every Review-only sidebar pane and the Diff view as always-available features.
- Preserve the URL direct-link contract: `/some/file.md` selects that doc on boot and forces Follow OFF.
- Preserve the CLI single-file invocation (`uatu watch some-file.md`).
- Halve the e2e suite's mode-related test surface (~25–35 tests deletable).

**Non-Goals:**

- Fixing the macOS watch freeze (issue #40). It shares the `src/shell/events.ts` SSE substrate but its root cause is orthogonal (overlapping refresh dispatch / chokidar lock contention).
- Restructuring the e2e harness for parallelism or per-worker workspaces. That's a separate change.
- Redesigning the Files-pane `All / Changed` filter or pane resizing UX.
- Introducing a new "selection intent" enum or splitting `selectedDocument` into multiple fields. The Follow rules below are expressible with a single boolean plus the existing selection.

## Decisions

### Decision 1: Eliminate the Mode field rather than collapsing it to a single value

We considered three approaches:

- **(A)** Keep `appState.mode` as a single-value enum (`"single"`) for forward-extensibility.
- **(B)** Remove the field entirely; ripple through every reference.
- **(C)** Reintroduce a different orthogonal concept (e.g. "view profile") to absorb mode-equivalent semantics.

**Chosen: (B).** Keeping a single-valued enum is dead-weight type machinery that future readers will misread as "there used to be more values; can I add one?" The bullet "BREAKING — Remove" in the proposal is more honest than a single-valued enum disguising the removal. Option (C) would re-introduce the same coordination cost we're trying to delete.

### Decision 2: Introduce a `follow-mode` capability that owns the toggle

Today, Follow's behavior is specified across `sidebar-shell`, `document-routing`, `document-tree`, and `tree-filtering` — never in one place. Each of those capabilities had to mention Follow because Follow's behavior depended on whichever surface was being described.

The new capability is the authoritative source of the four behavioral rules. Other capabilities reference `follow-mode` rather than re-specifying. This means:

- Future Follow refinements only touch one spec.
- The `tree-mount.ts` user-vs-programmatic distinction lives where it's specified, not as a comment buried in a click handler.
- E2E coverage for Follow lives in one feature file rather than scattered across `document-tree.e2e.ts`, `follow-mode.e2e.ts`, and `mode.e2e.ts`.

### Decision 3: Gate `handleTreeSelectDocument` by user-initiation flag

`@pierre/trees`' callback fires both for user clicks and for library-internal selection changes (initial mount with a pre-selected item; resetPaths-driven re-selection). Today, `tree-mount.ts:47` unconditionally sets `followEnabled = false` in the callback, so initial mount can race boot's `followEnabled = true` assignment.

We considered:

- **(A)** Sniff the call stack for a DOM event ancestor.
- **(B)** Add a guard flag set by the `TreeView` wrapper during programmatic calls.
- **(C)** Track most-recent-click state in DOM and consult it inside the callback.

**Chosen: (B).** `TreeView` already wraps the library and is the only call site that drives programmatic selections (e.g., from boot, from `events.ts`'s file-event handler, from `change-overview.ts`'s navigate-from-overview action). Setting `treeView.isApplyingProgrammaticSelection = true` around those call sites makes the call-site contract explicit and the callback gate trivially testable. (A) is fragile; (C) couples to DOM event ordering details that the library may change.

### Decision 4: Migrate per-Mode storage to single keys; discard Review-mode pane layout

We considered:

- **(A)** Merge Author + Review pane layouts via union of visible panes.
- **(B)** Read Author key on first boot, ignore Review key (warn-and-discard).
- **(C)** Prompt the user to choose.

**Chosen: (B).** Most users spent the bulk of their time in Author mode; the Author layout is the most-likely-preferred single-mode default. (A) would create layouts the user never explicitly configured (some pane visible in one mode but not the other). (C) interrupts boot with a modal for a one-time migration cost.

The migration code reads the legacy `uatu:panes:author` key once, writes it to the new `uatu:panes` key if present, then removes both legacy keys. Same pattern for `uatu:filesPaneFilter:author` → `uatu:filesPaneFilter`.

### Decision 5: Diff view collapses to "auto-refresh on disk change"

The proposal removes the Review-only stale-content hint behavior for the Diff view. We considered:

- **(A)** Keep the stale hint as a separate toggle independent of mode.
- **(B)** Remove it entirely; always auto-refresh.

**Chosen: (B).** The stale hint existed because in Review you might be mid-comment and not want the diff to shift under you. In a single-mode app where Review-the-mode no longer exists, the stale hint's framing disappears. If the auto-refresh-while-reading concern resurfaces, it should be re-introduced as a Diff-view-local "freeze" affordance — separate change.

### Decision 6: CLI `--mode` flag becomes a one-release deprecation

Hard-removing the flag would break scripted `uatu watch --mode=review` invocations. We considered:

- **(A)** Hard-remove; error on unknown flag.
- **(B)** Silently ignore; warn to stderr; remove next major.
- **(C)** Quietly accept and ignore forever.

**Chosen: (B).** One release of deprecation is enough warning for a tool of this size; (C) leaves a phantom CLI surface forever.

## Risks / Trade-offs

- **[Risk]** Discarding the Review-mode pane layout will frustrate users who customized it.
  **Mitigation:** First-boot warning in browser console; READMEs updated with migration note; the underlying panes (Change Overview, Git Log, Diff) all remain reachable via the per-pane visibility menu so a user can rebuild their preferred layout.

- **[Risk]** `@pierre/trees` may also fire its callback for resetPaths-driven re-selection (not just initial mount), and we need the programmatic-selection guard to cover those paths too.
  **Mitigation:** Audit every place `treeView.applyState(...)` or equivalent is called and wrap each with the flag. The flag is a per-render scope, not a global, so re-entrancy is safe.

- **[Risk]** Removing the Diff-view stale-hint behavior changes UX for users actively reviewing changes mid-edit.
  **Mitigation:** Document the change in the proposal's BREAKING list. If real users report regression, reintroduce a Diff-view-local freeze affordance in a follow-up.

- **[Trade-off]** The `selectedDocument` field doing double duty as "what's being viewed" and "what the user is currently pinned to" is implicit, not explicit. We're choosing a simpler model now over a more expressive one (e.g., an `intent` field).
  **Rationale:** Adding `intent` would re-create the multi-field coordination problem this change exists to remove. If pinning-as-distinct-from-viewing ever becomes a real product need, that's a future change with its own design.

- **[Trade-off]** Tests that exercise mode-switching behavior get deleted; any latent assumption baked into those tests about non-mode behavior is also deleted.
  **Mitigation:** Before deleting `mode.e2e.ts`, audit each test for assertions about non-mode behaviors that should survive — move those into the appropriate feature-named e2e file (e.g., a pane-visibility assertion goes to `sidebar.e2e.ts`).

## Migration Plan

The change can ship in a single release. No staged rollout is required because the SPA is local-first and the CLI is the only versioned surface.

1. **Boot-time storage migration** runs before the SPA renders. Reads `uatu:panes:author` (and any other `uatu:*:author` keys), writes them to the new bare-key names if not already set, then deletes both `:author` and `:review` variants.
2. **CLI flag deprecation:** `--mode=author|review` is silently accepted; emits `warning: --mode is deprecated and will be removed in the next release` to stderr.
3. **One release later:** remove the flag entirely; unknown `--mode` becomes a hard error from the CLI parser.

Rollback: revert the merge commit. The migration is one-way for storage keys (we delete the legacy `:author`/`:review` keys) — a user on a rolled-back binary will lose their pane layout once and reset to defaults. Acceptable given the tool's audience.

## Open Questions

- Should the migration code preserve the user's `uatu:panes:review` layout under a backup key for one release, in case a user complains and wants it recovered? Default answer: no — the discardable-state argument applies. Revisit if anyone surfaces a real need before the change merges.
