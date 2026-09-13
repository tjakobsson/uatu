## Why

Opening and returning to long chats feels slow on a phone, including on Wi-Fi, and loading feedback does not consistently explain the wait. The user noticed this with Claude Code, but the shared renderer and both providers' history paths contain potential bottlenecks, so this change covers Claude and OpenCode after the higher-priority file-selection fix.

## What Changes

- Measure touch-tab switching, conversation opening, streaming, older-history loading, and resume separately for both agents, distinguishing network, server, and browser work.
- Avoid rendering and measuring hidden transcripts while preserving live state, unread awareness, pending interactions, drafts, and reading position.
- Reduce full-timeline geometry work and repeated markdown/detail rendering; bound expensive history presentation where measurements require it.
- Remove optional catalog and hidden-preview work from the path to usable Chat, while retaining workspace/authentication prerequisites and lazy agent startup.
- Reduce repeated full-history work in Claude and OpenCode through bounded, freshness-aware in-memory reuse and provider-appropriate paging, preserving authoritative history and replay correctness.
- Give slow Chat reads and conversation switches immediate acknowledgment, delayed accessible loading feedback, cancellation of obsolete reads, and finite timeout/retry behavior. Keep refresh feedback separate from transport and agent errors.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-agents`: Shared responsive navigation, background presentation behavior, independent transcript/catalog readiness, loading feedback, and cross-agent performance validation.
- `opencode-chat`: Efficient paginated history with freshness, compatibility-store completeness, and replay correctness.
- `claude-code-chat`: Efficient native transcript paging and refresh without redundant processing of unchanged history or starting a turn.

## Impact

- Shared chat UI, renderer, markdown, viewport, client reads, find integration, and application boot sequencing; reuse the existing Diff loading-signal behavior where appropriate.
- Claude transcript/provider history and OpenCode history adapter paths, with bounded cache ownership at the workspace/provider level.
- Browser performance fixtures and focused UI, provider, lifecycle, pagination, and history-mutation tests. No new dependency or public endpoint is planned; any internal cursor adjustment must preserve existing opaque-cursor contracts.
- Implement after `preserve-manual-file-selection`, preserving that change's navigation ownership and the implemented `resilient-live-connections` guarantees.
- Installed-app launch restoration is a lower-priority follow-up, excluded here because distinguishing a relaunch from an explicit dashboard visit and safely restoring per-device destinations is not a small manifest edit. No third change is created.
- Offline support, broad bundle splitting, authentication policy, and terminal ownership changes remain outside scope.
