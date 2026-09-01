# Add Claude Code as a first-class chat agent

## Why

Chat is hardwired to OpenCode at the service layer even though the provider
seam beneath it was built for a second implementation, and users who prefer
Claude Code cannot use Chat at all. Supporting both — chosen per
conversation, not per workspace — lets each user work with the agent they
already pay for and trust, and proves the chat abstraction against a second
real agent. Established open-source multi-agent clients show the shape that
works: a shared timeline model with per-agent providers over the Claude
Agent SDK.

## What Changes

- Every conversation gains an owning agent. Users choose the agent
  (OpenCode or Claude Code) when starting a conversation; existing
  conversations keep their agent for life. Inventory, status, and the
  configuration picker become agent-aware. **BREAKING** for the
  workspace chat API: conversation summaries and snapshots carry an
  `agent` field, availability is reported per agent, and mutations are
  routed by the conversation's agent.
- The chat internals become agent-neutral: OpenCode wire normalization
  moves below the provider seam into an OpenCode-owned module, the
  hardwired OpenCode runtime becomes an injectable agent runtime seam,
  and `OpenCode*`-named shared types are renamed to neutral names.
  Shared machinery (adapter, replay, receipts, queue, inventory,
  attachment store, timeline renderer, all client UI) is reused by both
  agents.
- A Claude Code agent is added: availability probing of the `claude`
  executable, one Claude Agent SDK session per live conversation,
  streaming timeline, permission requests via the SDK's tool-approval
  callback, structured questions via `AskUserQuestion`, permission modes
  surfaced as chat modes, models with effort levels as reasoning
  variants, token usage, interrupt, native session resume, conversation
  discovery from Claude Code's own session storage, image attachments on
  prompts, plan approvals with implementation intents, subagent
  transcripts opening as drill-downs from their parent, reversible
  history over Claude Code's native rewind, and a live task-progress
  surface for the agent's own todo tracking.
- Documentation follows: the chat doc becomes agent-neutral with
  per-agent prerequisite sections; ARCHITECTURE.md and CLAUDE.md track
  the new `src/chat` layout.

Deliberately out of scope (follow-up change): importing Claude Code
sessions from working directories other than the canonical workspace
directory.

## Capabilities

### New Capabilities

- `chat-agents`: the multi-agent chat model — which agents a workspace
  offers, per-agent availability and retry, per-conversation agent
  identity, agent choice at conversation creation, and merged
  conversation inventory across agents.
- `claude-code-chat`: the Claude Code agent — executable discovery and
  availability, per-conversation Claude Agent SDK sessions, timeline
  normalization, permissions, questions, plan approvals, modes, models
  and effort, usage reporting, interrupt, resume from Claude Code's
  native session storage, image attachments, subagent drill-down,
  reversible history, and the task-progress surface.

### Modified Capabilities

- `opencode-chat`: requirements that assume Chat has exactly one
  implicit agent are re-expressed against the shared agent model —
  OpenCode startup becomes scoped to OpenCode conversations, the
  normalized workspace API reports agents in the plural, and the
  identity header follows the selected conversation's agent.
  OpenCode-specific behavior (server lifecycle, SDK compatibility
  probing, reversible history, attachments, inventory recovery) is
  otherwise unchanged; cross-agent inventory lives in `chat-agents`.

## Impact

- **Code**: `src/chat/` is restructured into shared modules plus
  `src/chat/opencode/` and `src/chat/claude/`; `src/server/routes.ts`
  chat routes gain agent awareness; `src/shell` chat surface wiring and
  the configuration picker gain an agent axis.
- **API contract**: `api/openapi.yaml` and its contract tests change for
  the agent field, per-agent status, and an agent parameter on
  conversation creation (breaking revision of the workspace chat API),
  plus additive extensions: a task-progress timeline item kind and
  agent-provided approval choices on permission cards.
- **Dependencies**: adds `@anthropic-ai/claude-agent-sdk` (license
  audit; must bundle into the compiled single-file `dist/uatu` binary —
  verified by an early spike task).
- **Docs and tests**: `docs/OPENCODE-CHAT.md` reorganized, unit + e2e
  suites extended with a Claude Code provider double; hub proxy and
  desktop client need no protocol changes beyond the API revision.
