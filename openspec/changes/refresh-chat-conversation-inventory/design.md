## Context

See `proposal.md` for motivation and `specs/opencode-chat/spec.md` for the behavior contract.

One `LazyOpenCodeChatService` and adapter serve every browser connected to a running workspace. The adapter already consumes OpenCode's native and compatibility event streams, but its replay state is partitioned by conversation. The browser correspondingly subscribes only to the selected conversation and fetches the conversation list once during Chat bootstrap. OpenCode lifecycle events therefore reach the workspace process without reaching clients as inventory changes.

OpenCode emits `session.created`, `session.updated`, and `session.deleted` with session metadata. Its v2 event stream is broader than one directory, while UatuCode's public Chat contract is confined to the canonical first watch root and excludes child sessions. Lifecycle events are hints rather than an authoritative inventory: the dual streams can duplicate them, streams can disconnect, and a suspended browser can miss them.

The existing conversation list is already the authoritative, normalized view. It merges the provider's stores, verifies canonical workspace membership, excludes child sessions, repairs default titles, applies known status, and sorts the result. The change should preserve that single source of truth.

## Goals / Non-Goals

**Goals:**

- Validate the inventory awareness and selected-deletion presentation in the real shell before backend work constrains the interaction design.
- Add one workspace-level signal that tells clients when to reconcile the authoritative conversation list.
- Make subscription establishment and reconnection race-safe without retaining or replaying an inventory mutation log.
- Keep lifecycle confinement and child-session filtering on the server.
- Update chooser options without re-running conversation selection or disturbing the selected projection.
- Keep per-page unseen state deterministic and separate from durable conversation data.

**Non-Goals:**

- Carry full conversation snapshots or provider session payloads over the inventory stream.
- Persist notification acknowledgement across a full page reload.
- Add conversation deletion, archival, activity dashboards, or multi-conversation orchestration.
- Change conversation execution directories, add worktrees, or group conversations by repository branch.
- Replace the selected conversation's existing replay stream.

## Decisions

### 1. Approve the real presentation before transport implementation

The first implementation slice builds the final product DOM, styles, accessibility labels, and pure presentation updates for the visible unseen count, touch-tab attention, collapsed desktop-strip attention, and selected-conversation deletion state. It does not connect those surfaces to provider events or network transport.

A fixture driver lives only in the E2E test harness and exercises the real bundled shell through deterministic states: no unseen conversations, one unseen conversation, several unseen conversations, Chat visible, touch Chat hidden, desktop Chat collapsed, and selected conversation deleted. No product query parameter, debug global, or shipped fixture path is added.

Before provider, API, or reconciliation work begins, implementation pauses and presents the live fixture states and representative desktop/touch screenshots in light and dark appearance. Review covers hierarchy, density, wording, count behavior, focus treatment, narrow widths, safe-area placement, and whether the indicators attract attention without competing with active-turn or permission signals. The review task is complete only after the user explicitly approves the presentation; requested changes are applied and presented again before continuing.

The fixture calls the same small presentation functions the eventual unseen-state controller will call, so approval covers production markup rather than a disposable mockup. Test-only fixture controls may remain as regression infrastructure, but any temporary product-side trigger must be absent before the gate completes.

Alternatives considered:

- Static design mockups are faster, but they do not expose the native select, collapsed strip, touch safe areas, existing status chrome, or responsive constraints that determine whether this UI works.
- Implementing end-to-end logic first makes the states easy to trigger, but makes visual feedback expensive by coupling aesthetic iteration to provider and transport code.

### 2. Stream invalidations and refetch the authoritative list

Add an authenticated read-only SSE endpoint at `GET /api/chat/conversations/events`. Each frame is a provider-neutral inventory invalidation, not a create/update/delete mutation and not a provider session record. On every initial connection and reconnection the endpoint emits an initial invalidation after registering the subscriber; subsequent relevant lifecycle changes emit the same idempotent signal.

The browser responds by fetching `GET /api/chat/conversations`. Establishing the subscriber before its initial signal closes the list-then-subscribe race: the initial reconciliation establishes current truth, and an invalidation arriving during that fetch marks the client dirty for one trailing reconciliation.

