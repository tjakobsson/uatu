## Context

See `proposal.md` for motivation and `specs/opencode-chat/spec.md` for the behavior contract. The relevant sequence is:

1. `MultiAgentChatService.listConversations()` bounds each agent contribution at four seconds. A slow contribution returns no entries in that response and triggers inventory invalidation when its nonempty result arrives. This protects other agents from cold-start delays.
2. `bootstrap()` starts the preferred agent's catalogs concurrently with inventory enumeration. `installInitialChooser()` returns without opening anything when the inventory is empty, but the saved `presentation.selectedId` remains.
3. `applyConversationInventory()` later patches the chooser using that saved ID. It opens a returned conversation only through the selected-conversation-deleted recovery branch. The empty bootstrap never entered that branch, so no projection or stream is installed.

The existing regression in `src/chat/lifecycle.test.ts` exercises actual `initChat` with controlled API results. It captures a settled loading indicator, the remembered ID selected, empty history, disabled Send despite nonempty input, and zero snapshot/subscription calls. Switching away and back succeeds. A temporary diagnostic condition that opened a selected conversation with neither projection nor read in flight made all six lifecycle tests pass; removing it restored the failure. That diagnostic product change was reverted.

This is a confirmed client failure for a server-supported sequence, not a captured trace proving the reported workspace exceeded the four-second bound. Separate real-process probing did not establish that timeout in the user's environment. No private conversation data is required for the regression.

## Goals / Non-Goals

**Goals:**
- Represent unfinished bootstrap restoration explicitly instead of inferring it from missing rendered content.
- Reuse the normal selection/read/stream lifecycle, including draft restoration, stale-read protection, loading feedback, and explicit read retry.
- Make startup ownership and cancellation deterministic across inventory and creation races.

**Non-Goals:**
- No new server readiness protocol, timer, polling loop, persisted flag, or provider-specific branch.
- No general retry-on-empty-projection behavior or refactoring of the full Chat controller.
- No change to existing fallback selection when the initial list is nonempty but lacks the saved ID; no auto-selection when there was no saved ID.
- No change to unseen-inventory accounting or ordinary selected-conversation deletion/reappearance behavior.

## Decisions

### 1. Keep one page-local, one-shot restoration intent

Represent the pending intent as the exact agent-qualified saved ID plus an ownership guard tied to the current startup/user-selection epoch. Arm it only when the initial chooser pass receives no conversations and has not been superseded by user selection or confirmed creation. Do not write it to presentation storage.

The existing `selectionGeneration` can guard selection changes, but creation does not advance that generation until its response reaches `selectConversation()`. Therefore the implementation must also invalidate startup ownership when creation is confirmed, before awaiting its request. That guard must prevent a still-running bootstrap from re-arming restoration after creation began, not merely clear an intent that already exists. Keep this guard local; an extra small ownership counter/flag is preferable to disturbing generation semantics for already open streams.

Conceptual transitions:

| State/event | Action |
| --- | --- |
| Empty initial inventory + saved ID + startup still owns selection | Record pending intent |
| Reconciliation still lacks that ID | Retain intent; do not open another conversation |
| Reconciliation contains the ID and ownership remains valid | Consume intent synchronously, patch chooser, start normal selection |
| Explicit selection or confirmed creation | Invalidate startup ownership and clear pending intent |
| Restoration read succeeds or fails | Remain consumed; normal selection/read handling owns the result |

**Alternative rejected:** `!projection && !readLane` as a general restoration condition. It also matches failed reads and unrelated transitions, making inventory events accidental retries.

### 2. Integrate restoration before ordinary deletion/reappearance reconciliation

While an intent is pending, an inventory missing that ID must not run `enterSelectedConversationDeleted()` for the never-opened conversation. Otherwise repeated empty inventories can enter deletion recovery and bypass one-shot semantics. When the ID arrives, update inventory truth and chooser state, consume the intent before any asynchronous work, and invoke `selectConversation(id)` once.

