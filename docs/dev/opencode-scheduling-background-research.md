# OpenCode V2 scheduling and background-task support

Research date: 2026-11-09. Uatu baseline: `14b60e77`, with
`@opencode/client` pinned to `2.2.5` in [package.json](../../package.json).
This is an integration assessment, not an implementation or a live-provider test.

## Summary

OpenCode V2 has a native, experimental **session scheduler**, not just background
subagents or a third-party cron plugin. It schedules a prompt to wake an existing
session. The current session's exposed tools include `schedule_create`,
`schedule_list`, `schedule_pause`, `schedule_resume`, and `schedule_delete` under
`opencode`; the official HTTP contract also exposes schedule management. [O1, O2]

Uatu already supports much of OpenCode's background-worker workflow. The main
missing capability is first-class native scheduling: inventory, lifecycle,
controls, wakeup attribution, and recovery. Existing Claude wakeup UI is useful
groundwork, but its process-lifetime and host-local-cron assumptions are not a
complete representation of OpenCode schedules. [U1–U4]

## What the scheduler can do

The official contract and exposed tool definitions describe: [O1, O2]

| Capability | Native behavior |
| --- | --- |
| One-shot wakeup | After a duration (`when.in`) or at a specified time (`when.at`). |
| Repeating wakeup | Every duration (`when.every`) or on a cron expression (`when.cron`). |
| Timezone | Explicit `tz`; schedule records expose the resolved timezone. |
| Conditional execution | Shell or Code Mode checks under `if` or `until`; shell checks can test exit success, `is`, `matches`, or `changes`. |
| Bounded lifetime | `ends.after`, `ends.at`, or `ends.times`. |
| Controls | List, inspect, pause, resume, permanently delete; neither the reviewed HTTP routes nor the exposed tools define schedule edit/update. |
| State and diagnostics | `active`, `paused`, or `done`; `nextDueAt`, `remainingRuns`, `runCount`, `lastFiredAt`, `lastOutcome`, and `lastOutput` where available. |

Outcomes include `fired`, `late`, `checked`, `expired`, `skipped`, `disabled`, and
`failed`. A completed condition check is therefore not necessarily a model turn.
Resuming an overdue paused one-shot fires it once immediately; a repeating
schedule resumes at its next slot. Those resume semantics do **not** establish
what happens after server downtime. [O1, O2]

Code Mode conditions have unusually important unattended-execution semantics:
no `fetch`, a 30-second limit, 20 tool calls, and a 32 KB output cap. Tool calls
must use static tool addresses and are authorized at creation for unattended
execution. Checks receive `state`, `now`, and `runs`, and can return a boolean or
`{ wake, state?, message? }`. An initial check runs with `state = null`; `if`
establishes its baseline without waking, while an already-matching `until` can
complete immediately. These limits apply to the Code Mode check, not to the
subsequent agent turn. [O1: `Schedule.ConditionInput`; O2]

### HTTP integration surface

These six operations are in the current official OpenAPI contract. [O1]

| Method and path | Operation ID |
| --- | --- |
| `POST /api/experimental/schedule` | `experimental.schedule.create` |
| `GET /api/experimental/schedule` | `experimental.schedule.list` |
| `GET /api/experimental/schedule/{scheduleID}` | `experimental.schedule.get` |
| `POST /api/experimental/schedule/{scheduleID}/pause` | `experimental.schedule.pause` |
| `POST /api/experimental/schedule/{scheduleID}/resume` | `experimental.schedule.resume` |
| `DELETE /api/experimental/schedule/{scheduleID}` | `experimental.schedule.delete` |

Creation requires `sessionID` and `prompt`. Listing requires a `sessionID` query
parameter and returns a `data` array, oldest first, without documented pagination.
`Schedule.Info` supplies creation/update clocks as `time.created` and
`time.updated`, not `createdAt`. No schedule-specific event was found in the
reviewed documented event inventory; do not invent event names for recovery. [O1]

### Experimental status and lifetime uncertainty

