## Why

Web Push fires for every eligible agent event, even while the user is looking at Uatu. A question in the conversation on screen buzzes the laptop and the phone at once, and a finished turn in another workspace raises an OS notification that the switcher's `finished` badge already shows. Notifications should reach the user when Uatu cannot show them the event itself, and stay quiet when it can.

## What Changes

- **The hub knows when a user is present.** A user is present while at least one of their session pages is visible on any device. Hidden pages already release their `/api/hub/live` stream, so the hub reads presence from the streams it holds. The hub dashboard does not count because it does not show agent activity. Presence is per user, not per device: someone at their desk gets no buzz on their phone.
- **Leaving has a 30-second grace period.** A user who hides their last visible session page stays "recently present" for 30 seconds. Switching tabs briefly or a stream reconnecting does not count as leaving. After a hub restart, every user starts in the grace period so reconnecting pages are counted before anything is sent.
- **Pushes wait while the user is present.**
  - A turn that completes while the user is present is not pushed. The chat or the switcher's `finished` badge already shows it.
  - A question or permission request that arrives while the user is present is held, not sent. It is pushed once the user has been away for the full grace period and the request is still unanswered.
  - Anything that arrives during the grace period is held. It is sent if the user stays away. If the user comes back first, a held completion is dropped and a held question stays held.
  - An answer from any device discards the held push, as it discards a pending one today.
- **A held question has its own time limit.** It can be released up to 60 minutes after it was asked. Its five-minute delivery lifetime starts at release, not at the original event. The workspace keeps unanswered requests in its notification feed for that long, so a reconnect after a replay gap can still tell which held requests are unanswered.
- **Absent users are notified as today.** With no visible session page, pushes go out immediately under each device's workspace and category preferences.
- **An in-app notice for questions in other workspaces.** When a workspace the user is not viewing starts waiting for an answer while a session page is open, that page shows a small notice (a toast) naming the workspace, with an Open button. Open goes to that workspace with Chat in front and selects the conversation that is waiting. If it was answered in the meantime, Chat opens on its list with a short note. The notice clears when dismissed, opened, or answered from any device. It is shown only while the page is open and never for the workspace being viewed. Completions do not get a notice; the badge covers them.
- **Out of scope:**
  - Idle detection: a visible page counts as present even if nobody has touched it for a while.
  - A per-device "notify even while I'm using Uatu" option.
  - Presence for the hub dashboard.
  - An in-app notice for the workspace being viewed.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `web-push-notifications`: a new requirement says delivery waits while the user is present. It defines presence, the grace period, the hold and release rules for each category, and the hold limit. "Delivery is bounded and suppresses duplicate events" now measures a held request's lifetime from its release.
- `hub-dashboard`: a new requirement adds the session page's notice for workspaces that start waiting elsewhere, and the link it opens that selects the waiting conversation.

## Impact

- `src/hub/live-broker.ts`: a per-user presence view (counts of visible session-page streams, the time the last one ended, and a change signal), built from the activity subscriptions the broker already tracks per user.
- `src/hub/notifications.ts`: `attempt()` checks presence.
  - Completions: dropped while the user is present, held during the grace period.
  - Questions and permission requests: held until the user is away.
  - A delivery can be sent only after release, within the 60-minute limit. Its expiry is measured from release.
  - A presence change starts a new delivery pass.
- `src/hub/notification-store.ts`: delivery records gain a persisted release time.
- `src/hub/main.ts` / `server.ts`: connect the broker's presence view to the notifications service.
- `src/chat/notification-feed.ts`: unanswered requests are kept for 60 minutes, not five. The replay window of past events is unchanged. The internal workspace API gains a read of its most recent unanswered request (conversation id only). The workspace child API is internal, so no public API revision changes.
- `src/shell/hub-nav.ts` (or a sibling module), `src/styles.css`: the notice, driven by the activity topic changing from not waiting to waiting. It sits above the touch-mode tab bar.
- `src/chat/ui.ts`, `src/chat/notification-navigation.ts`: the link that opens and selects the waiting conversation. Like the push `conversation` parameter, it survives the login redirect.
- Tests:
  - Unit: `src/hub/notifications.test.ts` (presence matrix, grace period, hold limit, restart grace), `src/hub/live-broker.test.ts` (presence counting), `src/chat/notification-feed.test.ts` (retention).
  - Hub navigation unit tests, for the notice's triggers and clearing.
  - e2e: `tests/e2e/hub-switcher.e2e.ts`, for the notice opening the waiting conversation.
- Docs: `ARCHITECTURE.md` notification section. The user-facing notification guide states what to expect.
