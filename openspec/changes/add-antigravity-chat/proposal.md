# Add Antigravity as a chat agent

## Why

People who use Google Antigravity cannot use it from Chat today. Antigravity's
command-line tool, `agy`, speaks the Agent Client Protocol (ACP) over standard
input and output, and Antigravity's ACP documentation says any ACP client can
launch it. Chat can therefore offer Antigravity as a third agent. It would run
the user's own installed `agy` under the user's own Antigravity login,
including personal Google account plans, with no credentials passing through
UatuCode.

This change depends on `generalize-chat-agent-seam`, which makes the shared
chat code agent-neutral. It is planned as the top pull request of a GitHub
stack, with the seam pull request below it.

## What Changes

- Chat offers **Antigravity** (agent id `antigravity`) after OpenCode and
  Claude Code in the agent picker. OpenCode stays the server default.
- UatuCode finds the installed `agy` on `PATH` and runs `agy acp`. Each live
  conversation has its own process, and listing conversations uses a separate
  short-lived one. ACP is spoken through the official
  `@agentclientprotocol/sdk` package.
- Login stays entirely with `agy`. UatuCode never sees or stores tokens, and
  the Hub's Agent accounts has no Antigravity entry. With no login, Chat shows
  the login-missing state and says to run `agy` and sign in.
- Supported: streaming replies and thoughts, tool activity, permission prompts
  (allow once or deny), models with thinking levels, modes (default, accept
  edits, plan), agy's slash commands, interrupt, mid-turn steering,
  context-window use, token usage, conversation cost, image attachments where
  agy accepts them, and conversation history from agy, enriched from agy's
  own transcript where it can be read.
- A new agent-neutral capability, `immediate-steering`, covers agents that take
  a message into the running turn at once but cannot withdraw it, as agy
  does. Busy Send and Enter steer, and Alt/Option+Enter and the Send hold
  queue, as in a steering conversation. The steer has no pending state and no
  withdraw, edit or switch-to-queue action, and it appears once in the
  timeline. Antigravity declares it with `send-now`, not `steering`.
- Not supported in this change: rename, undo and revert, background workers,
  agent questions, subagents, scheduled wakeups, and side questions.
- Cost is estimated from a built-in price table, a snapshot of models.dev that
  a development script regenerates. Chat makes no network request for prices
  at runtime.
- The SDK coverage report gains an Antigravity section derived from the ACP
  package's schema.
- Docs: `docs/CHAT.md` gains Antigravity prerequisites, including Google's
  policy note on consumer plans, and its Scope section no longer says that
  Chat does not implement ACP. `ARCHITECTURE.md`, the `CLAUDE.md` folder map
  and CONTRIBUTING.md's SDK list follow.

## Capabilities

### New Capabilities

- `antigravity-chat`: the Antigravity agent. It covers discovery of `agy` and
  its availability, the CLI-owned login, one process per live conversation,
  conversation listing and history, timeline normalization, permissions,
  models and thinking levels, modes, commands, interrupt, context and token
  usage, estimated cost, attachments, and the capabilities it declares.

### Modified Capabilities

- `chat-agents`: the offered agents are OpenCode, Claude Code and Antigravity
  in that order. Login-missing guidance covers an agent whose login is managed
  by its own command-line tool. The new `immediate-steering` capability adds
  its composer, dock, timeline and turn rules, and the shared surface's
  capability gates admit it.
- `agent-coverage-report`: coverage can be derived from a protocol SDK's
  published schema (methods and session update kinds) as well as from an
  agent SDK's declarations.

`agent-accounts` does not change. Under the requirement as modified by
`generalize-chat-agent-seam`, Antigravity declares a login the Hub does not
manage, so it has no Agent accounts entry.

## Impact

- **Code**: new `src/chat/antigravity/` (descriptor, runtime configuration,
  provider, ACP connection, normalization, transcript reader, price table,
  `sdk-coverage.ts`). `src/cli.ts` registers the third agent.
  `scripts/agent-coverage.ts` gains an ACP extractor. The shared composer,
  dock and adapter learn `immediate-steering`. A new script under
  `scripts/` regenerates the price table. `tests/e2e/server.ts` registers an
  Antigravity fake.
- **Dependencies**: adds `@agentclientprotocol/sdk` (Apache-2.0, 2.x, no
  runtime dependencies) and its `zod` peer. Installing them needs explicit
  approval, followed by `bun run check:licenses` and a check that both bundle
  into `dist/uatu`.
- **API contract**: no new published schema. Antigravity reuses the existing
  conversation, status, usage and cost payloads, and its conversation ids are
  `antigravity:<sessionId>`. `immediate-steering` is a new name in the open
  capability list, which clients already tolerate, and steers reuse the
  existing `steer` delivery value. A refused steer is a notice with the new
  `code` value `steer-refused`, whose item id names the request; `code` and
  `id` are open strings, so the change is additive and documented in the API
  changelog. The prompt route's `awaitingConfirmation` answer is on the
  workspace route the Hub proxies, outside the public contract. Commit 2
  confirms this against the compatibility gate.
- **Policy**: Google's terms restrict third-party use of `agy` under consumer
  plans. The docs state this, and users decide whether to use a personal
  plan (design D12).
