## Context

See `proposal.md` — Why. The current implementation is `openChildConversation`
in `ui.ts`: it appends a temporary `↳ label` option to the picker and selects
it, so the child rides the same `selectConversation` path as a real
conversation and the picker's flush-save logic has to special-case the injected
option to avoid pruning its draft. The whole mechanism exists to make a
drill-down look like a peer, which is the defect.

Two prior-art points from the exploration inform the model: a mobile coding
client opening nested runs uses a stack push with native back, not an overlay;
an overlay is a desktop idea. So the portable model is one behaviour with two
chromes — a stack on touch, an inline drill-down on the desktop split.

## Goals / Non-Goals

**Goals:**
- A subagent transcript is a drill-down, not a picker peer.
- The parent stays selected and answerable behind an open child.
- One navigation model, rendered as a stack on touch and inline on desktop.

**Non-Goals:**
- Multi-level nesting. One level; the back affordance returns one level.
- Anything the subagent row shows — that is `chat-agent-capabilities`.

## Decisions

**Drill-down state, not a picker option.** Replace the injected option with an
explicit "viewing child X of parent Y" state the surface holds. The picker's
selection stays the parent; the timeline renders the child; a back affordance
clears the state. This removes the flush-save special-case rather than adding to
it. Alternative considered: keep the option and add a back button — leaves the
child a pseudo-conversation that still pollutes the picker and the stored
drafts.

**One model, two chromes.** The drill-down is the same state in both modes; the
CSS and the back affordance differ. Touch renders it as a pushed screen with the
back gesture (consistent with the touch tab-bar navigation already in the app);
desktop renders it inline over the timeline with a return control, keeping the
parent's composer and its pending requests in view. Alternative considered: an
overlay in both — wrong on a phone, where a stack is the platform idiom and an
overlay traps focus.

**The parent stays live.** The parent's projection, its pending requests, and
its composer remain mounted behind the child, because a subagent can raise a
request the user must answer for the parent. The child is a view over the
parent, not a replacement of it. This is the same ownership the request-mirror
already establishes: a subagent's request is answered against the owning
conversation however many places show it.

## Risks / Trade-offs

- **Removing the picker option changes stored-draft pruning.** → The drill-down
  state is not a conversation, so it never enters the draft store; the
  special-case that protected the injected option's draft is deleted, not
  reworked.
- **Touch back-gesture vs the existing tab bar.** → The drill-down is a layer
  within the Chat tab; back returns to the parent transcript, not out of Chat.
  Verify it composes with the touch tab-bar rather than fighting it.
- **A child open while the parent streams.** → The parent stays mounted, so its
  updates continue; returning restores it at its live position via the same
  anchor logic that already governs the timeline.
- **Deep-linking or reload with a child open.** → A drill-down is transient view
  state, not a conversation; reload returns to the parent, which is the correct
  and expected reset rather than a restored pseudo-conversation.
