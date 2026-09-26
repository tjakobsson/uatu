## 1. Presence in the hub

- [x] 1.1 Add per-user presence to `LiveBroker`: `lastSeenAt` stamped when a user's last activity sink detaches, the broker start time, `presence(user, now)` returning present/recent/away with the 30 s grace period, and an `onPresenceChange` callback. Verify with `src/hub/live-broker.test.ts` cases: one visible page is present; its detach becomes recent, then away after 30 s; a second page keeps the user present; a never-seen user is recent for 30 s after start; one user's presence does not affect another.
- [x] 1.2 Connect the broker's presence to `HubNotifications` in `src/hub/main.ts`, with `onPresenceChange` triggering `drain()`. Add a no-op default (always away) so existing callers compile unchanged. Verify that `bun test src/hub` passes with the old tests untouched.

## 2. Holding and releasing deliveries

- [x] 2.1 Add optional `heldAt` and `releasedAt` to the persisted delivery record in `src/hub/notification-store.ts`. Loading a store written without them must still work. Verify with a store round-trip test that loads a fixture without the fields.
- [x] 2.2 Add `NOTIFICATION_HOLD_LIMIT_MS` (60 min) beside `NOTIFICATION_LIFETIME_MS`, and a `deadline(delivery)` helper used by both `attempt()` and `prune()` (design D2). Verify with unit cases: an unheld delivery expires at five minutes, a held one survives past five minutes, and a released one expires five minutes after release.
- [x] 2.3 Apply the presence table in `attempt()`. Completions are discarded while present, skipped while recent, and sent while away. Needs-answer deliveries are held while present or recent, and released or dropped past the hold limit while away. A skip must not change `attempts` or `nextAttemptAt`. Verify with `src/hub/notifications.test.ts` cases for every scenario in the `web-push-notifications` delta: on-screen question, other-workspace completion, one device quieting another, question following the user out (sent at 30 s, with a fresh five-minute lifetime), brief tab switch, completion just after looking away (both outcomes), answered-while-held, hold limit exceeded, away sends at once, other user unaffected, restart grace.
- [x] 2.4 Confirm that the existing discard rules cover held deliveries: resolution, gap snapshot, access loss, device removal, workspace removal, and re-enrollment. Add one test per rule with the delivery held. Verify that those tests pass.
- [x] 2.5 Confirm that held and released state survives a hub restart through `tests/notification-pipeline.ts`: hold while present, restart, become away, get exactly one send. Verify that the pipeline test passes.

## 3. Child retention and the awaiting lookup

- [x] 3.1 In `src/chat/notification-feed.ts` and the `AgentNotificationTracker` behind it (`src/chat/notifications.ts`), prune `pending` at the hold limit while the replay ring keeps its five-minute retention, so a late answer still announces its resolution. Verify with `src/chat/notification-feed.test.ts`: an unanswered request at 30 min is still in a gap snapshot, one at 61 min is gone, and ring replay is unchanged.
- [x] 3.2 Add the internal child route `GET /api/chat/awaiting` to `buildRoutes` (`src/server/routes.ts`), returning `{ conversationId }` for the most recent unanswered request, or `null`. Verify with a route test covering none, one, and several (newest wins), and check that `api/exclusions.yaml`'s `workspace-api` entry already covers the path, so contract checks stay green.

## 4. Opening the waiting conversation

- [x] 4.1 Rename `carryNotificationConversation` to `carryNotificationTarget` and carry `awaiting=1` alongside `conversation` through history updates and the hub login redirect. Verify with `src/chat/notification-navigation` unit tests and the existing login-carry test extended to `awaiting`.
- [x] 4.2 In `src/chat/ui.ts`, handle `?awaiting=1` on boot: ask `/api/chat/awaiting`, then follow the `?conversation=` path (Chat active in the current UI mode, conversation selected, unavailable handling). On `null`, open the list with an "already answered" note. Verify with unit or e2e coverage for both answers in desktop and touch mode.

## 5. The in-app notice

- [x] 5.1 Create `src/shell/attention-notice.ts`. It takes its baseline from the first activity report per workspace after load, keeps that across reconnects, raises a notice on a change from not awaiting to awaiting for another workspace, and clears on not awaiting, not running, Dismiss, or Open. One notice per workspace, newest first. Verify with `src/shell/attention-notice.test.ts` covering every trigger and non-trigger in the `hub-dashboard` delta, including the brief-tab-switch reconnect case.
- [x] 5.2 Render the notice: workspace display name, "An agent needs your answer", Open (links to `/s/<ws>/?awaiting=1` via `appUrl`-safe hub paths) and Dismiss. Use the switcher's awaiting tone. Place it bottom-right in desktop mode, clear of the composer, and above the tab bar with safe-area insets in touch mode. Initialize it from `app.ts` only on hub-served session pages. Verify by viewing it in the dev hub (`bun run dev`) in both modes before running e2e.
- [x] 5.3 Add e2e coverage in `tests/e2e/hub-switcher.e2e.ts`: a question in workspace beta raises the notice on alpha's page, Open lands on beta's waiting conversation, an answer elsewhere clears it, and the touch-mode tab bar stays reachable. Capture evidence shots of the notice in desktop and touch mode through `tests/e2e/evidence.ts`. Verify that the spec passes.
- [x] 5.4 Add e2e coverage that pushes are withheld while a session page is visible and sent after it is hidden past the grace period. Use the e2e hub server's recording sender and page visibility, with the grace period shortened through a test seam. Verify that the spec passes.

## 6. Documentation

- [x] 6.1 Update the notification section of `ARCHITECTURE.md`: the presence source, the hold and release table, the hold limit and child retention, and the notice and `?awaiting=1` flow. Verify by reading it against design.md.
- [x] 6.2 Update the user-facing notification text in `README.md` and `docs/SELF-HOSTING.md`: pushes are withheld while a session page is visible on any device; a question left unanswered is pushed about 30 seconds after you leave; questions in other workspaces show an in-app notice. Verify that the wording matches the spec's documentation clause in "Delivery continues without an open page".
