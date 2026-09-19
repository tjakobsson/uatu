## Why

Users need to know when an agent asks a question, requests permission, or finishes a turn while Uatu is closed or their phone is locked. On iPad, the desktop layout also places headers under the system's top-edge blur and shifts them out of view when the Magic Keyboard accessory bar appears, making the installed app difficult to use.

## What Changes

- Add opt-in, standards-based Web Push for hub-served Uatu in supported browsers and installed PWAs, including iPhone and iPad Home Screen apps.
- Offer per-device notification preferences for selected workspaces, with questions/permission requests and successful turn completion as the initial event categories.
- Observe agent events on the server independently of browser connections, with stable event identities, bounded retry, and duplicate suppression.
- Deliver notifications through a push-only service worker; tapping a notification opens the corresponding workspace and agent-qualified conversation.
- Replace the blanket prohibition on service workers with a push-only registration contract, preserving manifest-based installation and carefully migrating legacy registrations.
- Make the iPad desktop layout respect safe areas and the visual viewport, including hardware-keyboard accessory bars, software keyboards, rotation, and live mode switching.

## Capabilities

### New Capabilities

- `web-push-notifications`: Device opt-in and preferences, authenticated subscription lifecycle, agent notification events, background delivery, and conversation navigation.

### Modified Capabilities

- `pwa-install`: Permit a push-only service worker while keeping installation independent of notification permission and offline support; preserve the new worker during legacy cleanup.
- `base-path-serving`: Distinguish hub-owned push worker scope and notification control URLs from session-prefixed URLs and generic mounts.
- `touch-navigation`: Require safe-area and keyboard-aware geometry on tablets using desktop mode, including the reported 11-inch iPad Pro with Magic Keyboard.

## Impact

- Chat adapters/services for OpenCode and Claude need a shared, live-only notification event contract and a child-to-hub feed that remains active without pages.
- Hub code needs persistent VAPID identity, device subscriptions and preferences, delivery state, authenticated control routes, and Web Push sending. New public operations must enter the published Hub API contract; the child feed remains explicitly internal.
- PWA boot/cleanup, static asset serving, shared URL helpers, and chat navigation need push-worker registration and notification-click handling.
- Shell layout, chat/terminal viewport coordination, and CSS need iPad desktop-mode corrections. Physical iPad verification is required for the system blur and keyboard accessory behavior.
- A maintained Web Push implementation must work with Bun and the compiled distribution and pass the repository's license checks. HTTPS is required for remote devices, and the running hub needs outbound access to browser push services. No Apple Developer Program membership or Uatu-hosted relay is required.
