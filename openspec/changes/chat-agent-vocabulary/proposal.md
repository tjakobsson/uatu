## Why

Chat was built for one agent and says so everywhere. "Ask OpenCode…", "Message
OpenCode", "OpenCode Chat", "Question from OpenCode". A second agent — Claude
Code is the intended next one — would have to either lie about its name or
force a rename of every surface at the moment it lands.

The harder problem is the word **agent** itself. It already carries three
meanings in this one panel:

```
  agent = OpenCode's Build / Plan        →  #chat-agent-select, /api/chat/agents
  agent = a subagent in the fan-out      →  the pinned bottom track
  agent = OpenCode vs Claude Code        →  the meaning we now want
```

Three meanings, one word, and the third is the one users will type into a
support message. The picker labelled "Agent" that switches between Build and
Plan is the loudest of the three, and it is the one that has to give up the
name.

Second: agents differ in what they can do, and the differences are not
marginal. OpenCode reports token usage, reasoning variants, and subagent child
sessions. Not every agent will. Chat currently assumes every capability is
present because there is exactly one agent to ask. A control that assumes a
capability breaks when the capability is absent — and "absent" is the normal
case, not an error.

## What Changes

- **Fix the vocabulary.** Three words, three meanings, used consistently in the
  UI, the spec, and the route table:
  - **agent** — the program Chat talks to. OpenCode today.
  - **mode** — how that agent is asked to work. Build, Plan.
  - **subagent** — an agent the agent spawned inside a turn. The word already
    reads correctly once "agent" is fixed, and the bottom track already uses
    it. "Task" was considered and rejected: the todo track is already called
    the task list, so it would put two different things under one word.
- **Name the agent in the surface.** Chat states which agent it is talking to,
  instead of hard-coding "OpenCode" into every string. With one agent installed
  this changes the words, not the behavior; it is what makes a second agent a
  configuration rather than a rewrite.
- **Rename the mode control.** `#chat-agent-select` becomes the mode select,
  and `/api/chat/agents` becomes `/api/chat/modes`. **BREAKING** for the
  published workspace API.
- **Declare capabilities.** The agent reports what it supports. The surface
  renders a control only when the agent declares the capability behind it. An
  undeclared capability means the control is absent — not empty, not broken,
  not an error state.
- **Keep the capability record open.** This change declares only what Chat
  already does today: modes, model selection, commands, questions, permissions,
  subagents. Each later change adds its own key when it adds the feature behind it.
  Declaring a flag for something unbuilt would be a lie the UI then has to
  handle.

Explicitly out of scope:

- A second agent. No Claude Code, no ACP, no agent picker with two entries.
  This change makes the seam; it does not cross it.
- Any new capability. Reasoning variants, context usage, live tool output,
  change review, and subagent navigation are each their own change, and each
  adds its own capability key.
- Renaming the `opencode-chat` capability path or the `src/chat` module. The
  spec path stays where it is; moving it would collide with every parallel
  change now planned against it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: two requirements change.
  - *Users can prompt, steer, and cancel the active conversation* describes the
    composer without naming what the user is composing to. It must state that
    the surface names its agent, that the way of working is selected as a
    **mode**, and that a control appears only when the agent declares the
    capability behind it.
  - *The workspace API exposes normalized chat operations* must name the mode
    route rather than the agent route, and must carry the agent's identity and
    declared capabilities.

## Impact

**Code**
- `src/index.html`, `src/chat/ui.ts` — the user-visible strings, the mode
  select and its label, the agent's name in the header.
- `src/chat/types.ts` — the agent descriptor: identity plus declared
  capabilities. `ChatAgent` is renamed to the mode it actually describes.
- `src/chat/provider.ts`, `src/chat/sdk-v2-provider.ts`, `src/chat/adapter.ts`,
  `src/chat/service.ts` — the provider reports its identity and capabilities;
  `listAgents` becomes the mode listing.
- `src/server/chat-routes.ts` — `/api/chat/agents` → `/api/chat/modes`.
- `tests/e2e/chat.e2e.ts` — the renamed selector.
- `docs/OPENCODE-CHAT.md` — the vocabulary, and the statement that the
  integration is OpenCode-only becomes a statement about the only agent
  currently declared.

**Published API contract**
- A renamed route and a widened `ChatAvailability` are both breaking under the
  closed-object rule. `workspaceApiRevision` 3 → 4, with an `api/CHANGELOG.md`
  migration section naming the workspace domain, the route rename, and the new
  agent descriptor.

**Downstream changes**
- This is wave 0 of six. `chat-agent-capabilities`, `chat-subagent-navigation`,
  `chat-activity-output`, `chat-change-review`, and `chat-ui-density` are all
  written against the vocabulary this change establishes, and each adds one
  capability key to the record it opens. They can proceed in parallel once this
  lands; starting them before it means renaming their own work.

**Delivery**
- Chat is entirely unreleased — every `src/chat` commit postdates `v0.5.1`. A
  `feat(chat)` note is truthful here: the agent seam is new user-visible
  behavior, not a correction of shipped behavior.
