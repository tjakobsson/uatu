## Why

Dismiss finished currently serializes one save and a complete paginated conversation read per worker. A deterministic 285-worker replay produces 858 child-page reads over three pages; the existing 20-page or transcript-output byte bound independently causes save failures with the exact client error reported in #592.

## What Changes

- Save an explicit eligible group through one bounded conditional bulk operation, with one atomic persistence outcome and one visible result.
- Read a compact authoritative worker-only projection from the child, avoiding repeated transport of paginated transcript bodies while retaining complete source coverage and positive-activity fences.
- Preserve account scope, exact execution identities, revision checks, fail-closed availability, existing singleton callers and storage safety.
- Add regression coverage and update the public Hub and internal child contracts.
- Defer #581 diagnostics and #589/#590 lifecycle work. Reproduced failure mechanisms do not establish the cause of every live #592 error or reconnect.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `personal-workspace-state`: conditional atomic worker dismissal batches and compact complete authoritative evidence.
- `chat-agents`: compact internal authoritative worker evidence through agent-qualified dispatch.

## Impact

Dismissal client and Workers action, Hub dismissal handler/store, child routes and chat history projection, API schemas and focused tests. No dependency, authentication, configuration, runtime-limit, live-state or safety-setting changes. The feature was introduced after stable v0.8.0; a dismissal-only fix requires a Release Please chore override. When shipped with `fix-live-burst-recovery`, retain a visible fix for the independently reproduced stable reconnect defect. Do not edit generated changelog entries.
