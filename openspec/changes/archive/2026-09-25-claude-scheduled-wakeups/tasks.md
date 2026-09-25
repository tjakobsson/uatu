## 1. Spike

- [x] 1.1 Extend `scripts/spike-claude-sdk.ts` (or a sibling) to register `Stop` and `UserPromptSubmit` hooks, ask the model to schedule a 60-second wakeup, and log: the `Stop` payload's `session_crons`, its order relative to the `result` message, the fired turn's `UserPromptSubmit.source`, how the transcript stores the fired turn, and that retiring the query before the fire kills the cron; verify by recording the findings under design.md — Decisions (D2, D4, D8) before any further task

## 2. Provider: hold, fire, release, lose

- [x] 2.1 Register `hooks.Stop` on the session query and keep a per-session wakeup set with replace semantics; verify with a provider test feeding a Stop payload with two crons that the session records both and emits two pending `scheduled_wakeup` upserts
- [x] 2.2 Extend the hold rule so pending wakeups keep the session live and a result with wakeups but no background work emits `scheduled`; verify with tests that a result under one cron does not retire the session, that background wins when both are present, and that an emptied cron set returns to idle through the grace path with rows marked cancelled
- [x] 2.3 Register `hooks.UserPromptSubmit` and attribute wakeup turns by `source`, with the inference fallback when `source` is absent; verify with tests that a fired turn's user message carries `origin: "wakeup"` and the matching `wakeupId`, and that a typed prompt during the scheduled state does not
- [x] 2.4 Add Release: a control that retires the scheduled session and marks pending rows cancelled; verify with a test that release on a scheduled session ends the process, emits cancelled rows and `idle`, and that a following prompt resumes cleanly
- [x] 2.5 Mark pending wakeups lost on process exit and workspace shutdown with the notice text; verify with tests for the stream-ended path and the dispose path

## 3. Shared seam and wire

- [x] 3.1 Add `scheduled` to `ConversationStatus`, the `scheduled_wakeup` item, `origin` on `user_message`, and the `scheduled-wakeups` capability in `src/chat/types.ts`, `validation.ts`, and the Claude agent declaration; verify `bun test src/chat` passes and OpenCode's declaration is unchanged
- [x] 3.2 Bump the workspace API to revision 21 in `api/openapi.yaml` (schemas, version, summary, `x-uatu-revisions`), `api/contract.json`, `src/shared/version.ts`, and add the `api/CHANGELOG.md` section with a Migration note; verify `bun run api:validate` and `bun run test:api` pass and the compatibility step reports the bump as intended
- [x] 3.3 Implement the five-field cron evaluator for `nextFireAt`; verify with unit tests for a one-shot expression, a recurring expression, and month/day-of-week boundaries

## 4. Client: the scheduled state and wakeup rows

- [x] 4.1 Present the scheduled state in `composer-status.ts` and the composer: label naming the pending count and next fire time, a list with prompt, recurring mark, and fire time, and the Release action with its "ends every wakeup" wording; verify with composer-status tests and a DOM test that the list renders and Release calls the control
- [x] 4.2 Render `scheduled_wakeup` rows in the timeline for pending, fired (linking the turn), cancelled, and lost, and render `origin: "wakeup"` user messages as a wakeup header rather than a user bubble; verify with timeline-renderer tests for each state and the header
- [x] 4.3 Map a stored wakeup turn's origin in `src/chat/claude/transcript.ts` per the spike's D8 finding; verify with a transcript test on a fixture from the spike
- [x] 4.4 Add an e2e in `tests/e2e/chat-claude.e2e.ts` (or the existing Claude chat file) with the fake agent: schedule → scheduled state → fire → wakeup turn → release; verify it passes and save a screenshot of the scheduled composer under the change's `screenshots/`

## 5. Documentation and coverage

- [x] 5.1 Document the scheduled state, Release, and the process-lifetime limit in `docs/CHAT.md` and the session-lifetime paragraph of `ARCHITECTURE.md`; verify the text names the hook as the source and the loss behavior
- [x] 5.2 Retire the behavior-missing annotations for `ScheduleWakeup`, `CronCreate`, `CronDelete`, `CronList` in `src/chat/claude/sdk-coverage.ts` and regenerate the coverage report; verify the freshness test passes and the matrix shows them as dedicated

## 6. Revival: paused crons and enforced cancel (D9–D13; supersedes 2.4 and 2.5 where they differ)

- [x] 6.1 Extend `scripts/spike-claude-cron-revival.ts` with a one-shot `CronCreate` resumed after its fire time has passed, and record what the CLI does with it under design.md D9; verify by the recorded finding, and that D11's derivation treats that case accordingly
- [x] 6.2 Track which live crons came from `CronCreate` (the result's `id`) and, when the process ends with wakeups pending, mark `CronCreate` rows `paused` with the fires-again notice and `ScheduleWakeup` rows `lost`; verify with provider tests for the stream-ended, failure, and dispose paths holding one of each
- [x] 6.3 Keep a per-conversation set of cancelled cron ids with their prompts in the provider's durable state, leave cancelled ids out of every hold and `scheduled` decision, block their fires with `decision: "block"` on `UserPromptSubmit`, and swallow the blocked fire's `init`, `informational`, and `result` frames; verify with provider tests that a blocked fire emits no status and no notification turn, that a session holding only cancelled crons retires, and that the set survives a provider restart
- [x] 6.4 Add a per-wakeup cancel operation (provider, adapter, service, router, internal route, client) for live and paused rows, and make Release cancel every wakeup before retiring; verify with provider, adapter, and route tests that cancelling one of two live wakeups keeps the session scheduled for the other, and that cancelling a paused row needs no session
- [x] 6.5 Derive a conversation's paused crons from its transcript in `src/chat/claude/transcript.ts` (`CronCreate` results minus `CronDelete` ids, fired one-shots, cancelled ids, and crons past the 7-day expiry) and seed them as `paused` rows when a conversation without a live session is opened; verify with transcript tests on the revival spike's records and an adapter test that the conversation stays idle
- [x] 6.6 Add `paused` to the `scheduled_wakeup` status in `types.ts`, `validation.ts`, and `api/openapi.yaml`, and describe paused, the per-wakeup cancel, and the enforced cancel in the revision 21 `api/CHANGELOG.md` entry; verify `bun run api:validate`, `bun run test:api`, and the compatibility step
- [x] 6.7 Present paused rows in the timeline and composer: paused crons listed with "fires again when this conversation runs" and a Cancel per row, a Cancel on each pending wakeup, and the Release wording updated; drop the tool row's "kept across restarts" wording; verify with renderer and DOM tests and an e2e that cancels one wakeup, releases, and shows a reopened conversation's paused cron, saving screenshots under the change's `screenshots/`
- [x] 6.8 Update `docs/CHAT.md` and `ARCHITECTURE.md` for paused versus lost, the enforced cancel, and no automatic resume; verify the text states which wakeups come back and that cancelled ones are blocked
