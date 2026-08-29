## Why

Chat currently hides which subagent owns a surfaced request, drops OpenCode's live shell-output field, and offers no way to invoke OpenCode's reversible undo flow. These gaps make consequential approvals harder to evaluate, make agent activity appear silent, and force users to leave UatuCode for a core conversation operation that OpenCode already supports.

## What Changes

- Identify the specific subagent behind a permission or question shown in its parent conversation when attribution is available, and provide a direct control to open the owning transcript with a truthful fallback when attribution is incomplete.
- Normalize OpenCode's running and completed shell-output shapes, including its actual exit metadata, so command progress and results remain visible with bounded transcript presentation.
- Add local `/undo` and `/redo` Chat commands that use OpenCode's revert operations rather than its ordinary command endpoint.
- Match OpenCode's reversible interaction model: interrupt active work before undo, move the revert boundary across user turns, restore the reverted prompt to the composer, restore affected files through OpenCode, and keep every connected UatuCode client synchronized with the resulting transcript.
- Keep the behavior capability-gated and provider-neutral outside the OpenCode provider implementation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: Require attributable, navigable subagent requests; visible live and completed shell output; and provider-backed undo and redo with synchronized transcript and composer state.

## Impact

- Chat provider, adapter, service, routes, client, normalization, projection, composer, and timeline rendering.
- Additive workspace Chat API operations and contract coverage for undo and redo.
- Unit and end-to-end coverage for request provenance, shell-output lifecycle, reversible history, file restoration, and multi-client synchronization.
- No dependency update is expected; the pinned `@opencode-ai/sdk` already exposes the classic and native-v2 revert operations.
