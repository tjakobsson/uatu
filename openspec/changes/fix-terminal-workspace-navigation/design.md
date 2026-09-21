## Context

See `proposal.md` for the reported behavior and scope. The following code paths are established; their exact ordering in the reported Edge session is not yet established.

- `src/shell/hub-nav.ts` renders the current running workspace as an ordinary anchor. `aria-current` identifies it but does not prevent navigation, including navigation from a document URL back to the workspace root.
- `src/shell/presentation-storage.ts` scopes storage by workspace base path. Terminal visibility and pane references are in per-tab session storage; layout preferences are in local storage. This is already the appropriate persistence boundary.
- `src/terminal/client.ts` distinguishes a WebSocket that never opened from one that opened and then closed. In the latter case, an unexpected close calls the panel's removal callback. Removing the last pane persists hidden visibility.
- `src/hub/proxy.ts` accepts the browser upgrade independently of the child upgrade. The browser can observe `open`, followed by an upstream error, without ever having attached to a PTY. The terminal's reconstruction/readiness state is a stronger signal than the browser socket's open event.
- `src/terminal/server.ts` treats a PTY as occupied until its holder's close is processed. Ordinary attachment cannot replace that holder. Inventory exposes whether a PTY is attached, but does not identify which browser owns it.
- The terminal has no explicit pagehide/pageshow release-and-resume path. The shell's live channel has lifecycle handling, but that does not manage terminal WebSockets.
- Existing terminal reload tests exercise the direct E2E server. They do not establish the Hub-mediated workspace-picker ordering reported here.

## Goals / Non-Goals

### Goals

- Separate page departure, failed attachment, established-connection loss, confirmed shell exit, and explicit user close in the terminal controller.
- Make recovery cancelable and bounded, with one current attachment attempt per pane and no stale callback capable of changing newer state.
- Use existing inventory and reconstruction signals to recover through both direct and Hub-served transports.
- Reproduce timing-sensitive paths deterministically in tests rather than relying on browser speed.

### Non-goals

- Introducing a server-side browser identity, ownership lease, or automatic takeover entitlement.
- Sharing terminal visibility across tabs, devices, or workspaces, or migrating legacy storage.
- Keeping background workspace pages mounted as a new client-side workspace architecture.
- Changing PTY lifetime, shell creation policy for an explicit fresh open, or the native macOS client's navigation architecture.
- Broadly redesigning terminal inventory, authentication, or the shared live-channel recovery system.

## Decisions

### 1. Suppress only ordinary activation of the current running workspace

Retain the anchor and its stable URL. Handle unmodified same-tab activation of the current running row by preventing navigation and dismissing the menu through its existing focus behavior. Keyboard activation follows the same path. Match the stable workspace id, not display name or current document URL. Preserve modified clicks, middle-click, and browser context-menu actions. Preserve availability guards and the existing stopped-workspace Start flow.

Disabling or removing the anchor would also block useful open-in-new-tab behavior. Treating the click as an explicit refresh would keep the avoidable connection interruption. Neither is needed.

### 2. Add explicit release and resume without changing saved presentation

The panel owns a suspend operation distinct from `setVisible(false)` and destructive close. On `pagehide`, invalidate pending attempts, release every pane's transport, and retain visibility, pane ids, PTY references, and layout. Treat both persisted and unpersisted pagehide as resumable: the browser may preserve the document even when it does not advertise a history-cache restore.

On a subsequent `pageshow`, resume once if this document was suspended. A visibility return may also resume a suspended document on platforms that resume without a matching pageshow. A normal background-tab visibility change alone does not detach a healthy terminal. A fresh document restores through the existing workspace-scoped boot state.

Keep a monotonically increasing attempt generation and explicit lifecycle state at the pane/controller boundary. Socket callbacks, inventory requests, timers, and reconstruction callbacks must verify their generation. Hiding, closing, taking over, suspending, or replacing a pane invalidates its prior work. Release must work while connecting, attached, or recovering and must never send the user-termination code.

Using a visibility toggle for navigation would persist the wrong preference. Relying exclusively on implicit browser socket cleanup leaves event ordering outside the controller. Registering unload handlers would also complicate history caching without addressing recovery.

### 3. Reconcile failures against terminal readiness and inventory

Use terminal reconstruction completion to decide whether attachment succeeded. Browser WebSocket `open` means only transport availability. A failure before readiness follows the same reconciliation path whether the browser socket opened directly or through the Hub. A transport loss after readiness also preserves the pane until inventory or an explicit exit signal establishes the resource's fate.

Keep the panel visible with a per-pane reconnecting state. For a saved PTY:

