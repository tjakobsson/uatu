## Why

Chat throws away three things OpenCode reports on every turn, and each is a
feature the user asked for.

**Reasoning effort.** OpenCode models advertise `variants` — named ways of
thinking harder or faster, "high" and "xhigh" among them — and the prompt API
takes a `variant` per message. `listModels` keeps the id, provider, and name
and drops the variants, so the user cannot choose one.

**Context usage.** Every `AssistantMessage` carries `tokens {input, output,
reasoning, cache{read,write}}`, and every model carries `limit.context`. Used
over limit is the context-window fill. `normalizeAssistant` keeps the text and
drops the tokens; `listModels` drops the limit. So a conversation gives no sign
of how full its context is until it overflows.

**Subagent cost.** A fan-out of subagents is exactly where model and spend
matter, and the pinned track shows only a description and a status glyph. The
child session names its model and carries its own token counts — the same data
dropped above — so the track could say what each subagent ran and burned, and
does not.

All three are blocked by the same discard. Keep the data once, and the three
features sit on top of it.

## What Changes

- **Keep what OpenCode reports.** `listModels` carries each model's `variants`
  and `limit.context`; `normalizeAssistant` keeps `modelID`/`providerID` and
  `tokens`. Two new capability keys — **variants** and **context** — join the
  agent's declaration, added to the record wave 0 opened.
- **A reasoning-variant control**, beside the model select, offering the
  selected model's variants and sent as `variant` on the prompt. It sticks per
  conversation like the model select does, and is gated on the **variants**
  capability. A model without variants offers no choice.
- **A context-usage indicator** in the composer row: collapsed to a single bar
  reading used-over-limit, expandable to the input / cache / output breakdown.
  Gated on the **context** capability. Subtle by default — it answers "how full
  am I" without shouting.
- **Subagent attribution.** Each subagent row states the model it ran and the
  tokens it consumed, sourced from the child session's assistant usage and
  mirrored to the parent through the path that already carries a subagent's
  pending requests. The token figure is gated on **context**; the model name
  shows whenever the child reports one. A subagent that has not yet reported
  usage stays readable and asserts no figure. (Moved here from
  `chat-ui-density`, which could not build it without this plumbing.)

Explicitly out of scope:

- Per-subagent or per-turn cost in currency. `AssistantMessage.cost` is
  available; putting money in the UI is its own decision.
- Choosing variants for a subagent, or setting a workspace-wide default
  variant. The control is the composer's, per conversation.
- A running total of spend across a conversation. The context indicator reports
  the live window fill, not lifetime tokens.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: adds one requirement and extends the capability vocabulary.
  A new requirement, *Chat surfaces an agent's model options and usage*, states
  that where the agent declares them, Chat offers a per-model reasoning-variant
  choice, reports the conversation's context-window usage, and attributes each
  subagent with its model and token cost — each gated on its declared
  capability and absent, not empty, when undeclared. The **variants** and
  **context** capability names join those the agent may declare.

## Impact

**Code**
- `src/chat/types.ts` — `ChatModel` gains `variants` and `contextLimit`; the
  normalized assistant item keeps model and token usage; `SubagentEntry` and
  the tool item carry a usage total; `ChatCapability` gains `variants` and
  `context`.
- `src/chat/sdk-v2-provider.ts` — `listModels` keeps variants and the context
  limit; `describe()` declares the two new capabilities.
- `src/chat/normalization.ts` — assistant messages keep `modelID`/`providerID`
  and `tokens`.
- `src/chat/adapter.ts` — aggregate a child session's usage and mirror it onto
  the parent's projection on the existing coalesced path.
- `src/chat/ui.ts` — the variant select, the context indicator, the subagent
  attribution; each gated on `declares(...)`.
- `src/chat/timeline-renderer.ts` — `SubagentEntry` and the subagent row.
- `src/chat/validation.ts`, `src/chat/client.ts` — parse the widened model and
  the usage.
- `src/index.html`, `src/styles.css` — the variant select, the indicator, the
  attribution styling.

**Published API contract**
- `ChatModel`, the chat tool/assistant items, and `ChatPromptRequest` are all
  `additionalProperties: false`, so the added fields are breaking.
  `workspaceApiRevision` 4 → 5, with an `api/CHANGELOG.md` migration section.

**Delivery**
- Chat is unreleased. These are genuine additions, so a `feat(chat)` note is
  truthful.

**Relationship to other changes**
- Wave 1, on the `fix/chat-ui-density` branch alongside `chat-ui-density`,
  `chat-change-review`, `chat-activity-output`, and `chat-subagent-navigation`.
  It owns a new requirement, so its delta collides with none of theirs.