Schedule route descriptions require `experimental.schedules` in the session
configuration. The general config documentation does not fully document this
setting. Verify the deployed build's contract and feature availability before
recommending a configuration change; this research changed no settings. [O1, O3]

The reviewed docs do **not** specify schedule storage, restart recovery,
missed-run handling after downtime, delivery guarantees, or a durable scheduler
owner. Do not advertise this as an always-on cron service or infer schedule
durability from the API's separately documented durable prompt admission. [O1]

This matters in Uatu: it starts its own workspace-scoped `opencode serve` process
and terminates that process on disposal. A background OpenCode service in the
normal CLI architecture is not evidence that Uatu's private server keeps running
after its workspace stops. [U5]

## What Uatu already supports

These are existing features, not proposed additions: [U1, U2, U6]

- Native background subagents and shell work, with launch/result correlation,
  child transcript inspection, recovered results, and uncertain-state handling.
- Worker permissions and questions mirrored into the owning conversation.
- Parent-wide conversion of eligible blocking work through `session.background`.
  The API exists; chat deliberately has no manual conversion button. Verified
  personal Hub steering can request conversion automatically.
- Agent Stop through verified child `session.interrupt({ resume: false })`;
  owned shell inspection through `shell.get`/`shell.output`, and removal through
  `shell.remove`. Shell removal is not a guaranteed successful cancellation or
  final worker result.
- Pending user steers through the native inbox, with list/cancel/reconnect
  reconciliation; Uatu holds its ordinary queued messages itself.
- `/btw` through `session.generate`: a one-shot contextual answer, not a new
  background agent or tool-execution loop.
- Shared scheduled-wakeup rows, status, cancellation, and release behavior for
  **Claude Code**, not OpenCode V2.

## Integration gaps

### Native schedules: confirmed missing

The OpenCode V2 provider declares background capabilities but not
`scheduled-wakeups`; it implements no schedule management. Its event mapper has
no schedule-specific cases. A model may still use available native schedule
tools: generic tool rendering is not first-class scheduling support. [U1, U7]

Adding support needs more than recognizing tool names:

1. **Inventory and recovery.** Fetch authoritative schedules for the selected
   session on attach/reconnect, including schedules created by other clients.
   An absent tool-call row is not evidence that no schedule exists.
2. **A suitable domain model.** Preserve duration/absolute/cron kinds, explicit
   timezone, condition, limits, native state, and last outcome. The current
   `ScheduledWakeupItem` only carries a cron-shaped string and assumes host-local
   interpretation; its paused state means Claude will reconstruct a cron after
   session retirement, not native user-requested pause. [U3]
3. **Native controls.** Add pause/resume/delete, with creation as a separate
   product decision. The provider seam currently has list/cancel/release, but
   no schedule create/pause/resume methods. Do not equate pause, delete, and
   process release. [U4]
4. **Honest execution attribution.** Link a fired schedule to the resulting
   turn only when native evidence proves it; do not label it as user-typed
   input or infer attribution from a matching prompt alone.
5. **Lifecycle and attention.** Distinguish waiting for a schedule, running a
   condition, a failed/skipped check, and an actual agent turn. Waiting should
   not be presented as continuously working.
6. **Authorization and diagnostics.** Show the unattended condition's action
   scope, timezone, end limits, next run, and failure output. Keep existing
   permission boundaries; a scheduling UI must not silently enable the feature
   or broaden tool permissions.

### Related background features: additional opportunities

These are gaps in first-class integration, not proof that the agent cannot use
the underlying native facilities. Some omissions are deliberate product choices.
Routes and behavior below come from the official contract; provider comparisons
come from local source. [O1; U1, U2, U9–U11]

