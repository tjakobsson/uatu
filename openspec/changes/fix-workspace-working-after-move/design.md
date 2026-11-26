# Design: Workspace Activity & Inventory Across Session Moves

## Architecture & Decisions

### 1. Explicit `kind: "moved"` on `NormalizedSessionLifecycle`
`session.moved` differs from both `session.renamed` (`kind: "updated", sparse: true`) and `session.deleted` (`kind: "deleted", sparse: true`):
- Its `data.location.directory` (falling back to `event.location.directory`) is authoritative on the wire, whereas `session.deleted` carries no directory.
- Its `title` and `parentID` are absent on the wire, so move handling preserves any remembered title and resolves parentage only on move-in.
- In `src/chat/opencode/v2/normalization.ts`, `session.moved` is handled before the `foreign(event)` early drop so the source workspace learns that a session left. A `session.moved` event lacking any `location.directory` resolves to an ignored no-op rather than throwing.

### 2. Source-Workspace Cleanup Without Pre-Move Resurrection
When `applySessionLifecycle()` receives a move-out (`!inWorkspace`):
- `forgetActivity(id)` discards queued updates in `eventCoalescer` (`this.eventCoalescer?.discard(id)`), resets any retained projection's live/background status to `"idle"`, bumps a monotonic per-session status sequence, and clears `liveTurns`, `settledTurns`, `backgroundWork`, `unresolvedBackgroundWork`, `pendingInteractions`, `notifications`, `announced`, `backgroundRecoveries`, and `admittingSteers`.
- `listedSessions.delete(id)` is checked alongside `inventoryVisible(previous)` so a session known only through `listConversations()` still triggers `inventory.invalidate()`, while unrelated foreign moves cause neither provider lookups nor inventory invalidations.
- Known active child sessions referencing the moved parent via `sessionParents` are re-verified through `getSession()` so children that moved along with the parent are forgotten while any child that stayed in the workspace retains its activity.

### 3. Missed-Move Reconciliation for Directory-Scoped Providers
`OpenCodeV2Provider.listSessions()` queries the server scoped to `this.directory`, and `getSession()` returns `null` for both deleted and foreign sessions:
- `requireSession(id)` forgets activity whenever `getSession(id)` returns `null`.
- `listConversations()` and `server.connected` recovery reconcile any IDs in `liveTurns`, `backgroundWork`, `unresolvedBackgroundWork`, or `pendingInteractions` that are absent from `listSessions()` by checking `getSession(id)`. Valid in-workspace children (e.g., Claude Code subagents omitted from `listSessions()`) return an in-workspace record and are preserved; transient provider errors leave activity intact.

### 4. Destination-Workspace Inventory & Active-Turn Seeding
When `applySessionLifecycle()` receives a move-in (`inWorkspace === true`):
- Top-level move-ins update `inventorySessions` and `listedSessions`, invalidate `inventory`, and call `scheduleBackgroundRecovery(id)`.
- Optional `ChatProvider.listActiveSessions()` (implemented in `OpenCodeV2Provider` via `client.session.active()`) probes whether the moved-in session is actively executing, while preserving the adapter's live-event-truth invariant for unobserved pre-existing runs on `server.connected`. A per-session `statusSequences` baseline prevents an in-flight probe from overwriting a newer terminal status or move-out.
- Because each Uatu Hub workspace spawns its own `opencode serve` process, live move-in events and `session.active()` reflection apply whenever the destination workspace shares an OpenCode server with the move; independent per-workspace servers remain decoupled.
