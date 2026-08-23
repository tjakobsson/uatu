# API changelog

Entries are ordered newest first. Every entry has Hub and workspace revisions, a compatibility classification, and migration guidance. Use `None` when no migration is required.

## Hub 4 / Workspace 8 - Unreleased

Compatibility: breaking (workspace)

### Changes

- The chat composer can attach images to a prompt. Added `workspaceUploadChatAttachment` (`POST .../chat/conversations/{conversationId}/attachments`): one PNG, JPEG, GIF, or WebP image per multipart request (field `file`, 10 MiB cap), sniffed from the bytes and stored outside every watched root; the response's `ChatAttachmentStored.id` is what later requests reference. The mutation is origin-protected.
- Added `workspaceGetChatAttachment` (`GET .../chat/attachments/{attachmentId}`), serving a stored image's bytes under the workspace's chat authorization. Only workspace-issued identifiers resolve; anything else answers `404` without filesystem interpretation.
- `ChatPromptRequest` gained optional `attachments`: up to 8 `{id, name, mimeType}` references to previously uploaded images, submitted with the text as one message. `text` may now be empty when `attachments` is non-empty — an image-only prompt is valid (and `QueuedMessage.text` may be empty for such a message). Bytes never ride the prompt request. A reference the workspace has not stored, attachments on a slash command, or an empty text with no attachments answer `400`.
- `UserMessageItem` and `QueuedMessage` gained optional `attachments` (`MessageAttachment` references): held messages keep their attachments and deliver them under the configuration frozen at submission, and replayed user messages restate theirs. A replayed attachment whose reference could not be recovered carries no `id`; clients render it as a labeled placeholder.
- `ChatModel` gained optional `imageInput`, reporting whether the model can see image attachments; absent means not reported, which clients treat as no.

### Migration

Strict workspace chat consumers must regenerate against workspace revision 8: the closed response objects for user message items, queued messages, and models gained optional properties (`attachments`, `imageInput`), so validators built from revision 7 reject conversation snapshots, chat events, and model listings produced by revision 8. Request producers need no changes — every new request field is optional, and existing prompts remain valid.

## Hub 4 / Workspace 7 - Unreleased

Compatibility: breaking (workspace)

### Changes

- A prompt submitted while its conversation is running is now held in a workspace-owned queue instead of being delivered to the agent mid-turn as a steer. `ChatPromptAccepted` replaces required `delivery` (`steer` | `queue`) with required boolean `held`: `held: true` identifies a queued message whose `messageId` is the removal handle, `held: false` a dispatched prompt whose `messageId` is the provider message id.
- Added `workspaceRemoveQueuedChatMessage` (`DELETE .../chat/conversations/{conversationId}/queue/{messageId}`), removing a message the workspace still holds so it is never delivered. Removal of an already-delivered message answers `409`. The mutation is origin-protected and idempotent under the client `requestId`.
- `ConversationSnapshot` gained optional `queued`: the held messages in submission order, so a client joining or reloading mid-run presents the same queue as one that watched it build.
- `ChatEvent` gained the `conversation.queue` variant, restating the whole held queue after each change (`held`, `removed`, or `delivered`) on the ordered, replayable event stream.
- Held messages are delivered one at a time, in submission order, when the running turn ends on its own. Cancelling the active turn leaves the queue paused: nothing is delivered until the next accepted prompt submission, which joins the back of the queue and resumes delivery from its head.
- The held queue is bounded per conversation (20 messages, 256 KiB of held text). A submission that would exceed the bound answers `429` without altering the queue, and the prompt operation documents that status.
- The queue removal, cancel, and permission operations now document the `413` an oversized request body always produced; the question operation already declared it.

### Migration

Strict workspace chat consumers must regenerate against workspace revision 7: read `held` instead of `delivery` on prompt acceptance, accept the `conversation.queue` event variant, and accept optional `queued` on conversation snapshots. Clients that steered a running turn must queue instead; there is no steer delivery in revision 7.

## Hub 4 / Workspace 6 - Unreleased

Compatibility: breaking (Hub)

### Changes

- `CredentialToolName` now includes `ssh`; managed workspace and selected-clone SSH commands use its validated absolute path.
- `UnassignCredentialRequest` gained optional `stop`. `stop: true` stops the workspace session and removes the assignment in one workspace lifecycle operation, so a concurrent start cannot land between the stop and the removal. This is additive for request consumers.
- Unassigning a credential from a workspace whose session is running now returns `409` unless the request carries `stop: true`: the running child retains its projected credential configuration and the Hub-side helper serves tokens by id, so a catalog-only removal would report a revocation that is not in effect.
- Added `hubAssignWorkspaceCredentials`, which replaces selected authentication and signing defaults atomically under the workspace lifecycle queue and stable credential-lock ordering. The Hub settings page no longer performs client-side rollback after a partial pair.
- `CreateCloneJobRequest` and `CloneJobInput` remain closed at runtime as documented. Clone input responses and native login responses, including authentication and CSRF failures before dispatch, carry `Cache-Control: no-store`.
- SSH unlock accepts an empty passphrase for an unencrypted key. OpenPGP unlock and key-generation passphrases remain nonempty.
- Credential inventory returns one unavailable readiness result for a credential whose readiness probe fails instead of failing the whole inventory request.

### Migration

Strict credential-tool consumers must regenerate against Hub revision 4 or accept the new `ssh` enum value. The optional `stop` unassignment field and paired assignment operation are additive and require no migration. Clients may send an empty unlock passphrase only when unlocking an SSH credential.

