## Context

See `proposal.md` for motivation and `specs/opencode-chat/spec.md` for the behavioral contract.

The three reported gaps occur at different points in the same normalized Chat path:

- A mirrored permission or question already retains its owning `conversationId`. The timeline can distinguish a foreign request, `subagentEntries()` can associate child conversation IDs with task labels, and delegated `data-open-conversation` handling already opens the child drill-down. Only the request origin markup discards that information.
- OpenCode 1.18.21 reports a running shell tool's rolling output in `state.metadata.output` and its final output in `state.output`. UatuCode currently reads the final fields but not the rolling field, drops metadata while adapting live tool events, and reads `metadata.exitCode` where OpenCode reports `metadata.exit`. The legacy shell-ended event may omit an exit code entirely, which UatuCode currently misclassifies as failure.
- OpenCode's web client implements Undo and Redo as client-owned commands over reversible session APIs, not provider slash commands. The pinned SDK exposes classic `session.revert` / `session.unrevert` and native-v2 stage / clear operations. UatuCode supports sessions in both stores and already tracks the store choice in the provider, but its public provider interface, API, replay model, and composer have no reversible-history operation. Revert events currently add warning notices without replacing history that the provider has hidden.

The adapter also owns a queue of accepted prompts. Undo must serialize with that admission path so an idle transition caused by interruption cannot deliver a queued prompt before the revert is staged.

## Goals / Non-Goals

**Goals:**

- Preserve request ownership through rendering and reuse the existing transcript drill-down.
- Match the shell-output fields and lifecycle emitted by the pinned OpenCode protocol without changing transcript output bounds.
- Provide provider-neutral, idempotent Undo and Redo mutations with OpenCode-specific transport selection isolated in the SDK provider.
- Treat OpenCode as the authority for revert boundaries, file restoration, and visible history.
- Keep queued-message delivery, multi-client replay, and private composer drafts correct across conversation rewrites.

**Non-Goals:**

- Add arbitrary history branching, a visual branch browser, per-message revert buttons, or conversation forking.
- Reimplement file reversal from UatuCode file-change events or diffs.
- Let browsers call the OpenCode server directly.
- Change permission or question ownership and response semantics.
- Add terminal emulation or ANSI styling to Chat output.
- Migrate compatibility-store sessions into the native-v2 store.

## Decisions

### Derive request attribution from the existing child ID

`TimelineRenderer.render()` will build a child-label map once from `subagentEntries(projection.items)`, keyed by child conversation ID. A foreign request will pass an origin record containing its owner ID and the resolved label into request rendering. The renderer's cache variant will include that origin record so a generic fallback is replaced if structured task attribution arrives later without changing the request object.

The origin markup will retain plain explanatory text and add an `Open transcript` button carrying the escaped owner ID in `data-open-conversation`. It will use the same label function as the subagent track and drill-down title. If no matching task entry exists, it will use `Subagent`. Own-conversation requests receive no origin record. When the agent does not declare subagent support, the request remains truthfully identified as foreign but no dead navigation control is rendered.

This reuses the existing delegated click path and one-level drill-down. Adding a second navigation mechanism or putting child sessions into the conversation picker would conflict with the established parent-child model.

### Normalize the complete OpenCode shell state before rendering

Stored and live tool normalization will retain the tool metadata and direct output fields that OpenCode sends. Output selection will use structured content when present, final `state.output` when available, then rolling `state.metadata.output`, then the existing result fallback. This keeps final output authoritative while allowing running updates to fill the same command item.

Command exit status will accept both `metadata.exit` and the compatibility `metadata.exitCode`. A terminal ended event with no exit status will be treated as ended with unknown success rather than failed merely because a field is absent. A reported non-zero exit remains failed. The existing keyed upsert and bounded running/completed renderers remain responsible for in-place updates and output limits.

The alternative of special-casing shell output in the renderer was rejected. By then the output has already been discarded, and snapshot replay, live events, parent timelines, and drill-downs would continue to disagree.

### Model Undo and Redo as explicit local commands

`ChatCommand.kind` will gain a local-operation variant, and the service will append `/undo` and `/redo` only when the agent declares a new `reversible-history` capability. The composer will dispatch local operations through dedicated client methods instead of submitting their text to the prompt endpoint. Direct API calls remain capability-checked server-side.

This is preferable to adding names to `BUILTIN_COMMANDS`: that list routes through `provider.command()`, while OpenCode does not implement Undo or Redo as ordinary provider commands. Intercepting raw prompt text only inside the adapter was also rejected because it would give one endpoint incompatible response shapes and make composer draft restoration implicit.

### Put store-specific revert semantics behind one provider operation

The provider contract will expose optional high-level reversible-history operations and state. The SDK provider will derive the previous or next user-message boundary from authoritative provider messages and session revert metadata, ignore synthetic messages, choose the classic or native-v2 transport through its existing compatibility-session tracking, and return a normalized result containing:

