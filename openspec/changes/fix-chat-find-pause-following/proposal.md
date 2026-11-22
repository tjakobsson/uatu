## Why

[Issue #645](https://github.com/tjakobsson/uatu/issues/645) reports that while a chat timeline is smoothly catching up to the latest output, running Find or Find Next to reveal a match below the viewport lets the remaining catch-up animation scroll that selected match back out of view. `revealRange()` wrote `container.scrollTop` directly while focus remained in the Find bar, so `CoordinatedScrollOwner` saw downward movement while pinned, rebased its catch-up animation, and pulled the viewport past the match.

## What Changes

- Extract `revealRangeDelta(range, container)` from `revealRange()` in `src/find/highlight.ts` to compute the relative scroll delta (`null` for collapsed ranges, `0` when already in view, or the signed pixel delta).
- Export `coordinatedScrollOwner(scroller)` and add `CoordinatedScrollOwner.revealBy(delta)` in `src/chat/coordinated-scroll.ts` so deliberate Find range reveals cancel active or pending catch-up, supersede any standing hold or pending restore, apply the clamped scroll delta, and pause following at the landed position without re-pinning on the async scroll echo.
- Preserve following when Find lands on an already-visible match (`delta === 0`) while the timeline is settled at the bottom with no active or pending catch-up.
- Route Chat Find range reveals (parent timeline `#chat-timeline`, child drilldown `#chat-drilldown-timeline`, and outer-timeline reveal for inline shell viewports) through `CoordinatedScrollOwner.revealBy()` in `src/find/find-bar.ts`.
- Add unit regressions in `src/chat/coordinated-scroll.test.ts` and `src/find/highlight.test.ts`, plus a Chromium and WebKit E2E regression test in `tests/e2e/chat-focus-navigation.e2e.ts`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: Chat Find range reveals coordinate with `CoordinatedScrollOwner` to stop active catch-up and pause following at the revealed match while preserving following for already-visible matches when settled at the bottom.

## Impact

- Code: `src/chat/coordinated-scroll.ts`, `src/find/highlight.ts`, `src/find/find-bar.ts`.
- Tests: `src/chat/coordinated-scroll.test.ts`, `src/find/highlight.test.ts`, `tests/e2e/chat-focus-navigation.e2e.ts`.
- Non-goals: uncoordinated scroll panes (`.chat-tool-error`, `.chat-shell-window-content`) that do not run smooth catch-up animations remain direct `scrollTop` updates; floating/inline shell stdout already routes through `ShellScrollOwner.reveal()`.
