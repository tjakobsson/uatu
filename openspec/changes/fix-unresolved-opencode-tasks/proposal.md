## Why

OpenCode workers can remain Unresolved after reconnect, reuse, or a missing parent notification even when native evidence identifies their activity or outcome. Personal dismissal reads can also fail prematurely because the Hub's evidence deadline is shorter than the child's covered-history budget.

This change records the already implemented fixes retrospectively following review; it does not claim planning preceded implementation. Review identified child-history mutation and visibility races covered by this change.

## What Changes

- Recover verified activity after reconnect without restoring revoked Stop authority; exclude finished runs and chronologically older notifications from interference with resumed work.
- Recover explicit native child idle outcomes only for a uniquely attributable execution, without inventing a parent report or summary.
- Clear stale inventory observation clocks after disconnect and reject recovery whose consumed child history changes before publication.
- Allow 30 seconds for Hub evidence fetching instead of 10 seconds, accommodating the child's 25-second covered-history budget without bypassing evidence validation.
- Add public-provider and browser regressions, document dismissal ownership and limits, and consolidate duplicated test stream cleanup.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: Specify conservative activity and explicit-outcome recovery across reconnects and reused children.
- `chat-agents`: Specify publication fencing for consumed child-history evidence.
- `personal-workspace-state`: Specify evidence-fetch budget alignment while preserving authoritative reconciliation.

## Impact

Changes are confined to OpenCode V2 recovery, the Hub dismissal evidence deadline, tests, and documentation. No dependencies, public API shapes, authentication settings or persistent-store formats change. The Hub remains the dismissal authority; the browser remains an in-memory projection.

## Non-goals

No browser-persistent dismissal cache, automatic dismissal replay, retry UI, lock redesign, deployment, or claim that the exact reported live failures are resolved. Ambiguous workers remain unresolved.
