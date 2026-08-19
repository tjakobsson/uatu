## Why

Approving a file change means clicking "Allow" on a card that lists paths as
`<code>` strings. The user approves an edit without seeing the edit. OpenCode
carries the patch — `SnapshotFileDiff.patch`, with `additions`/`deletions` —
and the chat timeline already renders diffs for completed edit and patch tools
(`.chat-diff`), so the card could show what it is asking to apply, and does not.

Separately, an answered permission still costs a full card. `renderPermission`
keeps the summary, the whole resource list, and a "Resolved: approved-once"
line after the decision is made. The decision is over; the card is scroll the
user pays for on every later pass through the transcript. (This item moved here
from `chat-ui-density`, which could not touch `renderPermission` without
colliding with this change on the same requirement.)

## What Changes

- **Show the pending change in the permission card.** When a permission is a
  file edit, the card renders its diff inline — the same `.chat-diff`
  presentation the timeline already uses for completed edits — so the user sees
  what "Allow" applies before applying it. The diff stays in the card, not the
  Preview pane.
- **Recede a resolved request to a one-line trace.** A resolved permission or
  question collapses to what was asked and what was decided, with the resources
  it named still reachable by expanding it. Pending requests are untouched:
  their prominence is the point.

Explicitly out of scope:

- Rendering the diff in the Preview pane. It stays in the card.
- A confirmation step before answering, or any change to which request is
  answerable.
- Non-edit permissions (a command, a fetch) gain no diff — there is nothing to
  show.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: the requirement *Users can resolve agent interaction
  requests in context* gains two statements — that a permission to change a
  file shows what it would change where the decision is made, and that a
  resolved request recedes while keeping its outcome legible and its resources
  reachable.

## Impact

**Code**
- `src/chat/timeline-renderer.ts` — `renderPermission` renders a pending edit's
  diff and a resolved request's compact form.
- `src/chat/normalization.ts` — keep the patch on a permission that carries one.
- `src/chat/types.ts` — the permission item carries its diff when it has one.
- `src/styles.css` — the resolved-request compaction; the card diff reuses
  `.chat-diff`.
- `src/chat/validation.ts`, `src/chat/client.ts` — parse the permission diff.

**Published API contract**
- The permission item is `additionalProperties: false`, so a diff field is
  breaking. `workspaceApiRevision` bump, coordinated with the sibling wave-1
  changes so the branch lands one revision, with an `api/CHANGELOG.md` section.

**Delivery**
- Unreleased chat work. The diff-in-card is a `feat`; the resolved compaction
  is presentation stabilization. The combined branch PR carries the appropriate
  Release Please handling.

**Relationship to other changes**
- Wave 1, on `fix/chat-ui-density`. It owns *resolve interaction requests*, so
  its delta collides with none of the siblings.
