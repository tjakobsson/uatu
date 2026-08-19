## Context

See `proposal.md` — Why. This design records the decisions a code-and-SDK audit
settled, so implementation does not re-derive them.

- `ChatModel.contextLimit` is already transported and parsed (`types.ts`,
  `sdk-v2-provider.ts` `listModels`, `validation.ts`). Reuse it.
- The capability list is open (`parseChatAgent` accepts any non-empty string),
  so adding `context` needs no validator change — only `describe()` and the
  client gate.
- `workspaceApiRevision` is already 5; these fields land under it, extending the
  existing `## Hub 1 / Workspace 5` changelog section. No request field changes,
  so `src/server/routes.ts` is untouched.
- SDK `AssistantMessage` (v2 gen) carries message-level `modelID`/`providerID`
  and `tokens {input, output, reasoning, cache{read,write}, total?}`. `total`
  is optional and counts output, so it is NOT the window fill.

## Goals / Non-Goals

**Goals:**
- Keep token usage once, on the timeline items, and read it for both features.
- The context indicator populates on opening a conversation, not only after a
  new turn.
- Subagent usage computed server-side and mirrored, not fetched per-child.

**Non-Goals:**
- Currency cost, lifetime spend (see proposal).
- A projection-level usage field or a new ChatEvent variant (see Decisions).

## Decisions

**Carry usage on the timeline items, not the projection (Option A).** Feature 2
is unavoidably per-item: the client holds one projection and can never read a
child's, so a subagent's aggregate must be materialized onto the parent's `task`
tool item. The `ConversationItem` schema is therefore extended regardless.
Putting the same `TokenUsage` on the `assistant_message` item for feature 1 is
then minimal-surface — one new type, one closed schema (`ConversationItem`), one
validator, one transport (`item.upsert`). The alternative — usage on
`ConversationSnapshot`/`ChatProjection` — adds a second closed schema, snapshot
plumbing, and (because no ChatEvent carries a projection-level field) a new
ChatEvent variant for live updates, and STILL needs the value on the tool item
for feature 2. Option B is a superset of A's cost with none of its savings.

**History load is the authoritative path; live streaming is the refinement.**
`adapter.history` builds items from stored messages, which carry both parts and
message-level tokens, so attaching usage in `normalizeAssistant` populates the
indicator when a conversation is opened. Live intra-turn refinement rides
`message.updated`, which is the only at-risk path (see Risks).

**Decorate an existing assistant part; never mint a usage-only item.**
`renderItem` renders any `assistant_message` as a bubble, and it is not
groupable, so a usage-only or empty-markdown item would show as a stray bubble.
Instead: attach usage to the last assistant_message part of the message. On
history load that part exists. On live `message.updated` (which arrives with no
part), a bounded `messageId → last assistant part id` map — threaded like the
existing `messageRoles` map, populated in `message.part.updated` — lets the
usage upsert target the real part id; a `message.updated` arriving before any
text part buffers in a `messageId → pending usage` map and flushes when the
first part appears. `mergeInteraction` (adapter) and the client projection merge
must preserve streamed markdown when a usage-only upsert arrives
(`markdown: incoming.markdown || current.markdown`).

**Fill is input + cache, not total.** The window occupancy is
`input + cacheRead + cacheWrite` of the latest assistant message — the most
recent request's prompt, which already includes prior turns and cache. `total`
counts output and overstates occupancy. The expandable breakdown lists input,
cache, and output separately.

**Subagent usage aggregates in the adapter and mirrors to the parent tool
item.** Child events already reach the pump (proven by the request mirror). A
per-child usage map sums the child's assistant-message tokens and records its
model; on update, the parent's `task` tool item (matched by
`childConversationId === childSessionId`) is upserted with `model`/`usage`. The
per-child maps evict with the projection LRU alongside `lastModel`/`lastMode`.

Revised during implementation: "not fetched per-child" held for the live path
but left a real hole — the parent's own store never records the attribution, so
a workspace restart or an eviction of the parent lost a figure the child's
stored messages still carry. A cost that silently disappears is worse than the
round trips it saved. Reconstruction is therefore lazy and cached: a `task` row
whose child has no banked tally reads that child's messages once, in parallel
with its siblings, and banks the result — so the cost is paid per parent-open
for a subagent never seen live, and never again. A failed read banks nothing,
since an errored list is unknown rather than empty.

## Risks / Trade-offs

- **Live `message.updated` ↔ part ordering (primary).** Whether tokens reliably
  arrive after a first text part, or need the early-arrival buffer, needs a live
  check (`real-opencode.integration.test.ts`). → History load and turn
  completion are the guaranteed baseline; if the live path proves fragile the
  indicator still updates on open and at completion, only intra-turn refinement
  is lost.
- **Per-message vs cumulative tokens.** Affects the subagent sum (sum-of-messages
  vs latest). → Verify against a live child session before choosing; default to
  summing per-message components and fall back if `total` is unpopulated.
- **Which model string to show.** Child messages carry provider/model ids, not
  display names. → Show the id, or resolve against `listModels()` for a friendly
  name — a small follow-up decision, not a blocker.
- **This change and `chat-subagent-navigation` both touch the subagent track.** →
  Distinct concerns (attribution vs navigation) and distinct requirements, so
  no delta collision; the code touches `syncSubagents`/`subagentEntries` in
  different ways and merges mechanically.

## Migration Plan

No data migration, no revision bump. Extend the `assistant_message` and `tool`
members of the `ConversationItem` schema and the matching `expectKeys` lists,
add the `context` capability to `describe()` and the changelog, and let the
contract tests gate it. A client validating closed items must accept the new
optional `usage`/`model`; these are further optional fields under revision 5.
