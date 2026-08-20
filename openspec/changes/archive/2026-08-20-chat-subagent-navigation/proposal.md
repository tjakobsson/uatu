## Why

Opening a subagent's transcript lands badly. `openChildConversation` injects a
temporary `↳ label` option into the conversation picker and selects it — so a
subagent, which is a detail of the turn you are reading, is presented as a peer
conversation alongside the real ones. There is no way back except re-choosing
the parent, the injected option vanishes on reload, and in the picker a child
reads as a sibling of the conversation that launched it.

This gets worse with more agents, not better: a fan-out puts several children
in the picker, none of them a conversation the user started. A subagent
transcript is a drill-down into a turn, and the picker is the wrong surface for
it.

## What Changes

- **Open a subagent's transcript as a drill-down, not a picker entry.** The
  parent conversation stays selected in the picker; the child opens as a layer
  over the timeline with a way back to the parent. On a phone this is a stack
  push with the platform back gesture; on the desktop split it is an inline
  drill-down that keeps the parent in view — one model, two chromes.
- **Keep the parent answerable while a child is open.** A subagent can raise a
  permission question, and the parent must stay reachable to answer it — the
  drill-down does not trap the user in the child.
- **Stop populating the picker with children.** The picker lists conversations
  the user can start and resume; a subagent transcript is reached from its
  parent's subagent row, not from the picker.

Explicitly out of scope:

- Changing what a subagent row shows (its model and tokens are
  `chat-agent-capabilities`). This change is navigation only.
- Nesting drill-downs more than one level. A subagent of a subagent opens from
  the row it appears on; the back affordance returns one level.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: adds one requirement, *A subagent's transcript opens as a
  drill-down from its parent*, stating that a subagent transcript is reached
  from its parent rather than the conversation picker, that the parent stays
  selected and answerable while a child is open, and that returning to the
  parent is a first-class affordance — a stack pop on touch, an inline return on
  the desktop split.

## Impact

**Code**
- `src/chat/ui.ts` — replace `openChildConversation`'s picker injection with a
  drill-down layer and a back affordance; keep the parent's picker selection and
  its answerable requests intact.
- `src/index.html`, `src/styles.css` — the drill-down layer and its back
  control, in both the touch (stack) and desktop (inline) chromes.

**Published API contract**
- None. This is client navigation over data the workspace already provides;
  no schema or route changes, so no `workspaceApiRevision` bump.

**Delivery**
- Unreleased chat work; a `feat(chat)` note is truthful.

**Relationship to other changes**
- Wave 1, on `fix/chat-ui-density`. It adds a new requirement and touches only
  the client, so it collides with none of the siblings. It shares the subagent
  track with `chat-agent-capabilities`, but distinct concerns (that change
  attributes the row; this one changes what opening it does).
