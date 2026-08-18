## 1. Count what the workspace discards (independently useful — commit first)

- [x] 1.1 Give `normalizeProviderEvent` a discriminated outcome in `src/chat/normalization.ts` — recognized-with-updates, recognized-and-intentionally-ignored, unrecognized — so a real drop is distinguishable from a deliberate skip
- [x] 1.2 Catch parse failures at the normalization boundary and report them as unparseable-with-type rather than throwing to the caller
- [x] 1.3 Move the `normalizeProviderEvent` call in `src/chat/adapter.ts` inside the loop's error boundary (it currently sits outside the inner `try` at line 338) so one bad payload drops one event, not the pump
- [x] 1.4 Increment `chat.event.unhandled.<type>` and `chat.event.unparseable.<type>` through the existing `MetricsRegistry`, capping distinct types at 64 with an `other` bucket, and never recording payloads
- [x] 1.5 Tests: an unrecognized type is counted and the stream continues; a recognized type with a malformed payload is counted and later events for that conversation still arrive; an intentionally-ignored type is not counted as unhandled; the type cap folds overflow into `other`
- [x] 1.6 Confirm the counters reach `snapshot-<pid>.json` without `--debug` and `/debug/metrics` with it

## 2. Both event families for permissions and questions

- [x] 2.1 Map `permission.asked` / `permission.replied` onto the existing `permission:<requestId>` item, translating the bridged shape (`properties.permission` → action, `properties.patterns` → resources, `properties.id` → requestId, `properties.sessionID` → conversationId)
- [x] 2.2 Map `question.asked` / `question.replied` / `question.rejected` onto the existing `question:<requestId>` item
- [x] 2.3 Verify the shared item id makes the projection upsert deduplicate a request delivered under both families, and that `adapter.ts:607`'s merge keeps the more complete value
- [x] 2.4 Tests: classic-only delivery renders and answers; v2-then-classic and classic-then-v2 both settle on one entry; answering a doubly-delivered request sends exactly one provider reply

## 3. Recover a pending permission that the stream missed

- [x] 3.1 Add `listPermissions?(sessionId)` to `OpenCodeProvider` in `src/chat/provider.ts`, beside `listQuestions`
- [x] 3.2 Implement it in `src/chat/sdk-v2-provider.ts` against the global `GET /permission` filtered by directory, matching the route choice `listQuestions` documents
- [x] 3.3 Reconcile pending permissions on history load in `src/chat/adapter.ts`, concurrently with the existing question list, reusing its failure discipline (a failed list degrades the snapshot and must not rewrite the published set)
- [x] 3.4 Tests: a permission raised while the pump was down appears on load and is answerable; a recovered request that also arrives live yields one entry; a failing list leaves already-known requests visible

## 4. Stop the transcript from lying about compaction and revert

- [x] 4.1 Map `session.next.compaction.started` / `.ended` onto `notice` items so a compacted conversation says so
- [x] 4.2 Map `session.next.revert.staged` / `.committed` / `.cleared` onto `notice` items so reverted work is not presented as current
- [x] 4.3 Tests for both families; assert `session.next.compaction.delta` is treated as intentionally ignored rather than counted as unhandled

## 5. Verification and delivery

- [x] 5.1 Run `bun test`, `bun run typecheck`, `bun run check:licenses`
- [x] 5.2 Run `bun run test:api` and confirm no contract artifact changed — this change adds no route and no response schema, so unlike `chat-startup-diagnostics` it must need no revision increment
- [x] 5.3 Run the real-OpenCode integration test (`UATU_REAL_OPENCODE=1`)
- [x] 5.4 Run `bun test:e2e`; the pre-existing `find.e2e.ts` "⌘G steps matches without focus" failure is unrelated and stays out of scope
- [x] 5.5 Drive a real OpenCode turn with `permission: {bash: "ask"}` and read `chat.event.unhandled.*` from the snapshot file to confirm the counters answer the question that motivated this change
- [x] 5.6 Commit onto `fix/chat-startup-diagnostics` and push so the fixes land in PR #260; update that PR's body to describe them
