## Why

Chat remembers a conversation's model, mode, and reasoning variant only in the current browser. Opening that conversation on another device can therefore show false defaults and, on the next prompt, silently change the model or run under a mode different from the one displayed. Conversation titles also cannot be edited from Chat even though the provider can persist them.

## What Changes

- Make the effective model, mode, and reasoning variant authoritative conversation state exposed by the normalized workspace API, rather than device-local presentation state.
- Restore that configuration when a conversation is opened on another device or after a workspace restart, and publish configuration changes to other open clients.
- Keep a client's unsubmitted selection local until a prompt is accepted; accepted configuration becomes the conversation's shared state.
- Add a capability-gated conversation rename operation and a Chat affordance that persists the title through the agent.
- Rename the ambiguous `New` action to `New conversation`; it continues to create a conversation with the workspace's current agent.
- Keep drafts, reading position, expanded activity, and panel geometry client-local. Do not add a second agent, an agent picker, or a `New agent` action.
- **BREAKING**: widen the closed normalized Chat contract with conversation configuration and rename support, requiring a workspace API revision bump and migration notes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: resumable conversations gain authoritative model/mode/variant configuration, cross-client updates, manual renaming, and unambiguous conversation-creation wording.

## Impact

- Chat domain types, validation, provider abstraction, OpenCode SDK adapter, service, routes, client, projection, and UI.
- Conversation snapshots/events and the published workspace OpenAPI/streaming contract, operation metadata, revision, and changelog.
- Browser presentation persistence: existing per-conversation configuration values stop being authoritative; device-local drafts and geometry remain unchanged.
- Unit, integration, contract, and browser coverage for cross-device resume, restart recovery, concurrent clients, unsupported capabilities, and rename behavior.
