## Why

Mobile clients reaching UatuCode through Tailscale can remain on a white page or get stranded in `Reconnecting` after a device-specific transport interruption while another client continues working. The live document and Chat channels do not consistently keep intermediary paths active, take ownership of stalled recovery, or clear interruption messaging after transport has recovered.

## What Changes

- Keep the document SSE channel active across otherwise idle periods with protocol-level keepalives that survive the Hub proxy without creating application state updates.
- Bound how long the browser may delegate recovery to a native `EventSource` stuck in `CONNECTING`, then replace the stream and reconcile authoritative state.
- Reconcile and re-establish live document state when a suspended page resumes, returns to the foreground, or regains network connectivity.
- Make Chat stream recovery observable: a successful reconnect resets failure accounting and clears stale interruption messaging even when the conversation is idle.
- Ensure one client's interruption or reconnect does not disturb another client's document or Chat streams, and verify that canceled proxied streams release child subscriptions.
- Add transport diagnostics sufficient to distinguish client disconnects, Hub-to-child failures, and recovery attempts without recording streamed content or credentials.
- Leave cold-start white-page handling, JavaScript bundle size, and bundle splitting for separate follow-up work.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `document-watch-index`: Strengthen idle liveness, bounded reconnect, lifecycle reconciliation, independent-client behavior, and proxied stream cleanup requirements for the live document channel.
- `sidebar-shell`: Require the connection indicator to represent confirmed document-channel transport state and to leave `Reconnecting` after confirmed recovery.
- `opencode-chat`: Require conversation and inventory streams to detect successful reconnection, reset failure state, clear stale interruption messaging, and recover independently across clients.

## Impact

- Client connection lifecycle in `src/shell/events.ts`, `src/shell/connection.ts`, and `src/chat/client.ts`/`src/chat/ui.ts`.
- SSE production and cancellation in `src/server/watch-session.ts` and `src/server/routes.ts`.
- Hub streaming proxy behavior and diagnostics in `src/hub/proxy.ts` and its server integration.
- Unit and integration coverage for keepalives, lifecycle wake-up, stalled reconnect replacement, multiple clients, truthful status, and downstream cancellation.
- The SSE wire format gains comment keepalive frames; no application event schema, API revision, dependency, or breaking compatibility change is expected.
