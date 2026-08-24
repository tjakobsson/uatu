## 1. Visual Prototype And Approval Gate

- [x] 1.1 Build the production DOM, CSS, and pure presentation updates for the visible notification indicator with an accessible unseen count, polite announcement, touch-tab attention, collapsed desktop-strip attention, and selected-conversation deletion state without connecting network or provider logic.
- [x] 1.2 Add a test-only E2E fixture driver for zero, one, and several unseen conversations; visible and hidden Chat; touch and desktop modes; and selected-conversation deletion, with no shipped debug trigger or fixture route.
- [x] 1.3 Exercise the real shell at representative desktop, narrow desktop, phone, and tablet widths in light and dark appearance; capture screenshots and check hierarchy, density, wording, focus treatment, safe areas, and competition with active-turn and request indicators.
- [x] 1.4 Present the live fixture and screenshots for manual aesthetic and UX review, apply requested revisions, and pause implementation until the user explicitly approves the presentation. Do not begin task group 2 before approval.
- [x] 1.5 After approval, lock the accepted markup, responsive behavior, accessible names, and hidden-state presentation with focused tests and verify no temporary product-side fixture trigger remains.

## 2. Provider Lifecycle And Inventory Signals

- [x] 2.1 Add provider-neutral normalization for `session.created`, `session.updated`, and `session.deleted`, covering native and compatibility envelopes with lifecycle metadata tests.
- [x] 2.2 Add a bounded one-signal-per-subscriber conversation-inventory broadcaster with initial notification, coalescing, cancellation, and disposal tests.
- [x] 2.3 Connect normalized lifecycle hints to the adapter, enforcing canonical workspace confinement and top-level-session filtering without looking up deleted sessions.
- [x] 2.4 Invalidate inventory directly after successful local create and rename operations and when the provider event pump starts or restarts.
- [x] 2.5 Track inventory-relevant session metadata so duplicate and timestamp-only updates do not cause repeated invalidations, with tests for rename, child, foreign, duplicate, and noisy-update cases.

## 3. Workspace API And Client Transport

- [x] 3.1 Extend `WorkspaceChatService` with provider-neutral inventory subscription and pass it through the lazy OpenCode service lifecycle.
- [x] 3.2 Add authenticated pull-driven SSE at `/api/chat/conversations/events` with an initial invalidation, keepalives, one pending signal per client, no-store behavior, and cancellation coverage.
- [x] 3.3 Add the app-base-path-aware inventory stream to `ChatApiClient`, including bounded reconnect backoff, initial/reconnect notification, persistent-failure reporting, and cleanup tests.
- [x] 3.4 Document the route and normalized inventory event in `api/openapi.yaml`, `api/operations.yaml`, and `api/streaming.yaml`, then update route-coverage and API contract fixtures.

## 4. Authoritative Browser Reconciliation

- [x] 4.1 Split initial chooser installation from later option reconciliation so a refreshed list preserves the selected id without reloading its snapshot or stream.
- [x] 4.2 Add one serialized inventory reconciliation loop with an in-flight dirty bit, authoritative full-list replacement, deduplication, and non-destructive failure behavior.
- [x] 4.3 Start the inventory stream after Chat bootstrap and trigger recovery reconciliation on stream reconnect, Chat activation, workspace credential refresh, and a page returning to `visible`.
- [x] 4.4 Handle external rename and unselected deletion by patching only changed chooser options while preserving focus, drafts, staged attachments, staged configuration, anchors, and the active turn.
- [x] 4.5 Connect selected-conversation deletion to the approved unavailable presentation, closing the selected stream while preserving local state and keeping the chooser and New conversation paths usable.

## 5. Live Unseen-State Integration

- [x] 5.1 Track page-local known and unseen conversation ids from post-baseline reconciliation, excluding locally created-and-selected conversations and removing deleted ids.
- [x] 5.2 Drive the approved visible notification indicator with its accessible count, live announcement, touch-tab indicator, and collapsed-strip indicator from the unseen set without moving focus or opening Chat.
- [x] 5.3 Clear the current unseen set on activation of the visible indicator, pointer or keyboard activation of the conversation chooser, or explicit unseen selection, and verify merely revealing Chat does not acknowledge it.
- [x] 5.4 Remove or consolidate any prototype-only presentation wiring while retaining the test-only fixture states as visual regression infrastructure.

## 6. Cross-Client Verification

- [x] 6.1 Add browser-level coverage with two clients proving remote creation updates the chooser and indicators without changing the first client's selected conversation, draft, focus, or timeline position.
- [x] 6.2 Add browser-level coverage for remote rename, unselected deletion, selected deletion, local creation without self-notification, and subagent exclusion.
- [x] 6.3 Add recovery coverage for inventory-stream interruption, provider-pump restart, duplicate invalidations during an in-flight fetch, and page visibility restoration.
- [x] 6.4 Run the focused Chat and route tests, `bun run typecheck`, `bun run api:validate`, the relevant Playwright files, and the full `bun test` suite.
