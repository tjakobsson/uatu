## Why

The Claude Code chat agent shipped in #317 works end to end, but a real session
exposes it as unpolished next to the official clients: the context meter reports
several times the window (it reads the turn's summed `result` usage as occupancy),
models are named without versions and the app's "More models" set is unreachable,
Bash rows carry no command, background tasks and their completion are invisible
and are killed with the session, and a stack of SDK signals the CLI emits
(compaction, retries, rate limits, progress, refusal fallback, titles, dialogs)
is dropped. This change closes every gap found in the 2026-09-02 live audit in one
change, delivered in ordered phases so each lands independently reviewable.

## What Changes

Phase 1 — correctness of what is already shown
- Context meter reads window occupancy from the most recent assistant message's
  usage (input + cache read + cache write of one API call), never the per-turn
  summed `result` usage; a `compact_boundary` resets it to `post_tokens` and the
  authoritative `getContextUsage()` breakdown is fetched at turn end where the
  session supports it.
- Model names carry their version everywhere the model is named (picker row,
  composer button, "Started new conversation" line, usage attribution), derived
  from the catalog's `description`/`resolvedModel` when `displayName` lacks it.
- A curated "More models" section offers the ids the Claude apps offer but the
  CLI catalog omits (Fable 5, Opus 4.8, 4.7, 4.6, Sonnet 4.6) plus a free-text
  model id entry, since the CLI accepts any full id.
- Bash tool rows show the command as their subject and the description in the
  body; group summaries inherit the subject so "Bash ×5" becomes readable.
- The permission card's persistent-approval scope line is agent-specific: the
  OpenCode sentence stays for OpenCode, Claude Code gets its own truthful one.
- `request_user_dialog` and MCP `elicitation` control requests get handlers,
  surfacing as interaction cards instead of stalling or silently failing.

Phase 2 — background work
- `task_started`, `task_progress`, `task_updated`, `task_notification`, and
  `background_tasks_changed` become timeline and status state: a background-work
  indicator while tasks run, a completion row when one settles, and a Stop action
  per task (`stopTask()`).
- A session with live background tasks is not idle: it stays alive until the
  background set empties, and the turn-over signal becomes `session_state_changed`
  `idle` rather than the first `result`.
- A completed background task's notification reaches the model: the workspace
  wakes the session so the agent can act on it, the way the terminal CLI does.
- `tool_progress` heartbeats give running tool rows an elapsed-time readout; the
  live tail of a running turn is kept compact.

Phase 3 — richer status and streaming
- Assistant text streams token by token (`includePartialMessages`).
- `status` (compacting), `api_retry`, and `rate_limit_event` surface in the
  routine composer status region; `model_refusal_fallback` re-attributes the turn;
  `memory_recall` shows inline.
- Conversation titles follow Claude Code's own generated title (`rename_session`
  / transcript `ai-title`) instead of the truncated first prompt.
- Plan utilization from the SDK's usage request is shown beside the context
  meter when the login has plan limits.

No breaking changes to the chat wire protocol; new item kinds and status states
are additive and gated by declared capabilities.

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `claude-code-chat`: context usage measures one API call's occupancy and
  resets on compaction; models are named with version and the app-only ids are
  offered; Bash activity names its command; permission scope copy is Claude
  Code's own; dialog and elicitation requests are brokered; background tasks are
  surfaced, kept alive, stoppable, and their completion wakes the model; turn
  end follows the session's idle signal; retries, rate limits, compaction,
  refusal fallback, and memory recall surface; titles follow Claude Code's own.
- `opencode-chat` (the shared chat surface): background work is presented as a
  composer status state and timeline rows; tool rows name a shell command as
  their subject; the context readout may present agent-reported categories and
  a plan-utilization figure; persistent-approval scope copy is agent-specific;
  streaming assistant text updates in place for every agent that streams.

## Impact

- `src/chat/claude/normalization.ts`, `provider.ts`, `models.ts`, `transcript.ts`
  (new event kinds, session lifetime, catalog augmentation, title capture).
- `src/chat/types.ts`, `validation.ts`, `provider.ts` seam (new item kinds:
  background task, compaction marker, dialog request; new status states).
- `src/chat/tool-detail.ts`, `timeline-renderer.ts`, `ui.ts`,
  `configuration-picker.ts` (Bash subject, meter source, model labels, more
  models + custom id, background-work chip, streaming).
- `src/chat/adapter.ts` (turn-over on idle signal, background set per session).
- `@anthropic-ai/claude-agent-sdk` stays at the current major; `Query` methods
  used grow from 9 to about 14 (`getContextUsage`, `stopTask`,
  `backgroundTasks`, `streamInput`, the usage request).
- Specs `claude-code-chat` and `opencode-chat`; e2e fixtures under
  `tests/e2e/chat-*` gain background-task and streaming scenarios.
