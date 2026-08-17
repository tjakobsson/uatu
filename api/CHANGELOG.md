# API changelog

Entries are ordered newest first. Every entry has Hub and workspace revisions, a compatibility classification, and migration guidance. Use `None` when no migration is required.

## Hub 1 / Workspace 3 - Unreleased

Compatibility: breaking (workspace)

### Changes

- `PermissionItem` and `QuestionItem` gained an optional `conversationId` naming the conversation that owns the request. It differs from the containing conversation when a subagent's request is surfaced in the conversation that launched it, and answers are addressed to the owner so exactly one reply reaches OpenCode however many places displayed the request.

### Migration

Workspace clients that validate conversation items against a closed schema must accept the new optional `conversationId` on permission and question items, or they will reject an otherwise valid timeline. Clients that ignore unknown properties need no change. A client that answers a request MUST address the owning `conversationId` when present, rather than the conversation it is displaying; answering the displayed conversation for a surfaced subagent request will be refused as a stale request. No existing field changed meaning, type, or nullability.

## Hub 1 / Workspace 2 - Unreleased

Compatibility: breaking (workspace)

### Changes

- `ChatAvailability`'s `unavailable` variant gained an optional `diagnostics` object carrying the evidence needed to diagnose a failed OpenCode startup: resolved executable, executables shadowed on `PATH`, version, probed endpoint, elapsed time, probe count, the last probe's classified outcome, and OpenCode's captured stdout and stderr. It never contains the ephemeral OpenCode server password.
- Added `workspaceRetryChat` (`POST /s/{workspaceId}/api/chat/retry`), which discards a cached Chat startup failure and starts OpenCode again. Adding an operation is additive on its own.

### Migration

Workspace clients that validate `ChatAvailability` against a closed schema must accept the new optional `diagnostics` property on the `unavailable` variant, or they will reject an otherwise valid response. Clients that ignore unknown properties need no change, and the property is absent whenever there is nothing to report. No existing field changed meaning, type, or nullability.

## Hub 1 / Workspace 1 - Unreleased

Compatibility: initial

### Changes

- Captured the existing Hub, proxied workspace, SSE, NDJSON, terminal REST, and terminal WebSocket behavior as the initial experimental contract.
- Added authenticated workspace chat status, model inventory, conversation inventory, snapshot, mutation, and replayable SSE operations. Prompt requests can select an available model and acceptance can include a provider-updated conversation title. This is additive; existing clients require no migration.
- Added authenticated slash-command discovery. Recognized leading slash prompts execute OpenCode commands, skills, or compaction while unknown and malformed slash text remains an ordinary prompt. This is additive; the prompt request and response contract is unchanged.

### Migration

None. This is the first published contract and makes no compatibility claim for earlier undocumented builds.
