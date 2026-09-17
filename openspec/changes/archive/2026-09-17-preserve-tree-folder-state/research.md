# Fresh research and assessment: preserving tree folder state

Date: 2026-09-16. Reviewed baseline `8a524297d367621ffe0116eea906c82318695b98`
through implementation commit `1a5e990` (including proposal commit `6b75fc9`).
Diff: `git diff 8a52429...1a5e990`.

## Follow-up status

The assessment below is historical evidence about `1a5e990`. The user authorized
fixing both findings afterward. They are now resolved in the working tree, with
permanent red-to-green regressions: requested-identity-scoped representation
fixes navigation through unavailable B, and a native-click activation bridge
fixes same-file pointer/Enter/Space/touch activation without duplicate routing.
The follow-up passed 55 relevant E2E tests, 45 unit tests, and typecheck; see
[`validation.md`](validation.md#independent-review-follow-up) for commands and
limitations. No architecture replacement or performance optimization was needed.

## Verdict

**Keep the core approach, but fix two confirmed interaction/lifecycle gaps before
merging.** Conditional reveal plus reset-boundary expansion restoration is a
reasonable adapter-local solution for authoritative document snapshots. A second
folder-state model or a tree-library replacement is not justified by this review.

The earlier validation accurately records its passing tests. Fresh independent
review identified two missing scenarios, and new targeted probes failed on the
committed implementation. No product fixes were made during this assessment.

## Method and limits

- Separate fresh contexts researched library semantics, reviewed repository
  standards, and challenged the spec/design. They inspected current source and
  primary library sources, not the prior reviewers' conclusions.
- The primary agent verified the fixed baseline, commit list, and nonempty diff.
  Read-only reviewers could not independently execute Git or tests; their
  source-only limitations were retained rather than treating their review as an
  exhaustive execution-backed approval.
- An implementer independently reproduced both proposed findings with temporary
  tests against the real library. Those tests were removed afterward, and the
  working tree was confirmed clean before this note was added.
- Library findings concern installed `@pierre/trees@1.0.0-beta.6`, not an assumed
  upstream latest version. Installed-package paths below are primary sources but
  are not tracked in this repository.
- No scale benchmark or extra browser-engine testing was performed in this pass.
  Baseline behavior was inspected in source, not executed in a separate checkout.

## Primary-source findings

| Question | Evidence and implication |
| --- | --- |
| Can reset preserve expansion automatically? | Public reset options have only `initialExpandedPaths` and prepared input; reset creates a new store. There is no public preserve-expansion flag. [L1, L2] |
| Does reset lose every kind of state? | No. It preserves surviving selected paths and reconciles focus. Expansion is the state the caller must supply. [L2] |
| Why restore collapsed ancestors after reset? | Initialization resolves each supplied expanded path and marks every ancestor directory expanded. Supplying `guides/deep/` also opens `guides/`. An expanded-path snapshot alone cannot represent an expanded descendant beneath a collapsed ancestor at initialization. [L3] |
| Can the adapter read expansion through public methods? | Directory handles expose `isExpanded()`, `expand()`, and `collapse()`. There is no public aggregate expansion-snapshot method in the installed declarations. Enumerating known directories and probing handles is legitimate public-interface orchestration. [L1, A1] |
| Are incremental mutations available? | Yes: `add`, `remove`, `move`, and `batch`. They are an alternative to full reset, but converting arbitrary index snapshots into safe mutations adds reconciliation work; move inference also needs identity/collision policy. [L1] |
| Is restoration free of repeated notifications? | No. Each effective `collapse()` records a store event synchronously; the controller rebuilds projection and notifies subscribers. A no-op collapse emits nothing. There is no general expansion-batching option exposed alongside these handles. [L4] |
| Is selecting a row the same as focusing it? | No. Public handles expose distinct methods. Row clicks apply selection, then focus the clicked directory, then toggle expansion. Programmatic `select()` does not focus. Thus restoring the active leaf need not steal keyboard focus. [L5] |
| Is a selection callback an activation callback? | No. `FileTree` invokes `onSelectionChange` when the selection version changes. Activating an already-selected row need not change that version. Public options expose a selection callback, but no general row-click/activation hook. [L1, L6] |

## Standards assessment

**No actionable documented-standard violations or baseline code smells found.**
The implementation stays inside the tree adapter, uses public library handles,
retains the programmatic-selection guard, and does not continuously duplicate
folder state. Tests are colocated or in the feature-specific E2E file; direct
tests use the real library and restore patched globals/prototypes. The added
browser refresh assertions wait on observable completion. [A1, A2, A3, S1]

This is a qualified source assessment, not proof of correctness; the independent
Spec assessment below found concrete failures despite standards conformity.

## Spec assessment: confirmed findings

### P2: activation of the active file can leave Follow enabled

The delta spec requires manual selection to disable Follow. The new directory
reconciliation restores the active leaf after folder clicks. Clicking that same
leaf afterward leaves the library's selection unchanged, so no callback reaches
`applyUserRowClick`, which turns Follow off. [S2, A1, A4, L6]

Reproduction:

1. Enable Follow and modify `guides/setup.md` so Follow selects it.
2. Collapse and reopen `guides/`.
3. Confirm `setup.md` remains selected and Follow remains on.
4. Click `setup.md` and expect Follow to turn off.

Temporary test command:

```sh
bun run test:e2e tests/e2e/document-tree.e2e.ts --grep 'temporary research same selected leaf click disables Follow after folder reopen' --workers=1
```

**Result:** one failure, after all prerequisites passed. `#follow-toggle`
`aria-pressed` was `true`, expected `false`, after the 10-second assertion timeout.
The temporary test has been removed, so this command will not select a test in
the committed suite until a permanent regression is added.

Attribution: the general already-selected-row activation blind spot predates the
branch. The newly reconciled folder-reopen sequence exposes it where directory
selection previously allowed the next leaf click to change selection. This
attribution is based on baseline source inspection, not a baseline execution.
Touch Preview activation uses the same routing entry point, but that consequence
was not separately reproduced. Existing new keyboard coverage activates a
different file and therefore misses this case. [A3, A4]

### P2: A → unavailable B → A incorrectly suppresses reveal

The delta spec requires reveal when the active document changes. Remembering only
the last successfully represented selection treats navigation back to A as an
unchanged refresh if B was unavailable. The temporary-absence exception instead
concerns the same active document disappearing and returning without intervening
navigation. [S2, A1]

Reproduction through the real adapter:

```ts
view.update(roots(), leaf); // A
directory("guides/").collapse();
view.update(roots(), "unavailable.md"); // B
view.update(roots(), leaf); // A is a new navigation, not a refresh
expect(directory("guides/").isExpanded()).toBe(true);
```

Temporary test command:

```sh
bun test src/sidebar/tree-view.test.ts -t 'temporary research unavailable selection transition reveals returning leaf'
```

**Result:** 0 passed, 1 failed, 42 filtered out; expected expanded `true`, received
`false`. This temporary test was also removed after the probe.

Attribution: new reveal-suppression defect. Baseline source unconditionally
revealed a represented selected path during update. Opening a stale search
result is one application route to requesting an unavailable document, since
search passes the supplied document ID to the routing entry point. [A5]

No additional missing requirements or unapproved scope were established. Both
nested expansion restoration and directory-selection reconciliation had explicit
user approval; approval does not remove the need to fix their interaction gaps.

## Alternatives and recommended next step

1. **Retain conditional reveal and exact reset restoration.** The library facts
   support both. Keep expansion owned by the library rather than add persistent
   per-folder application state. [L1–L3]
2. **Scope remembered representation to the current requested document identity.**
   Invalidate it when the requested identity changes, including to an unavailable
   document. Preserve it while that same request temporarily loses its tree path.
   This can fix A → B → A locally without exposing reveal flags to every caller.
3. **Treat activation separately from selection changes.** Preserve directory
   focus and the approved active-file highlight, while ensuring an intentional
   same-file click/keyboard activation reaches existing Rule A exactly once.
   The installed public declarations offer no general activation callback, so
   the exact integration needs design and browser verification; do not assume an
   unsupported hook or replace the library's keyboard handling. [L1, A4]
4. **Add permanent regressions for both confirmed failures**, including keyboard
   activation of the already-selected file and touch Preview behavior as
   appropriate, then rerun the relevant suites.
5. **Do not switch to incremental tree mutations merely to avoid this reset
   workaround.** That is attractive if the application later provides reliable
   mutation events, but snapshot-to-mutation inference is a broader trade-off,
   not an obviously simpler correction here. [L1]

Performance is an open measurement question, not a third confirmed defect.
`readExpandedPaths()` enumerates ancestors and probes all directories; the added
post-reset pass and individual collapses add work. `ancestorPaths()` repeatedly
slices/joins path segments, so highly nested input costs more than a simple
linear scan. A deep/wide-tree benchmark measuring reset time and notification
counts would establish whether this matters before introducing optimization.
Compact-folder topology changes also merit a targeted regression, but no concrete
new defect was established in that area. [A1, L4]

## Source index

- **L1:** `node_modules/@pierre/trees/dist/model/publicTypes.d.ts:88–108,167–180,230–249`
  — public handles, option/callback surface, and mutations/reset options.
- **L2:** `node_modules/@pierre/trees/dist/model/FileTreeController.js:666–706`
  — reset store replacement, surviving selection, focus reconciliation, emissions.
- **L3:** `node_modules/@pierre/trees/dist/path-store/src/store.js:357–474`
  — initial expanded-path resolution and ancestor expansion.
- **L4:** `node_modules/@pierre/trees/dist/path-store/src/store.js:223–228` and
  `node_modules/@pierre/trees/dist/model/FileTreeController.js:802–804,815–843,1144–1158`
  — collapse delegation and synchronous store/listener notification.
- **L5:** `node_modules/@pierre/trees/dist/render/FileTreeView.js:1681–1705` and
  `node_modules/@pierre/trees/dist/model/FileTreeController.js:361–368,815–843`
  — row-input ordering and separate selection/focus operations.
- **L6:** `node_modules/@pierre/trees/dist/render/FileTree.js:338–345` and
  `node_modules/@pierre/trees/dist/model/FileTreeController.js:805–813`
  — callbacks gated by changes to the selected-path set/version.
- **A1:** `src/sidebar/tree-view.ts:78–85,156–168,294–318,391–465,476–490,719–750`
  at `1a5e990` — selection lifecycle, reset restoration, callbacks, expansion scan.
- **A2:** `src/sidebar/tree-view.test.ts:16–248` at `1a5e990` — adapter lifecycle
  cases and real-library DOM test setup/teardown.
- **A3:** `tests/e2e/document-tree.e2e.ts:228–358` at `1a5e990` — refresh and
  pointer/keyboard coverage, including the different-file activation control.
- **A4:** `src/shell/follow.ts:79–103` — Rule A and touch Preview activation.
- **A5:** `src/sidebar/search-open.ts:63–65` — routing a search-result identity.
- **S1:** `CLAUDE.md`, `CONTRIBUTING.md:103–105`, and `ARCHITECTURE.md` — repository
  feature ownership, test placement, and UI verification conventions.
- **S2:** `openspec/changes/preserve-tree-folder-state/specs/document-tree/spec.md:4–6,61–87,96–107`
  — reveal, temporary absence, and manual-selection requirements.
