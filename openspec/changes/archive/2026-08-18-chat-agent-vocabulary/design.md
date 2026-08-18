## Context

See `proposal.md` — Why. Four facts about the current code shape the approach.

**`ChatAgent` already means the wrong thing.** `src/chat/types.ts` defines
`ChatAgent = { name, description }`, and its comment says it is "a primary
OpenCode agent (Build, Plan, ...)". That is a mode. The word has to move.

**The route table carries the same mistake into the published contract.**
`/s/{workspaceId}/api/chat/agents` returns `ChatAgentList`, summarized as
"List primary OpenCode agents a prompt can run under". Renaming only the UI
would leave a route whose name means the opposite of what the UI now says.

**`ChatAvailability` is a closed discriminated union.** The `ready` arm is
`{ state: "ready", version }` with `additionalProperties: false`. Any agent
identity or capability record added to it is breaking.

**The word "task" is already taken.** `#chat-task-list` is the todo track. The
subagent track is `#chat-subagents`. Using "task" for a subagent run would put
two unrelated things under one word, which is the exact defect this change
exists to fix.

## Goals / Non-Goals

**Goals:**
- One word per concept, in the UI, the spec, and the route table.
- A capability record the surface can read before it renders, and that later
  changes extend one key at a time.
- The seam proved by OpenCode alone, with no second agent to guess at.

**Non-Goals:**
- A second agent, an agent picker, or any ACP work.
- Moving the `opencode-chat` spec path or the `src/chat` module. Five changes
  are queued against both; moving either would collide with all of them.
- Renaming internals that are not user-visible and not part of the contract.
  Churn is not the goal; ambiguity is what is being removed.

## Decisions

**"Mode" for build and plan.** It is the word the agent-side ecosystem already
uses for exactly this — an agent advertises named ways of working and the
client selects one. Choosing the same word means a future adapter maps to our
vocabulary instead of translating around it. Alternatives considered:
"profile" (suggests saved user settings, which these are not) and "persona"
(suggests a character, not a tool policy).

**"Subagent" stays.** Once "agent" means the backend, "subagent" reads exactly
right: an agent the agent spawned. It is already the word in the code and in
the pinned track. Alternative considered: "task", rejected on the collision
above.

**Capabilities ride on the `ready` availability state.** The client already
fetches status before it renders Chat, so the declaration arrives before the
first paint. Putting it on a separate endpoint would let controls appear after
the surface is already usable, which is the pop-in the change is meant to
prevent. Alternative considered: a dedicated `/api/chat/capabilities` route —
one more round trip, one more failure mode, and nothing gained.

**Positive declaration only.** A capability is present in the record or it is
not. No `supported: false`, no tri-state, no "unknown". A missing key and a
false key would eventually disagree, and the surface would have to decide which
one it believed.

**Declare only what exists today.** Modes, model selection, commands,
questions, permissions, subagents. Nothing for usage, variants, live output,
change review, or subagent navigation — those changes each add their own key
with the feature behind it. A flag declared ahead of its feature is a lie the
surface then has to handle, and it would also make the five parallel changes
edit the same record.

**Rename the type before introducing the new meaning.** `ChatAgent` becomes
`ChatMode` in one step, and only then does a new `ChatAgent` appear for the
backend. Doing both at once produces a diff where a familiar type silently
changes meaning, which is the hardest kind of review to do well.

**Rename the route and take the bump.** `/api/chat/agents` → `/api/chat/modes`,
`workspaceApiRevision` 3 → 4, one `api/CHANGELOG.md` section covering both the
rename and the widened `ChatAvailability`. Alternative considered: keep the
route and rename only the UI — cheaper today, and it leaves a permanent trap
for the next reader, which is the same class of defect being fixed.

## Risks / Trade-offs

- **A rename touches a lot and delivers no visible feature.** → It is wave 0 of
  six for exactly that reason. Landing it first is what keeps the other five
  from renaming their own work; landing it late costs five rewrites.
- **"Agent" is a load-bearing word in the archived specs and in git history.** →
  Only the two modified requirements and live documentation are corrected.
  Archived changes are historical record and stay as written.
- **The contract break reaches every workspace API consumer, not just Chat.** →
  One revision covering both breaks, with the changelog naming the route rename
  explicitly, so a consumer sees a rename rather than a missing route.
- **With one agent, capability gating is untestable in the real world.** Every
  key OpenCode declares is always true, so the absent-capability path never
  runs in production. → Cover the absent path in unit tests against a provider
  that declares less, and treat "the control is absent" as the assertion, not
  "the control is disabled".
- **Users who read "agent" as Build/Plan today will have to relearn it.** →
  Chat is unreleased. There is no installed base to migrate, and this is the
  last moment the rename is free.

## Migration Plan

No data migration. `workspaceApiRevision` 3 → 4 follows the established path:
bump `api/contract.json` and `api/openapi.yaml`, add the `api/CHANGELOG.md`
section, and let the contract tests gate it. A consumer on revision 3 sees the
mode route where the agent route was, and an extra agent descriptor on the
ready state.
