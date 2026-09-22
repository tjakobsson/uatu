## Why

In Microsoft Edge, selecting a workspace, even the workspace already open, can hide the terminal and leave its running shell behind a "Take over" action. Ordinary navigation should preserve this tab's terminal state and reconnect its shells without requiring users to reclaim their own session.

## What Changes

- Make ordinary activation of the current running workspace dismiss the picker without navigating or interrupting the terminal. Preserve explicit open-in-new-tab gestures and the current stopped workspace's Start action.
- Preserve workspace-scoped, per-tab terminal visibility and pane references through reload, workspace round trips, and browser history restoration. Release departing connections without terminating shells or recording the panel as user-closed.
- Recover terminal attachment failures through the Hub without treating a browser-side WebSocket open as proof that the child accepted the attachment. Keep a visible recovery state while reconciling inventory and retrying transient failures within a bounded window.
- Preserve explicit takeover for terminals genuinely held elsewhere. Persisted pane references never authorize automatic takeover.
- Cover the reported Edge flow through a real Hub, including delayed connection teardown and comparison with an installed Edge PWA.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `hub-dashboard`: Ordinary activation of the current running workspace is a no-navigation action.
- `embedded-terminal`: Navigation preserves this tab's terminal presentation and attachments, and transient attachment failures recover without hiding the panel or creating replacement shells.
- `hub-service`: Terminal WebSocket bridge failures and teardown leave clients able to recover and do not retain abandoned upstream holders.

## Impact

- Browser workspace navigation in `src/shell/hub-nav.ts`.
- Terminal lifecycle, restoration, and failure handling in `src/terminal/client.ts`, `src/terminal/panel.ts`, and their persistence helpers.
- Hub WebSocket bridging in `src/hub/proxy.ts`; terminal server ownership behavior and routes must continue enforcing explicit takeover.
- Colocated lifecycle/proxy tests and Hub-backed Playwright coverage under `tests/e2e/`.
- No new dependency or persisted-state migration is expected. Existing workspace-scoped storage and terminal inventory remain the basis for restoration.
- The Edge trigger has been reported but not reproduced during planning. The first implementation task establishes its event ordering rather than treating the suspected stale-connection race as proven.
