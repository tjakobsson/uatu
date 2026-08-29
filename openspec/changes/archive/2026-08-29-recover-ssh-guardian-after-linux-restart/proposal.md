## Why

Stopping Windows can terminate a WSL2 VM before Uatu's detached SSH guardian removes its Unix sockets and ownership record. On the next Hub start, the preserved control socket has no listening process, so recovery fails with a generic `SSH guardian request failed` error and requires informed manual cleanup.

## What Changes

- Record the Linux boot identity in newly created SSH guardian ownership state.
- Automatically remove exact, owner-validated guardian artifacts that are proven to come from an earlier Linux boot, including partially cleaned runtime state.
- Continue to fail closed for current-boot, replaced, unowned, or otherwise unprovable artifacts.
- Keep the shipped ownership format readable and provide actionable recovery guidance when automatic recovery is unavailable.
- Cover WSL-style abrupt shutdown recovery and ownership-format compatibility with tests.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `hub-credentials`: Extend dedicated SSH runtime recovery to recognize and safely clean exact artifacts left by a previous Linux boot.

## Impact

- SSH guardian ownership and startup-handshake formats in `src/hub/credential-ssh-supervisor.ts`.
- Managed SSH agent startup and recovery in `src/hub/credential-ssh-agent.ts`.
- Guardian lifecycle tests and the `hub-credentials` specification.
- No public HTTP API or stored credential-secret format changes.