The stream does not need cursors or a retained replay ring. A client only needs to know that at least one change may have happened, so each subscriber holds at most one pending signal. Reconnection always starts with another authoritative reconciliation and therefore repairs any number of missed events.

Alternatives considered:

- Polling only on Chat activation or a timer is simpler, but leaves a visible Chat panel stale and makes notification latency arbitrary.
- Sending full inventory snapshots on every lifecycle event duplicates list normalization, increases event payloads, and still needs snapshot recovery after gaps.
- Publishing inventory events into every conversation replay multiplies one workspace event across projections and fails when there is no selected conversation.

### 3. Normalize lifecycle hints separately from timeline updates

Extend provider-event normalization with optional session-lifecycle metadata containing the lifecycle kind and the fields needed to classify the session: id, directory, parent identity, and display metadata. Timeline updates remain conversation-scoped and unchanged.

The adapter accepts a lifecycle hint only when the session's canonical directory equals the workspace path and it has no parent. Deletion uses metadata carried by the event rather than looking the session up after it has disappeared. Foreign and child lifecycle events are discarded before they reach the inventory broadcaster.

Create and rename operations performed through the adapter invalidate directly after provider success; correctness does not depend on OpenCode echoing an event for UatuCode's own mutation. Provider lifecycle events cover mutations performed through another compatible client. Starting or restarting the provider event pump also invalidates once so a server-side stream interruption is repaired even though browser SSE connections remained open.

Duplicate lifecycle events collapse naturally because the signal is idempotent. `session.updated` events can be noisy, so the adapter compares inventory-relevant identity, membership, parentage, and title metadata and coalesces invalidations; timestamp-only restatements do not trigger repeated list reads. If prior metadata is unavailable, one conservative invalidation establishes it from the next authoritative listing.

Alternative considered: expose raw OpenCode lifecycle events to browsers. Rejected because that leaks provider schema, bypasses canonical-directory confinement, and forces every client to reproduce child-session filtering.

### 4. Keep a bounded workspace inventory broadcaster

The adapter owns a small broadcaster independent of conversation projections. Subscribers receive a signal immediately on subscription and after each invalidation. A stalled subscriber has at most one queued signal; further invalidations coalesce into it. Cancellation removes the subscriber, and adapter disposal closes all subscriptions.

`WorkspaceChatService` exposes inventory subscription as a provider-neutral operation. The route uses the same authentication, no-store headers, keepalive cadence, pull-driven response shape, and cancellation discipline as conversation SSE, but its payload has no conversation id, generation, or replay cursor.

Alternative considered: reuse `ConversationReplay`. Rejected because its generation, sequence, retention-gap, and conversation identity semantics solve ordered timeline replay, while inventory invalidation is unordered one-bit state.

### 5. Reconcile with one serialized client state machine

The Chat client owns one inventory stream and one reconciliation state machine after successful bootstrap. At most one list request is in flight. An invalidation arriving during a request sets a dirty bit and causes exactly one trailing request; duplicate signals while dirty do not add work. Failed requests preserve the previous inventory and leave reconciliation retryable.

The client also requests reconciliation when a bootstrapped Chat surface becomes active and when `visibilitychange` returns the page to `visible`. These are recovery triggers, not polling. The inventory stream stays connected while the mounted Chat surface is collapsed or another touch tab is active so hidden entry points can receive awareness promptly.

Chooser rendering is split into two operations:

- Initial installation chooses the persisted id or first conversation and loads it, preserving current bootstrap behavior.
- Later reconciliation patches the options and selected value by id without calling `selectConversation` when the selected id still exists.

This separation prevents an inventory update from closing the selected stream, reloading history, rewriting the draft, or moving the timeline anchor. Sorting follows the authoritative response even when the selected option changes position.

### 6. Derive unseen state from inventory identity differences

After the initial list becomes the silent baseline, the browser tracks known and unseen top-level conversation ids in memory. A later authoritative response adds newly observed ids to the unseen set. The direct local-create path records the returned id as known before installing the response and selects it explicitly, so its own creation is not unseen. Removal deletes an id from both sets; rename and reorder do not create unseen state.

