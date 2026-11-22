## 1. Coordinator & Find Wiring

- [x] 1.1 Extract `revealRangeDelta(range, container)` from `revealRange()` in `src/find/highlight.ts`.
- [x] 1.2 Export `coordinatedScrollOwner(scroller)` and add `CoordinatedScrollOwner.revealBy(delta)` sharing `pauseAtCurrent(upwardPending)` with `pause()` in `src/chat/coordinated-scroll.ts`.
- [x] 1.3 Route Chat Find range reveals (parent timeline, child drilldown timeline, and inline shell outer viewport reveals) through `revealChatRange()` in `src/find/find-bar.ts`, removing the now-unreachable `scrollRoot` fallback option.

## 2. Verification & Spec Sync

- [x] 2.1 Add unit tests for `revealRangeDelta` in `src/find/highlight.test.ts` and `revealBy` (downward during catch-up, in-view during catch-up, near-bottom echo vs. manual resume, idle-at-bottom no-op) in `src/chat/coordinated-scroll.test.ts`.
- [x] 2.2 Add Chromium and WebKit E2E regression test running Find Next on a match below the viewport during active catch-up in `tests/e2e/chat-focus-navigation.e2e.ts`.
- [x] 2.3 Sync the delta spec into `openspec/specs/opencode-chat/spec.md` and validate with `openspec validate --all --strict`, `tests/openspec-discipline.test.ts`, `bun run typecheck`, unit tests, and Playwright E2E.
