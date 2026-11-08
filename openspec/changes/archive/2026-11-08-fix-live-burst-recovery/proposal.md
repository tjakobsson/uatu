## Why

A deterministic broker/endpoint test closes an actively reading client's live stream when one upstream chunk contains 2,713 small conversation events (~2 MiB). Synchronous fan-out fills the outbound queue before its reader can run, misclassifying a normal burst as a stalled client. This is a proven local interruption path, not attribution of the reported live incident.

## What Changes

- Yield fairly while processing large child-event batches so active clients can drain their bounded queues.
- Preserve event ordering, generation/abort ownership, queue limits and termination of genuinely stalled clients.
- Cover ordinary live delivery and catch-up replay with deterministic bounded fixtures.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `hub-live-stream`: distinguish a draining reader from a stalled client during large upstream batches.

## Impact

Hub broker scheduling and colocated broker/endpoint tests. No wire/API, authentication, adapter, dismissal, dependency or browser-setting changes. Existing lifecycle tests remain intact.
