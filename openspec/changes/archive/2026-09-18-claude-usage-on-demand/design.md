## Context

See proposal.md — Why. The mechanics that shape the approach:

- `probeContextUsage` (`chat/claude/provider.ts`) runs once per turn after the result. It races `getContextUsage()` and `readPlanUtilization()` under `CONTEXT_REPORT_TIMEOUT_MS` (3 s) and emits one `context_report` upsert (`context.reported`). It bumps `session.reportGeneration`, which the retirement continuation (the idle-timer / "probe a later turn overtook" check) also keys on.
- The plan windows live nowhere else. The transcript never carries them; the adapter's projection (LRU of 64) does; the client keeps them in `usage-pane.ts`'s module-level `current`. The rate-limit standing is different: `rateLimitedSessions` keeps it per session across query retirement and re-attaches it on every `readSession`.
- An idle conversation has no process: the provider retires the query after the turn's grace window. `ensureLive` starts one with `resume: nativeId` (or a pre-minted `sessionId` for a never-prompted conversation) and already sends control requests before any prompt (`captureModels(query)`).
- The provider persists `durableSnapshot()` (configurations, active/hidden native ids, staged reversible state, deferred renames, pending sessions) through a serialized write-behind and restores it on start. `hiddenNative` is the existing set of native session ids the inventory must not list.
- The workspace's `/api/chat/*` routes are an explicit internal exclusion in the API contract (`workspace-api`); chat *item* schemas are published through the live stream and are closed objects (`context_report` has `additionalProperties: false`). A new route costs nothing; a new field on `context_report` costs a workspace revision.
- The SDK method behind the read is `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`. Every field it returns is already optional in `PlanUtilization`.
- The client's chat init already fetches per-agent inventories (`status`, `models`, `commands`, `modes`) through `ChatClient`; the e2e suite runs against `FakeE2EChatService` (`tests/e2e/chat-service.ts`), which implements the service seam and is driven by `control()` actions.

## Goals / Non-Goals

**Goals:**
- One last-known plan report per workspace process, durable, served before any conversation is opened.
- An on-demand read that never disturbs a running turn and never starts a process the user did not ask for.
- No change to published item schemas; no API revision.
- The readout and the pane keep one row model and one refresh path.