The remembered ID alone is not proof of an actively selected conversation. After cancellation, do not let an intermediate inventory that omits that never-opened ID manufacture a deleted-selection state whose later recovery would resurrect the cancelled intent. Keep enough startup ownership state to distinguish that saved reference from a real opening/selection; preserve the stored reference without treating it as an active selection. Once a conversation is actually selected, ordinary inventory reconciliation remains authoritative. Repeated inventories containing the selected ID must not reopen a successful or failed restoration. Actual later disappearance/reappearance of an opened conversation continues to use the existing recovery behavior.

Use the existing selection path rather than directly installing a snapshot: it already owns agent context, saved draft/anchor restoration, read errors, subscription creation, and obsolete-response checks. Restoration does not synthesize a user chooser interaction, focus the composer, or acknowledge unseen entries.

**Alternative rejected:** mark the saved conversation deleted during bootstrap. Pending startup discovery is not evidence of deletion, and borrowing that state would couple startup retries to a different lifecycle.

### 3. User action wins at its intent boundary

Explicit chooser selection supersedes pending startup restoration immediately. For creation, the boundary is a valid agent choice (or the single-agent creation action), before `api.createConversation()` starts. Cancelling the agent-choice menu does not supersede restoration. Once confirmed creation supersedes restoration, a failed creation does not silently re-arm it; the user sees the existing error and can choose what to do next.

Retain existing selection-generation checks for a restoration snapshot that arrives after a newer manual selection. Cover both cancellation before the late inventory arrives and stale history responses after restoration has begun.

**Alternative rejected:** cancel only when creation succeeds. A late inventory could otherwise open the remembered conversation while the creation request is outstanding.

### 4. Preserve server bounds and use deterministic client tests

The four-second contribution bound solves cross-agent responsiveness and is not the defect. No timeout changes or extra runtime retries are needed.

Use controlled promises and inventory invalidations in `src/chat/lifecycle.test.ts` to prove the missing transition and its ownership rules without sleeping for real startup. Reuse the existing red reproduction, retaining its exact symptom assertions. Add a focused browser check to the inventory suite that releases an initially empty list into a populated list while retaining scoped presentation storage. Run it in desktop and touch presentation to verify actual dropdown, history, composer, and focus behavior. Standard E2E uses fake agents: it validates client restoration, not actual OpenCode process startup, and must be described that way.

Read failures must remain failures until explicit retry; test repeated invalidations during the request, after success, and after failure. Also test repeated empty lists, unrelated entries, missing saved selection, immediate nonempty bootstrap, manual selection, creation in flight/failure/menu cancellation, and an obsolete history response. No model requests are needed.

## Risks / Trade-offs

- **Initial empty inventory cannot distinguish slow startup from a genuinely absent session** → Retain only an inert exact-ID intent; no probing, timeout extension, or unrelated auto-selection. Explicit user action cancels it.
- **Clearing an intent without invalidating bootstrap ownership can let it re-arm** → Guard both bootstrap arming and later consumption; test confirmed creation before the first inventory resolves.
- **Existing deletion recovery can bypass restoration guards** → Keep pending-startup absence out of that path and verify repeated empty/unrelated inventories before arrival.
- **Shared UI changes could affect Claude conversations or normal inventory updates** → Keep logic agent-neutral and run existing lifecycle, inventory, and agent-isolation tests.
- **Mocks cannot prove the real workspace's timing** → State the evidence boundary; the server-supported response sequence and the exact UI failure are deterministic without treating real startup timing as proven.

## Migration Plan

No migration or configuration change is required. Ship as a client bug fix with the normal build-identity refresh. Rollback is a code revert; saved presentation and provider conversations remain unchanged. Before preparing a fix PR, check whether the behavior exists in the latest stable `v*` tag and follow the repository's Release Please override rule if it only affects unreleased work.