| Observation | Result |
| --- | --- |
| Inventory lists it detached | Attempt ordinary attachment to that same PTY. |
| Inventory lists it occupied during restore | Allow a short bounded reconciliation window for the departing connection to release. Never send takeover automatically. |
| It remains occupied at the deadline | Show the existing explicit takeover choice for that PTY. |
| Successful inventory omits it, or an explicit shell-exit signal arrives | Show ended/unavailable state with an explicit New shell action. |
| Inventory/authentication request fails | Retain the pane reference and show Retry or the appropriate authentication/origin explanation. |
| Established holder receives 4410 | Park in the existing Take back state; cancel automatic recovery. |

Use a five-second total automatic recovery budget per restore/resume or user Retry, with increasing delays starting at 100 ms and capped at one second. Bound requests and attachment readiness by the remaining budget; no request or silent open socket can keep recovery pending forever. Stop on success, explicit exit, authentication failure, takeover notification, user cancellation, or lifecycle suspension. Retry must not recursively start a new budget when its own connection fails. Unit tests use controlled time rather than sleeping.

Saved references are hints, including references copied when a tab is duplicated. Reconciliation never treats them as ownership proof. An inventory read followed by an attach still races another client; a refused ordinary attach returns to reconciliation within the same budget. Reload/resume recovery must not inherit a previous explicit takeover flag as automatic permission to reclaim.

An unconditional takeover would hide teardown races but break the single-holder contract. An unconditional fresh shell would lose the user's running process. Retrying forever would conceal genuine conflicts. Bounded recovery with a visible terminal gives each outcome an explicit path.

### 4. Make bridge teardown complete and idempotent

Retain the current proxy model and existing terminal wire messages. Add an explicit closed/cancelled bridge state and an idempotent disposal path. Browser departure, failed browser upgrade, and upstream failure must close the appropriate peer and clear pending messages. If the upstream open event arrives after disposal, close it without flushing queued readiness or input. Preserve application close codes for established connections and ensure cleanup cannot overwrite their meaning.

The browser's readiness-aware reconciliation from decision 3 handles upstream upgrade refusal even if the Hub already accepted the browser. Do not infer an HTTP 409 from a generic bridge 1011 or authentication success alone; inventory supplies the occupied/missing facts. No new public protocol or API revision is planned.

Waiting to accept the browser until after an upstream handshake would change the proxy's upgrade architecture and still would not solve delayed release of the previous holder. Adding custom error frames or ownership identifiers is unnecessary for this correction.

### 5. Verify through the Hub and preserve evidence of the actual trigger

Start implementation by recording the Edge version, application version, navigation type, pagehide/pageshow events, browser socket events, Hub bridge closure, child holder state, and workspace-scoped storage before and after A -> A. Repeat A -> B -> A and refresh. Use an isolated test Hub and shells; retain traces in the normal test output locations.

Build deterministic tests for delayed old-holder release, browser-open/child-refused attachment, abandoned upstream opening, stale callbacks after resume, and a genuine second-window holder. The browser regression must use a real Hub with two workspace prefixes and assert PTY identity, shell-local state, pane count, and saved visibility. Checking only that xterm renders would miss replacement shells.

Run the targeted flow with Playwright's installed Microsoft Edge channel and Chromium. Check the installed Edge PWA manually for navigation and history behavior; an emulated standalone media query is not equivalent to an installed app. Keep lack of a local Edge installation or PWA verification explicit in implementation evidence rather than treating Chromium success as Edge verification.

## Risks / Trade-offs

- Inventory cannot identify the old tab's holder. Mitigation: retry ordinary attach only after inventory reports detached; occupied restore gets a bounded wait followed by explicit takeover. A genuine conflict may therefore take up to five seconds to settle.
- Browsers differ in unload and history-cache ordering. Mitigation: preserve presentation on pagehide, track suspension explicitly, and ignore obsolete callbacks after a resume generation starts.
- Multiple restored panes can issue concurrent reads. Mitigation: share an in-flight inventory read at panel level where practical, while keeping each pane's generation and deadline independent.
- A bridge close can race upstream opening or another close. Mitigation: terminal disposal state, idempotent peer cleanup, and deterministic event-order tests.
- A generic close was previously used as a proxy for shell exit. Mitigation: test explicit exit/termination separately from transport failure, including loss of an exit frame followed by authoritative inventory absence.
- The reported Edge trigger remains unconfirmed. Mitigation: reproduce before implementation, retain the known code-path tests, and update the diagnosis if tracing reveals a different trigger. Any finding that requires a different protocol or wider scope requires revisiting this design before coding that expansion.

## Migration Plan

1. Implement and verify the client lifecycle and proxy cleanup using existing storage keys and wire formats. Update `ARCHITECTURE.md` to describe the lifecycle distinction once implemented.
2. Deploy through the normal Hub/client build-identity update path. No data migration or ownership conversion is required.
3. Before preparing a fix PR, check whether the defect exists in the latest stable `v*` release and follow the repository's Release Please override rules if it only affects unreleased functionality.
4. Roll back by reverting the implementation. Existing shells and persisted workspace presentation remain in their existing formats.
