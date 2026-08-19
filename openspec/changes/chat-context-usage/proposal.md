## Why

OpenCode reports token usage on every message — `AssistantMessage.tokens
{input, output, reasoning, cache{read,write}}` — and each model carries
`limit.context`. Two things the user asked for sit on that data, and uatu drops
it at normalization.

**Context usage.** A conversation gives no sign of how full its context window
is until it overflows. Used over limit is the fill; the data is there and
discarded.

**Subagent cost.** The pinned subagent track shows a description and a status
glyph. The child session names its model and carries its own token counts, so
the track could say what each subagent ran and burned, and does not.

The reasoning-variant feature (`chat-agent-capabilities`) already landed the
model side of this — `ChatModel.contextLimit` is transported. This change adds
the usage side: keep the tokens OpenCode reports, and build the two readouts on
top.

## What Changes

- **Keep token usage on the timeline items.** A new `TokenUsage` rides on the
  `assistant_message` item (the conversation's own usage) and on the `task`
  tool item (a subagent's aggregated usage, mirrored from the child). One type,
  one closed schema touched.
- **A context-usage indicator** in the composer row: collapsed to a bar reading
  used-over-limit, expandable to the input / cache / output breakdown. Gated on
  a new **context** capability. Used is `input + cache read + cache write` of the
  latest assistant message — what occupies the window now — against the selected
  model's `contextLimit`.
- **Subagent attribution** on each subagent-track row: the model it ran (shown
  whenever known) and the tokens it consumed (gated on **context**), aggregated
  from the child session and mirrored onto the parent's `task` tool item. A
  subagent that has not reported usage stays readable and asserts no figure.

Explicitly out of scope:

- Currency cost. `AssistantMessage.cost` is available; money in the UI is its
  own decision.
- A lifetime-spend total. The indicator reports the live window fill, not the
  sum across the conversation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: adds one requirement, *Chat reports context usage and
  subagent cost*, and the **context** capability name. Where the agent declares
  it, Chat reports how full the conversation's context window is and attributes
  each subagent with its model and token cost — each gated, absent (not empty)
  when undeclared. This is the second half of the split from
  `chat-agent-capabilities`, which shipped the reasoning variant and deferred
  these two because they share a message-level token-usage seam.

## Impact

**Code**
- `src/chat/types.ts` — `TokenUsage`; `usage` on the assistant item; `usage`
  and `model` on the tool item; `context` capability.
- `src/chat/normalization.ts` — surface message tokens onto the last assistant
  part (history) and via a `messageId → last part` map on live
  `message.updated`, without minting a stray usage-only bubble.
- `src/chat/adapter.ts` — aggregate a child session's usage and mirror it onto
  the parent's `task` tool item; merge usage in `mergeInteraction`; evict the
  per-child maps with the projection LRU.
- `src/chat/sdk-v2-provider.ts` — `describe()` declares `context`.
- `src/chat/timeline-renderer.ts` — `SubagentEntry` and the subagent row carry
  model and usage.
- `src/chat/ui.ts` — the context indicator; the subagent row attribution; both
  gated on `declares("context")`.
- `src/chat/validation.ts`, `src/index.html`, `src/styles.css`.

**Published API contract**
- The `assistant_message` and `tool` items are `additionalProperties: false`,
  so the added fields are breaking — but land under the existing
  `workspaceApiRevision` 5 (no bump), extending its `api/CHANGELOG.md` section.
  No request field changes, so `src/server/routes.ts` is untouched.

**Delivery**
- Unreleased chat work; a `feat(chat)` note is truthful.

**Relationship to other changes**
- Wave 1, on `fix/chat-ui-density`. Adds a new requirement, so its delta
  collides with none of the siblings. It shares the subagent track with
  `chat-subagent-navigation` (distinct concerns: that change moves navigation;
  this attributes the row) and the composer with `chat-agent-capabilities`
  (which added the variant select).
