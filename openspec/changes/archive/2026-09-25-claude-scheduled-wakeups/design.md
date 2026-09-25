## Context

See proposal.md — Why. What the code and SDK give us today:

- Session lifetime is decided in `src/chat/claude/provider.ts` on a turn's
  `result`: retire unless `pendingTurns > 0`, `queuedTurns > 0`, an
  unprompted turn is in flight, or `backgroundTasks.size > 0`
  (`idleExceptReads`). The background set is fed by the
  `background_tasks_changed` system message. An emptied set arms a grace
  timer before idle.
- Agent-initiated turns are already recognized: after the first result, an
  `assistant`/`stream_event`/`init` frame with no pending prompt sets
  `unpromptedTurn` (D9 of the background-tasks work). A fired wakeup is such
  a turn.
- The SDK's `query()` accepts `hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>`
  with in-process callbacks. `StopHookInput` carries
  `session_crons?: SessionCronSummary[]` — `{ id, schedule, recurring, prompt }`,
  `schedule` a cron expression, a one-shot wakeup encoding a single fire
  time. `UserPromptSubmitHookInput.source` distinguishes `loop_wakeup`,
  `schedule_wakeup`, `system`, `sdk`, `user`; the SDK notes payloads may omit
  it while it rolls out.
- No SDK stream message announces crons. `background_tasks_changed` does not
  include them.
- The conversation status enum, item union, and capability list are closed
  schemas in `api/openapi.yaml` (workspace API revision 20).
- The composer's background presentation: `composer-status.ts` maps
  `background` + declared capability to a named state with a label from the
  live `background_task` items.

## Goals / Non-Goals

**Goals:**
- A session with pending crons stays up; a fired wakeup runs and is shown for
  what it is.
- The user can always see that a session is being held and can end it.
- A wakeup the user cancelled never fires again from uatu, whatever the CLI
  rebuilds.
- Loss and dormancy are reported as what they are, never hidden.

**Non-Goals:**
- Persisting crons across process or workspace restarts, or restarting
  sessions to keep a schedule running (D13). The CLI owns the crons; uatu
  reports their fate and enforces a cancel.
- A user-side scheduler or UI to create wakeups.
- Deleting a cron from the CLI's own store. The SDK has no control request
  for it, and uatu never writes Claude Code's storage; a cancel is enforced
  by blocking (D12), not by removal.
- OpenCode parity — OpenCode has no equivalent primitive today.

## Decisions

**D1 — Read crons from the `Stop` hook, not from the tool stream.**
Register `hooks.Stop` on the session's query; the callback records
`session_crons` (replace semantics, like the background set) on the live
session and emits `scheduled_wakeup` item upserts. Alternative: parse
`ScheduleWakeup`/`CronCreate` tool_use inputs as they stream — rejected: the
tool input is the *request*, the hook payload is what the CLI actually holds
(clamping, `stop: true`, `CronDelete`, `/loop` all resolve there).

**D2 — Hold rule extends `idleExceptReads`.** `session.wakeups.size > 0`
joins the background-set check in every retirement decision, including the
grace-timer path. The status emitted on a result with no background work
but pending wakeups is `scheduled`; with both, `background` wins (running
work is the more urgent fact) and the wakeup list is still shown.
Ordering: the hook is expected to fire before the `result` message (the
model stops, then the SDK reports). The spike (task 1.1) confirms this. If it
does not, retirement on `result` is deferred until the Stop hook for that
turn has been seen or a short bound expires — the same shape as the
context-report wait that already sits before `retireIfIdle`.
*Spike:* confirmed on every turn of every run: `hook:Stop` precedes
`result` (the CLI awaits Stop hooks before ending the turn, since a Stop hook
may block the stop). No deferred-retirement fallback is built. Crons change
only at a Stop, so a cron set is always current when its turn's result is
read. A fired one-shot is absent from the next Stop's `session_crons` —
exactly like a cancelled one — so the row's outcome is decided by whether
a wakeup turn was attributed to it since the previous Stop: attributed →
`fired`, not attributed → `cancelled`. A recurring cron stays in the set
after it fires.

