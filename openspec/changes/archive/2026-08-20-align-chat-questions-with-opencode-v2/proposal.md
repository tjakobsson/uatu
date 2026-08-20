## Why

Uatu treats an omitted OpenCode SDK v2 `custom` flag as disabled even though OpenCode enables custom answers unless the flag is explicitly false. Its question card also exposes a permanent text field and auto-submits some single-choice questions, which differs from the requested deliberate confirmation flow.

## What Changes

- Normalize custom-answer support as enabled unless OpenCode sends `custom === false`, for both live and recovered pending questions.
- Add a UI-only "Type your own answer" choice to every supported single-select and multi-select question.
- Reveal and focus the custom text input only when that choice is selected; submit its trimmed text as an ordinary string answer rather than submitting the synthetic choice label.
- Allow a multi-select answer to combine provider options with one custom string.
- Preserve typed custom text when its choice is temporarily deselected, but exclude it from submission unless selected.
- Stop auto-submitting one-question single-select flows when a radio option is clicked; retain selection state and require the explicit Answer action.
- Preserve existing stepped multi-question navigation, final confirmation, multi-select behavior, request ownership, and at-most-once provider replies.
- Reject missing, empty, or otherwise semantically invalid per-question answer arrays before calling OpenCode.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: Structured questions adopt OpenCode SDK v2 custom-answer defaults and choice presentation while requiring explicit confirmation for single-question single-select answers.

## Impact

- OpenCode question normalization, normalized interaction validation, question-card rendering and DOM state, answer collection, and adapter-side semantic validation.
- `src/chat/normalization.ts`, `src/chat/timeline-renderer.ts`, `src/chat/ui.ts`, `src/chat/adapter.ts`, related tests, and normalized API documentation.
- No provider reply shape or persisted conversation migration; answers remain ordered `string[][]` values.
