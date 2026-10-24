## Why

A follow-up typed while an OpenCode turn runs can today only wait in Uatu's queue until the turn ends, so the user cannot redirect the agent mid-turn: the only correction is Cancel and resend (tjakobsson/uatu#518). Steering was removed on purpose by `own-chat-message-queue` (archived 2026-08-23) because the OpenCode server then pinned could not withdraw an admitted input. OpenCode 2.x now has a session inbox whose entries can be listed, cancelled, and switched between steer and queue delivery, which removes that reason for 2.x. Separately, a held message cannot be sent ahead of a dormant queue (#514, "Send now").

## What Changes

- OpenCode 2.x conversations gain **steering**: a message submitted while the agent works can be delivered into the running turn at its next step boundary. It goes to OpenCode's own inbox, where OpenCode keeps it, and the composer dock shows it until OpenCode delivers it. This reverses the archived "no steer" decision for OpenCode 2.x only. OpenCode 1.x (deprecated) and Claude Code get no steering.
- A new positive agent capability, `steering`, is declared by the OpenCode 2.x agent only. Every steering control depends on it.
- A second positive capability, `send-now`, is declared by the OpenCode 2.x and Claude Code agents but not by 1.x. The shared surface needs it to show Send now on Claude Code and hide it on 1.x (see design.md D2).
- **Queue** delivery stays Uatu-owned for every agent, in strict submit order. Skills, slash commands, and `/reload` always use the queue. Before releasing a held message on 2.x, Uatu applies the model, mode, and variant fixed when the message was submitted.
- Composer: a visible **Send** remains available while busy for every agent, with a separate **Stop** button. On a `steering` agent, tap Send and desktop Enter steer; touch Enter inserts a newline and Ctrl/Command+Enter steers. ⌥Enter queues where offered; holding Send queues after unchanged 500ms arming plus a two-second countdown, with release during the countdown cancelling. Keyboard delivery is fixed, not configurable: legacy per-device defaults are ignored without deleting browser settings. No delivery Settings path, selector/dropdown or added height is introduced. Accessible Send names its busy delivery and shortcuts. Commands and attachments still queue, explicit HTTP/dock delivery remains available, and idle delivery remains immediate. Submission targets retain the successor compact-density exceptions and 8px mutation gaps. Compact touch layouts retain pending safety information.
- The dock becomes one list in submit order, with steers first, sticky delivery counts, a taller bounded scroll area and overflow-only fade. Leading Steer/Queue badges, separate Paused chips and plain timing labels distinguish state. Actions quote their message for accessibility and have at least 36px desktop / 44px touch targets. The existing bound (20 messages / 256 KiB) counts both deliveries.
- Dock height uses the actual desktop panel or a shared visual-height budget for all touch work tracks, including a smaller hardware-editing cap. Compact keyboard/short-landscape summaries retain pending counts, paused-batch Send and replacement warnings. Reserving final dock height before a reduced-motion-aware reveal preserves reading intent and bottom pinning.
- Per-entry actions: Remove; Edit (returns text and attachments); Queue → Steer, which is "Send now" on 2.x; Steer → Queue. An already-delivered withdrawal produces one neutral notice and never duplicates delivery. A dock-level **Send N paused steers now** wakes all paused steers. Queued Send now/Steer explicitly names and confirms the same wake effect. On Claude Code, Send now delivers one held entry while dormant or idle. Undo's batch warning uses counts instead of message names.
- Cancel stops the turn without waking the session. The Uatu queue goes dormant as it does today, and pending steers are shown as paused.
- Undo/revert: on a `steering` agent the replacement prompt is sent as a steer, and pending entries stay.
- 2.x normalization stops putting a user message on the timeline when `session.inbox.enqueued` arrives. The message joins the timeline when `session.inbox.delivered` arrives.
- **BREAKING (unreleased API)**: queued messages on the wire gain `delivery` and `paused`, the prompt mutation accepts a delivery, new queue-entry mutations are added (change delivery, send now), and `WORKSPACE_API_REVISION` is incremented.
- The SDK coverage annotations for the 2.x inbox events and operations are updated (dashboard #480).

Closes tjakobsson/uatu#518 and #514 (Send now for OpenCode 2.x and Claude Code, not 1.x). Independent of #513 (client 2.0.29). #457 is out of scope.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: The prompt/queue/cancel requirement now allows mid-turn delivery as an explicit steer on agents that declare `steering`. The workspace API and the queue events now carry the delivery and paused state, plus switch and send-now operations. Undo/redo sends its replacement as a steer. Held attachments also apply to steers and to Edit. New requirements cover the steering lifecycle and Send now.
  The composer layout requirement is revised to separate Send, delivery selection, and Stop; responsive rows replace the unconditional one-line constraint.
- `chat-agents`: The shared surface's capability-gated differences now include steering and Send now, which appear only for agents that declare `steering` or `send-now`.

## Impact

- Code: `src/chat/types.ts` (`ChatCapability`, `QueuedMessage`, `conversation.queue` change kinds), `src/chat/provider.ts` (prompt delivery, interrupt resume, inbox operations), `src/chat/adapter.ts` (held queue plus pending steers, cap, cancel, switch race, send now), `src/chat/validation.ts`, `src/chat/service.ts`, `src/server/routes.ts` (new queue-entry routes), `src/chat/client.ts`, `src/chat/opencode/v2/provider.ts` and `v2/normalization.ts`, `src/chat/claude/provider.ts` (send now only, no capability), `src/chat/ui.ts` and `src/chat/timeline-renderer.ts` (composer keys, split menu, dock), `src/index.html` and `src/styles.css`, `src/shared/version.ts` (`WORKSPACE_API_REVISION`), `src/chat/opencode/sdk-coverage.ts`, `api/openapi.yaml`, `api/CHANGELOG.md`.
- Tests: unit tests next to each module. Playwright `tests/e2e/chat-queue.e2e.ts` and a new steering spec, plus the e2e test harness (see design.md, "Test harness"). The real manual pass targets installed OpenCode 2.0.29 (approved 2026-10-15); the SDK and fake-server contract stay pinned to 2.0.28.
- APIs: `WORKSPACE_API_REVISION` goes from 24 to 25 (24 shipped in v0.8.0). This needs a new `api/CHANGELOG.md` entry, and the `QueuedMessage` and `conversation.queue` schemas in `api/openapi.yaml` must be updated. The new queue-entry routes are session-child routes, so they are classified as internal exclusions and not published as public operations. Every strict consumer (web, macOS Desktop WebView) uses the same assets and regenerates from them.
- Dependencies: none new. Uses `@opencode/client` 2.0.28, which is already pinned.
- Release notes: chat steering is new user-visible behavior (a `feat`).