| Feature | Upstream API | Uatu assessment |
| --- | --- | --- |
| Background-job inventory | `GET /api/experimental/job` (`experimental.job.list`), filtered by `sessionID`, `kind`, `status`, and `descendants`. Kinds: `shell`, `subagent`, `image`; states: `running`, `completed`, `error`, `cancelled`. | **High-value investigation.** Uatu currently reconstructs agent/shell work from launcher, execution, inbox, and history evidence; it does not use this inventory. Consider it as additional recovery evidence, not automatic authority to Stop or replace proven occurrence identities. |
| Image background jobs | The same job inventory includes `image` jobs. | **Not represented as a dedicated OpenCode worker kind.** Native worker correlation recognizes subagent/shell sources. Investigate image result/assets and ownership contracts before promising equivalent inspection or controls. |
| Native shell launcher and running-command browser | `POST/GET /api/shell` (`shell.create`, `shell.list`); list includes currently running commands only. | Provider uses get/output/remove, not create/list. A workspace command browser/launcher would be new product scope. An exited command disappearing from list is not a successful worker result. |
| Agent-owned interactive terminals | Standard `/api/pty` lifecycle/connect routes and experimental persistent-PTY routes, including per-session terminal list/create/read and terminal snapshot/connect/handoff/shutdown. | Uatu has its **own** Bun PTY terminal, not an OpenCode PTY browser. Inspecting/attaching to agent-controlled terminals is a separate potential feature; do not describe Uatu as lacking a terminal. |
| Native wait-for-idle | `POST /api/experimental/session/{sessionID}/wait` (`experimental.session.wait`). | No provider use found. Potential orchestration/verification helper; becoming idle does not by itself prove all detached background jobs settled. |
| Full native inbox administration | `session.synthetic` admits synthetic input; `session.inbox.update` changes pending delivery mode. Native inbox includes user, synthetic, compaction, and move entries. | Uatu exposes user-steer controls and read-only worker recovery, not arbitrary synthetic injection or full inbox administration. **Deliberate boundary**, not an accidental omission: inbox-update would bypass Uatu's frozen submission configuration. Do not add unrestricted controls just for API parity. |

The job endpoint lists **active and unconsumed** jobs, not a documented permanent
run-history database. The reviewed contract has no job-specific get/stop/output
endpoint; use kind-specific contracts rather than inventing generic job controls.
Similarly, persistent-PTY terminology does not prove schedule durability; its
read endpoint explicitly describes terminal selection as server-local and reset
on restart. [O1]

Parent/child sessions and live events are **not wholly missing**: Uatu already
lists sessions, reads `parentID`, verifies ownership, subscribes to events, and
recovers missed state. Upstream `session.list` additionally offers `parentID`
filtering and `session.create` can create linked children; using those for a new
task-launch UI would be additional scope, not the missing foundation. [O1; U1]

The native event stream is explicitly volatile: disconnections miss events and
slow consumers can overflow it. Client subscriptions have no replay or automatic
reconnection. Schedule/job support therefore needs authoritative reconciliation,
not just new event cases. Uatu already has recovery machinery to extend. [O1, O4;
U1]

### Coverage-report blind spot

The SDK coverage report currently checks events, message parts, and dedicated
tool renderers, not API operations. OpenCode tool names are not enumerated by
either SDK; the report lists only names Uatu already renders specially.
Consequently, a clean event report does not prove coverage of scheduling or
other management APIs. Add an operations/capabilities inventory if the goal is
to discover future integration gaps systematically. [U8]

## Recommended smallest next step

Start with **read-only native schedule inventory**, surfaced per conversation
with next due time, timezone, state, and last outcome. Validate the feature flag
and routes against the target OpenCode server before declaring a capability;
the live documentation and this session's tool catalog do not prove compatibility
with every server used alongside the pinned `2.2.5` client.

Before adding mutation controls or promising unattended operation, run an
isolated, explicitly authorized compatibility spike covering:

- Feature disabled/enabled; create/list/get and required session scope.
- Delay/absolute/interval/cron schedules, explicit timezone and DST boundaries.
- `if`/`until` baseline behavior, denied conditions, failure output, and end limits.
- Pause/resume of overdue one-shots versus repeating schedules; permanent delete.
- Due time while a session is busy, prompts/configuration at fire time, and
  evidence linking a schedule to its admitted input and execution.
