## Why

The copy icon attached to every completed assistant message adds persistent message-level chrome without enough value. Fenced code-block copy remains useful because it provides a precise shortcut for content that is otherwise awkward to select.

## What Changes

- Remove the whole-answer copy action from completed assistant messages.
- Keep copy actions on fenced code blocks within assistant messages.
- Retain accessible clipboard feedback and failure handling for code-block copy.
- Remove whole-answer-only rendering, styling, interaction handling, and tests.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: Narrow assistant-content copy behavior to fenced code blocks and remove the completed-answer copy requirement.

## Impact

- Affects Chat timeline decoration, delegated copy handling, copy-action presentation, and Chat tests.
- Does not affect Preview code-block copy, Chat code-block copy, conversation data, or service APIs.
