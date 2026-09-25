## Why

Claude Code can promise itself a future turn — `ScheduleWakeup` for a
self-paced loop, `CronCreate` for a schedule, `/loop` for either — and uatu
silently breaks that promise. Those session crons are not background tasks:
the SDK never announces them on the message stream, so when the turn's
result arrives the workspace sees no pending prompt and an empty background
set, retires the session, and the CLI process exits with the cron inside it.
The tool row shows the wakeup being scheduled; nothing ever fires. The agent
reasons as if it will be woken; the user sees a conversation that went quiet.

## What Changes

- The Claude Code provider learns about session crons through the SDK's
  `Stop` hook, which carries `session_crons` for the session that just
  finished a turn, and treats a non-empty set like live background work: the
  session is held instead of retired.
- A new conversation state, **scheduled**: no turn is running and nothing is
  executing, but the session holds one or more future wakeups. It is distinct
  from `background` (which is running work with stop actions) and from idle.
  The composer names it, and a list shows each wakeup with its prompt,
  whether it recurs, and when it next fires.
- Each wakeup appears in the timeline as its own row that follows its life:
  pending → fired (linking to the turn it started), cancelled, paused, or
  lost.
- When a wakeup fires, the CLI starts a turn on its own. uatu already handles
  agent-initiated turns for background notifications; the fired turn is
  presented as a wakeup — labeled by its origin through the SDK's
  `UserPromptSubmit` hook `source` — not as a message the user typed.
- The user can cancel any one wakeup, or release the whole scheduled
  session. Ending a process does not end a `CronCreate` cron: the CLI
  rebuilds those from the transcript when the session is resumed (spike).
  So uatu enforces a cancel itself. It persists the cancelled cron ids per
  conversation, blocks their fires through the `UserPromptSubmit` hook, and
  never holds a session for them. A cancelled wakeup never fires again from
  uatu, and no model turn is spent to get there. Release cancels every
  wakeup, then retires the process.
- Honest limits, by kind. A `ScheduleWakeup` lives only as long as its
  process: if the workspace stops or the process exits first, its row reads
  lost with a notice. A `CronCreate` cron is paused instead. It fires again
  once the conversation runs, and its row says so.
- A conversation opened without a live session lists its paused crons,
  read from the transcript, each with a Cancel. Nothing resumes on its own:
  the workspace does not start sessions for their schedules.
- `durable: true` on `CronCreate` is downgraded to session-only in SDK
  sessions, so uatu never sees a durable cron.
- The Claude Code agent declares a new `scheduled-wakeups` capability; the
  conversation status enum, the timeline item family, and the user-message
  item gain the corresponding shapes. **BREAKING** on the closed workspace
  API schema: the workspace API revision is bumped.
- The agent coverage report's `ScheduleWakeup`, `CronCreate`, `CronDelete`,
  and `CronList` rows move from behavior-missing to dedicated once this
  lands (that change's annotations are edited here, not there).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities
- `claude-code-chat`: "A Claude Code conversation runs as its own agent
  session" — session lifetime also follows pending wakeups; "Claude Code
  capabilities are declared truthfully" — scheduled wakeups join the declared
  list; plus a new requirement, "Scheduled wakeups are held, shown, fired,
  and releasable".

## Impact

- `src/chat/claude/provider.ts` — `hooks` on the SDK query (Stop,
  UserPromptSubmit), a per-session cron set, the hold/retire rule, release,
  loss on process exit, wakeup-turn labeling.
- `src/chat/types.ts`, `src/chat/provider.ts`, `src/chat/adapter.ts`,
  `src/chat/validation.ts` — `scheduled` status, `scheduled_wakeup` item,
  `origin` on user messages, `scheduled-wakeups` capability.
- `src/chat/composer-status.ts`, `src/chat/timeline-renderer.ts`, `src/chat/ui.ts`
  — the scheduled state, the wakeup list with release, the wakeup rows and
  the fired-turn label.
- `src/chat/claude/transcript.ts` — a stored wakeup turn replays with its
  origin where the transcript records it, and a conversation's paused
  `CronCreate` crons are derived from its transcript.
- The Claude provider's durable state — the per-conversation set of
  cancelled cron ids that it blocks.
- `src/server/routes.ts`, `src/chat/adapter.ts`, `src/chat/client.ts` — the
  internal release and per-wakeup cancel operations.
- `api/openapi.yaml`, `api/contract.json`, `api/CHANGELOG.md`,
  `src/shared/version.ts` — workspace API revision 21 with a Migration note.
- `src/chat/claude/sdk-coverage.ts` — the wakeup tools' annotations (from
  the `agent-coverage-report` change) are retired.
- Depends on: nothing in `agent-coverage-report` except the annotations file
  existing; the two changes can land in either order, with the annotation
  edit adjusted accordingly.
- Precondition: a short spike confirming the SDK behavior this design reads
  from the type declarations (task 1.1). If the spike contradicts it, the
  design is revised before further tasks.
