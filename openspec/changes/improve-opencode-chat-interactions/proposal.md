## Why

Chat currently hides which subagent owns a surfaced request, drops OpenCode's live shell-output field, and offers no way to invoke OpenCode's reversible undo flow. These gaps make consequential approvals harder to evaluate, make agent activity appear silent, and force users to leave UatuCode for a core conversation operation that OpenCode already supports.

## What Changes

- Identify the specific subagent behind a permission or question shown in its parent conversation when attribution is available, and provide a direct control to open the owning transcript with a truthful fallback when attribution is incomplete.
- Normalize OpenCode's running and completed shell-output shapes, including its actual exit metadata, so command progress and results remain visible with bounded transcript presentation.
- Add local `/undo` and `/redo` Chat commands that use OpenCode's revert operations rather than its ordinary command endpoint.
- Match OpenCode's reversible interaction model: let users revert directly from any visible user turn, expose the hidden suffix with per-message restore controls, retain `/undo` and `/redo` as one-turn shortcuts, restore the boundary prompt to the composer, restore affected files through OpenCode, and keep every connected UatuCode client synchronized with the resulting transcript.
- Rank slash-command suggestions by exact, prefix, segment, substring, and subsequence matches so meaningful command fragments remain discoverable.
- Give workspace and agent identity a dedicated Chat header row on desktop as well as touch layouts so conversation controls do not compete for width.
- Keep the behavior capability-gated and provider-neutral outside the OpenCode provider implementation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: Require attributable, navigable subagent requests; visible live and completed shell output; provider-backed selected-message revert and restore with synchronized transcript and composer state; fuzzy slash-command discovery; and an uncrowded two-row Chat header.

## Impact

- Chat provider, adapter, service, routes, client, normalization, projection, composer, and timeline rendering.
- Additive workspace Chat API operations and contract coverage for undo, redo, selected-message revert, and selected-message restore.
- Unit and end-to-end coverage for request provenance, shell-output lifecycle, reversible history, file restoration, and multi-client synchronization.
- No dependency update is expected; the pinned `@opencode-ai/sdk` already exposes the classic and native-v2 revert operations.
