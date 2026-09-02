## Context

See proposal.md — Why. Findings come from a live audit on 2026-09-02 (Claude Code
2.1.258, `@anthropic-ai/claude-agent-sdk` 0.3.x) of a Haiku turn in a throwaway
workspace driven with Playwright, plus a read of the SDK's type declarations
against `src/chat/claude/`.

Facts the design rests on:

- `result.usage` is documented "MAIN AGENT LOOP ONLY … per-turn": it sums every
  API call of the turn. The normalizer currently emits it as the `usage:` carrier
  the meter reads, hence 3.8M "in context" against a 1M window. Each `assistant`
  message's `usage` is one call's occupancy. `getContextUsage()` answers even on a
  promptless session with `totalTokens`, `maxTokens`, `percentage`, `model`, and
  categories.
- `supportedModels()` returns five rows whose `displayName` omits the version
  ("Opus (1M context)", "Fable"); the version lives in `description`
  ("Fable 5.1 · …") and the wire id in `resolvedModel`. The CLI accepts any full
  id passed as `model` (probed: `claude-opus-4-8` → 1M window, `claude-opus-4-6`
  and `claude-sonnet-4-6` → 200k), and echoes an unknown string back unvalidated.
- The provider retires a session on the first `result` with no pending turn
  (`provider.ts` readSession). Background tasks die with it; their completion
  landed in the native transcript as unconsumed `queue-operation` entries.
- Five system subtypes carry background work: `task_started`, `task_progress`,
  `task_updated`, `task_notification` (edges, with `ambient` flag), and
  `background_tasks_changed` (level: full id set, per-process, nothing at startup).
  `session_state_changed` `idle` is documented as the authoritative turn-over
  signal. `stopTask(id)` exists.
- `request_user_dialog` and MCP `elicitation` are control requests the host must
  answer; the provider registers no `onElicitation` and no dialog handler.
- `tool_progress` (elapsed seconds, heartbeat), `stream_event` (behind
  `includePartialMessages`), `compact_boundary` (pre/post tokens), `status`
  (compacting), `api_retry`, `rate_limit_event`, `model_refusal_fallback`,
  `memory_recall`, `rename_session`, and transcript `ai-title` entries are all
  currently in the ignored set or never read.
- `describeToolDetail` has no `bash` case; Claude's Bash rows fall to generic.
- The permission card's scope sentence is hard-coded to OpenCode's semantics
  with a comment saying a second agent needs its own.

## Goals / Non-Goals

**Goals:**
- Every user-visible gap from the audit closed, in three phases that each leave
  `main` shippable and each map to one PR.
- New signals ride the existing seam (`NormalizedProviderUpdate`,
  `ConversationItem`, capabilities) so the shared renderer stays agent-neutral and
  OpenCode can adopt the same kinds later without a second path.
- Nothing asserted that the session did not report: no invented token figures,
  no fabricated model versions, no phantom "done" for a task still running.

**Non-Goals:**
- Reworking OpenCode's own normalizer beyond what the shared kinds require.
- MCP server management (`mcpServerStatus`, toggles, reconnect) and plugin or
  skill reloads — no user-facing ask yet.
- Fast mode, adaptive-thinking toggles, or `setMaxThinkingTokens`: effort covers
  the reasoning control the picker already exposes.
- Hub-level aggregation of background work across workspaces.

## Decisions

### D1. Meter source: latest assistant usage now, `getContextUsage()` as the expanded truth
The `result` usage carrier is dropped. Live and stored paths both emit a
`usage:` carrier per assistant message (the stored path already does), so the
meter's tail scan finds the latest single-call occupancy with no renderer change.
At turn end the provider calls `getContextUsage()` once and emits a
`context_report` update (total, max, categories) that the meter shows in its
expanded view and uses as the fill when present; a `compact_boundary` emits the
same update from `post_tokens`.
*Alternative:* `getContextUsage()` only. Rejected because it cannot be recomputed
from stored transcripts on reopen, and the spec requires the fill on open.
*Alternative:* keep `result` and divide by call count. Rejected: guesswork.

### D2. Model naming: derive a versioned name from the catalog row
`modelsFromCatalog` builds `name` as: `displayName` if it already contains a
digit; otherwise the leading segment of `description` before " · " (which is the
versioned name in every current row), with the 1M marker preserved
("Opus 5 (1M context)"). `resolvedModel` is the fallback when neither yields a
version. The static manifest keeps versioned names as it does now. The composer
button, "Started new conversation" line, and usage attribution all read
`ChatModel.name`, so one derivation fixes every surface.
*Alternative:* show `description` in the composer. Rejected: too long for the
one-line composer layout the spec fixes.

