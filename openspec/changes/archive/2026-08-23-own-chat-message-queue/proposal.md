# Own the chat message queue

## Why

Messages submitted while the agent is working drift up into the middle of the streaming turn instead of staying next to the composer (issue #277, release-blocking for v0.6.0 / PR #257), and once submitted they cannot be taken back. The projection appends live items in arrival order, so a message accepted mid-turn is buried by the output that keeps streaming after it — the snapshot path already orders message-major, so the misplacement only shows while the agent works. Removal cannot be delegated: the pinned OpenCode server API has no operation to withdraw an admitted input (its message endpoint is read-only, and its own TUI offers only whole-session abort), and uatu currently admits busy sends as *steers*, which the running turn consumes irrevocably.

## What Changes

- **Busy sends are held by uatu, not admitted to OpenCode.** While a conversation is running, submitted prompts enter a uatu-owned, server-side queue in the chat service instead of being admitted as OpenCode steers. When the conversation goes idle, the service admits the next held message. Steer-while-running delivery is dropped (**BREAKING** for the unreleased workspace chat API surface only; the chat feature has never shipped in a stable release).
- **Queued messages stay with the composer.** Held messages render pinned directly above the composer — the position accepted drafts already occupy — with an explicit queued state, instead of entering the timeline mid-turn. They join the timeline only when actually admitted, which lands them at the head of their own turn.
- **Queued messages are removable.** Each held message carries a remove affordance; removing it deletes it from the uatu queue before admission. The workspace API gains a remove-queued-message operation, and the API revision increases.
- **Queue state is shared across clients.** The conversation event stream broadcasts queue changes (enqueue, remove, admission) so web and desktop clients render the same queue, and a reload or reconnect mid-run still shows held messages.
- **Live timeline ordering becomes message-major.** Items applied from live events are placed in provider order (parent message, then part order) rather than arrival order, matching the snapshot path and the OpenCode TUI, so a message can never be buried by output that belongs to an earlier turn.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: The prompt/steer/cancel requirement changes — busy submissions queue in uatu (removable, composer-adjacent) instead of steering the running turn. The workspace API requirement gains the queue's remove operation and queue-state exposure. The conversation-updates requirement gains queue events so clients stay consistent. Timeline ordering while streaming becomes message-major.

## Impact

- **Client:** `src/chat/ui.ts` (composer, queued rendering, the session-local `queued` set goes away), `src/chat/timeline-renderer.ts` (pinned queue block), `src/chat/projection.ts` (message-major insertion, queue state), `src/chat/client.ts`.
- **Server:** `src/chat/service.ts` and `src/chat/adapter.ts` (held queue, admission on idle, remove operation, queue events; `delivery` decision at `adapter.ts:464` changes), `src/server/routes.ts` (new route), API revision bump in the published contract.
- **Provider:** `src/chat/sdk-v2-provider.ts` stops sending `delivery: "steer"`.
- **Desktop:** consumes the new queue events/operation through the same workspace API (no native changes expected beyond WebView content).
- **Release notes:** chat is unreleased, so the fix PR body needs a `BEGIN_COMMIT_OVERRIDE` / `chore(chat): …` override per the repo's release-note discipline.
