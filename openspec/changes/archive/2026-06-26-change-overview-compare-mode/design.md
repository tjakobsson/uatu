## Context

The Change Overview measures review burden against the resolved review base (merge-base of the base ref and `HEAD`), spanning committed + staged + unstaged changes. This is uatu's differentiator: "what a reviewer sees." Plain git, locally, defaults to `git diff HEAD` — only your uncommitted edits. Authors want both lenses but the burden framing must survive the switch.

Two facts ground the design:

1. **The `HEAD`-comparison path already exists.** `getDocumentDiff` (`src/document/diff.ts`) and `collectChangedFiles` (`src/review/load.ts`) already compute `compareRef = "HEAD"` as the dirty-worktree-only fallback when `base.mergeBase` is null. This change lets users *deliberately* select that path; it is not new git plumbing.
2. **Base resolution is shared.** Both the burden meter and the per-file Diff view resolve their base via `resolveReviewBase` / the same priority order. To stay coherent, the compare target must be one concept threaded through both.

```
              merge-base            HEAD         working tree
                  │                  │                │
  branch commits  ●━━━━━━━━━━━━━━━━━━●                │
  uncommitted     │                  ●━━━━━━━━━━━━━━━━●
  base       ─────┴───────────────────────────────────┘   (default · the promise)
  last-commit ────────────────────────┴────────────────┘   (git-local default)
```

## Goals / Non-Goals

**Goals:**
- One session-global compare target with two presets (`base` default, `last-commit`) that recomputes the burden score and reshapes the changed-files list.
- The selected target flows into both the review-burden snapshot and the per-document Diff view.
- The burden number is portable: it carries a precise resolved-ref anchor so it is unambiguous when read away from the control.
- Three vocabulary layers held distinct: control (plain intent), evidence subtitle (precise ref + `merge-base` SHA), readout (precise portable anchor).
- Default `base` so a fresh visitor lands on the differentiator; persist the user's choice per session.

**Non-Goals:**
- Arbitrary ref/branch picker (compare against any commit). Two presets only; the data model leaves room but the UI does not grow.
- Per-repository compare targets. The target is session-global.
- Changing `.uatu.json` schema, the scoring algorithm, level thresholds, or the resolved base ref itself.
- Server-side persistence of the choice (client/session concern only).

## Decisions

### Decision: Score recomputes with the mode (one rule)
The burden score always means "burden of the diff currently shown for the selected target." Switching to `last-commit` recomputes against `HEAD`.
- **Why:** One rule is easier to hold than "the number is loyal to base regardless of what files you see." Because `base` is the default, the promise is still the first thing anyone sees.
- **Alternative considered:** Mode is navigation-only — score stays anchored to base, toggle only filters the file list. Rejected: "why didn't the number move?" is a confusing moment and splits the meaning of the panel.

### Decision: Compare target is server-session state, set via POST (mirrors `setScope`)
Introduce a `ReviewCompareTarget = "base" | "last-commit"` (in `src/shared/types.ts`). The target is held as **server-session state** in `src/server/session.ts` (default `"base"`), exactly like `scope`. A new `POST /api/compare-target` route calls a `setCompareTarget` that recomputes `repositories` and rebroadcasts over SSE — the same path `setScope` uses. The snapshot's `reviewLoad.base` carries the resolved `compareTarget` and a precise `comparedAgainstRef`; `getDocumentDiff` reads `getSession().getCompareTarget()` so per-file diffs match the overview. The client mirrors the value into `appState` and persists it (`src/shell/state.ts`, localStorage); on boot it POSTs its persisted preference to reconcile the server.
- **Why this transport:** `/api/state` is a cached GET wired to the watcher→fingerprint→SSE broadcast model; a per-request query param can't drive a recompute without diverging from what SSE pushes. Server-session state is the established pattern (`scope`) and keeps `reviewLoad` the single source of truth, so **every existing consumer of `repository.reviewLoad` needs zero churn** — the cached snapshot already reflects the active target. The compare-target is folded into the state fingerprint so a switch always rebroadcasts even when scores happen to coincide.
- **Trade-off accepted:** like `scope`, the target is shared across all connected clients (tabs), and a switch costs one localhost recompute round-trip. Both are acceptable for a single-user local tool; recompute is cheap because the staged/unstaged worktree diffs are shared between targets (only the committed `merge-base..HEAD` range is base-only).
- **Alternative considered:** Ship both snapshots and let the client pick (instant, no server state). Rejected: doubles the `repositories` wire payload and forces every `reviewLoad` consumer onto a selector; the recompute it avoids is negligible on localhost.
- **Coherence:** switching the target invalidates `documentDiffCache` and reloads the active document if it is in Diff view.

