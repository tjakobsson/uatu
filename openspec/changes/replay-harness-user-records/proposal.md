## Why

Reopening a Claude Code conversation shows raw `<task-notification>` markup — and skill preambles like "Base directory for this skill: …" — as blue user bubbles. Claude Code writes these to the transcript as `user` records because that is how the model received them, but they are not the person's words. Live, the same background-task completion is a settled task row; on reopen it was a wall of XML attributed to the user.

## What Changes

- The transcript reader carries the store's own authorship facts (`origin.kind`, `isMeta`) and a stored task notification parses to its task id, launching tool, status, and summary.
- On reopen, a task notification replays as the same settled `background_task` row the live stream produces, named by the Bash/Agent step that launched it; a harness-authored record (`isMeta`) is not presented at all. A prompt that merely quotes the tag stays a bubble.
- Harness-authored records no longer count as a session's first prompt or title source.

## Capabilities

### Modified Capabilities

- `claude-code-chat`: reopened history presents background-task notifications as settled task rows and never presents harness-authored records as the user's messages.

## Impact

- `src/chat/claude/transcript.ts`, `src/chat/claude/normalization.ts` and their tests. No wire, storage, or dependency change.
- Screenshots in `screenshots/`: `before-touch.png` (main), `after-touch.png`, `after-desktop.png`.
