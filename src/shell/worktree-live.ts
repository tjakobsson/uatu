// The page's subscription to the `worktrees` topic on its one live channel
// (task 5.2). Every invalidation — the fresh one each attach and reconnect
// delivers, one after a committed Uatu operation, one after a Hub
// reconciliation that saw the repository change — becomes two DOM events
// the existing surfaces already listen for:
//
//   uatu:worktrees-changed      hub-nav re-reads /api/hub/state, so the
//                               workspace picker's rows are authoritative
//   uatu:worktrees-invalidated  an open worktree dialog reloads its
//                               register list (worktree-dialog)
//
// Nothing else happens: the active workspace, its document/preview, its
// terminal and its selected conversation are not touched, and the payload
// (content-free by contract) is not read at all.

import type { LiveChannel } from "./live-channel";

export const WORKTREES_CHANGED_EVENT = "uatu:worktrees-changed";
export const WORKTREES_INVALIDATED_EVENT = "uatu:worktrees-invalidated";

export function watchWorktreeInventory(channel: Pick<LiveChannel, "subscribe">, target: EventTarget): () => void {
  const handle = channel.subscribe({ topic: "worktrees" }, {
    data: () => {
      target.dispatchEvent(new Event(WORKTREES_CHANGED_EVENT));
      target.dispatchEvent(new Event(WORKTREES_INVALIDATED_EVENT));
    },
  });
  return () => handle.close();
}
