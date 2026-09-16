## 1. Lock down the reproduction and ownership boundaries

- [ ] 1.1 Re-run the existing reproduction with `UATU_CHAT_LIFECYCLE_TEST_CHILD=1 bun test ./src/chat/lifecycle.test.ts --test-name-pattern 'cold restore'`; verify it fails with the saved ID selected, blank history, disabled Send despite nonempty input, and no snapshot/subscription calls, while its explicit-switch workaround succeeds.
- [ ] 1.2 Extend the controlled lifecycle fixture to cover repeated empty/unrelated inventories and repeated arrival notifications during and after restoration; verify assertions distinguish exact saved-ID restoration from fallback selection and count opening reads/subscriptions.
- [ ] 1.3 Add lifecycle cases for manual selection, confirmed creation before initial inventory resolves and while late inventory arrives, creation failure, and cancelled agent choice; verify tests assert that user intent cannot be overwritten or re-armed by bootstrap.
- [ ] 1.4 Add read-failure/explicit-retry and obsolete-history-response cases; verify failed restoration is not retried by repeated inventory notifications and a newer selection wins over a delayed response.

## 2. Implement one-shot startup restoration

- [ ] 2.1 Add page-local pending saved-ID restoration and startup ownership guarding in `src/chat/ui.ts`; arm only for an unsuperseded empty initial inventory and consume before the normal opening path. Verify the original reproduction passes with history, restored draft, normal composer availability, and exactly one subscription.
- [ ] 2.2 Integrate pending restoration with inventory reconciliation without routing a never-opened, still-absent saved ID through deletion recovery, including after cancellation. Verify repeated empty/unrelated/duplicate inventories pass, a cancelled intent cannot reopen through an absent-then-present sequence, and existing selected-conversation disappearance/reappearance coverage remains green.
- [ ] 2.3 Invalidate restoration ownership on explicit selection and confirmed creation before awaiting creation, while leaving cancelled agent choice alone. Verify all ownership cases from 1.3 pass, including creation failure and bootstrap still in flight.
- [ ] 2.4 Preserve normal read loading/error/retry and stale-response behavior; verify cases from 1.4 pass without automatic retries, duplicate subscriptions, creation requests, or prompt submissions caused by restoration.

## 3. Verify preserved behavior and browser integration

- [ ] 3.1 Add or reuse lifecycle coverage for no saved ID, immediate nonempty inventory, delayed catalogs, and already open conversations. Run `bun test ./src/chat/lifecycle.test.ts ./src/chat/ui.test.ts ./src/chat/agents.test.ts ./src/chat/inventory-reconciler.test.ts` and verify no change to ordinary bootstrap, agent isolation, or inventory reconciliation.
- [ ] 3.2 Add a focused case to `tests/e2e/chat-inventory.e2e.ts` using synthetic conversations, retained scoped presentation storage, and controlled initial-empty/later-populated inventory. Verify desktop and touch render saved history and a usable composer without a manual switch, and that background restoration neither opens Chat nor steals focus. Keep evidence in Playwright output through the existing evidence helper, not hardcoded change paths.
- [ ] 3.3 Run `bun run test:e2e -- tests/e2e/chat-inventory.e2e.ts tests/e2e/chat-agents.e2e.ts --workers=1`, `bun run typecheck`, and `git diff --check`; record results and any environment blockers. Distinguish fake-agent browser coverage from real OpenCode cold-start validation.
- [ ] 3.4 Run the broader unit suite with `bun test` in the repository's documented clean environment where needed; record results, inspect the diff for diagnostic leftovers, and confirm no API/storage/dependency/server-timeout changes were introduced.

## 4. Prepare review evidence

- [ ] 4.1 Record the original red reproduction and final green results, the confirmed missed-restoration cause, and the limitation that the user's actual startup timing was not captured; verify the review summary links to the relevant tests and does not claim real-process reproduction of the timeout.
- [ ] 4.2 Before proposing a fix PR, determine whether the bug exists in the latest stable `v*` tag and record the release-note classification; include the repository-required Release Please override in proposed PR content if this only stabilizes unreleased functionality. Do not publish without user approval.

## 5. Capture final visual proof

- [ ] 5.1 After implementation and verification, run the controlled delayed-inventory browser scenario in desktop and touch presentation and capture screenshots showing the remembered conversation selected, its saved history rendered, its nonempty draft restored, and Send enabled. Pair each capture with passing assertions that restoration happened without a manual conversation switch, page reload, or new-conversation action, and that the conversation has a live subscription; screenshots alone do not establish the interaction sequence. Use synthetic content and the existing Playwright evidence helper, writing normal test evidence to `test-results/` and the HTML report rather than hardcoding change paths in tests. Verify both screenshots exist and visually inspect them before marking this task complete.
- [ ] 5.2 Link the desktop and touch screenshots and their supporting test results in the implementation completion summary, describing exactly what each demonstrates and identifying the controlled fake-agent setup rather than claiming real OpenCode cold-start timing was captured. Verify the links resolve to the final passing run's artifacts. If assembling PR evidence later, use `UATU_E2E_SCREENSHOTS_DIR=openspec/changes/fix-opencode-conversation-startup/screenshots` through the existing evidence workflow.