- whether a boundary remains staged;
- whether the operation changed the boundary;
- the user turn restored for editing, including recoverable attachment references;
- enough state to report no-more-undo and no-redo outcomes without guessing.

For classic sessions, stage and clear map to `session.revert` and `session.unrevert`. For native-v2 sessions, staging maps to `v2.session.revert.stage`; advancing Redo stages the next hidden user boundary, while the newest Redo clears through `v2.session.revert.clear`. OpenCode remains responsible for snapshots and workspace file restoration.

The adapter will not calculate file changes or mutate its projection before the provider succeeds. Keeping boundary calculation in the SDK provider avoids leaking OpenCode message and session shapes into provider-neutral service and route layers.

### Serialize reverts with prompt admission and queue delivery

Undo and Redo will use the same per-conversation mutation lane that guards prompt admission. Before Undo interrupts a running turn, the adapter will mark delivery paused for that conversation. The idle event caused by interruption therefore cannot release a held message. The pause remains while a revert is staged.

A successful Redo that clears the boundary releases the pause. Submitting a replacement draft while staged commits the provider's reverted branch as part of prompt admission, admits that replacement first, then permits the older held queue to continue. Queued messages remain listed and removable throughout. Repeated Undo and Redo stay in the same serialized lane.

The alternative of clearing queued messages was rejected as silent data loss. Rejecting Undo whenever a queue exists was safer but unnecessarily prevents a reversible operation that can be ordered correctly.

### Make the provider snapshot authoritative after every rewrite

A conversation rewrite cannot be represented only with current append/upsert events because it removes a suffix of the timeline. After a successful local mutation, and when the event pump observes an externally initiated revert lifecycle event, the adapter will fetch authoritative session state and history, replace the conversation projection, and publish a resynchronization event with a conversation-rewritten reason.

`ConversationProjection` will gain a replacement path that clears timeline and text-reconciliation state before seeding the fetched items. The replay stream will tell connected clients to fetch a fresh snapshot rather than attempting a long series of inferred removals. The snapshot will carry normalized reversible-history state so a restarted adapter and newly connected client do not rely on process-local knowledge of a staged boundary.

Only the mutation response returns an editable draft to its caller. Other clients respond to the resynchronization by replacing visible history while preserving their local composer text and attachments. The existing warning-only revert event mapping will become a reconciliation trigger; notices may describe a completed rewrite, but they are not the source of transcript truth.

### Use additive, idempotent workspace API operations

The workspace API will add authenticated, origin-protected Undo and Redo operations under a conversation. Each accepts the existing client-generated `requestId` shape and uses adapter receipts keyed by conversation, direction, and request ID. A retried response returns the original normalized result without moving the boundary twice.

Responses include the operation outcome, staged state, and optional restored draft. The API schema, runtime validation, fake E2E service, and workspace API revision will change together. Existing prompt, command, cancellation, and request-response operations are unchanged.

## Risks / Trade-offs

- [Classic and native-v2 revert behavior can drift] -> Keep all SDK calls and boundary translation in `SdkV2Provider`, pin exact fixture tests for both stores, and do not infer file restoration in the adapter.
- [Native-v2 revert APIs are experimental] -> Continue pinning the SDK and isolate its signatures behind the provider contract so a protocol update changes one module.
- [An interrupt idle event could release a held prompt] -> Set the per-conversation delivery pause before interrupting and test the exact event ordering.
- [A provider event can announce a revert before the local mutation response] -> Make reconciliation idempotent and serialize projection replacement; duplicate triggers converge on the same provider snapshot.
- [Replacing a projection can disturb scroll or form state] -> Use the existing conversation resync path and keyed renderer behavior; preserve only client-local presentation that still maps to surviving item IDs.
- [A restored attachment reference may no longer resolve] -> Reuse the existing `MessageAttachment` placeholder semantics and restore only attachments whose UatuCode store IDs remain recoverable.
- [Specific subagent attribution can arrive after the request] -> Include the derived origin label in the renderer cache variant and fall back to a generic label until it is available.
- [Live shell output can be large or frequent] -> Retain OpenCode's rolling tail and UatuCode's existing bounded renderer; update one keyed command item rather than appending rows.

## Migration Plan

1. Add normalized types, capability declarations, provider operations, API schemas, and compatibility tests without exposing controls until the full path is present.
2. Add projection replacement, queue pausing, idempotent adapter mutations, and resynchronization handling.
3. Add client command dispatch and composer draft restoration, then enable the capability from the OpenCode provider.
4. Add request attribution and shell normalization independently within the same release; neither depends on reversible history at runtime.
5. Validate classic and native-v2 sessions, multi-client resync, queued-message ordering, and the existing Chat E2E suite before release.

No persisted UatuCode data migration is required. Revert state remains owned by OpenCode. If the UatuCode change is rolled back while a boundary is staged, the provider's file and history state remains valid, but clearing that boundary may require OpenCode's own client until the feature is redeployed.
