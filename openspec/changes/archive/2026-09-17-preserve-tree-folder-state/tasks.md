## 1. Establish the revised behavior contract

- [x] 1.1 Review the carried-over reproduction tests and rerun `bun run test:e2e tests/e2e/document-tree.e2e.ts --grep 'user-expanded|user-collapsed' --workers=1`; verify both collapsed-ancestor cases fail on current product code and both expanded-folder controls pass.
- [x] 1.2 Rewrite the collapsed-active-file regressions to require no active/selected file, an empty preview, and Follow off immediately after manual ancestor collapse and after reopening; run them against the current implementation and verify they fail on the new contract rather than setup timeouts.
- [x] 1.3 Add input-origin cases for pointer/touch, native Enter/Space and ArrowLeft collapse, focus-only keyboard movement, unrelated folders, no active document, and nested/multi-root ancestor matching; verify tests distinguish actual manual ancestor collapse from other interactions and programmatic expansion changes.
- [x] 1.4 Add permanent persistence and lifecycle regressions for background content/add/remove/rename, All/Changed transitions, reconnect/resume, reload, legacy/first-visit defaults, explicit file/Follow resumption, and late preview responses; verify refresh completion independently of the empty preview and record the pre-fix failures.

Task 1.1 is retained historical diagnosis of the original folder-reopening bug; its evidence is in `validation.md`. The remaining checklist replaces the previous hidden-selection acceptance tasks. Prior green implementation/review results do not complete these revised tasks.

## 2. Handle manual ancestor collapse and document closing

- [x] 2.1 Add adapter-level observation of completed native ancestor collapse and a dedicated application deselection signal; verify actual expanded-to-collapsed transitions emit once, pointer/touch and keyboard behave consistently, programmatic resets/filter restoration emit no deselection, and listeners are cleaned up on disposal/remount.
- [x] 2.2 Extend Follow Rule A with one shell-level close-document variant that clears requested selection and preview metadata/content, sets intentional-empty state, turns Follow off, and synchronizes the tree without reopening the folder; verify both Rule A outcomes and its programmatic guard, directory focus, touch staying in Files, and unrelated collapse leaving preview and Follow unchanged without introducing a fifth rule.
- [x] 2.3 Invalidate pending document presentation on deselection and coordinate empty mode with rendered/source/diff preview lifecycles; verify delayed responses cannot repopulate an empty preview or overwrite a subsequently selected document.
- [x] 2.4 Remove hidden-active-file restoration on directory collapse/reopen, and reevaluate the same-file activation bridge without that obsolete assumption; verify reopening selects no file while deliberate activation of an already-selected visible file still invokes manual navigation exactly once for pointer, keyboard, and touch.

## 3. Preserve intentional emptiness and normal navigation

- [x] 3.1 Extend selection reconciliation to distinguish intentional emptiness from startup defaults and a retained unavailable document; verify Rule D, filter transitions, and reconnect/resume never select a fallback after manual deselection, while existing default and unavailable-document recovery controls still pass.
- [x] 3.2 Persist only the deliberate-deselection indication in workspace/base-path-scoped browser storage, leaving existing personal preferences Hub-backed and adding no API field; reconcile remembered document path, URL/history, and boot restoration. Verify reload remains empty with Follow off, another workspace/browser is unaffected, unavailable storage is handled gracefully, another tab's background reconciliation does not erase the marker, and absence of the marker keeps normal startup behavior.
- [x] 3.3 Clear intentional-empty state on explicit document navigation or enabling Follow and retain requested-identity-scoped reveal bookkeeping; verify explicit reselect, history/deep-link navigation, Follow resumption, A → unavailable B → A reveal, and continuous same-document temporary absence using setups that do not manually close that document.
- [x] 3.4 Retain All-to-All expansion snapshots and public-handle restoration of collapsed ancestors beneath expanded descendants, with no reveal inputs for intentionally empty selection; verify add/remove/rename preserve both open and closed directories and programmatic/filter restoration neither deselects an active document nor resurrects a closed one.

## 4. Revalidate the revised implementation

- [x] 4.1 Run `bun run test:e2e tests/e2e/document-tree.e2e.ts tests/e2e/follow-mode.e2e.ts tests/e2e/manual-selection.e2e.ts tests/e2e/files-pane-filter.e2e.ts --workers=1`; verify the revised close/reload/resume scenarios and retained navigation/filter controls pass on desktop and touch.
- [x] 4.2 Run `bun test src/sidebar/tree-view.test.ts`, the affected selection/persistence/preview lifecycle unit suites, and `bun run typecheck`; record exact commands and verify all pass, including persisted-state compatibility and stale-response handling.
- [x] 4.3 Perform a fresh browser UX pass on collapse, empty preview, reopening, reload, and explicit resumption for desktop and touch; verify the revised interaction is observable and consistent, storing screenshots/evidence only in `test-results/`.
- [x] 4.4 Append the new implementation/verification results to validation notes while retaining earlier reports as historical evidence, then run `bunx --no-install openspec validate preserve-tree-folder-state --strict` and `git diff --check`; verify no stale hidden-selection expectations or diagnostic edits remain before declaring the revised implementation complete.