### D3. "More models" is a static, clearly separated section plus a typed id
A second manifest lists the app-only ids with hand-maintained versions and
windows (`claude-fable-5` 1M, `claude-opus-4-8` 1M, `claude-opus-4-7`,
`claude-opus-4-6`, `claude-sonnet-4-6` 200k, effort tiers per the SDK docs).
They are appended to the live catalog under a distinct group label
("More models") so the catalog's own rows stay first and unmistakable. The picker
gains a free-text id row under that group; a typed id is sent verbatim as
`model` and any CLI rejection surfaces as that turn's failure. The context window
for a typed id is unknown (`contextLimit` absent) and the meter shows "?" as it
already does for an unknown limit.
*Alternative:* probe validity with a promptless session. Rejected: the CLI echoes
any id back, so the probe proves nothing.

### D4. Bash gets a first-class tool detail
`describeToolDetail` gains `case "bash"`: subject is `input.command` (first line,
bounded), body shows the command in a code block, the `description` as meta, then
the bounded output. Group summaries already call `toolSubject`, so the collapsed
line reads "Bash ./hello.sh · Bash ls -la · Read README.md" once subjects exist;
`groupSummary` is extended to include up to N subjects before falling back to
counts. `run_in_background: true` marks the row as a background launch so the
Phase 2 task row can link to it by `tool_use_id`.

### D5. Permission scope copy comes from the agent descriptor
The scope sentence moves from the renderer into a per-agent string carried on the
agent's chat descriptor (`ChatAgent.permissionScopeNote`). OpenCode keeps its
verified sentence. Claude Code's states the truth of how the provider implements
"Allow always" (session-scoped suppression within the conversation; verify
against the current `brokerToolUse` before writing the sentence — the spec
forbids asserting more).

### D6. Dialogs and elicitations reuse the question card
Both are pending interactions with a prompt and a structured answer, which is
what the `question` item already models. The provider registers `onElicitation`
and a `request_user_dialog` handler that emit `question` items tagged with a
`source` ("dialog" | "elicitation") and the raw schema; the client renders known
`dialog_kind`s as choices and unknown ones as a JSON-schema form (the existing
question form handles fields). Session end abandons them through the same
`abandonInteractions` path permissions use.

### D7. Session lifetime follows the idle signal and the background set
`LiveSession` gains `backgroundTasks: Set<string>` replaced on every
`background_tasks_changed` (ambient ids excluded) and reset when the process
(re)starts. Retirement requires `pendingTurns === 0 && backgroundTasks.size === 0
&& state === "idle"`, where `state` is fed by `session_state_changed`. The
`result` message still emits the `completed` status for the turn, but a new
conversation-level `working` state ("background") is emitted while the set is
non-empty, so the adapter's `liveTurns` and the composer distinguish
idle / working / background. CLIs that never emit the level signal (older
versions) fall back to today's behavior because the set stays empty.

### D8. Background tasks are one item kind, updated in place
`task_started` upserts a `background_task` item (id `task:<task_id>`,
description, type, `tool_use_id`, status running); `task_progress` /
`task_updated` re-upsert with progress and the backgrounded flag;
`task_notification` re-upserts with the terminal status and summary. The live
list in the composer is the projection's set of running `background_task` items;
the timeline shows the same items as rows (running rows collapsed into the
composer list, settled rows in place). Stop is a new provider action
`stopTask(conversationId, taskId)` on the chat API, gated by a new
`"background-tasks"` capability that only the Claude agent declares.

### D9. Waking the model on task completion
Two candidate paths were considered; the spike (task 5.1, output in
`screenshots/phase2-spike-d9-output.txt`) decided it:
1. **CLI-driven.** Newer CLIs hold the result while background agents run
   ("heldBackResult") and may continue the turn themselves.
2. **Host-driven.** On a non-ambient `task_notification` with no pending turn,
   the provider pushes a synthetic user envelope through the existing prompt
   queue, flagged so the normalizer emits no `user_message` for it.

