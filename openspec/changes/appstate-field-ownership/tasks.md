## 1. Map and document ownership

- [ ] 1.1 Enumerate every `appState.<field> =` assignment site (grep) and record current writers per field
- [ ] 1.2 Finalize the field-ownership table and add it to ARCHITECTURE.md's state-lifecycle section

## 2. Preview-owned fields

- [ ] 2.1 Add mutators for `viewMode`, `viewLayout`, `splitRatio`, `diffStyle`, `wrap`, `previewMode` in `src/preview/view-mode.ts` / `src/preview/layout.ts` (persistence fused in)
- [ ] 2.2 Replace external direct assignments with mutator calls; unit-test the mutators

## 3. Sidebar-owned fields

- [ ] 3.1 Add mutators for `panes`, `filesPaneFilter`, `gitLogLimit` in their sidebar owner modules; `compareTarget` in `src/sidebar/change-overview.ts`
- [ ] 3.2 Replace external direct assignments with mutator calls; unit-test the mutators

## 4. Shell-owned fields

- [ ] 4.1 Give `shell/events.ts` ownership of `roots`, `repositories`, `scope`, `staleHint` via mutators; route `shell/boot.ts` and any other writers through them
- [ ] 4.2 Confirm `followEnabled`/`selectedId` writes remain exclusively inside `shell/follow.ts`'s rule implementations; convert any stragglers

## 5. Verify

- [ ] 5.1 Grep check: `appState.<field> =` matches only in each field's owner module (or its colocated test)
- [ ] 5.2 `bun test` passes, including new mutator tests
- [ ] 5.3 `bun run test:e2e` passes (follow-mode, url-routing, sidebar, wordwrap suites exercise the moved writes)
- [ ] 5.4 `bunx openspec validate appstate-field-ownership` passes
