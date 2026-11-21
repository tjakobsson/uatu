## ADDED Requirements

### Requirement: Moving a conversation to another worktree clears source activity and updates destination state

When OpenCode relocates a conversation to another directory, the source workspace SHALL clear its tracked activity and refresh its conversation inventory without waiting for another event on that session. Directory-scoped lookups and reconnects SHALL reconcile missing active sessions, and a destination workspace observing the move SHALL refresh its inventory and reflect active work reported by its provider.

#### Scenario: Active conversation moves out of the source workspace
- **WHEN** an active OpenCode 2.x conversation emits `session.moved` naming another worktree directory
- **THEN** the source workspace normalizes the move even when the event location is foreign, discards buffered pre-move updates, and clears its live-turn, background-work, and pending-interaction activity for that session
- **AND** the source workspace reports not working unless another in-workspace conversation remains active
- **AND** the source workspace invalidates its conversation inventory if the moved conversation was visible or previously listed, while ignoring unrelated foreign moves without extra session lookups

#### Scenario: Missed move is healed when listing conversations, looking up a session, or reconnecting
- **WHEN** a tracked active conversation has moved to another worktree or been deleted without a live move event reaching the adapter
- **THEN** a subsequent `listConversations()`, `requireSession()` miss (`getSession()` returning `null`), or `server.connected` recovery verifies missing tracked sessions and clears stale activity for those no longer in the workspace
- **AND** in-workspace subagent sessions omitted from `listSessions()` and sessions whose verification fails with a transport error keep their tracked activity

#### Scenario: Active conversation moves into the destination workspace on a shared server
- **WHEN** a destination workspace receives `session.moved` naming its own directory for a top-level conversation currently running on the provider
- **THEN** the destination workspace invalidates its conversation inventory, schedules background recovery, and reflects the running turn in its workspace activity when `listActiveSessions()` reports the session active
- **AND** an in-flight active-session probe MUST NOT overwrite a newer terminal turn transition or move-out
