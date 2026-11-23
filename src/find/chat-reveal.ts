import { coordinatedScrollOwner } from "../chat/coordinated-scroll";
import { revealRange, revealRangeDelta } from "./highlight";

/**
 * Reveal a DOM range inside a Chat scroll container. Routes through the
 * container's active `CoordinatedScrollOwner` when one manages it so catch-up
 * stops and following pauses; falls back to `revealRange` when no active owner
 * handles the scroll.
 */
export function revealChatRange(range: Range, container: HTMLElement): void {
  const owner = coordinatedScrollOwner(container);
  if (owner) {
    const delta = revealRangeDelta(range, container);
    if (delta === null) return;
    if (owner.revealBy(delta)) return;
  }
  revealRange(range, container);
}