The visible conversation controls show one compact numeric badge button with warning-toned treatment; its text, accessible name, and title carry the unseen count. Activating it acknowledges the current unseen set and hides the button. The touch Chat tab and collapsed desktop Chat strip keep the attention-dot idiom while Chat is hidden. Their accessible names include the unseen count, and a dedicated polite live region announces a newly increased count without reusing the conversation timeline's status message or moving focus.

Opening Chat does not clear unseen state. Activating the notification-dot button, pointer or keyboard activation of the native conversation chooser, or selecting an unseen conversation acknowledges the current set. A later arrival starts a new unseen set. State is deliberately page-local: after a full reload, the freshly fetched inventory is the baseline rather than a notification backlog.

Alternative considered: clear the indicator when Chat becomes visible. Rejected because a native select still displays only the selected title, so visibility alone does not expose the new options.

### 7. Treat selected-conversation deletion as an explicit terminal selection state

If reconciliation no longer contains the selected id, the client closes that conversation's SSE stream, preserves its local draft state, and replaces the chooser selection with a non-conversation placeholder explaining that the conversation was deleted elsewhere. The timeline does not get replaced by another conversation. Prompt, rename, attachment, configuration, and cancellation controls become unavailable for the missing selection while `New conversation` and the chooser remain usable.

An explicit chooser change or local creation leaves this state through the normal selection path. If the same id later returns to top-level inventory, as can happen when session parentage changes, the client also uses the normal selection path to fetch a fresh snapshot and restart the conversation stream while preserving local presentation state. Other inventory updates still avoid reloading a selected conversation that remained present throughout. Making the unavailable state explicit avoids an apparently spontaneous context switch.

### 8. Keep the public contract and generated clients synchronized

Document the new SSE operation and inventory event schema in `api/openapi.yaml`, `api/operations.yaml`, and `api/streaming.yaml`, and include the static child route in route-coverage and app-URL discipline checks. The event carries only a normalized change indication, so adding or removing provider metadata later does not alter the public contract.

## Risks / Trade-offs

- [The fixture prototype could drift from the eventual live states] -> Drive the production presentation functions from a test-only harness, then keep focused DOM and accessibility tests when the live controller is connected.
- [Manual approval can pause the apply workflow] -> Treat the pause as an intentional gate: retain the branch and task state, present the fixture, and resume only after explicit user approval.
- [OpenCode lifecycle shapes differ between native and compatibility streams] -> Normalize both `data` and `properties` envelopes, test all three lifecycle kinds, and invalidate conservatively when valid inventory metadata is incomplete.
- [An update-heavy provider could cause repeated list reads] -> Suppress timestamp-only changes, coalesce server signals, and serialize client reconciliation with a dirty bit.
- [A lifecycle event can race the authoritative fetch] -> Register before the stream's initial signal and schedule one trailing fetch for any signal received in flight.
- [A separate OpenCode process may not publish lifecycle events into this server's stream] -> Reconcile on stream restart, Chat activation, and page resume; the authoritative GET remains independent of event delivery.
- [Rebuilding a native select while it is open can be disruptive] -> Preserve the selected id and focus, avoid replacing unchanged options, and defer a cosmetic reorder while chooser interaction is active if browser behavior requires it.
- [Selected deletion can strand local draft data] -> Keep the presentation record until the user explicitly leaves the missing selection; do not let inventory pruning erase it during the transition.
- [A persistent inventory outage could be mistaken for a healthy list] -> Keep the last known list usable, reconnect with bounded backoff, and cover recovery rather than treating an errored fetch as an empty inventory.

## Migration Plan

1. Build the fixture-driven presentation in the real shell, complete manual desktop/touch review, and pause until explicit approval.
2. After approval, add provider lifecycle normalization and the adapter broadcaster without changing existing conversation APIs.
3. Add the authenticated inventory SSE route and API contract entries; old clients continue using the unchanged list and conversation streams.
4. Connect client reconciliation and unseen state to the approved presentation. The initial authoritative list remains backward-compatible and no persisted browser or server data requires migration.
5. Rollback removes the new route and client subscription; provider-owned conversations and existing presentation storage remain intact.
