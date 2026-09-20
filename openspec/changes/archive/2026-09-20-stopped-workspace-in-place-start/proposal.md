## Why

A hub-served session page whose workspace is stopped — from the dashboard, another device, or a hub restart that did not bring it back — sits on `Reconnecting` for as long as it stays open, with nothing to act on. The page already knows the truth: the hub's activity topic tells it the workspace is not running, and the switcher chip's dot goes dark. Only a manual reload reaches the hub's session-unavailable page and its Start button, and that reload throws away the previewed document, scroll position, and any chat draft. GitHub issue #396.

## What Changes

- The connection indicator gains a fourth state, **Stopped**, shown when the hub reports the current workspace's session not running. It replaces `Reconnecting` for that case; `Reconnecting` remains the word for a transport gap or an unreachable child of a running session.
- While the indicator reads Stopped, activating it **starts the workspace** through the hub's session start API rather than attempting a reconnect. A successful start returns the page to `Connected` in place — the preview, scroll position, sidebar selection, and chat draft are untouched. The reload fallback of the manual reconnect does not apply to a stopped session, because a reload would only reach the same offer.
- A start refused because the workspace's credential store is locked hands off to the hub dashboard's unlock flow, the way the switcher's Start for another workspace already does. Any other failure is shown at the indicator and the control stays available.
- The workspace switcher menu's entry for the **current** workspace offers Start when the session is stopped, as entries for other stopped workspaces already do; today the current row is inert.
- A session started from anywhere else (the dashboard, another device, the switcher on another page) clears the Stopped state on the open page from the stream, without a reload.
- Pages served directly by `uatu serve` (no hub) are unchanged: they have no hub to report a stopped session and no session to start.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `sidebar-shell`: "Animate the live connection indicator" gains the `Stopped` label and state, sourced from hub-reported session state, and the rule that a stopped session is never shown as `Reconnecting`. "The connection indicator offers a manual reconnect" gains the rule that while Stopped the control starts the session instead of reconnecting, with no reload fallback, and the locked-credential hand-off.
- `hub-dashboard`: "The workspace switcher chip reflects real session state" gains the current workspace's Start affordance in the menu when its session is stopped, and the requirement that the session page's indicator and the switcher agree on the stopped state.

## Impact

- `src/shell/connection.ts` — a `stopped` raw state (label, title, accessible name, CSS class); activation dispatches to start instead of `requestManualRecovery` while stopped; a small error line for a failed start.
- `src/shell/hub-nav.ts` — publishes the current workspace's running fact (from the activity topic, confirmed by a hub state read) to the shell; offers Start on the current row; shares one start routine (POST `/api/hub/sessions/<id>/start`, unlock hand-off) between the row and the indicator.
- `src/shell/live.ts` — the manual-recovery entry declines to reload while the current session is stopped (a reload cannot help), so an in-flight attempt that was started just before the stop settles without navigating away.
- `src/styles.css` — `.connection-state.is-stopped` dot and label treatment, no pulse.
- `src/index.html` — no markup change expected; the indicator's existing button is reused.
- Tests: `src/shell/connection.test.ts` (new state, activation routing, error line), `src/shell/hub-nav.test.ts` (running-fact derivation, current-row Start), `src/shell/live.test.ts` (no reload while stopped), and a hub e2e in `tests/e2e/hub-switcher.e2e.ts` or a sibling: stop the viewed session through the hub API, assert `Stopped` without reload, click, assert `Connected` with the previewed document and a chat draft preserved; screenshots at desktop and phone sizes.
- No hub API change: the start endpoint, the activity topic, and `GET /api/hub/state` already carry everything needed. No workspace API change. No change to UatuCode Desktop.
