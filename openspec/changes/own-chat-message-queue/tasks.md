# Tasks: own the chat message queue

## 1. Server-owned queue in the chat service

- [x] 1.1 Add a per-conversation held-message queue to the chat service/adapter (id, text, submission order, staged configuration), stored server-side; submissions while the conversation is running/sending are held instead of admitted, and the prompt response reports the message as queued with its held id
- [x] 1.2 Drop steer delivery: `adapter.ts` no longer chooses `"steer"`; all OpenCode admissions use `delivery: "queue"` (busy sends are simply not admitted yet)
- [x] 1.3 Admit held messages on the running→idle transition, one at a time in submission order, through the existing serialized admission lane (`enqueuePromptAdmission`), re-holding the head if the conversation reports running again before acceptance
- [x] 1.4 Make cancellation leave the queue dormant: no admission on cancel-induced idle; the next user submission appends to the queue and resumes delivery from the head
- [x] 1.5 Implement remove-held-message in the service through the same serialized lane: removes an undelivered message, refuses with a "no longer held" outcome once admitted; idempotent under retried request ids via the receipts mechanism
- [x] 1.6 Unit tests colocated with the service/adapter covering hold-on-busy, ordered admission, cancel dormancy, resume-on-submit, remove, remove-after-delivery refusal, and retried remove idempotency

## 2. Workspace API contract

- [x] 2.1 Add the remove-queued-message route to `src/server/routes.ts` (origin-protected under cookie auth, conversation-ownership validated, client request id required)
- [x] 2.2 Include held messages in submission order in the conversation snapshot, and add queue events (held / removed / delivered) to the ordered conversation event stream with normal sequence numbering so replay, gap detection, and resync apply
- [x] 2.3 Bump `WORKSPACE_API_REVISION` from 6 to 7 in `src/shared/version.ts` and update the published API contract/documentation for the new route, prompt-acceptance shape, snapshot field, and event types
- [x] 2.4 Server tests: snapshot carries the queue, queue events are sequenced and replayable, cross-origin removal is rejected, foreign-conversation removal is rejected

## 3. Client queue presentation

- [x] 3.1 Extend the client projection with queue state sourced from snapshot + queue events; delete the session-local `queued` set in `ui.ts` and the in-timeline "Queued — the agent is still working" tag
- [x] 3.2 Render held messages pinned above the composer in the accepted-drafts position — submission order, visibly queued, per-message remove control — distinct from in-flight optimistic drafts; wire the remove control to the new API operation
- [x] 3.3 Update composer status copy for the queue model (no "Steering…" / "Steer accepted"); a queued acceptance announces that the message is held
- [x] 3.4 Client tests: queue renders from a cold snapshot (reload mid-run shows held messages), queue events add/remove/deliver entries, delivered message leaves the pinned block and appears as a normal head-of-turn user message

## 4. Message-major live ordering

- [x] 4.1 ~~Stamp normalized items with an order anchor~~ Superseded by design decision 7 (refined during implementation): the snapshot comparator is a stable `createdAt` sort, so live insertion reuses that comparator directly and no new anchor field or normalization change is needed
- [x] 4.2 Insert live upserts at their snapshot position in `applyChatEvent` (`projection.ts`) instead of appending (`insertInConversationOrder`), so live-applied order equals snapshot order
- [x] 4.3 Tests: a late update for an earlier moment renders in place, and equal timestamps keep provider arrival order (`projection.test.ts`)

## 5. End-to-end verification and release hygiene

- [x] 5.1 Run the app and demonstrate the queue UI (queue two messages while the agent works, remove one, let one deliver) before the long e2e pass
- [x] 5.2 E2E coverage in `tests/e2e/` (feature-named file): messages queue at the composer while streaming, survive reload, are removable, deliver in order on idle, and cancellation leaves them dormant
- [x] 5.3 Full `bun test` and `bun test:e2e` pass
- [x] 5.4 Prepare the PR with the Release Please override block (`BEGIN_COMMIT_OVERRIDE` / `chore(chat): stabilize the unreleased chat queue before release` / `END_COMMIT_OVERRIDE`) since chat is unreleased, and reference issue #277
