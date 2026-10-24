## Context

See proposal.md, "Why". The current state that shapes this design:

- **The archived decision.** `own-chat-message-queue` (archive 2026-08-23, design D1–D3) made every busy submission Uatu-held. The reason was that the OpenCode server pinned then could not withdraw an admitted input, and that design's Non-Goals said steer "may return later as an explicit action". OpenCode 2.x's session inbox can now list, cancel, and re-deliver pending input, so that reason no longer applies to 2.x. This change reverses the "no steer" decision for 2.x only. Every other decision in that design still holds: the workspace owns the queue, admission is serialized, cancel leaves the queue dormant, queue state rides the snapshot and event stream, and the dock sits at the composer.
- **The adapter's queue** (`src/chat/adapter.ts`). `prompt()` (≈:897) holds a busy or behind-queue submission in `heldQueues` (≈:306), with its model, mode, and variant fixed at submission (≈:963–981). The bound is `MAX_HELD_MESSAGES = 20` and `MAX_HELD_TEXT_BYTES = 256 KiB` (≈:170). `scheduleDelivery`/`deliverNextHeld` (≈:1232–1294) release the head on an idle or completed transition, and `dormantQueues` pauses delivery. `removeQueued` (≈:1007) and `abort` (≈:1335) run through the per-conversation admission lane `enqueuePromptAdmission`. A staged revert dispatches the replacement immediately, ahead of the paused queue (≈:933–950). Every dispatch goes through `dispatchPrompt` (≈:1099), which calls `provider.prompt(..., delivery: "queue")` or `provider.command(...)`.
- **The provider seam** (`src/chat/provider.ts:281`). `prompt` is typed `delivery: "queue"`, and `interrupt(sessionId)` takes no options.
- **OpenCode 2.x provider** (`src/chat/opencode/v2/provider.ts`). `prompt` (≈:625) applies the model and mode through `session.switchModel`/`switchAgent`, then calls `session.prompt({ delivery, resume: true })`. `interrupt` (≈:766) calls `session.interrupt` without `resume`. Slash commands learn the inbox id that the server minted from the normalized `session.inbox.enqueued` user row (`reportEnqueuedUser`, ≈:567).
- **2.x normalization** (`v2/normalization.ts`). `session.inbox.enqueued` with `item.type === "user"` upserts a `user_message` timeline item at once (≈:188–204). `session.inbox.delivered` and `session.inbox.delivery.changed` are in `IGNORED` (≈:73–74). `session.inbox.cancelled` is not recognized.
- **The wire.** `QueuedMessage` (`src/chat/types.ts:837`) is `{id, text, queuedAt, requestId?, attachments?}`. `conversation.queue` (≈:884) restates the whole queue with `change.kind ∈ {held, removed, delivered}`. `parseQueuedMessages` and the queue-event case in `src/chat/validation.ts` (≈:614, ≈:676) reject unknown keys. `api/openapi.yaml` (≈:2307, ≈:2316) publishes both shapes. `WORKSPACE_API_REVISION` is **24** (`src/shared/version.ts:44`), and v0.8.0 shipped it.
- **Client.** `QueueDockRenderer` (`src/chat/timeline-renderer.ts:1116`) renders `#chat-queue` (`src/index.html:855`), and its only action is Remove (`ui.ts` ≈:3404). Enter submits at `ui.ts` ≈:4089, and no ⌥Enter binding exists. Per-device preferences use `presentationLocalStorage()` (`src/shell/presentation-storage.ts`).
- **OpenCode 2.0.28 server semantics.** These were read from its source and must not be assumed beyond it:
  - Default delivery is steer. Steers batch-promote at the next safe step boundary.
  - `interrupt` never deletes pending input. `resume: true` wakes steer-scope input only, and omitting it or passing false wakes nothing.
  - `inbox.update` from steer to steer answers 409. Updating to steer wakes execution.
  - `inbox.cancel` on a delivered or missing entry is a 204 no-op.
  - The inbox is persisted in SQLite.
  - Model and agent are session-level and resolved at delivery. Entries carry no model of their own.

## Goals / Non-Goals

