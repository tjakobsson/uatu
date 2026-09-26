## Context

See proposal.md (Why) for the motivation. This section covers the current state the design depends on.

- `HubNotifications` (`src/hub/notifications.ts`) watches each covered workspace's child notification feed. It records one delivery per event and enrolled device in the persisted `NotificationStore`, and a drain loop sends pending deliveries through `attempt()`. The drain runs on every ingested frame and on a one-second `refresh()` timer. Deliveries expire five minutes after the source event (`NOTIFICATION_LIFETIME_MS`), checked in `attempt()` and `prune()`.
- The child's `NotificationFeed` (`src/chat/notification-feed.ts`) keeps a `pending` map of unanswered requests and a replay ring of past events. Both are pruned at the same five-minute lifetime. After a replay gap, the hub gets a snapshot of `pending` and discards any unsent needs-answer delivery missing from it.
- Since #357, a session page holds its one `/api/hub/live` stream only while it is visible. The lifecycle recovery releases it on hide or `pagehide` and reconnects when the page is shown again. Session pages opt into the `activity` topic. The broker keeps one `ActivityFeed` per user with a set of sinks, one per session-page stream (`LiveBroker.subscribeActivity(sink, user)`). The dashboard opens a stream only for the worktree dialog, and without `activity`.
- The browser's push worker must show a notification for every push: Safari revokes subscriptions that stay silent, and Chrome shows its own generic notice instead. Suppression therefore has to happen before the hub sends.
- The workspace child API (`/s/<ws>/api/*`) is excluded from the public contract (`api/exclusions.yaml`, `workspace-api`). The `activity` topic is published and stays bounded to four booleans.

## Goals / Non-Goals

**Goals:**
- One presence signal, owned by the hub and read by the notification engine, with no new client report.
- Hold and release states that survive a hub restart, reuse today's delivery records, and keep the one-delivery-per-event-and-enrollment rule.
- An in-app notice built only from data the page already receives, plus one internal child read.

**Non-Goals:**
- Changing the published Hub API, the `activity` topic's fields, or any public revision.
- Letting the push worker decide suppression.
- Suppressing per conversation or per workspace. Presence covers the whole user.

## Decisions

### D1. Presence is derived from the broker's per-user activity feeds

A user is present while their `ActivityFeed` has at least one sink. The broker records `lastSeenAt[user]` when a user's last sink detaches, and exposes `presence(user, now): "present" | "recent" | "away"` plus an `onPresenceChange` callback. "Recent" means `now - lastSeenAt < 30 s`, or `now - brokerStartedAt < 30 s` for a user it has never seen.

*Why activity sinks, not all streams:* only session pages subscribe to `activity`, and only visible ones hold a stream. The dashboard's worktree stream and background tabs drop out without extra rules. "Present" then means exactly "a page that can show the switcher badge is on screen", which is the promise the spec makes.

*Alternatives:*
- A client heartbeat reporting `document.visibilityState`, for example piggybacked on `activity-viewed`. This adds a write path and a timeout rule for something the stream already tells us.
- A per-device presence table keyed by enrollment. Rejected together with per-device suppression (see proposal).
- Deciding in the service worker with `clients.matchAll()` and a focus check. Blocked by the forced-visible-notification rule described in Context.

A visible page whose network drops also loses its sink. The 30-second grace period covers the reconnect, and the same window covers the restart case.

### D2. Holding is decided in `attempt()`, not at enqueue

`enqueue()` records deliveries exactly as today, so dedupe, cutoffs, and discard-on-resolution stay the same. `attempt()` reads presence for `device.user` before sending:

| Category | present | recent | away |
|---|---|---|---|
| turn-completed | discard | skip (stays pending) | send; expires at `createdAt + 5 min` |
| needs-answer | mark `heldAt` (first time), skip | mark `heldAt`, skip | if `heldAt` is set and unreleased: discard when `now - createdAt > 60 min`, else stamp `releasedAt = now`. Then send; expires at `(releasedAt ?? createdAt) + 5 min` |

`heldAt` and `releasedAt` are optional fields on the persisted delivery record, so an old store loads unchanged. `prune()` and the expiry check in `attempt()` use one helper, `deadline(delivery)`:
- `releasedAt + 5 min` once released;
- `createdAt + 60 min` while held and unreleased;
- `createdAt + 5 min` otherwise.

The 24-hour journal prune is unchanged. A delivery that is skipped does not bump `attempts` or `nextAttemptAt`, so it is re-checked on the next drain pass. That pass runs every second and whenever presence changes, so a release goes out within about a second of the grace period ending.

*Why not a separate "held" status:* every discard rule already targets `status === "pending"`: resolution, gap snapshot, access loss, device removal, workspace removal, and re-enrollment. A held delivery that stays `pending` inherits all of them, which is what the spec requires ("every other rule that discards an unsent delivery SHALL discard a held one alike").

*Why decide at send time:* presence can change between ingest and drain, and a completion in the grace period has to be re-decided when the period ends. Deciding once at enqueue would need a second pass anyway.

### D3. The child keeps unanswered requests for the hold limit