## Hub 3 / Workspace 6 - Unreleased

Compatibility: breaking (Hub)

### Changes

- `HubWorkspace` now requires `credentialAssignments`, containing deduplicated public credential names in separate `authentication` and `signing` arrays. Empty arrays mean the workspace has no assignments. Assignment presence does not imply that a credential is enabled, unlocked, or otherwise usable.

### Migration

Strict Hub state consumers must regenerate against Hub revision 3 or add the required closed `credentialAssignments` object and its two required string arrays. Consumers deciding whether to warn about missing assignments must test both arrays for emptiness and must not treat a non-empty array as proof that startup will succeed.

## Hub 2 / Workspace 6 - Unreleased

Compatibility: breaking (Hub and workspace)

### Changes

- Added authenticated Hub credential management operations for public credential metadata, public-key export, SSH/OpenPGP generation and import, token creation, unlock/lock, enable/disable, advisory workspace assignment, readiness tests, confirmed deletion, and credential-tool configuration and probes. Public DTOs are closed and omit private keys, passphrases, token values, and reusable agent credentials.
- `CreateCloneJobRequest` gained optional `credentialId` and `retainAssignment` fields. A selected compatible credential controls that clone's normal Git authentication; `retainAssignment: true` requires `credentialId` and records the assignment only after successful workspace registration. This is additive for request consumers.
- `HubWorkspace` now requires `credentialRestartRequired`, matching the boolean already returned by `GET /api/hub/state`. It reports whether assignment changes need a running workspace restart before its generated credential configuration is current.
- Added `ConversationConfiguration`, with optional `model`, `mode`, and `variant`; `variant` requires `model`. `ConversationSnapshot` now requires `configuration`, and `ChatPromptAccepted` now returns the accepted effective `configuration`.
- Added replayable `conversation.configuration` and `conversation.updated` `ChatEvent` variants for effective configuration and conversation-summary changes.
- Added the capability-gated `workspaceRenameChatConversation` operation: `PATCH /s/{workspaceId}/api/chat/conversations/{conversationId}` accepts an idempotency `requestId` and a title that is trimmed, non-empty, and at most 200 UTF-8 bytes. It returns the updated conversation summary. Unsupported or conflicting renames return `409`; unknown conversations return `404`.
- Added `conversation-rename` to the recognized positive `ChatAgent` capabilities.

### Migration

Strict workspace consumers must regenerate against Workspace revision 6 or widen their closed schemas before connecting. Snapshot decoders must accept and require `configuration`; prompt-acceptance decoders must accept and require `configuration`; stream decoders must accept `conversation.configuration` and `conversation.updated`. Configuration fields are optional, and absence means unknown or agent-controlled: clients must not substitute the first offered model, mode, or variant. A `variant` is only valid together with `model`. Capability-aware clients should expose rename only when `conversation-rename` is declared, send a unique `requestId`, and enforce the 200 UTF-8-byte trimmed-title limit rather than a 200-character limit. Clients that reject unknown event variants or newly required response fields are incompatible with revision 6. Strict Hub state consumers must regenerate against Hub revision 2 or add the required `credentialRestartRequired` boolean to their closed `HubWorkspace` schema. The credential operations and optional clone request fields otherwise remain additive.

## Hub 1 / Workspace 5 - Unreleased

Compatibility: breaking (workspace)

### Changes

- `ChatModel` gained optional `variants` (the reasoning variants the model advertises, e.g. `high`/`xhigh`) and `contextLimit` (the model's context-window size). `ChatPromptRequest` gained an optional `variant` naming how the selected model should reason; a request carrying `variant` MUST also carry `model` — a variant names an effort of a model, and pairing them keeps validation independent of server-side memory of the conversation's current model. The `variants` capability joined those a `ChatAgent` may declare.
- `PermissionItem` gained an optional `diff`: the unified diff a file-edit permission would apply, when the agent attaches one (OpenCode reports it on the permission's `metadata.diff`). It is absent for a permission with nothing to show — a command, a fetch.
- New `TokenUsage` schema: what a message spent, component by component. Every component is optional, and an absent one means the agent did not report it — which is not the same statement as zero. Each provider message's usage is carried exactly once on a dedicated `assistant_message` item whose id is `usage:<provider-message-id>` and whose `markdown` is empty; it is a hidden data carrier, not a message bubble or content part. The carrier's optional `model` names the model that reported it, so clients can keep context percentages paired with that model's window after another model is selected. The `tool` item gained an optional `usage` and `model`, which on a `task` tool describe the subagent's own session — the model it ran and the tokens it consumed, aggregated from that child session and mirrored onto the row that launched it. The `context` capability joined those a `ChatAgent` may declare; it governs whether either figure is reported at all.

### Migration

A workspace client that validates conversation items against a closed schema must accept the new optional `diff` on permission items, the new optional `usage` and `model` on assistant-message items, and the new optional `usage` and `model` on tool items, or it will reject an otherwise valid timeline. A client presenting assistant messages must suppress the empty-markdown `usage:<provider-message-id>` carrier as a bubble while still consuming its usage data. Clients that ignore unknown properties need no change. No existing field changed meaning, type, or nullability. Window occupancy is `input + cacheRead + cacheWrite`; `output` is what came back rather than what occupies the window, so a client that adds it to the fill will overstate it. When a usage carrier has `model`, its context percentage uses that model's `contextLimit`, not a different model selected for a future prompt.

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
