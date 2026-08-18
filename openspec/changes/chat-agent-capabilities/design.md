## Context

See `proposal.md` — Why. The three features share one root cause: OpenCode
reports the data and uatu discards it at two seams.

- `sdk-v2-provider.ts` `listModels` keeps `{selection, provider, name}` and
  drops each model's `variants: [{id, headers, body}]` and `limit.context`.
- `normalization.ts` `normalizeAssistant` keeps the message text and drops
  `modelID`, `providerID`, and `tokens {input, output, reasoning,
  cache{read,write}}`.

Two facts that shape the approach:

- The v2 prompt body already accepts `variant?: string` (per message), and the
  provider already switches OpenCode's session-level agent on the side when the
  mode changes. A variant is the same shape of side-channel — a per-prompt
  field, not session state we have to reconcile.
- The adapter already mirrors a child session's state into its parent's
  projection for pending requests (`resolveMirroredCopy`,
  `ProviderSession.parentId`). Subagent usage rides that path rather than a new
  one.

## Goals / Non-Goals

**Goals:**
- Keep the reported data once, at the two seams, and let all three features
  read it.
- Each feature gated on its own declared capability, absent when undeclared.
- Subagent usage computed server-side and mirrored, not fetched per-child by
  the client.

**Non-Goals:**
- Currency cost, lifetime spend, or a workspace-wide default variant (see
  proposal — out of scope).
- Reworking the model select, the composer layout, or the subagent track
  beyond what these three additions need.

## Decisions

**Two capability keys, `variants` and `context`, not one.** They are
independent: a model can offer reasoning variants without the agent reporting
token usage, and vice versa. One key would gate a control on a capability it
does not need. The subagent token figure is gated on `context` — it is the
same usage data — while the subagent's model name shows whenever the child
reports one, since that costs nothing extra.

**Variant is a per-prompt field, remembered per conversation.** It matches the
model select's own model: stored per conversation in the presentation state,
sent with each prompt, refused if the selected model does not offer it. The
alternative — a session-level variant switched on the side like the mode — is
possible but wrong: a variant is a property of the ask, not of the session, and
OpenCode's prompt API already models it that way.

**Context usage reads the latest assistant message, not a running sum.** The
window fill is what the last turn's `tokens` reports against `limit.context`;
it is not the sum of every turn. Carrying a per-message usage on the assistant
item and reading the newest is both correct and cheap. The alternative — a
separate usage endpoint — adds a round trip for something already in the
timeline.

**Subagent usage is aggregated in the adapter and mirrored.** Sum a child
session's assistant-message tokens, publish the total onto the parent's
projection on the existing coalesced update. The alternative — the client
fetching each child conversation to compute a row number — multiplies requests
by the fan-out width and puts a provider-shaped calculation in the browser.

**One indicator, one figure per subagent.** The context indicator collapses to
a single fill and expands to the breakdown; a subagent row shows one total.
OpenCode reports five numbers (input, output, reasoning, cache read/write); the
scannable surface wants one, with the rest available on expand or in the
transported item.

**Take the revision bump.** `ChatModel`, the assistant/tool items, and
`ChatPromptRequest` are all closed objects, so every added field is breaking:
4 → 5, one `api/CHANGELOG.md` section. Encoding usage inside an existing string
to dodge the bump was rejected for the same reason the earlier chat changes
rejected it — it makes string parsing a protocol.

## Risks / Trade-offs

- **The context "fill" is an approximation of what OpenCode counts.** The last
  message's input+cache is the prompt size, not necessarily OpenCode's own
  context accounting. → Report it as the tokens the agent itself reported
  against the model's own limit, label it as usage rather than a guarantee, and
  do not invent a number OpenCode did not give.
- **A streaming turn moves the token counts continuously.** → Read usage from
  the same coalesced projection update the surface already re-renders from; do
  not add an independent per-event channel for the indicator.
- **A subagent's model may be absent early.** → The row stays readable and
  asserts nothing until the child reports; absent usage is a normal state, not
  an error, exactly as `chat-agent-vocabulary` established for undeclared
  capabilities.
- **The variant catalog is model-specific and its ids are free strings.** →
  Render what the model advertises; never assume a fixed `low/medium/high/xhigh`
  set. A model with no variants shows no control.
- **This is the wave-1 change with the widest code reach and the only API
  bump.** → It owns a new requirement, so its spec delta collides with none of
  the sibling changes; the code touches shared files (`ui.ts`,
  `normalization.ts`, `types.ts`) but distinct functions.

## Migration Plan

No data migration. `workspaceApiRevision` 4 → 5 follows the established path:
bump `api/contract.json` and `api/openapi.yaml`, add the `api/CHANGELOG.md`
section, extend the closed schemas with the new optional fields, and let the
contract tests gate it. A client on revision 4 sees optional fields it does not
read; a client validating closed objects moves to 5.
