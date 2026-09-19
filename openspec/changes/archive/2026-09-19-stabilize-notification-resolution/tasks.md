## 1. Hub enrollment refuses on an unsettled feed (#402)

- [x] 1.1 Make `settle()` in `src/hub/notifications.ts` report the workspaces whose observer did not connect within the bound, and have `enroll()` throw `NotificationRequestError(503, …)` naming them via `workspaceName` before any store mutation. Verify with a unit test in `src/hub/notifications.test.ts`: a source whose `open` never resolves for one running workspace → `enroll()` rejects with status 503 and a message containing that workspace's name, `store.snapshot().devices` is unchanged, and no cutoff is stamped.
- [x] 1.2 Cover the retry and the mixed case: after the feed answers, a second `enroll()` succeeds and `since[ws]` is not earlier than the feed position (extend the existing "stamps the cutoff after the feed position is known" fixture); an enrollment selecting a stalled running workspace plus a stopped one still refuses, and one selecting only stopped workspaces returns without waiting. Verify both tests pass under `bun test src/hub/notifications.test.ts`.
- [x] 1.3 Cover re-enrollment: an existing device whose update selects a stalled workspace is refused and its previous record (preferences and cutoffs) is unchanged. Verify by asserting the stored device before and after are deep-equal.
- [x] 1.4 Confirm the hub API needs no contract change: `hubEnrollNotifications` already declares `503` through the generic `NoStoreError` response (`api/openapi.yaml`, `api/operations.yaml`), and the new reason is carried in the existing `error` string. Verify `bun run api:validate` and `bun run test:api` pass with no revision bump.

## 2. Adapter resolutions carry the owning conversation (#403)

- [x] 2.1 Add per-request owner tracking in `src/chat/adapter.ts` (`interactionOwner` keyed by item id), populated from `pendingQuestions`, `pendingPermissions`, and the upsert branch of `observeNotifications`; cleared on remove and in `forgetInteractions`. Have the remove branch publish `sourceId = [owner ?? session.id, requestId]`. Verify `bun test src/chat/adapter.test.ts` still passes.
- [x] 2.2 Unit test the reconciliation-only path: upsert a child question through a parent reconciliation (`listQuestions` returning a request owned by the child), drop the answered event, deliver a parent reconciliation with only the removal → `onNotification` receives `resolved` for the identity built from `[childConversationId, requestId]` and the tracker's `pendingSnapshot()` is empty. Verify the test fails on current main and passes with 2.1.
- [x] 2.3 Unit test the parent-answer path for both kinds: `respondQuestion`/`respondPermission` called with the parent conversation id for a child-owned request → `resolved` is emitted under the child identity. Verify the test passes.

## 3. Spec and closing

- [x] 3.1 Sync the two delta scenarios into `openspec/specs/web-push-notifications/spec.md` at archive time; until then verify `openspec validate stabilize-notification-resolution` reports the change valid.
- [x] 3.2 Run `bun test` and the notification-related e2e file(s) (`tests/e2e/*notification*`); verify a green run and that the enrollment dialog's existing error-path e2e still shows a server message without an "enabled" state.
- [x] 3.3 Close #404 with the reasoning from the proposal (option 3) and link this change's PR from #402 and #403. Verify the three issues reference the PR.
