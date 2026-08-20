## Context

See `proposal.md` for motivation and `specs/opencode-chat/spec.md` for observable behavior. Today the client stores `model`, `mode`, and `variant` defaults plus per-conversation maps in its presentation record. Opening a conversation applies those browser values before its snapshot arrives. A new browser therefore chooses its own first model, shows `Mode: default`, and can send those claims back on the next prompt.

The provider already applies model/variant and mode as OpenCode session-level state on the v2 path (`switchModel`, `switchAgent`), while compatibility prompts carry them in the prompt body. OpenCode's persisted session/message records carry the model and agent metadata needed to reconstruct accepted configuration. The adapter's `lastModel`, `lastMode`, and `lastVariant` maps currently optimize validation only; they are process memory and cannot be authoritative.

Conversation title is provider-owned and durable. The provider abstraction already has optional `renameSession`, but that operation is used only for first-prompt title generation and is not exposed through the normalized service or API.

## Goals / Non-Goals

**Goals:**
- Make accepted conversation configuration recoverable from provider-owned state and consistent across clients.
- Distinguish shared effective configuration from a client's unsubmitted next-prompt choice.
- Ensure unknown configuration causes omission, never an invented selection or implicit switch.
- Expose rename through the same capability, confinement, origin, and idempotency boundaries as other Chat mutations.

**Non-Goals:**
- Synchronizing drafts, scroll anchors, expanded rows, panel geometry, or an unsubmitted picker choice.
- Adding Hub personal-state fields for conversation configuration; the configuration belongs to the shared provider conversation, not to a user/device record.
- Selecting among OpenCode, Claude Code, or another top-level agent.
- Changing OpenCode's own global model/provider configuration.

## Decisions

### D1: Add a normalized conversation-configuration record

Introduce `ConversationConfiguration` with optional `model`, `mode`, and `variant` fields. `variant` is valid only with `model`. A conversation snapshot carries the effective record separately from `ConversationSummary`, avoiding an extra configuration lookup for every row in the inventory. Prompt acceptance returns the accepted effective record, and a replayable `conversation.configuration` event publishes later changes.

Optional fields are deliberate. Empty does not mean "the first inventory option" or "Mode: default"; it means the agent has not reported an explicit value. The UI leads each picker with a non-claiming agent-default/current-unknown option whose empty value is omitted from prompt requests. It never preselects the first model for an existing conversation.

Alternative: add configuration to every `ConversationSummary`. Rejected because listing conversations would require an N+1 provider-state sweep for metadata needed only by the opened conversation.

### D2: Recover effective state from the provider, not Hub personal state

Extend the provider seam with a configuration read for one session. The OpenCode implementation reads current persisted session state where exposed and falls back to the newest stored user/assistant metadata for fields represented there. Native and compatibility record shapes are normalized behind that seam. Snapshot construction asks for this record, so a fresh adapter after workspace restart does not depend on its validation caches.

After an accepted prompt, the adapter updates its known configuration from exactly the values applied by the provider and appends a replayable configuration update. The cache accelerates subsequent reads while the process lives, but a cache miss always falls back to provider state. Provider events that report a session model/agent change update the same record when available.

Alternative: extend per-user Hub personal state with maps keyed by conversation id. Rejected because Hub users share the same underlying OpenCode conversation, direct serve has no Hub record, concurrent users would hold conflicting truths, and provider-side changes would bypass it.

Alternative: persist a Uatu sidecar in the watched repository. Rejected because merely chatting must not modify the repository, and the provider already owns durable conversation state.

### D3: Separate effective state from staged client state

The client projection holds the server-reported effective configuration. Picker interaction creates an in-memory staged override for that conversation. A clean picker follows snapshots and configuration events; a dirty picker retains the user's explicit next-prompt choice while the effective record may change underneath it. Prompt submission combines each staged field with the effective record, sends only explicit known values, and clears the staged state only after acceptance. The acceptance response becomes the immediate source of truth; the corresponding stream event is idempotent.

Per-conversation model/mode/variant maps in the existing local presentation payload are ignored and pruned. They are not migrated into shared state because a stale device value cannot be distinguished from the provider's actual state. Drafts and reading presentation remain untouched. Unsubmitted picker changes do not survive reload; losing an uncommitted choice is safer than silently applying it later.

Alternative: write picker changes to the provider immediately. Rejected because browsing controls on one client would mutate another client's active conversation before the user submits anything, and cancelling an accidental selection would require another remote mutation.

### D4: Rename through a declared capability and idempotent mutation

Add `conversation-rename` to the agent's positive capability list. OpenCode declares it because its provider implementation supports `renameSession`; an adapter without rename support omits it. Add an origin-protected mutation on `/api/chat/conversations/:conversationId` accepting `{requestId, title}`. The title is trimmed, must be non-empty, and is capped at 200 UTF-8 bytes before reaching the provider.

The adapter runs rename through its receipt store, revalidates workspace ownership, returns the updated summary, and publishes a replayable `conversation.updated` event. The selected conversation header and inventory option consume that event. Manual rename uses the same provider title field as automatic first-prompt naming; because automatic naming already runs only for provider-default titles, a manual title is not overwritten.

Alternative: store a display alias in browser or Hub personal state. Rejected because it would disagree across users and with OpenCode's own session list, and would not satisfy durable conversation renaming.

### D5: Treat the contract widening as a workspace API revision

Add the configuration schema, snapshot field, prompt-accepted field, configuration/update stream variants, rename operation, and capability name to the public contract. The contract's closed objects make these additions breaking for strict consumers, so bump `workspaceApiRevision`, regenerate/update operation metadata and route coverage, and add a migration section to `api/CHANGELOG.md`.

The UI label becomes `New conversation`. No route or type calls that operation "new agent"; top-level agent selection remains absent.

## Risks / Trade-offs

- [Older OpenCode record shapes omit one configuration field] -> Normalize every supported native/compatibility shape and represent a genuinely unavailable field as absent; never guess. Cover restart reconstruction with recorded shapes and the real-OpenCode integration test.
- [A remote update arrives while another client has staged a choice] -> Keep the explicit staged choice visible and local; acceptance resolves it against current offered values, while clean controls follow the remote event.
- [A configured model/mode is no longer offered] -> Display the recovered value as unavailable/current for truthfulness, but require a currently offered value before it can be newly selected; omission preserves provider state.
- [Configuration reads make snapshot loading slower] -> Read only the selected conversation, cache successful recovery for the adapter lifetime, and reuse message/session data already needed where practical.
- [Local-storage cleanup discards an intentional but unsent choice] -> Accept the one-time loss; importing it could silently overwrite authoritative provider state, which is the defect this change fixes.
- [Rename during a running turn races provider title generation/events] -> Receipt serialization and provider-default-title checks make manual titles authoritative; session update events reconcile to the provider's returned title.

## Migration Plan

Ship server contract, provider recovery, mutation/events, and client support together with the workspace API revision bump. On first load, clients ignore and later prune legacy per-conversation configuration maps; no provider history or Hub personal-state migration is required. Existing OpenCode titles and session configuration remain in place and are read through the new normalized seam.

Rollback restores the previous contract revision and client behavior without rewriting provider sessions. Titles renamed while the change was deployed remain ordinary OpenCode titles. Configuration selected through accepted prompts remains valid provider state, though an old client may again display a device-local value.
