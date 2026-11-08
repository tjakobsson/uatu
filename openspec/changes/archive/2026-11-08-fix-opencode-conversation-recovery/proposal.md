# Proposal

## Why

[Issue #578](https://github.com/tjakobsson/uatu/issues/578) reports inaccessible OpenCode V2 conversations and interrupted recovery. Synthetic reproductions show that saturated child ownership lookups and a five-second whole-history deadline can reject otherwise readable parent history; review also found an unbounded child-accounting read on that path.

## What Changes

- Keep authoritative parent history readable when optional child ownership, execution history, or accounting enrichment is unavailable.
- Give whole-history recovery a separate bounded window while retaining shorter worker and mutation deadlines.
- Preserve workspace ownership, Stop authority, cancellation, stream-generation fences, and native revert visibility under partial enrichment.
- Share worker identity construction between normalization and exclusion-only evidence so those identities cannot drift.
- Add public provider/adapter regression coverage and align the chat documentation.

These artifacts are being added retrospectively during review of the uncommitted implementation. They record the existing work and remaining review corrections; they do not claim that planning preceded implementation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: parent history recovery tolerates unavailable optional child enrichment without weakening native visibility or control safeguards.

## Impact

- Product code: `src/chat/adapter.ts` and the OpenCode V2 provider/worker identity implementation.
- Tests: colocated provider, adapter, and worker identity coverage where required.
- Documentation: `docs/CHAT.md` and the existing `opencode-chat` capability spec.
- No new dependencies, public wire changes, authentication changes, agent restarts, or execution mutations.
- Read-performance optimization is explicitly out of scope. Authenticated mobile/SSE validation remains an acknowledged limitation, not a claim that every cause of issue #578 is resolved.
