# Proposal: Clear stale workspace activity when a conversation moves to another worktree

## Why

When OpenCode 2.x relocates an active conversation to another worktree, it emits `session.moved` carrying the destination `location.directory`. Uatu's OpenCode v2 normalizer currently drops `session.moved` on the source workspace (because `event.location` is foreign) and treats it as unrecognized even when local. Subsequent turn-settlement events carry the destination directory and are also ignored on the source workspace, leaving `ChatAdapter`'s activity maps (`liveTurns`, `backgroundWork`, `pendingInteractions`) permanently reporting `working: true` even when opening the workspace shows no conversations.

In addition, directory-scoped provider reads (`OpenCodeV2Provider.listSessions()` and `getSession()`) filter out foreign sessions before returning to `ChatAdapter`, so neither opening the workspace nor reconnecting clears missed moves. On the destination side, when a shared OpenCode server delivers `session.moved` mid-turn, the destination workspace does not invalidate inventory or detect the already-running turn.

## What Changes

1. **Normalize `session.moved` across source and destination workspaces:** Extend `NormalizedSessionLifecycle` with `kind: "moved"` and handle `session.moved` in `src/chat/opencode/v2/normalization.ts` before foreign-event filtering, emitting the wire-authoritative destination directory.
2. **Clear source workspace activity and inventory on move-out:** In `ChatAdapter.applySessionLifecycle()`, forget moved-out session activity (including discarding buffered coalescer updates and clearing live projection status), re-verify any known active child sessions, remove the session from `listedSessions`, and invalidate inventory when the session was visible or listed without hitting the provider for unrelated foreign moves.
3. **Heal missed moves on lookup and reconnect:** Forget stale activity in `requireSession()` when `provider.getSession()` returns `null`, and reconcile tracked active sessions absent from `listSessions()` via `getSession()` during `listConversations()` and `server.connected` recovery.
4. **Reflect moved-in conversations and live activity on the destination workspace:** Add optional `listActiveSessions()` to `ChatProvider` (backed by `client.session.active()` in `OpenCodeV2Provider`), invalidate destination inventory on top-level move-in, schedule background recovery, and seed live turn status without racing newer terminal transitions.

## Non-goals

- Sharing a single `opencode serve` process across separate Uatu Hub workspaces or bridging in-flight execution state across independent `opencode serve` processes.
- Changing Hub switcher activity badge rendering or notification UX outside existing `ChatActivity` updates.
- Modifying OpenCode's worktree creation or session-move semantics.
