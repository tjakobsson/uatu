## 1. Child: activity summary endpoint

- [x] 1.1 Add an internal `GET /api/activity` SSE route in `src/server/routes.ts` that emits `{ working, awaiting }` for the workspace, derived from live conversation statuses and pending interactions across agents via the chat service, with an opening comment frame and 15 s keepalives; verify with a route test that a status change and a pending permission each produce exactly one event and that the payload has no other fields
- [x] 1.2 Classify the route as internal in the API contract's exclusion list alongside the rest of the workspace API (see 5.1); verify the route-coverage check passes locally

## 2. Hub: broker

- [x] 2.1 Create `src/hub/live-broker.ts` with refcounted upstream subscriptions keyed by `(workspace, topic[, conversation])`, opening the child's existing SSE routes through the brokered token, stamping per-topic cursors, fanning events out to client streams, and lingering 3 s after the last unsubscribe before aborting; verify with unit tests that four subscribers share one upstream, that the upstream is aborted after linger, and that a quick unsubscribe/resubscribe reuses it
- [x] 2.2 Add the bounded replay buffer (256 KB per upstream) and topic-scoped resync: a client cursor inside the buffer replays from the buffer, one behind it forwards the child's replay or resync for that topic only; verify with a unit test that a stale conversation cursor resyncs the conversation topic while the document topic replays
- [x] 2.3 Handle upstream failure and child exit as topic-scoped unavailability signals that leave client streams open; verify with a unit test that a child fetch rejecting delivers one unavailability envelope per subscribed client and closes no client stream
- [x] 2.4 Compute the `activity` topic per user by merging session running state with each running child's activity endpoint, refcounted per user, validated to the fixed shape before fan-out; verify with a unit test that a stopped workspace reports not running, an unreachable child reports not running, and any extra field is dropped

## 3. Hub: stream and subscription routes

- [x] 3.1 Add `GET /api/hub/live` to `src/hub/server.ts`, authenticated by the hub session, parsing the initial subscription set from the query, issuing an unguessable stream id in the first event, writing an opening comment immediately, and enveloping every event as `{ ws, topic, key?, cursor, event }`; verify with a route test that headers and the first frame arrive within 100 ms for an idle workspace and that a workspace the user may not access is refused
- [x] 3.2 Add `POST /api/hub/live/{streamId}/subscriptions` with add/remove operations bound to the stream id and the same hub session; verify with a route test that adding a conversation starts its events on the open stream, removing stops them, and a request with another session's stream id is refused
- [x] 3.3 Extend stream diagnostics and metrics with the brokered stream and per-topic upstream classes, fixed vocabulary only; verify with the existing sanitization test pattern that no identifier, cursor, payload, cookie, or token appears in any record
- [x] 3.4 Add a hub integration test that opens three real client streams on one workspace with the same conversation, asserts the child's subscriber count is one per topic, disconnects two, and asserts the count is unchanged until the last leaves; verify it passes alongside the existing stream-isolation integration test

## 4. Client: one live channel

- [x] 4.1 Rework `src/shell/live-channel.ts` to own the single `/api/hub/live` stream: envelope dispatch to registered topic consumers, per-topic cursor tracking, one bounded-backoff reconnect presenting all cursors, generation guarding, and subscription add/remove through the control route; verify with unit tests (controllable EventSource and timers) covering reconnect-with-cursors, topic resync isolation, and a stale generation being ignored
- [x] 4.2 Make `src/shell/events.ts` a `document` topic consumer that confirms the shell indicator on the first applied state of the current generation; verify `src/shell/recovery.test.ts` and the events tests pass unchanged in intent
- [x] 4.3 Make the chat client's inventory and conversation handlers topic consumers, with selection changes and subagent drill-downs becoming subscription changes instead of new EventSources, and topic-scoped resync/unavailability routed to the chat surface's interruption ownership; delete the direct per-stream `EventSource` code paths rather than gating them; verify `src/chat/lifecycle.test.ts` and `src/chat/ui.test.ts` pass with the wrapped EventSource count asserting exactly one live source per page and a grep confirms no client code references the three per-stream routes
- [x] 4.4 Collapse `src/shell/recovery.ts` consumers to one channel recovery: wake-ups reconcile state and reconnect the one stream; verify the lifecycle test asserts a `pageshow`/`visibilitychange`/`online` burst yields one reconnect
- [x] 4.5 Add the `activity` consumer in `src/shell/hub-nav.ts`: live chip dot from stream state, per-workspace working/awaiting in the menu, an awaiting badge on the collapsed chip distinct from working; verify with a unit test that a question in another workspace badges the chip and answering it clears the badge, and save a screenshot of the badged chip and open menu under `openspec/changes/hub-brokered-live-stream/screenshots/`
- [x] 4.6 Keep `appUrl()` discipline: the live routes are hub-origin and allowlisted in `shared/app-url-discipline.test.ts`; verify that test passes

## 5. Remove public `serve` and the per-stream routes

- [x] 5.1 Make the hub refuse `/s/<id>/api/events`, `/s/<id>/api/chat/conversations/events`, and `/s/<id>/api/chat/conversations/<conversation>/events` with a non-cached error naming `/api/hub/live` as the replacement, before the proxy; verify with a hub route test that each path is refused and that a child-side counter shows no upstream request was made
- [x] 5.2 Remove user-shaped `serve` and `watch` from `src/cli/parse.ts` and `src/cli.ts`: a user invocation prints the hub bootstrap steps and exits non-zero, the hub's child invocation (`--exit-on-stdin-close`) and the source-run harness are unchanged, and `SERVE_DEPRECATION_WARNING` with its gate is deleted; verify with CLI parse tests for the refusal, the child path, and the source-run path, and that `openspec` spec `serve-cli-startup`'s removed requirements have no remaining test references
- [x] 5.3 Rewrite README usage around `uatu hub` alone, make `docs/SELF-HOSTING.md` the single start path, and update `ARCHITECTURE.md`'s serve/hub split and live-delivery sections; verify the docs build the Pages workflow runs succeeds locally

## 6. Contract revision

- [x] 6.1 Add the `live` SSE protocol definition and the two hub operations to `api/contract.json` and the OpenAPI document; remove the workspace API from the public contract and add its explicit internal exclusion covering every child route; verify the route-coverage check classifies every child route as an explicit exclusion
- [x] 6.2 Increment the public API revision: `contract.json`, the OpenAPI version, summary, and `x-uatu-revisions`, `version.ts`, and a changelog section with Migration naming `/api/hub/live` as the replacement for the three removed streams and `uatu hub` as the replacement for `serve`; verify by running CI's compatibility step locally and confirming it reports the breaking change as covered by the revision and migration entry

## 7. Dev loop

- [x] 7.1 Add `dev/hub.json` (user `dev`, documented password, `stateDir` under `.local/`) and `scripts/dev-hub.ts` that starts the hub from source, registers and starts `testdata/watch-docs` if absent, and opens the session URL; point `bun run dev` at it and remove any bare-child dev script; verify `bun run dev` opens a hub-served session with the live stream connected

## 8. End-to-end verification

- [x] 8.1 Add an e2e test through a hub that opens three session tabs with conversations selected and asserts a document load in the first tab completes under one second; verify it fails against the pre-change hub and passes after
