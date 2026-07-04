## 1. Map and document ownership

- [x] 1.1 Enumerate every `appState.<field> =` assignment site (grep) and record current writers per field
- [x] 1.2 Finalize the field-ownership table and add it to ARCHITECTURE.md's state-lifecycle section

## 2. Preview-owned fields

- [x] 2.1 Add mutators for `viewMode`, `viewLayout`, `splitRatio`, `diffStyle`, `wrap`, `previewMode` in `src/preview/view-mode.ts` / `src/preview/layout.ts` (persistence fused in)
- [x] 2.2 Replace external direct assignments with mutator calls; unit-test the mutators

## 3. Sidebar-owned fields

- [x] 3.1 Add mutators for `panes`, `filesPaneFilter`, `gitLogLimit` in their sidebar owner modules; `compareTarget` in `src/sidebar/change-overview.ts`
- [x] 3.2 Replace external direct assignments with mutator calls; unit-test the mutators

## 4. Shell-owned fields

- [x] 4.1 Give `shell/events.ts` ownership of `roots`, `repositories`, `scope`, `staleHint` via mutators; route `shell/boot.ts` and any other writers through them
- [x] 4.2 Confirm `followEnabled`/`selectedId` writes remain exclusively inside `shell/follow.ts`'s rule implementations; convert any stragglers

## 5. Verify

- [x] 5.1 Grep check: `appState.<field> =` matches only in each field's owner module (or its colocated test)
- [x] 5.2 `bun test` passes, including new mutator tests
- [x] 5.3 `bun run test:e2e` passes (follow-mode, url-routing, sidebar, wordwrap suites exercise the moved writes)
- [x] 5.4 `bunx openspec validate appstate-field-ownership` passes

## Implementation notes

- The enumeration (1.1) showed the proposal's guessed map needed refinement: preference
  fields (`viewMode`, `wrap`, `viewLayout`, `diffStyle`, `gitLogLimit`) were already
  single-writer via their `apply*` mutators — the real sprawl was the selection trio
  (`selectedId` 19 sites / `previewMode` 21 / `followEnabled` 9 across 8 modules).
- New owner module `src/shell/selection.ts` holds `setSelectedId`/`setPreviewMode`;
  `followEnabled` stays with `shell/follow.ts` (`setFollowEnabled`), per the four rules.
- `previewMode` is owned by `shell/selection.ts` (not `preview/` as the proposal guessed)
  because it always moves together with `selectedId`.
- The grep scenario is codified as a permanent regression test:
  `src/shell/state-ownership.test.ts` scans `src/` for out-of-owner assignments and
  asserts the ownership map covers every declared `appState` field.