`NotificationFeed` prunes `pending` at `NOTIFICATION_HOLD_LIMIT_MS` (60 min) instead of the five-minute lifetime. So does `AgentNotificationTracker` (`src/chat/notifications.ts`), which produces the feed's events. Today it forgets an unanswered request after five minutes and marks it settled, so an answer given later would announce no resolution, and the hub would release a push for a question already answered. The replay ring's retention stays at five minutes. The hub's `enqueue()` still refuses to create a delivery for an event older than five minutes, so a gap snapshot that now lists older unanswered requests creates nothing new. It only avoids discarding held deliveries that are still genuinely pending.

*Alternative:* extend the ring too. Rejected because only unanswered-request identity matters for reconciliation, and a longer ring means more memory and replay volume for no behavior.

### D4. The notice is a client module fed by the existing activity listener

A new `src/shell/attention-notice.ts` registers an activity listener on `liveChannel()`. It keeps `known: Map<ws, awaiting>`, which is filled from the first report for each workspace after page load and never reset by a reconnect. The live channel already keeps the latest activity across suspend and resume, and the module keeps its own copy anyway.
- A change from not awaiting to awaiting, for a workspace other than the page's own, pushes a notice.
- A change back to not awaiting, or to not running, removes it.
- A change to awaiting counts only if the workspace had read not awaiting for at least 1.5 s (`QUIET_BEFORE_NOTICE_MS`). The broker reports a running workspace whose activity it has not read yet as idle and corrects itself a moment later. That happens right after the hub or a session starts, and on every first page in the lazy e2e broker. Read literally, the correction would announce a question that was already waiting when the page loaded.

The notice is rendered in a fixed stack container inside the app shell. In desktop mode it sits bottom-right, clear of the chat composer. In touch mode it sits above the tab bar, using the existing safe-area and tab-bar height variables. It uses the switcher's `awaiting` tone. Workspace display names come from the same source hub-nav already uses for the switcher menu.

*Alternative:* put it inside hub-nav's switcher. Rejected because hub-nav is already large, and the notice has its own lifecycle and markup.

### D5. "Open" resolves the waiting conversation at the destination

The notice links to `/s/<ws>/?awaiting=1`. On boot, the chat UI sees `awaiting` and calls a new internal child route, `GET /api/chat/awaiting`. The route returns `{ conversationId: string | null }`: the most recent entry of `NotificationFeed.snapshot()` by `createdAt`. The page then continues exactly as for `?conversation=<id>`: activate Chat in the current UI mode, select the conversation, and use the existing unavailable-destination handling. A `null` answer opens Chat on its list with a short "already answered" note.

`carryNotificationConversation` (renamed `carryNotificationTarget`) carries `awaiting` through history updates and the login redirect, just as it carries `conversation`.

*Why not put the conversation id in the activity topic:* the published `hub-live-stream` requirement forbids per-conversation detail in the summary, and adding a field to that closed object would be a breaking revision. Resolving in the workspace keeps the summary bounded and the public contract untouched.

### D6. Wiring

`src/hub/main.ts` (where `HubNotifications` is built) passes `presence` and `onPresenceChange` from the `LiveBroker` into the notifications options. `onPresenceChange` triggers `drain()`. The e2e hub server (`tests/e2e/hub-server.ts`) and the notification pipeline harness (`tests/notification-pipeline.ts`) wire the same seam, so specs can drive presence through real page visibility.

## Risks / Trade-offs

- **A visible but unattended page silences pushes.** An unlocked screen with the Uatu tab in front counts as present. → Mitigation: stated in the docs. Idle detection is an explicit non-goal and can be added later on the same `presence()` seam.
- **A question left unanswered buzzes the phone 30 seconds after the tab is hidden.** This is intended ("follows the user out"), but a user who deliberately leaves a question for later gets one push. → Mitigation: one push per event and device at most. It is never repeated.
- **Hub restart grace delays pushes by up to 30 seconds** for users with no page open. → Accepted. Delivery timing is already not guaranteed.
- **Browsers differ on when a page counts as hidden.** An occluded window may stay "visible" in some browsers. → Accepted and documented. The behavior then errs toward quiet only while a Uatu window is actually on screen.
- **A question within 1.5 s of an answer in the same workspace raises no notice** (D4's quiet period). → Accepted. The switcher badge still shows it, and the hold rule still pushes it if the user leaves.
- **After a hub restart, a visible notice can disappear and come back.** The new broker briefly reports every workspace idle; the page clears the notice, then re-raises it once the workspace has read idle for the quiet period, or not at all if the correction arrives sooner. → Accepted: rare, and the badge is unaffected once the broker has read the workspace.
- **Two questions in the same workspace raise one notice**, because `awaiting` is a boolean. → Accepted. Open selects the newest, and the conversation list shows the rest.
- **Longer `pending` retention in the child** holds at most one entry per unanswered request. → Negligible.

## Migration Plan

No migration step. New delivery fields are optional, and deliveries recorded before the upgrade behave as never held. Rollback to a build without this change ignores the extra fields. After that rollback, a held delivery older than five minutes expires on the old rule.