**Non-Goals:**
- A hub-wide (cross-workspace) report. Plan usage is per login, and a hub usually serves one login, but aggregating it touches the hub live stream and the public contract; a later change can lift the workspace report to the hub once this one has been lived with.
- Periodic polling of the login. Reads are user-initiated or piggyback on a session that is already up.
- Showing the `behaviors` attribution block (unchanged from the readout design, D6).
- Plan usage for OpenCode (#394 is its own change).

## Decisions

**D1. A usage report is provider state, not conversation state.** `ChatProvider` gains two optional methods:
```
usageReport?(): Promise<AgentUsageReport | undefined>;              // last-known, no I/O
readUsage?(mode: UsageReadMode): Promise<UsageReadResult>;
AgentUsageReport = { plan: PlanUtilization; readAt: number; conversationId?: string }
UsageReadResult = { report: AgentUsageReport } | { report: null; reason: "no-live-session" | "timeout" | "unavailable" }
```
The read answers with its reason on the seam itself: the provider is the only thing that knows why a read did not answer, so the route does not have to guess.
`plan` reuses the existing type wholesale (an empty plan still means "this login reports none"). `conversationId` names the conversation the read went through, for the client's "refreshed that conversation" bookkeeping. A new `ChatCapability` `"usage"` is declared by Claude's `describe()` so the client shows controls only for agents that answer.
*Alternative:* a `lastPlan` field on `ConversationSnapshot`. Rejected: the report is per login; every conversation would carry a copy, and a conversation-less workspace could not be answered.

**D2. Two internal routes, through the existing layers.** `GET /api/chat/usage?agent=<id>` returns `{ report: AgentUsageReport | null }` for one agent, selected the way `/api/chat/models` is — per agent rather than one map for all, so an agent that does not declare `usage` (and a runtime that is not up) is never started for a question it cannot answer; the client asks once per agent that declares the capability. `POST /api/chat/usage/read` with `{ agentId, requestId, mode }` returns `{ report }` or `{ report: null, reason }` (`no-live-session` for a live-only read that found none; `timeout`; `unavailable`). Route → `ChatService` → `ChatAdapter` → provider, like `stopTask`; the adapter keys the receipt on `requestId` and holds one in-flight read per agent so concurrent callers join it. Both are covered by the `workspace-api` exclusion; the route-coverage test needs nothing new.
*Alternative:* carry the report on the conversation stream as an event. Rejected: the stream is published protocol and per conversation.

**D3. The read chooses its session; the client never does.** In `readUsage`:
1. A live session exists → read on its query. Prefer the one with the most recent activity. The turn keeps running: the read is a control request, the same kind the turn-end probe already sends, and it does not touch `pendingTurns`, `reportGeneration`, or the idle timer.
2. `mode === "live-only"` and none live → `{ report: null, reason: "no-live-session" }`.
3. Otherwise the most recently updated known conversation → `ensureLive` (a resume), read, and if `sessionIsIdle` retire it directly (the same call the probe continuation makes), so it does not linger for the follow-up grace window.
4. No Claude conversation in the workspace → a probe query: `queryFactory` with a fresh pre-minted id that is added to `hiddenNative` first, so a transcript the CLI may write never lists; read; `query.return()`. The id is not registered as a conversation.
*Alternative for 3:* always use a probe query, never resume. Rejected: resuming the conversation the reader is looking at also refreshes its context readout and totals, which is what "read now" means from inside a conversation; and the totals ledger (`since`) keeps its existing meaning — a process that first observes the conversation at the read observes from then.

**D4. The read reuses the probe and emits the same item.** A read runs `getContextUsage()` and `readPlanUtilization()` together and upserts one `context_report` (`context.reported`) into the conversation it went through — plan, context breakdown, conversation totals — identical in shape to a turn-end report. Its `createdAt` is the read time, so newest-wins in the readout is untouched. The probe query (D3.4) emits nothing: there is no conversation. The read has its own timeout, 15 s including a cold start, since 3 s is sized for a query that is already up.

**D5. The provider keeps and persists the newest report.** Every plan read that answers — turn-end or on demand, windows or an explicit empty plan — updates `lastUsage` when its `readAt` is newer, and `durableSnapshot()` gains `usage: AgentUsageReport | undefined`. Restore loads it before any session starts, so the first `GET /api/chat/usage` after a workspace restart answers from disk. A durable file without the field loads as today.

**D6. The client seeds from the route and falls back to it.** `usage-pane.ts` stays the client-side holder (`noteUsageReport`, newest wins by `readAt`). Chat init calls `client.usage()` once and notes each agent's report; conversation reports keep flowing in as they do now. `syncPlanUsage` in `ui.ts` reads the plan from the conversation's newest report **or**, when the conversation has none, from `currentUsageReport()`; the conversation's totals block stays per conversation. This is what closes #389: a standing without a report of its own no longer empties the readout.

**D7. Age and staleness are painted, not polled.** The pane head reads `Pro plan · as of 21:33 · 12 min ago`; the readout head gains the same line. The existing one-minute tick (today only while a window carries a reset) runs whenever a report is held, because the age moves. Past `USAGE_STALE_MS` (10 min) the pane, the readout head, and the composer summary carry `data-stale="true"`; CSS mutes the figures and the tooltip says "read 12 min ago". The chip text itself does not change — it stays short.

**D8. One refresh path, two buttons.** `usage-pane.ts` exports `readUsageNow(mode)`: it posts the read, tracks one in-flight promise (a second click awaits it), notes the report, and on `null`/failure records a reason string the pane and readout render as a status line ("Couldn't read usage · timed out"). The pane header gets a third pane action (↻, `aria-label="Read usage now"`) and the readout head a "Read now" button beside "Keep in sidebar"; both disable while in flight and read "Reading…". The empty state becomes "No usage read yet." with an inline "Read now" button. Opening the pane or the readout while the held report is stale calls `readUsageNow("live-only")`; only the buttons call `"start"`.

**D9. The e2e double drives every state.** `FakeE2EChatService` implements `usage()` and `readUsage()`; `control()` gains `usageReport` (seed the last-known report, with `readAt` in the past for the stale cases) and `usageRead` (`outcome: "ok" | "fail" | "no-live-session"`, optional `delayMs` for the in-flight assertions, optional `plan` and `conversationId` so an answered read lands a `context_report` in a conversation, as the real provider's does). The fixture's default is `no-live-session`: a fixture workspace has no running turn unless a spec says so, so opening a stale readout starts nothing by itself. `stats` reports the modes read so far. No test names `openspec/`.

## Risks / Trade-offs

- [The SDK usage method is experimental] → same posture as today: every field optional, a failed or timed-out read says so and keeps the figures; the normaliser test pins the shape.
- [Starting a CLI for a read costs a process and 1–3 s] → only an explicit click starts one; unasked refreshes are live-only; concurrent clicks join one read; the started session retires immediately when idle.
- [The CLI might write a transcript for the probe query] → the id enters `hiddenNative` before the query starts; `provider.test.ts` asserts the inventory is unchanged; the real-CLI integration test asserts no new session file is listed.
- [A control request mid-turn could be held by the CLI until the current tool call returns] → the 15 s timeout and the failure note; the live session's turn is never interrupted.
- [A pane-driven read lands a `context_report` in a conversation the reader is not looking at] → harmless: the report is a newer, truthful statement of that conversation's window and totals.
- [The stored report may belong to a login the user has since changed] → it shows its own read time and age; the next read replaces it.
- [Ten minutes is a guess at "stale"] → a single constant; the 5-hour window moves about 0.3 %/min at full burn, so ten minutes bounds the error at a few percent.

## Migration Plan

- Durable state gains an optional `usage` field; older files load unchanged. No API revision (internal routes, no schema change).
- `sidebar.e2e.ts` and `chat-claude-polish.e2e.ts` assertions on the empty-state string change with it.
- Rollback is a code revert; a durable file written with the field is ignored by older code (unknown keys are dropped on load).