**D3 — `scheduled` is a new status, `scheduled_wakeup` a new item.**
Reusing `background_task` was considered: zero new wire shapes, but every
row would offer a stop action that cannot work and the composer would say
"1 task running" for nothing that runs. A separate item:
`{ type: "scheduled_wakeup", wakeupId, prompt, recurring, schedule, nextFireAt?, status: "pending" | "fired" | "cancelled" | "paused" | "lost", firedTurnId? }`
(`paused` added by D10).
`nextFireAt` is computed from the cron expression by a small five-field
evaluator (next match after now; one-shots match once) — display only, no
dependency. Recurring rows stay `pending` and update `nextFireAt` after each
fire; the fired turn is linked from a per-fire timeline notice rather than
by flipping the row. That per-fire notice is the wakeup header itself (D4):
it names the wakeup it came from, and a one-shot's row links to it.
The item also carries an optional `message`, the notice on a `lost` row.
*As built (task 5.2):* the four scheduling calls also get a purpose-built
tool row (`schedule` detail kind): "Schedule wakeup · in 1 min" with the
prompt and reason, "Schedule task · every */5 * * * *" with repeats/once,
"Cancel scheduled task", "List scheduled tasks". That is what moves them to
dedicated in the coverage report.

**D4 — Wakeup turns are labeled by hook `source`.** Register
`hooks.UserPromptSubmit`; when `source` is `loop_wakeup` or
`schedule_wakeup`, the session marks the next user-role message as a wakeup
turn and the `user_message` item carries `origin: "wakeup"` with the
`wakeupId` where the prompt matches a known cron. When `source` is absent
(roll-out caveat), a user-role message that arrives with no pending prompt,
no background notification envelope, and pending crons is attributed the
same way — the same inference D9 already makes for unprompted turns. The
timeline renders `origin: "wakeup"` as a wakeup header, not a user bubble.
*Spike:* `source` is absent on both CLIs observed (2.1.261 bundled with the
SDK, 2.1.281 installed), for typed prompts and fired wakeups alike, so the
inference is the operative path and `source` is honored when a later CLI
sends it. A fired turn reaches an SDK host as `command_lifecycle(started)` →
`UserPromptSubmit` (the cron's prompt verbatim, a fresh `prompt_id`) →
`system/init` → assistant → Stop → result. There is **no `user` message on
the stream**, so there is nothing to "mark": the provider mints the wakeup
`user_message` itself from the hook, as it mints typed prompts at accept
time, id `message:wakeup:<prompt_id>`. Attribution: a `UserPromptSubmit`
with no accepted prompt pending whose text equals a known cron's prompt (or
whose `source` says wakeup). The `init` that follows already starts the
unprompted turn (D9 of background tasks), so status and retirement need no
new path.

**D5 — Release is session retirement.** A "Release" action on the scheduled
state calls the existing interrupt/retire path; the process exit marks
pending rows `cancelled` (user intent) rather than `lost`. There is no
per-cron cancel; the list says the release ends every wakeup.
*Revised by D12:* retirement alone does not end a `CronCreate` cron, which
the next resume rebuilds. Release is now "cancel every wakeup (D12), then
retire", and each wakeup also has its own Cancel.
*As built:* Release has its own chat operation,
`POST /api/chat/conversations/:id/release`, rather than riding cancel.
Cancel reports `interrupted` and is a no-op without a running turn, and
Release has to end in `idle`. The route is part of the internal workspace
protocol (the `workspace-api` exclusion), so no public operation is added.
The provider refuses a release while a turn runs or background work is
live, because either would die with the process.

**D6 — Loss is the process-exit edge.** The existing stream-ended branch
that settles background tasks ("died with the process") also settles
wakeups as `lost` with the notice text, and emits `idle`. Workspace shutdown
goes through the same exit.
*Revised by D10:* only a `ScheduleWakeup` is lost at that edge. A
`CronCreate` cron is paused.

