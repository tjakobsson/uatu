## Why

Chat loads its conversation inventory only during initial bootstrap, so a top-level OpenCode conversation created, renamed, or deleted from another device does not appear until the workspace page is reloaded. Users need awareness of new conversations without having their current conversation, draft, or reading position replaced.

## What Changes

- Keep the workspace conversation inventory synchronized across connected clients while Chat is running.
- Reconcile the authoritative inventory after subscription establishment, reconnection, and page resume so missed lifecycle events cannot leave the list stale.
- Preserve the selected conversation and its local presentation state when another conversation is discovered or updated.
- Mark newly discovered top-level conversations as unseen and expose that state beside the conversation chooser and on hidden Chat entry points until the user acknowledges the updated inventory.
- Keep subagent child sessions out of the inventory and unseen count.
- Reflect external conversation renames and deletions, including an explicit state when the selected conversation was deleted elsewhere.
- Keep worktree support, conversation-directory selection, and multi-conversation orchestration outside this change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: Require live, reconnect-safe conversation inventory synchronization and non-disruptive awareness of newly discovered conversations across clients.

## Impact

- Chat provider event normalization and workspace-level inventory state.
- The normalized Chat API gains a read-only inventory-change subscription alongside the authoritative conversation-list endpoint.
- Chat client inventory reconciliation, chooser rendering, unseen state, accessibility announcements, touch-tab badge, and collapsed desktop Chat affordance.
- Unit, route, and end-to-end coverage for cross-client creation, rename, deletion, reconnection, and selection preservation.
- No new runtime dependency and no change to OpenCode ownership of durable conversation history.
