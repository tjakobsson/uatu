## Context

See `proposal.md` for priority and issue #339. The exact sequence behind the user's generic file jump is not yet reproduced. Exploration established that `nextSelectedDocumentId` falls back when the selected file is binary or missing, regardless of Follow being off. A missing text file then returning does not restore the original selection. Those are confirmed rule-level failures, not proof of the reported incident's cause.

`watch-session.ts` starts asynchronous rescans from a debounce callback without waiting for the prior refresh. Each refresh assigns shared roots and repository state when it completes; `createStatePayload` timestamps publication rather than scan start. An earlier slow scan can therefore overwrite later results and appear newer to the client's timestamp guard. This is a code-level ordering hazard that needs a controlled integration reproduction.

Preview loads already have selection, view, layout, and generation guards. The tree has a path-based programmatic-selection guard. Audit these existing mechanisms before replacing them. The implemented `resilient-live-connections` change owns transport recovery and remains in force. The single-mode `follow-mode` spec is authoritative for Follow behavior; legacy Author/Review wording elsewhere is not a reason to restore removed modes.

## Goals / Non-Goals

**Goals:**

- Keep user navigation separate from whether its destination is currently in the index.
- Make scan publication and asynchronous preview completion respect their existing ownership boundaries.
- Reproduce the generic text-file failure or document precisely which tested triggers were fixed and which reported trigger remains unknown.

**Non-Goals:**

- Infer file renames or follow moved files by inode.
- Change Follow-on target eligibility, browser back/forward intent, file exposure rules, or cross-client state ownership.
- Optimize chat, change PWA launches, or rewrite the event protocol.

## Decisions

### 1. Retain a selected destination while its content is unavailable

With Follow off, a non-null selection remains authoritative even when lookup fails or the file is binary. Retain enough session-local root/path identity to name a destination while absent; keep persisted `documentPath` semantics unchanged. Do not fabricate a selectable tree entry or bypass the index to read missing or excluded content.

Render an unavailable presentation for a missing target while retaining the selected identity and URL. When the target returns, reload it even if its ID equals the previous selected ID and there is no comparable old mtime. A real deletion stays unavailable. Selecting something else or enabling Follow ends that retention. Initial boot with no chosen destination continues using the existing default-selection rules.

A timed fallback was rejected because a slow replacement would still navigate away unpredictably. Keeping the old file contents without a clear unavailable state was rejected because those contents could appear current.

### 2. Serialize refresh execution and coalesce events received in flight

Retain the current debounce and maximum-wait behavior for starting idle work. Permit one scan and repository collection at a time. Events arriving in flight mark a pending reconciliation and retain the latest relevant changed-file intent. Drain pending work after completion, including after errors, without a second concurrent scan. Publish only complete results, and ensure shutdown cancels pending scheduling and prevents post-stop publication.

Serial execution prevents completion-order inversion and duplicate expensive scans. Merely tagging responses at publication does not fix the hazard; parallel scans with generation rejection would still waste work. Do not increase debounce delays to hide races. Preserve eventual Follow-on catch-up and subscriber-specific context.

### 3. Keep current selection ownership through every asynchronous boundary

Audit all document and commit-preview completions, scope recovery, and tree callbacks against the current navigation intent. Extend the existing load guard where an uncovered completion can update the preview or chrome after navigation. Cancelling superseded read requests is useful, but cancellation is not a replacement for checking ownership.

Reproduce programmatic tree echoes using the real library where possible. A different path during a programmatic operation is not sufficient proof of a user gesture. If that path reproduces a jump, distinguish the real activation from library bookkeeping while retaining pointer and keyboard operation. Avoid a long-lived blanket suppression flag that swallows subsequent user input.

### 4. Verify identity, contents, URL, and active surface together

Use controlled response gates and injected scan completion, not timing sleeps. Cover text and Markdown independently of the known image case, selected-file replacement, complete deletion, empty index, file return, unrelated edits, reconnect and resume, and two independent clients. Verify Follow-on switching still works. For each race assert the selected destination, displayed file, URL, Follow state, focus, and active tab where applicable.

Record the reproduction evidence with implementation validation. Do not describe the general issue as resolved solely because the image test passes.

## Risks / Trade-offs

- [Missing selection outlives its tree row] -> Keep destination identity outside row membership and show a named unavailable state; navigation remains usable.
- [Serial scans delay bursts] -> Preserve progress and a pending drain, measure scan duration, and test sustained changes without concurrent execution.
- [Late recovery revives an old destination] -> Guard completion by current navigation intent, including the unavailable-to-available transition.
- [Tree guard hides user input] -> Exercise real pointer and keyboard selection immediately after refresh.
- [Retained paths expose removed content] -> Continue authorizing every read against current index and exposure rules.

## Migration Plan

Ship as a compatible client/server update with no persisted-state migration or new dependency. Existing stream keepalives and recovery remain unchanged. Rollback is a normal binary rollback, which restores the previous selection behavior. Implement and validate this change before `improve-chat-responsiveness` to keep the urgent regression independently reviewable.

## Open Questions

- Which generic trigger matches the user's incident: temporary index absence, stale scan publication, or another navigation callback? The first task establishes evidence; the destination-retention contract is the same in each case.
