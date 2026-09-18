## 1. Seam and types

- [x] 1.1 Add `AgentUsageReport` to `src/chat/types.ts`, the `"usage"` `ChatCapability`, and the optional `usageReport()` / `readUsage(mode)` methods to `ChatProvider` in `src/chat/provider.ts`; verify `bun test src/chat/agents.test.ts src/chat/types` still passes and Claude's `describe()` declares `usage` in `provider.test.ts`
- [x] 1.2 Add wire validation for `AgentUsageReport` in `src/chat/validation.ts` (reuses the `PlanUtilization` validator; `readAt` finite, `conversationId` optional string); verify with new cases in `validation.test.ts` that reject a missing `readAt` and accept an empty plan

## 2. Claude provider: last-known report and the on-demand read

- [x] 2.1 Hold `lastUsage` in `ClaudeProvider`, update it from every answered plan read (turn-end and on demand, newest `readAt` wins, empty plan included), persist it as `usage` in `durableSnapshot()` and restore it in `restoreDurableState()`; verify in `provider.test.ts` that a report survives a provider restart from the durable file and that a file without the field loads unchanged
- [x] 2.2 Implement `usageReport()` (returns `lastUsage`) and `readUsage("live-only")`: read on a live session's query without touching `pendingTurns`, `reportGeneration`, or the idle timer, emit one `context_report` upsert into that conversation, answer `undefined` when no session is live; verify in `provider.test.ts` with the fake query factory that a mid-turn read emits a report, the turn's own probe still follows, and retirement is unchanged
- [x] 2.3 Implement `readUsage("start")` for an idle conversation: `ensureLive` the most recently updated known conversation, read, then `retireSession` when `sessionIsIdle`; verify in `provider.test.ts` that the query starts and retires, the conversation gains a `context_report` and no message, and a prompt racing the read joins the live session
- [x] 2.4 Implement the conversation-less probe query: fresh pre-minted id added to `hiddenNative` before start, read, `query.return()`, never registered; verify in `provider.test.ts` that `listSessions()` is unchanged before and after and that `hiddenNative` persists; add a real-CLI assertion in `real-claude.integration.test.ts` that no new session file is listed
- [x] 2.5 Give the on-demand read its own 15 s timeout and map failures to `{ report: null, reason }` (`timeout`, `unavailable`); verify in `provider.test.ts` with a hanging fake read that the call resolves with `timeout` and `lastUsage` is untouched

## 3. Adapter, service, routes, client

- [x] 3.1 Add `usage()` and `readUsage(agentId, requestId, mode)` to `ChatAdapter` and `ChatService`, with the receipt keyed on `requestId` and one in-flight read per agent that concurrent callers join; verify in `adapter.test.ts` that two overlapping reads perform one provider call and both resolve with the same report
- [x] 3.2 Add `GET /api/chat/usage` and `POST /api/chat/usage/read` to `buildRoutes` in `src/server/routes.ts` (agent selection as `/api/chat/models` does; 400 on a bad `mode`); verify with a routes unit test and that `bun test api/route-coverage.test.ts` still classifies every child route as internal
- [x] 3.3 Add `usage()` and `readUsage()` to `ChatClient` in `src/chat/client.ts` through `appUrl()`; verify in `client.test.ts` and that `shared/app-url-discipline.test.ts` passes

## 4. Client: seed, fallback, age, refresh

- [x] 4.1 Seed `usage-pane.ts` from `client.usage()` at chat init and key newest-wins on `readAt`; verify in `usage-pane.test.ts` that a seeded report paints before any conversation is opened and that an older conversation report does not roll it back
- [x] 4.2 Make `syncPlanUsage` in `ui.ts` fall back to `currentUsageReport()` when the conversation has no plan report, keeping the totals block per conversation, so a standing shows beside the last-known windows; verify in `ui.test.ts` that a standing-only conversation renders the readout head and rows from the last-known plan
- [x] 4.3 Paint read time and age in the pane head and the readout head ("as of 21:33 · 12 min ago"), run the minute tick whenever a report is held, and stamp `data-stale` on the pane, readout head, and composer summary past `USAGE_STALE_MS` (10 min) with muted styling in `styles.css`; verify in `usage-pane.test.ts` and `composer-status.test.ts` with a controlled clock
- [x] 4.4 Add `readUsageNow(mode)` to `usage-pane.ts` (single in-flight promise, reason string on `null`/failure) and the controls: the ↻ pane action in `index.html`, the "Read now" button in the readout head, the inline button in the new "No usage read yet." empty state, each disabled and reading "Reading…" while in flight and showing "Couldn't read usage · <reason>" on failure; verify in `usage-pane.test.ts` that a second click joins the first read and a failure keeps the figures
- [x] 4.5 Trigger `readUsageNow("live-only")` when the pane is opened or the readout toggles open with a stale report; verify in `usage-pane.test.ts` that a fresh report triggers no read and a stale one posts exactly one live-only read
- [x] 4.6 Hide the controls for agents without the `usage` capability (OpenCode conversations); verify in `ui.test.ts`

## 5. E2E double and end-to-end coverage

- [x] 5.1 Implement `usage()` / `readUsage()` in `tests/e2e/chat-service.ts` with `control()` actions `usage-report` and `usage-read` (`ok` / `fail` / `no-live-session`, optional `delayMs`); verify `tests/evidence-discipline.test.ts` passes
- [x] 5.2 In `sidebar.e2e.ts`: the pane shows a seeded report on load with its age, survives `page.reload()`, marks a seeded old report stale, reads on demand with the in-flight state, and keeps figures with the reason on a failed read; update the empty-state assertion to the new wording
- [x] 5.3 In `chat-claude-polish.e2e.ts`: a conversation with a rate-limit standing and no report of its own shows the standing beside the last-known windows; the readout's "Read now" refreshes the figures and the conversation's context readout; opening a stale readout with a live session refreshes without a click and with none does not start a read
- [x] 5.4 Update the affected assertions in `chat-claude-polish.e2e.ts` and `sidebar.e2e.ts` on the previous empty-state string and confirm the e2e suites for chat and sidebar pass locally