**Answer (2026-09-02, Claude Code 2.1.258, SDK 0.3.252): path 1.** With the
SDK input stream kept open, a backgrounded `sleep 8 && echo done` produced
`result` #1 ("STARTED") at +4.8s, then at +11.4s `background_tasks_changed`
(empty set), `task_updated` (completed), `task_notification` (completed,
output file), and — with no envelope from the host — a second `system/init`,
a Read of the output file, "FINISHED done", and `result` #2 at +15.4s. The
CLI starts the follow-up turn on its own. The audit's unconsumed
`queue-operation` entries were the consequence of the provider retiring the
session on the first result: with no process left, the queued turn never
ran. So path 2 is not built. What the provider must do instead:

- keep the session alive while the background set is non-empty (D7);
- treat the unprompted follow-up as a turn: `running` when its first
  message arrives with no accepted prompt pending, `completed`/`failed` on
  its result, so the composer and the held-message queue behave as they do
  for any turn;
- the second `init` is the same session (same id); it re-reports the model
  and slash commands and is handled like the first.

No `session_state_changed` message was observed in the spike, so the level
signal cannot be a precondition for retirement on this CLI: a session is
retired on a result (or on a later `idle` signal, where one is sent) when no
prompt is pending and the background set is empty.

### D10. Streaming rides `stream_event` behind `includePartialMessages`
The provider sets `includePartialMessages: true` and the normalizer folds
`content_block_delta` text deltas into the current `message:<uuid>` item using
the existing coalescer/text-reconciler path OpenCode uses. Thinking deltas update
the `reasoning` item's status only (no partial text) to keep reasoning rows
cheap. The completed `assistant` message remains the truth and overwrites the
streamed text.

### D11. Status signals map onto the routine status region
`api_retry` → composer status "retrying" with the HTTP status in the title;
`status` with `compacting` → "compacting"; `rate_limit_event` → a `warning`
item with kind and `resetsAt` (already a shared kind), plus a composer badge
while `rejected`; `model_refusal_fallback` → `memory.lastModel` swap so later
attribution is truthful, and a `warning` item naming both models;
`memory_recall` → a `reasoning`-styled item labelled "Recalled from memory".
None of these add new fixed-width text to the composer; they are named states
the existing status region already supports.

### D12. Titles: `ai-title` from the transcript, `rename_session` live
The transcript reader picks the last `ai-title` entry as the session title;
the live stream's `rename_session` control updates it. A user rename stored by
UatuCode (`conversation-rename` capability) wins, as it does today.

### D13. Phasing
Phase 1 (correctness), Phase 2 (background work), Phase 3 (status and
streaming), each its own PR against `main`, in that order. Phase 2 depends on
Phase 1 only for the Bash `tool_use_id` link (D4); Phase 3 depends on Phase 1's
meter carrier (D1) for compaction. Every phase adds the fixture-driver events
the e2e harness needs so the Playwright suite covers it without a real model.
Every task that changes what the user sees ends by saving a screenshot under
the change's `screenshots/` folder (README there names the convention): the
reviewer spots regressions from the folder instead of running a session. The
`before-*` set from the audit is the baseline each `phaseN-*` capture answers.

## Risks / Trade-offs

- [`background_tasks_changed` ordering vs edge bookends is unspecified] → the
  level signal owns liveness and retirement; the edges only decorate rows. A
  missing bookend can leave a row "running" until the level clears, never the
  reverse.
- [Holding sessions alive for background work keeps a `claude` process per
  conversation] → bounded by the CLI's own task timeouts; workspace shutdown
  still terminates them; the composer shows what is holding the process.
- [Host-driven wake-up (D9 path 2) invents a turn the user did not type] → not
  built: the spike proved the CLI wakes itself (D9); the follow-up is an
  ordinary turn in the timeline, attributed to the task row that preceded it.
- [`getContextUsage()` is one more control round-trip per turn] → fired after
  the result, never awaited by the turn; failure leaves the per-message carrier.
- [Static "More models" manifest drifts as Anthropic ships models] → the section
  is labelled as UatuCode's own list, the typed-id row covers anything missing,
  and the manifest is a one-line edit.
- [Streaming multiplies event volume] → deltas are coalesced by the existing
  client-side coalescer; the SSE path already carries OpenCode's deltas.
- [`request_user_dialog` kinds are an open set] → unknown kinds render the
  payload as a generic form; the dialog cannot be silently dropped because the
  control request would otherwise time out and fail the tool visibly.

## Open Questions

- (answered) D9: the current CLI (2.1.258) starts the follow-up turn on its own
  for a settled Bash background task under the SDK; see D9.
- Exact `dialog_kind` values the CLI sends today, for tailored rendering; the
  generic form covers the rest.
