# API changelog

Entries are ordered newest first. Every entry has Hub and workspace revisions, a compatibility classification, and migration guidance. Use `None` when no migration is required.

## Hub 1 / Workspace 4 - Unreleased

Compatibility: breaking (workspace)

### Changes

- Renamed `workspaceListChatAgents` to `workspaceListChatModes`, and its route from `GET /s/{workspaceId}/api/chat/agents` to `GET /s/{workspaceId}/api/chat/modes`. The response envelope key changed from `agents` to `modes`, and the item schema `ChatAgent` was renamed to `ChatMode`. The operation always listed OpenCode's Build/Plan ways of working, which this API now calls **modes**; **agent** now names the program Chat talks to.
- `ChatPromptRequest`'s optional `agent` property was renamed to `mode`, for the same reason. It still carries a mode name such as `build`.
- `ChatAvailability`'s `ready` variant gained an optional `agent` object — the new `ChatAgent` schema — carrying the agent's `id`, its display `name`, and the `capabilities` it declares. Capabilities are declared positively: a capability appears in the list or the agent does not have it. There is no `false` and no `unknown`. The capability list is open: a client MUST ignore a name it does not recognize rather than reject the agent, so a later revision can add a capability without another breaking change.

### Migration

A workspace client that lists ways of working must call `/api/chat/modes` and read the `modes` key; the `agents` route and key are gone, not deprecated. A client that sends a mode with a prompt must rename the request property from `agent` to `mode`; the accepted values are unchanged. A client that validates `ChatAvailability` against a closed schema must accept the new optional `agent` on the `ready` variant, or it will reject an otherwise valid status. Clients that ignore unknown properties need no change for that last item. A client SHOULD present a control only when the agent declares the matching capability, and MUST treat an absent capability as unsupported rather than as an error or an empty result.

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