- Browser disconnect/reconnect, private-server restart, workspace shutdown and
  reopen, missed due times, and prevention of duplicate local scheduling.
- Experimental job inventory versus Uatu's established execution/result evidence,
  including descendants, consumed jobs, image jobs, and ownership confinement.

Keep scheduling in OpenCode; do not introduce a second Uatu timer engine to
imitate it. Treat an always-on Hub scheduler as a separate product decision until
native lifecycle behavior is established. No spike was executed for this report.

## Evidence and verification

Official documentation was checked by a separate read-only Luna research agent;
Uatu findings were independently checked against local source by a Sol worker.
These used the native role defaults (Luna High and Sol Medium); runtime effort
was not independently measured. The native tool catalog was
inspected without creating, listing, modifying, or running any schedules.
No service was started or restarted, no authentication/configuration was
changed, and no dependencies were installed. Local `node_modules` is absent;
the SDK coverage generator and runtime tests were not run.

Independent report review checked the upstream contracts and local integration
claims. Its one correction—the HTTP delete operation ID—was confirmed directly
against the official OpenAPI and applied. Local Markdown targets and whitespace
checks passed.

### Official sources

- **O1:** [OpenCode V2 OpenAPI](https://opencode.ai/docs/openapi.json), linked
  from the [API reference](https://opencode.ai/docs/api/). See
  `/api/experimental/schedule`, its schedule-ID subroutes, and
  `Schedule.ConditionInput`.
- **O2:** This session's native Code Mode catalog, discovered read-only with
  `search({ namespace: "opencode", query: "schedule" })`: the exact
  `tools.opencode.schedule_create`, `schedule_list`, `schedule_pause`,
  `schedule_resume`, and `schedule_delete` signatures/descriptions.
  This is evidence for the current harness, not a published compatibility
  guarantee for every OpenCode release.
- **O3:** [Configuration](https://opencode.ai/docs/config/).
- **O4:** [JavaScript client](https://opencode.ai/docs/build/client/), event
  subscription behavior; O1's `event.subscribe` description.

### Uatu sources

- **U1:** [OpenCode V2 provider](../../src/chat/opencode/v2/provider.ts):
  `describe`, `backgroundBlockingWork`, `generate`, `stopTask`, `taskOutput`,
  `listPendingInbox`, and `cancelInbox`.
- **U2:** [OpenCode coverage annotations](../../src/chat/opencode/sdk-coverage.ts),
  especially the native background/inbox operations and deliberate omissions.
- **U3:** [Shared chat types](../../src/chat/types.ts): `ChatCapability` and
  `ScheduledWakeupItem`.
- **U4:** [Provider seam](../../src/chat/provider.ts):
  `PendingScheduledWakeup`, `listScheduledWakeups`, `listPausedWakeups`,
  `cancelWakeup`, and `release`.
- **U5:** [OpenCode runtime](../../src/chat/opencode/opencode-service.ts):
  `start`'s workspace-scoped spawn and `disposeService`'s process termination.
- **U6:** [Chat behavior](../CHAT.md#background-workers-opencode-v2) and
  [Claude scheduled wakeups](../CHAT.md#scheduled-wakeups-claude-code).
- **U7:** [V2 normalization](../../src/chat/opencode/v2/normalization.ts) and
  [tool details](../../src/chat/tool-detail.ts).
- **U8:** [SDK coverage generator](../../scripts/agent-coverage.ts):
  `extractOpenCode`, `openCodeDedicatedTools`, and the OpenCode tools-axis note.
- **U9:** [Native background correlation](../../src/chat/opencode/v2/background.ts):
  `PreparedNotification`, `prepareNotification`, and `LauncherEvidence` worker kinds.
- **U10:** [Uatu's PTY adapter](../../src/terminal/pty.ts), using Bun's PTY API.
- **U11:** [HTTP routes](../../src/server/routes.ts): task Stop/output,
  parent background, wakeup cancel, and session release endpoints.