**Goals:**
- A steer on 2.x reaches the running turn at its next step boundary, and until OpenCode delivers it the user can still withdraw it, switch it to queue, or edit it.
- One dock and one bound across both deliveries. Every client sees the same dock, and a message is never delivered twice.
- No change in delivery behavior for OpenCode 1.x. Claude Code keeps its current queue, plus Send now. Both receive the shared separate Send/Stop composer controls.

**Non-Goals:**
- Steering on Claude Code or OpenCode 1.x.
- Persisting the Uatu-held queue across a workspace restart. It stays in memory as today.
- Showing Uatu-held messages to OpenCode's TUI attached to the same session.
- Per-steer model, mode, or variant. OpenCode has no per-entry configuration.
- Showing OpenCode's non-user inbox entries (synthetic, compaction, move).
- Client 2.0.29 (#513) and #457.

## Decisions

### D1. Steers live in OpenCode's inbox; the queue stays Uatu-held

A steer is handed to OpenCode at once with `session.prompt({ delivery: "steer", resume: true })`, and OpenCode owns it until delivery. A queued message stays in the adapter's `heldQueues` for every agent, in strict submit order, including skills, slash commands, and `/reload`. This keeps #475's ordering for a queued `/reload`. When a held message is released on 2.x, the provider's existing `switchModel`/`switchAgent` calls apply its fixed model, mode, and variant first. That code path is already in `OpenCodeV2Provider.prompt`/`command`. This decision keeps it and pins it with a test.

*Alternatives rejected:*
- **Uatu-held steers, released by interrupting and resending.** This loses the running step's work, which is the opposite of steering.
- **OpenCode's native `delivery: "queue"` for queued messages.** OpenCode resolves model and agent at delivery and stores none per entry, so a queued message would lose the configuration it was submitted under. Commands and `/reload` cannot share OpenCode's inbox ordering with Uatu's own built-ins, and the 1.x and Claude paths would diverge from 2.x.
- **`session.inbox.update` to switch delivery.** Steer to queue would leave the message in OpenCode's queue, where it would again lose its frozen configuration. Queue to steer would need the message to already be in OpenCode's inbox. `inbox.update` stays unused and is annotated as such (D12).

### D2. Two positive capabilities: `steering` and `send-now`

`steering` is declared by the 2.x provider only. It gates the delivery choice, the Steer entries, the switch actions, and the steer treatment of undo replacements. `send-now` is needed because the shared surface may show a control only behind a declared capability ("One chat surface serves every agent"), and the agreed scope gives Send now to 2.x and Claude but not to 1.x. Both provider descriptors gain it. 1.x is unchanged, because not declaring a capability is the only way to leave it unchanged.

*Alternative rejected:* inferring Send now from `steering`. That would hide it on Claude, which #514 asks for.

### D3. Pending steers are tracked from inbox events, reconciled by `inbox.list`

2.x normalization turns inbox events into a new provider update kind, a pending-inbox delta, instead of timeline items:
- `enqueued` with `type: "user"` becomes *pending(id, text, attachments, delivery, at)*.
- `delivered` and `cancelled` become *settled(id, outcome)*.
- `delivery.changed` becomes *delivery(id, delivery)*.
- `synthetic`, `compaction`, and `move` entries yield nothing for the dock. Synthetic keeps its current timeline behavior.

The adapter keeps a per-conversation pending-steer map built from these deltas. It replaces the map from `session.inbox.list` when it attaches to a conversation (snapshot read) and after the provider stream reconnects, keeping `type: "user"` and `delivery: "steer"` entries only.

**Paused.** OpenCode does not report a paused state, so the workspace derives it. Pending steers stay paused after the session settles idle, interrupted, or completed until a later live phase or accepted wake supersedes that settlement. Each delayed acknowledgement can clear only the settlement owner observed before its request, never a newer one; wall-clock timestamps do not establish this ordering. This is the "stranded" rule. A held message is paused when `deliveryPaused()` is true: dormant, a revert mutation in progress, or a revert staged. Confirmed or ambiguous Stop application retains dormancy; only positive evidence of non-application can restore the prior delivery state.

### D4. A steer enters the timeline when OpenCode delivers it

`session.inbox.enqueued` no longer upserts a `user_message`. Normalization keeps the enqueued user payload in its memory, keyed by inbox id, and upserts the `user_message` (same `message:<id>` id, same `requestId`) when `session.inbox.delivered` arrives. The item's `createdAt` is the delivery event's time, so the row sorts after the output that preceded it (the order rule in "Timeline order follows the conversation's message order"). A delivered message that the memory never saw, for example after a restart, comes from history as today.

**Knock-on effect (must be handled, not a contradiction):** `reportEnqueuedUser` (≈:567) finds a slash command's server-minted id from the enqueued **timeline row**. It must key off the new pending delta instead, so `/command` row convergence and late-admission retirement keep working. The command tests in `v2/provider.test.ts` cover it. Idle prompts also lose their enqueued-time row. The adapter's acceptance row (`dispatchPrompt`) still shows the message at once, and the delivered row converges on the same id.

### D5. Wire shape

- `QueuedMessage` gains `delivery: "steer" | "queue"` (required on the wire) and `paused?: true`.
- `conversation.queue`'s `change.kind` gains `steered`, `switched`, `paused`, and `resumed`. `messageId` stays required, so a group pause or resume publishes one event per affected entry, which the bound limits to 20.
- `queued` lists steers first, in enqueue order, then held messages in submission order. A steer's `id` is its inbox id, which equals the provider message id that Uatu mints (`stableProviderId("msg", …)`), so Remove and Switch address one handle across the event and the snapshot.
- The prompt route body accepts an optional `delivery`. The prompt response's `held` becomes `pending` plus `delivery`.
- New routes:
  - `PATCH /api/chat/conversations/:id/queue/:messageId {requestId, delivery}` switches delivery.
  - `POST …/queue/:messageId/send-now {requestId}` sends a message now.
  - The existing `DELETE` removes a steer as well as a held message.

  All three are origin-protected, receipt-keyed, run in the admission lane, and are registered once in `src/server/routes.ts`. They are classified as internal session-child routes in the contract coverage, like the existing queue `DELETE`.
- `WORKSPACE_API_REVISION` goes from 24 to 25. The code is at 24 and v0.8.0 shipped 24, so this needs a new `api/CHANGELOG.md` entry. `api/openapi.yaml`'s `QueuedMessage` and queue-event schemas are updated, and `validation.ts` accepts exactly the new keys and kinds.

### D6. Prompt admission decision table (adapter)

| conversation | agent declares `steering` | text is a command | delivery | result |
|---|---|---|---|---|
| idle, nothing held, no revert | any | any | any | dispatch now (unchanged) |
| revert staged | yes | no | any | replacement sent as a **steer** (`resume: true`); pending entries stay |
| revert staged | no | any | any | dispatch now, ahead of the paused queue (unchanged) |
| busy, or something held | yes | no | steer | **steer**: counted against the bound, `provider.prompt(delivery: "steer")` |
| busy, or something held | otherwise | | | **hold** (unchanged) |

A steer submission does not apply the composer's staged model, mode, or variant to the session, because a mid-turn `switchModel` would retarget the turn the user is steering. The steer runs with the session's configuration at delivery, which the dock note states. The composer's staged selection stays staged for the next queued or idle submission.

Undo replacement on a steering agent: with `resume: true`, OpenCode promotes every pending steer at the next boundary. By decision, steers paused before the undo deliver in the same batch as the replacement, oldest first by inbox order, and only the Uatu-held queue stays pending. The confirmation counts pending steers and explains this batch effect without repeating their text.

### D7. Withdrawing a steer (switch to queue, edit, remove)

This runs in the admission lane:
1. Call `inbox.cancel({inboxID})`.
2. Wait for that id's settled delta. The wait is bounded, about 5 s. If it times out, the adapter decides from `inbox.list`: if the entry is absent, it treats it as delivered when history holds the message and as cancelled otherwise.
3. If the outcome is `cancelled`, the steer leaves the map. For switch-to-queue, it is inserted into `heldQueues` at its submission-order position by `queuedAt`, with the session's configuration at that moment frozen onto it. Removal and edit publish `removed`.
4. If the outcome is `delivered`, the adapter throws `SteerAlreadyDeliveredError`. The route answers 409 with a distinct code, the client shows "Too late — already delivered", and nothing is held or returned.

The 204-on-missing behavior is why step 2 waits for the event instead of trusting the response. A message is never both delivered and returned or held.

If confirmation remains unavailable, the route returns 409 with `steer-withdrawal-unconfirmed`. The entry stays inspectable with the existing `unconfirmed:true` marker. The browser preserves the draft and pending input and reads status without automatically retrying any mutation. For this withdrawal-specific uncertainty, **Retry withdrawal** explicitly repeats only cancellation against the original native inbox ID; edit, conversion and resubmission stay unavailable until confirmation. A per-entry action lock prevents duplicate clicks and conflicting actions while a request is in flight. Admission/resume uncertainty does not grant this exception.

Each in-flight browser action also records explicit terminal queue events for its conversation and inbox ID. A terminal event observed before an HTTP uncertainty response prevents that response from recreating the notice or pending entry. The fence lasts only for that action, is not an evictable global terminal cache, and is never inferred from passive queue absence.

Passive attach/reconnect reads never infer cancellation of an uncertain withdrawal from absence, even when visible history appears complete: it may exclude reverted delivery or predate cancellation. The adapter retains the entry until positive delivery evidence or settlement, or until an explicit withdrawal retry obtains sufficient post-cancellation inbox/history evidence through D7's bounded fallback. Inbox presence alone cannot settle withdrawal. Concurrent inbox snapshots fence delivered/cancelled entries until their reads finish, and delivered evidence from complete visible history or the live projection wins over a stale pending list. Retry classification is page-local, supplied by the scoped error rather than inferred from the shared public marker; a fresh page with only the generic marker stays conservatively read-only.

A switched-back message takes its submission-order position in the held queue, and the session's configuration at the moment of withdrawal is frozen onto it.

### D8. Switching a held message to steer and Send now

On a `steering` agent, Switch-to-steer and Send now are one operation. The message leaves `heldQueues` (`switched`) and goes through `provider.prompt(delivery: "steer", resume: true)` with its attachments. Its frozen configuration is not applied (D6): a steer runs with the session's configuration at delivery. This works mid-turn, when dormant, and when idle. A dormant queue stays dormant for the remaining held entries, because only a new submission resumes it.

For paused steers, one dock-level `Send N paused steers now` action calls `provider.interrupt(sessionId, { resume: true })`. Queued Send now (or Steer while running) explicitly names and confirms that it also sends paused steers. Confirmation uses an in-app dialog with Cancel as the initial focus; cancelling changes nothing. The remaining held queue stays dormant.

On a `send-now` agent without `steering` (Claude), Send now is accepted only when `turnActive()` is false. It dispatches that held message through `dispatchPrompt` under its frozen configuration, removes it (`delivered`), and leaves the rest held. Dormancy is unchanged, so the remaining entries wait for the next submission.

### D9. Cancel

`abort` calls `provider.interrupt(id, { resume: false })`. The seam's `interrupt` gains an optional `{ resume?: boolean }`. 2.x passes it through, and the 1.x and Claude providers ignore it. The Uatu queue goes dormant as today. Pending steers stay with OpenCode and read as paused (D3). Delivery restarts on a new message, on switching an entry to steer, or on Send now.

### D10. Composer and dock

- **Keys.** Desktop Enter steers. Touch Enter always inserts a newline, idle or busy, including a displayed command candidate; Send or Ctrl/Command+Enter explicitly steers. ⌥Enter queues where steering offers the choice. Commands and attachments still queue and idle submissions still deliver immediately.
- **Send and Stop (approved UX revision, 2026-10-15).** Send remains a visible, labelled submit button while busy, including on non-steering agents where it queues. Stop is a separate labelled button that only cancels the turn; it remains in place but disabled when idle. Empty drafts disable Send, not Stop. Cancelling disables duplicate Stop and Send until the cancellation request settles.
- **Send.** No delivery selector/dropdown or replacement menu. Tap steers; unchanged 500ms arming plus a two-second hold queues once, and release during the countdown cancels. Separate Stop and existing focus/gesture guards remain. Busy Send's accessible name and description state its actual action and fixed shortcuts; commands and attachments still queue.
- **Layout.** Send, Stop, selector and menu choices have at least 2.75rem targets; submission controls have 0.5rem gaps and visible focus rings. At content widths up to 30rem, steering-capable composers use settings/status above delivery/Send/Stop. Non-steering composers retain one compact rail. Above that width all share one rail. Routine lifecycle changes and menu opening keep footprints stable; V2 reserves the wider Stop-parent footprint before workers appear. Raw-touch hit checking ignores gap taps that browsers might retarget. Send uses a dedicated darker fill token for at least 4.5:1 white-text contrast in either theme.
- **Fixed default (approved review-round-4 decision, 2026-10-22).** Steer is not configurable. Legacy `chat-delivery` values are ignored without storage deletion/migration or changes to other browser settings. No delivery Settings path, extra layout height, wire field or API revision change is introduced. Explicit HTTP/dock choices and unsupported-agent queue behavior remain unchanged. This supersedes the original per-device preference decision and completed historical tasks implementing it.
- **Cancellation lock.** The shared form-submit handler refuses all submission paths while cancellation is pending, not just the disabled Send button. It captures and clears a one-shot delivery override before any early return; a blocked Alt+Enter cannot leak into the next message, and an accepted override remains local across asynchronous attachment staging.
- **Dock.** Workers and Pending are matching sibling cards with independently scrolling content and always-visible headers. They share a measured height budget, never an outer scroller. The explicit independent-pane request supersedes the earlier shared-scroller contract; see the compact-chat-background-steering design for short-content redistribution and physically insufficient bands. Desktop normally uses 40% of actual panel height (maximum 25rem); touch uses 35% of visual height, 25% from 48rem width, or 24% during hardware editing. Existing reading/safe-area budgets remain except when whole actions physically require space. The bottom fade appears only with pending content below. Expanded entries retain Steer/Queue badges, Paused chips, timing labels and the steer accent edge.
- **Entry actions.** Remove and Edit remain per entry with contextual accessible names. Queued entries offer Steer or Send now as supported; steers offer Queue. Paused steers share one batch action in Pending's content pane, available even when entries are collapsed; the count header stays consistent with Workers. Commands get no Steer action. Existing approved compact targets, independent gaps, focus outlines, silent successes and operation-scoped refusals/uncertainty remain unchanged.
- **Note.** Expanded pending steers show one model/mode-at-delivery note. Compact keyboard/short-landscape mode may hide that routine note, but deliberate expansion keeps entries/actions accessible in the independent pane. Replacement safety and the 44px paused-steer batch Send action remain available even when entries are collapsed.
- **Edit.** Edit calls the remove or withdraw mutation first and loads the composer only on success, so a failed withdrawal ("already delivered") leaves the draft untouched.

Independent-review refinements: duplicate-text and image-only actions include a human-readable client-local pending-message number. Each entry retains that discriminator through reordering, switching and sibling removal; state is bounded by live entries. Successful mutations explicitly announce each event once, even with repeated words, while routine paints remain deduplicated.

**Expanded-card budget amendment.** The dock percentages above and prior 40% phone/35% tablet reading reserves now apply only when both cards are collapsed. With either expanded, use remaining measured panel pixels after chrome, composer/notices and safe-area padding: reserve 20% bounded to 32–96px for conversation, yielding to measured whole actions down to the lesser of 16px or 10% of the remaining region where physically possible. Both long panes share the remainder; short/collapsed panes return unused capacity. No blank fill or forced conversation jump is introduced. The compact-chat-background-steering design defines the shared policy and short-band behavior.

**Compact touch geometry.** A software-keyboard visual height at most 450px, or a landscape band at most 390px with width at least 600px, uses a single 44px-input/submission row and hides routine model/status chrome. At visual heights at most 450px the header drops its identity row. The outer surface cannot scroll; viewport application resets its scroll offset while preserving the transcript's coordinated owner. Height budgets use measured panel/visual geometry, not vh/dvh. Software-keyboard mode and short landscape hide non-queue work tracks/Continue; counts, batch Send and replacement safety remain visible. Hardware editing retains `calc(0.45rem + env(safe-area-inset-bottom))` without double software-keyboard insets. Existing request-answer covered-chrome behavior is unchanged.

**Reading intent and motion.** Dock growth reserves the final bounded layout height, then reveals the added area with a 160ms clip animation; reduced motion applies it immediately. Animating layout height was rejected after scroll traces reproduced native clamps racing prompt-echo removal and losing bottom pinning. Remote updates retain the semantic reading anchor; explicitly sending still requests latest. Touch-only hover/active feedback, readable hints, 44px subagent-open targets and hiding the rail beside expanded tracks preserve usable controls within the shared budget.

### D11. Bound

The existing check counts pending steers plus held messages against 20 messages and 256 KiB of text. Steers raised by other clients (D3) count too. This makes the bound a property of the dock, not of who submitted.

### D12. SDK coverage annotations

`src/chat/opencode/sdk-coverage.ts` holds the annotations for both generations. The `2.x:session.inbox.*` "ignored" reason is replaced by mappings for `enqueued`, `delivered`, `cancelled`, and `delivery.changed`. The operations `session.inbox.list`, `session.inbox.cancel`, and `session.interrupt` (with `resume`) are annotated as used. `session.inbox.update` is annotated as deliberately unused, for the D1 reason. The dashboard (#480) is regenerated by `bun run coverage:agents`.

### D13. Test harness

The chat Playwright suites (`tests/e2e/chat-queue.e2e.ts` and the others) run against `FakeE2EChatService` (`tests/e2e/chat-service.ts`), which replaces the whole chat service. No fake OpenCode server exists in `tests/e2e/`; the only scripted 2.x server is the `fetch` stub in `src/chat/opencode/v2/provider.test.ts`. This change adds `tests/e2e/opencode-v2-fake.ts`. It is a small scripted HTTP plus SSE server that implements the 2.0.28 routes the provider calls (session, prompt with delivery and resume, inbox list/cancel, interrupt, switchModel/switchAgent, event stream), and it is driven through `/__e2e/chat` control calls. `tests/e2e/server.ts` registers it as an extra agent served by the real `ChatAdapter` and `OpenCodeV2Provider`. The Claude Send now flow uses the existing `FakeE2EChatService` (`claude` agent) extended with `send-now`. *Alternative rejected:* extending `FakeE2EChatService` with steering. It is cheaper, but it would not exercise the adapter or provider in e2e.

The real manual pass targets installed OpenCode 2.0.29, as approved on 2026-10-15. This changes only the real verification target: the SDK and scripted fake remain pinned to 2.0.28, and fake-server checks do not count as the real manual pass.

## Risks / Trade-offs

- [The wait for withdrawal confirmation could hang if the stream is down] → Bounded wait plus an `inbox.list`/history decision (D7). An uncertain result leaves the steer visible. The user can explicitly retry withdrawal only; no automatic cancellation, editing, conversion or original-message resubmission occurs.
- [The derived paused state could disagree with OpenCode after a missed idle] → The paused state is recomputed from the projection status on every snapshot and reconnect, so at worst the label is stale and delivery is unaffected. Send now on a steer that is not actually stranded is a harmless wake.
- [Undo replacement batches older paused steers with the replacement] → By decision (D6). A count-only confirmation explains the batch before submission.
- [The timeline row moving from enqueue to delivery changes 2.x command id convergence] → D4 re-keys `reportEnqueuedUser`, and the existing command tests guard it.
- [`delivered` with no remembered payload, for example a workspace restart while a steer was pending] → The row comes from history on the next snapshot. Until then the dock entry clears and the row is absent, the same as today's restart behavior for in-flight work.
- [The OpenCode TUI on the same session does not see Uatu-held messages] → Accepted limitation, as agreed.
- [The Uatu queue is lost on workspace restart, while steers survive in OpenCode's SQLite] → Accepted for the queue. Steers re-appear through `inbox.list` on attach (D3).
- [Separate actions need more space] → A width-based second rail on narrow panels trades composer height for large labelled targets and usable settings. Stop never replaces Send, and opening the selector never changes geometry. Desktop and Chromium/WebKit touch tests cover state stability, selection-only behavior, edge/gap taps, focus, and non-steering enqueue.

## Migration Plan

This is one deployable change with no data migration. The workspace API revision goes from 24 to 25, with an `api/CHANGELOG.md` entry. Strict consumers (web, Desktop WebView) ship the same assets, and the freshness handshake makes a stale pairing diagnosable. Rollback is a revert. The release note is a visible `feat(chat)`, because steering is new user-facing behavior.

## Open Questions

None.
