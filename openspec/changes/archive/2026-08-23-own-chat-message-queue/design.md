# Design: own the chat message queue

## Context

See proposal.md — Why. The mechanics that produce the current behavior:

- `src/chat/adapter.ts:464` picks `delivery = running ? "steer" : "queue"` and admits every submission to OpenCode immediately via `client.v2.session.prompt` (`sdk-v2-provider.ts:352`). A steer is folded into the running turn at its next step boundary and can never be withdrawn — the pinned OpenCode server (SDK 1.18.21) exposes no operation on an admitted input; `/api/session/{sessionID}/message/{messageID}` is GET-only, and OpenCode's own TUI offers only whole-session abort.
- On acceptance the client splices the message into the timeline at the current end of `items` (`confirmAcceptedDraft`, `src/chat/projection.ts:55`) and tags it via a session-local `queued` set (`ui.ts:189`). Live `item.upsert` events append in arrival order (`projection.ts:81`), so turn output that keeps streaming lands *after* the spliced message and buries it — issue #277. The snapshot path already orders message-major (`sdk-v2-provider.ts:302`), which is why a reload self-heals.
- The `queued` tag is client-session state: a reload mid-run forgets it.
- OpenCode's admitted-input lifecycle (its `SessionInput` module) is admit → promote, with unpromoted inputs lying dormant after an abort until the next run wakes the session. There is no remove.

Constraints: the chat feature and its workspace API are unreleased (no stable consumers; breaking is acceptable with the release-note override). The workspace API serves multiple concurrent clients (web, desktop WebView) over the existing snapshot + ordered-event-stream contract with idempotent mutations (receipts keyed by client request ids).

## Goals / Non-Goals

**Goals**
- Busy submissions never reach OpenCode until the conversation is idle; until then they are server-held, composer-adjacent, and removable.
- One queue, owned by the workspace server, identical on every client, surviving reload and reconnect.
- Live-applied timeline order equals snapshot order.

**Non-Goals**
- No steer affordance in this change (may return later as an explicit action; dropping it here is user-confirmed scope).
- No durability of held messages across a workspace-server restart (in-memory is acceptable; see Open Questions).
- No upstream OpenCode changes and no dependence on unpinned OpenCode behavior.
- No TUI-badge parity work beyond what the queue design already yields — held messages are not timeline items, so the TUI's positional QUEUED derivation is unnecessary.

## Decisions

**1. The queue lives in uatu's chat service, not the client and not OpenCode.**
`ChatService` (`src/chat/service.ts` / `adapter.ts`) keeps an ordered list of held prompts per conversation. Submissions while `status` is running/sending are stored there and acknowledged as `queued` with the held-message id; nothing is admitted to OpenCode.
*Why not OpenCode-native `delivery: "queue"`:* admitted inputs cannot be removed (see Context), which fails the requirement outright.
*Why not client-local:* removability demands the authority be where all clients converge; a client-local queue diverges across web/desktop and dies on reload.

**2. Admission on idle, serialized with everything else.**
The service already observes conversation status from the provider event stream and already serializes prompt admission (`enqueuePromptAdmission`). On a transition to idle, the service admits the queue head with `delivery: "queue"` through that same serialization, waits for acceptance, and repeats one at a time. Removal requests run through the same lane, so remove-vs-admit cannot race: a message is either still held (removed, never sent) or already admitted (removal refused with a "no longer held" outcome). Retries of both prompt and remove stay idempotent through the existing receipts mechanism.

**3. Cancel leaves the queue dormant.**
Cancelling the active turn does not trigger admission; held messages stay visible and removable. The next user submission appends to the queue and restarts delivery from the head. This mirrors OpenCode's own semantics (aborted sessions leave unpromoted inputs dormant until the next wake) and preserves the removal window that motivated the change — cancel-then-instant-admit would leave no moment to prune the queue.

**4. Queue state rides the existing snapshot + event contract.**
Snapshots gain the held messages in submission order; the ordered event stream gains queue events (held / removed / delivered) with normal sequence numbers, so replay, gap detection, and resync behave exactly as for other conversation events. Clients derive the pinned block purely from this state — the session-local `queued` set in `ui.ts` is deleted, along with the in-timeline "Queued — the agent is still working" tag (a held message is never a timeline item; a delivered one is an ordinary head-of-turn user message).

**5. Rendering docks the queue to the composer, outside the timeline scroll.**
Held messages render in a dedicated `#chat-queue` strip directly above the composer (muted fill, dashed edge — deliberately not the sent-message accent), reconciled by a small `QueueDockRenderer`. Refined during implementation from "reuse the accepted-drafts position at the timeline tail": in-flow rendering leaves the queue wherever the transcript ends — mid-window for a short conversation — while the dock keeps it against the input whatever the scroll position or transcript length, which is what "adjacent to the composer" actually means visually. Each entry shows submission order, the queued marking, and its remove control; in-flight optimistic drafts stay in the timeline as before.

**6. `WORKSPACE_API_REVISION` 6 → 7.**
New route for removal (origin-protected, ownership-validated, request-id idempotent, registered in `src/server/routes.ts`), queued acceptance shape on the prompt response, held messages in the snapshot, and new event types. Strict consumers regenerate; the feature is unreleased so this is the cheap moment to break.

**7. Message-major ordering for live upserts.**
`applyChatEvent` inserts a new item at its conversation position instead of appending. Implementation refinement: the snapshot path's canonical order is a *stable sort by `createdAt`* (`history()` deliberately avoids an id tiebreaker so provider part order survives), so introducing a separate parent-message anchor would disagree with the very order the requirement says live must match. Instead, a new live item is inserted where that stable sort would place it — before any item with a later `createdAt`, after all items with an equal or earlier one — which preserves arrival order (provider part order) within a message and needs no new wire field. Items keep their position on in-place upserts, exactly as before. This makes live order equal snapshot order (the ADDED spec requirement); the mid-turn burial mechanism itself is closed structurally by the hold queue.

## Risks / Trade-offs

- [Held messages lost if the workspace process dies] → Accepted for this change (queue is short-lived by nature); called out as an Open Question for a follow-up. The client's transport-failure draft restoration still covers the submission that was in flight.
- [Status flapping could admit early — e.g., idle blip between steps or during reconnect] → Admission keys off the service's own normalized status transitions, runs through the serialized admission lane, and admits one message at a time; a conversation that reports running again before acceptance simply re-holds the head (it was never sent).
- [Dropping steer removes a capability some flows used ("Steering...")] → User-confirmed scope. Cancel + queue covers the correction workflow; an explicit steer action can be reintroduced later without unwinding this design.
- [Ordering anchors missing for some normalized item kinds (notices, synthetic ids)] → Fallback is current behavior (append); the invariant enforced is only "never render an earlier message's item after a later message's items," which anchored items satisfy and unanchored items cannot violate mid-turn once busy sends are held.
- [Desktop WebView is a second consumer of the new contract] → It consumes the same web assets and workspace API; the revision bump plus the freshness handshake keep a stale pairing diagnosable rather than silently wrong.

## Migration Plan

Single deployable change; no data migration (queue is new, in-memory). No stable release contains the chat feature, so external compatibility is a non-issue; strict workspace-API consumers regenerate against revision 7. Rollback is a revert. The PR body carries the Release Please override (`BEGIN_COMMIT_OVERRIDE` / `chore(chat): …`) because this stabilizes unreleased functionality.

## Open Questions

- Should held messages survive a workspace-server restart (persist to the state dir)? Deferrable: the spec is silent on restart durability, and adding persistence later changes neither the API contract nor the UX shape.