### Decision: Three vocabulary layers
- **Control** (segmented toggle): plain intent — `Since base` / `Since last commit`. Never shows raw refs, so labels stay stable across repo configs and the button expresses *what you want*, not *what resolved*.
- **Evidence** (subtitle): precise git truth — `origin/main · merge-base abc1234`. `merge-base` appears *only* here.
- **Readout** (burden anchor): precise + portable — `Review burden 72 high · vs origin/main` or `· vs HEAD`. Reflects the actually resolved ref (`origin/develop` if configured), so the number survives being screenshotted into a PR.
- **Why precise (not echoed) readout:** the score is the artifact people communicate. `· base` is meaningless detached from the UI; `· vs origin/main` is unambiguous anywhere, and it surfaces a configured non-default base instead of hiding it. uatu's audience are git users — `HEAD`/`origin/main` are respectful, not intimidating.

### Decision: Segmented toggle, not dropdown-on-label or click-to-cycle
A 2-item segmented control under the panel title, with the evidence subtitle beneath it.
- **Why:** Zero hidden affordance for a feature that gates the product's hero capability. Click-to-cycle and clickable-label both hide that a choice exists.
- **Alternative considered:** Dropdown on the base label — elegant and extensible to "any ref," but discoverability is weak and we explicitly are not building a ref picker now.

### Decision: Default `base`, persist per session
Fresh session → `base`. Choice persisted in session storage like other uatu UI prefs.
- **Why:** First-time visitors must see the differentiator; returning authors keep their working lens.

### Decision: Collapsed state when no base resolves
When the resolved base is dirty-worktree-only, `base` and `last-commit` describe the same diff. The control reflects this (e.g. disabled/annotated) rather than implying a meaningful choice.
- **Why:** Honesty — offering two buttons that do the same thing erodes trust in the panel.

## Risks / Trade-offs

- **Mode not threaded into every diff entry point** → the file Diff view would silently disagree with the overview. Mitigation: thread `ReviewCompareTarget` through `/api/document/diff` and assert coherence in an e2e test that toggles the mode and checks both the meter and a file diff.
- **Anchor ref drift between meter and diff** → readout says `vs origin/main` but a file diff resolved differently. Mitigation: single resolution function maps target→compareRef; both consumers call it.
- **Persistence leaking across unrelated repos/sessions** → stale target applied. Mitigation: session-scoped storage; `base` is a safe default if the stored value is unreadable.
- **Extra git work on toggle** → recompute on every switch. Mitigation: it is one snapshot recompute per toggle (not per file), and the `HEAD` path is already exercised as the fallback.
- **Label bikeshedding** → `Since base` / `Since last commit` chosen for "since when" parallelism; revisit only if user testing shows confusion.

## Migration Plan

Additive and backward compatible. New optional request param defaults to `base`, reproducing today's behavior when absent. No `.uatu.json` migration, no CLI changes. Rollback = revert; stored client preference is inert without the server param.

## Resolved Questions

- **Collapsed state** (no resolvable base): keep both buttons visible, mark the control with `data-collapsed` and an annotation that the two targets coincide, rather than disabling it.
- **Anchor placement**: inline ` · vs origin/main` suffix inside the burden readout, not a separate line.
