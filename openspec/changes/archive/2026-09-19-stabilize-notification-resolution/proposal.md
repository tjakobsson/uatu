## Why

Two gaps left over from the Web Push review loop (#400) let the hub either promise notifications it cannot honor or keep a delivery alive after the request was answered. Both are recorded as follow-ups #402 and #403; the feature is unreleased, so fixing them now keeps the first release truthful.

## What Changes

- Enrollment refuses instead of guessing: when a selected workspace is running and the hub cannot establish that workspace's notification-feed position within the settle bound, `enroll` answers with a retryable 503 naming the workspace(s) and writes no device record. Today it stamps the cutoff anyway, so a completion between the cutoff and the eventual cursor is silently lost while the device reports itself enabled (#402).
- Interaction resolutions publish under the owning conversation: a question or permission that belongs to a subagent is announced under `[childConversationId, requestId]`, but its removal — from a parent's authoritative reconciliation, or from an answer given in the parent's transcript — is currently keyed under the parent session id. The tracker then resolves an id that was never pending, the child's request stays pending in the feed, and a queued retry can still notify after the answer (#403). The adapter will retain each published request's owner and publish removals under it.
- Unit coverage for both, plus one spec scenario each.
- No user-visible surface changes; the enrollment dialog already shows a failed request's message without marking the device enabled.
- Out of scope: #404 (completions between a workspace's start and the hub's first feed open) is closed separately with its reasoning; nothing here touches the feed protocol.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `web-push-notifications`: "Notifications require explicit device opt-in" gains the retryable refusal when a running workspace's feed position cannot be established; "Notifications describe live agent events" gains a scenario making the existing "known resolution discards the unsent delivery" sentence testable for a child request whose live answer signal was missed.

## Impact

- `src/hub/notifications.ts` — `settle()` reports which workspaces did not connect; `enroll()` throws `NotificationRequestError(503, …)` before any store mutation. `src/hub/server.ts` already maps `NotificationRequestError` to its status.
- `src/chat/adapter.ts` — `observeNotifications` removals resolve the owner from per-request tracking recorded when the request was published (questions and permissions alike).
- `src/hub/notifications.test.ts`, `src/chat/adapter.test.ts` — new cases.
- `openspec/specs/web-push-notifications/spec.md` — two scenarios.
- No API schema change: the enroll operation's documented error responses already include 503 for "sender not configured"; confirm the OpenAPI description covers the new reason during implementation (`bun run api:validate`).
- Release notes: the feature is unreleased, so the PR carries a `chore(notifications)` Release Please override.