**D7 — Wire revision.** New status value, new item type, new optional
`origin` on `user_message`, new capability `scheduled-wakeups`: the closed
schemas make each of these breaking for strict consumers. Workspace API
revision 20 → 21 in `api/openapi.yaml` (`x-uatu-revisions`, version, summary),
`api/contract.json`, `src/shared/version.ts`, and an `api/CHANGELOG.md`
section with a Migration note ("treat unknown status as idle-like, ignore
unknown item types"). CI's compatibility step is run locally before the PR.

**D8 — Transcript replay.** Whether Claude Code records a wakeup's origin in
the stored transcript is unknown until the spike. If it does, the transcript
reader maps it to `origin: "wakeup"`; if not, replayed wakeup turns read as
plain user messages and the spec's "where the transcript records their
origin" clause is the honest limit. Either way no pending row is replayed;
paused crons are derived separately (D11).
*Spike:* the store keeps a fired prompt as a `type: "user"` record with
`isMeta: true` and string content equal to the cron's prompt. CLI 2.1.281
also writes `turnOrigin: "scheduled"` on it (`"sdk"` on a typed SDK prompt);
2.1.261 writes no `turnOrigin`, and `promptSource` differs between them
(`"sdk"` on 2.1.261, `"system"` on 2.1.281), so it is not a signal. No
`origin` field is written. Today's replay drops `isMeta` records, so a
wakeup turn replays as an assistant reply with no prompt at all. The reader
maps a user record with `turnOrigin: "scheduled"` to a `user_message` with
`origin: "wakeup"`; for a record without `turnOrigin` (2.1.261), an `isMeta`
user record whose text equals the `prompt` of an earlier
`ScheduleWakeup`/`CronCreate` call in the same transcript (`ScheduleWakeup`
input `prompt`, `CronCreate` input `{ cron, prompt, recurring }`) is
attributed the same way. No `wakeupId` on replay: no row is replayed to
point at. Other `isMeta` records stay dropped.

**Spike record (task 1.1).** `scripts/spike-claude-wakeups.ts`, SDK 0.3.261,
three runs: `ScheduleWakeup` 60 s on CLI 2.1.261 and 2.1.281, recurring
`CronCreate "* * * * *"` on 2.1.281. Trimmed evidence (event order, hook
payloads, transcript records) is in `tests/fixtures/claude-sdk/spike-wakeups.json`.
Also observed: a one-shot's `schedule` encodes minute and hour only
(`"3 20 * * *"`), rounded up to a whole minute (the `ScheduleWakeup` result's
`toolUseResult.scheduledFor` is that minute in ms); neither tool asks
`canUseTool`; closing the query before the fire time ends the cron — the
transcript did not grow past the fire minute on either CLI (D6 holds).

**D9 — Revival (second spike, `scripts/spike-claude-cron-revival.ts`).**
On CLI 2.1.281, resuming a session rebuilds its `CronCreate` crons from the
transcript. A recurring cron fired within a minute of an idle resume, with
no prompt. A one-shot `CronCreate` resumed before its time fired on time.
A cron removed by `CronDelete` did not come back. A fresh session in the
same folder got none of them. A `ScheduleWakeup` one-shot did not come
back, whether resumed before or after its fire time. `durable: true` is
downgraded: the result reads `durable: false`, "Session-only", and no
`scheduled_tasks.json` is written. A one-shot `CronCreate` whose fire time
passed while no process ran is dropped on resume: it did not fire in the
90 s after an idle resume, and the next `Stop` listed no crons (task 6.1,
scenario S4). Unverified: the 7-day auto-expiry applied on rebuild.

**D10 — Paused versus lost is decided by the scheduling tool.**
`session_crons` does not name the tool that made a cron. The provider
learns it from the stream: a `CronCreate` result carries the cron `id`
(`toolUseResult.id`), and a `ScheduleWakeup` result carries none. When the
process ends with wakeups pending (stream end, failure, workspace
shutdown), a `ScheduleWakeup` row reads `lost` with the D6 notice. A
`CronCreate` row reads `paused`, with a notice that it fires again once the
conversation runs. `paused` is a new `scheduled_wakeup` status, added
inside revision 21, which has not shipped. A paused row carries no
`nextFireAt`, because nothing fires until a session runs.

**D11 — A conversation lists its paused crons when opened.**
With no live session, the provider derives the conversation's paused
crons from its transcript: every `CronCreate` result (id from the result;
prompt, cron, and recurring from the call's input), minus ids a
`CronDelete` call removed, minus one-shots whose fired prompt appears later
in the transcript, minus one-shots whose fire time (the first match after
the call) has already passed, since the CLI drops those (D9), minus
cancelled ids (D12), minus crons older than the CLI's 7-day expiry. A
paused one-shot's notice says it fires only if the conversation is running
by its time. The adapter seeds them as `paused` rows, like the live
background list. The conversation's status stays idle: nothing is held.
The composer lists them with "fires again when this conversation runs"
and a Cancel per row. Once a session starts and reports its crons, the
live rows replace the derived ones.

**D12 — Cancel is enforced by blocking, not by removal.**
The provider keeps a per-conversation set of cancelled cron ids with
their prompts, in its durable state file next to the staged-revert records.
Every retirement decision and every `scheduled` status ignores a cancelled
id: it never holds a session. When a `UserPromptSubmit` hook carries the
prompt of a cancelled cron, the hook answers
`{ decision: "block", reason }`. The spike showed a blocked fire makes no
model call and leaves the cost total unchanged. It still emits
`system/init`, `system/informational`, and a `result`, and writes one
`system/informational` record ("UserPromptSubmit operation blocked by
hook") to the transcript. The provider swallows those frames: no running
status, no turn notification, no row. Replay already drops system records
other than a compaction. A blocked fire runs no `Stop` hook, so the CLI
keeps listing the cron; the filter handles that. Cancel works on a live
row (the session keeps running for the rest) and on a paused row (no
process is needed). Release is cancel-every-wakeup followed by
retirement. The set drops an id once the transcript no longer yields that
cron (D11). The block matches by prompt text, so a live cron sharing a
cancelled cron's prompt would be blocked as well.

**D13 — No automatic resume.** Starting sessions at workspace start to
keep schedules running would hold processes and spend tokens on schedules
nobody watches. Paused crons stay paused until the user runs the
conversation.

## Risks / Trade-offs

- [Stop hook fires after `result`] → ruled out by the spike (D2); no
  fallback is built.
- [Hook registration changes CLI behavior] → hooks are additive; the
  callbacks return `{ continue: true }` and never block. Verified by the
  existing provider test suite running with hooks registered.
- [A recurring cron holds a process indefinitely] → that is what the agent
  asked for; the composer shows it and Release ends it. Workspace shutdown
  still owns the process.
- [`source` absent — on every CLI the spike saw] → D4's inference path is
  the operative one; a CLI-injected prompt that matches no known cron is not
  attributed and gets no header (it stays the unprompted turn it is today).
- [Cron evaluator wrong on DST/timezone edges] → display only; the CLI fires
  on its own clock. Stated as "about" in the label.
- [Held processes count against the hub's capacity] → same as background
  work today; no new limit introduced.
- [A cancelled cron still exists inside the CLI] → the agent's own
  `CronList` keeps showing it, so the agent may believe it is scheduled.
  Its fires are blocked and the timeline says it was cancelled. Telling the
  agent is a later option.
- [Revival rules beyond the spike] → the 7-day expiry and missed one-shot
  `CronCreate` behavior are unverified (D9). A derived paused row that the
  CLI does not in fact rebuild shows a schedule that will not fire. The
  next session's first `Stop` corrects it.

## Migration Plan

1. Task 1.1 spike; adjust D2/D4/D8 from findings and record them in this
   file before continuing.
2. Land the change with the revision bump.
3. Rollback: revert; sessions retire on result as before, and the agent's
   wakeups silently fail again — the pre-change behavior.

## Open Questions

- Answered by D9: `durable: true` is downgraded to session-only in SDK
  sessions. The tool row's "kept across restarts" wording for a durable call
  is misleading and goes (task 6.7).

- Whether the SDK exposes the cron's absolute next fire time anywhere (the
  type declares only the expression). If a later SDK adds it, D3's evaluator
  is replaced without spec change.
