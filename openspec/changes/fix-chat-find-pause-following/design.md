## Context

PR #633 introduced `CoordinatedScrollOwner` as the single automatic position writer for `#chat-timeline`, `#chat-drilldown-timeline`, and shell viewports. Request jumps and keyboard/accessibility focus navigation pause following through the coordinator, but Chat Find still called `revealRange()` directly while focus stayed in `#find-query`. During smooth catch-up, a downward `revealRange()` write fired a native `scroll` event with `movement === "down"` while `anchor.isPinned()` remained `true`, causing `observe()` to rebase `this.motion` and scroll the selected match out of view.

## Goals / Non-Goals

**Goals:**
- Route Chat Find range reveals on coordinated timelines through `CoordinatedScrollOwner` without creating a circular dependency from `src/find/highlight.ts` into `src/chat/`.
- Cancel active/pending smooth catch-up and pause following at the revealed match, including when the match is already inside the viewport during an in-flight catch-up animation.
- Prevent the async native `scroll` echo from re-pinning following even when the revealed match lands inside the 48px near-bottom band, while keeping subsequent deliberate manual downward scrolling able to resume following.
- Leave following untouched when a match is already in view (`delta === 0`) and the timeline is settled at the bottom with no catch-up active or pending.

**Non-Goals:**
- Changing Preview Find (`previewEngine`), terminal Find, or uncoordinated panes (`.chat-tool-error`, `.chat-shell-window-content`).
- Altering floating or inline shell stdout reveal semantics (already handled by `ShellScrollOwner.reveal()`).

## Decisions

1. **Split geometry measurement from mutation in `src/find/highlight.ts`.**
   `revealRangeDelta(range, container)` computes `null` (collapsed), `0` (already visible), or the signed vertical delta. `revealRange()` delegates to it, keeping `src/find/highlight.ts` free of chat imports.

2. **Expose `coordinatedScrollOwner(scroller)` and `CoordinatedScrollOwner.revealBy(delta)`.**
   `src/find/find-bar.ts` already imports from `src/chat/`. `revealChatRange()` resolves the owning `CoordinatedScrollOwner` (falling back to `revealRange()` if absent) and calls `owner.revealBy(delta)`.

3. **Unify pause state updates via `pauseAtCurrent(upwardPending)`.**
   `revealBy(delta)` checks `catchingUp` (`this.motion !== null || (isPinned && bottomGap > 0.5)`) and `moved`. If neither holds, it returns early without unpinning. Otherwise it calls `this.cancel()` (superseding catch-up, standing holds, and pending restores), sets `this.positioned = true`, writes the clamped `scrollTop` if `moved`, and runs `this.pauseAtCurrent(false)` so `previous` matches the landed `scrollTop` (suppressing scroll-echo re-pinning) and `upwardPending` stays `false` (allowing later deliberate downward arrival to resume).

## Risks / Trade-offs

- **Collapsed ranges:** `revealRangeDelta` returns `null`, so collapsed/unrendered ranges never scroll or pause following.
- **Idle bottom match followed by later output:** By design, an already-visible match when settled at the bottom preserves following (matching `resolveReveal`). Once Find moves the viewport or interrupts catch-up, following pauses and subsequent output keeps the match anchored.
