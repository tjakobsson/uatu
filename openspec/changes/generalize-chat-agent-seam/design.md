# Design — generalize-chat-agent-seam

## Context

See `proposal.md` for motivation. This change ships as the bottom pull
request of a GitHub stack, `refactor(chat)!: generalize the chat agent seam
for more agents`, from `refactor/generalize-chat-agent-seam` in
`tjakobsson/uatu` into `main`. It carries this OpenSpec change and five
behaviour-preserving commits. The `!` marks the Workspace API revision bump in
D3, not a change in chat behaviour. The Antigravity pull request
(`add-antigravity-chat`, head `feat/add-antigravity`) is the top of the stack.

The current state that shapes each decision:

- **Turn liveness.** Image capture (`add-agent-chat-visuals`) needs to know
  whether an assistant reply's text is final and whether its turn is still
  running. `src/chat/agents.ts` (`visualTextEnded`, `visualItemLive`,
  `enrichSnapshot`, and the history and live paths around lines 401, 435 and
  634) and `src/chat/adapter.ts` (the recovery condition near line 1968,
  `statusUpdate`/`withVisualStatus` near line 7144, and
  `snapshotClaudeItem`, `orderedClaudeItem`, `preserveClaudeTurn` and
  `mergeInteraction` near line 7500) read agent-private Symbol markers by name:
  `CLAUDE_TURN`, `CLAUDE_TEXT_BLOCKS` and a `startsWith("claude:message:")`
  test from `src/chat/claude/normalization-types.ts`, and
  `OPENCODE_EXECUTION_LIVE`, `OPENCODE_TEXT_END`, `OPENCODE_COMPLETION_ALIAS`,
  `OPENCODE_STEP_LIVE`, `OPENCODE_ALIAS_LIVE` and `isVisualTurnLive` from
  `src/chat/opencode/normalization-types.ts`. `claudeVisualIdentity` runs for
  every agent, and `nativeVisualMessageIdentity` in
  `src/chat/visual-identity.ts` accepts only `"claude" | "opencode"`.
- **Runtimes.** `src/chat/claude/runtime.ts` implements discovery through
  `src/chat/executable.ts`, a coalesced `--version` probe with a 10 s timeout,
  shadowed-executable diagnostics, version parsing and the
  idle/starting/ready/unavailable states. Only Claude Code uses it.
  `src/cli.ts` (around lines 206–237) wraps it in an inline `AgentRuntime`
  literal. `src/hub/agent-account-runtime.ts` imports `ClaudeRuntime` by name.
  `LazyChatService` (`src/chat/service.ts`) takes options that extend
  `OpenCodeServiceOptions`, builds an OpenCode runtime by default, and reports
  "OpenCode is restarting; chat will retry." and "The installed OpenCode
  version is not compatible with chat." for every agent, Claude Code included.
  `ManagedProcess` (process-group SIGTERM, grace period, SIGKILL) and
  `BoundedTextCapture` are private to `src/chat/opencode/opencode-service.ts`.
- **Login.** `src/chat/login-action.ts` hard-codes `LOGIN_COMMANDS` and, on a
  Hub-served page, always links to `/settings#agent-accounts/<id>`. The same
  commands are repeated in `ACCOUNT_AGENTS` (`src/hub/agent-account-service.ts`),
  `CLAUDE_LOGIN_COMMAND` (`src/hub/agent-account-claude.ts`) and
  `LOGIN_COMMAND` (`src/hub/agent-account-opencode-v2.ts`). Two pieces of copy
  name a fixed agent: `usageReadFailureLabel` in `src/chat/composer-status.ts`
  ("Claude Code could not answer") and the `ui.ts` model-chip fallback
  (`agent?.name ?? "OpenCode"`).
- **Interactions.** `src/chat/claude/provider.ts` owns the pending
  interaction map (`interactions`, `awaitInteraction`, `requireInteraction`,
  the reply and list methods, `abandonInteractions`) and the `PushQueue` that
  feeds `events()`.
- **E2E harness.** `tests/e2e/server.ts` builds a single-agent and a dual-agent
  router by hand, types the harness body's agent as `"opencode" | "claude"`,
  and strips qualifiers with a fixed `^(?:opencode|claude):` pattern. The second
  fake (`claude-fixture`) is registered as `claude`.

## Goals / Non-Goals

**Goals**

- A third agent can plug in without touching shared code paths that name
  OpenCode or Claude Code.
- OpenCode and Claude Code behave exactly as before, except for the startup
  messages and copy listed in the `chat-agents` delta.
- Each refactor lands as one commit that passes `bun run test:ci` alone.

**Non-Goals**

- Adding the third agent (that is `add-antigravity-chat`).
- Changing the Hub's Agent accounts set: it stays OpenCode and Claude Code.
- Changing any public conversation payload other than the agent descriptor.
- Revising `add-agent-chat-visuals` artifacts. That change describes the
  behaviour as built; this change keeps the behaviour and renames the plumbing.

## Decisions

### D1. Four agent-neutral liveness facts, written by normalizers

Each normalizer writes neutral, in-process Symbol annotations. They survive
object spreads and are dropped by JSON, as the current markers are, so the
wire and the workspace API revision do not change for this decision.

Per assistant reply:

1. **Text sealed.** The reply's Markdown is final for capture. It has two
   forms, because the agents differ today: an explicit end (OpenCode's text
   end) and "completion seals text only" (Claude Code, where a reply's
   completion time ends its text block but not its turn). Shared code derives
   what `visualTextEnded` does today from these two forms. A reply with
   neither form never treats a completion time as sealing its text.
2. **Execution live: yes, no, or unknown.** Yes and no are the reply's own
   execution evidence (OpenCode's execution marker today). Unknown keeps
   today's fallback: live while the conversation streams, unless the reply
   has a completion time that is not text-only.

Per status update:

3. **Turn continues despite this terminal status.** A failed step that is not
   the end of the execution (OpenCode's step marker today).
4. **Repeat status, not a turn boundary.** A restated idle status that must not
   end a newer turn (OpenCode's completion alias today). The continuation the
   adapter derives from it (OpenCode's alias-live marker today) becomes adapter
   state, not a normalizer fact.

`isVisualTurnLive` moves to a shared module and reads facts 3 and 4.

**Shared sealable turn token.** Claude Code's turn token becomes a neutral
token any normalizer may attach to every reply of one turn. The adapter is
the only place that freezes, copies, seals or preserves tokens (today's
`snapshotClaudeItem`, `orderedClaudeItem`, `preserveClaudeTurn`, the terminal
sealing in `statusUpdate`, and the recovery comparison). Each token is either:

- **provisional**: in live projection the producer's own completion is
  ignored, and only the in-order status sequence seals it (Claude Code's live
  token today); or
- **authoritative**: the producer's completion is adopted, and recovery
  republishes a row whose evidence changed even when its JSON is equal
  (OpenCode 2.x stored-history execution evidence today).

A closed token is never reopened by a later, stale row, for either kind.

**Visual identity.** Stored captures are keyed by hashes of the identity
strings, so `claude:message:<id>`, `claude:text:<apiId>:<n>` and
`opencode:message:<id>` stay byte-identical. `nativeVisualMessageIdentity`
takes an agent id, and a new agent uses `<agentId>:message:<id>`. Claude's
text-block offsets become a neutral "text blocks" annotation, and
`claudeVisualIdentity` becomes an agent-neutral capture-identity helper that
returns the row's own identity when no blocks are present, as it does today.
`OPENCODE_TEXT_START_FALLBACK` is unrelated to liveness and stays in the
OpenCode stack.

- Alternative: a per-agent liveness strategy object called by shared code.
  Rejected: it moves the agent names one level down instead of removing them,
  and it splits the adapter's single freezing point.
- Alternative: put the facts on the wire. Rejected: they are capture plumbing,
  not contract, and would force a revision bump and client work for nothing.
- Verification: commit 1 first adds characterization tests that pin today's
  decisions for every marker combination (both OpenCode generations, Claude
  Code live and history, rows with and without a turn token). The tests are
  then switched to the neutral facts unchanged.

### D2. A generic runtime for agents found on PATH; an agent-neutral lazy service

`PathAgentRuntime` is configured with a binary name, display name, version
parser and message templates, and keeps today's state machine: discovery
through `executable.ts`, one coalesced probe, a 10 s timeout, shadowed
executables in diagnostics, and idle, starting, ready and unavailable states.
Claude Code becomes one configuration. Its messages stay byte-identical:
"Claude Code is not installed or is not available on PATH.", "Claude Code did
not answer a version probe within 10s.", and "Claude Code could not be
started: <detail>.". `ClaudeRuntime` stays as a named export built on the
generic runtime, so `src/hub/agent-account-runtime.ts` changes only its
import if at all.

The inline `AgentRuntime` literal in `src/cli.ts` becomes a shared adapter
from a `PathAgentRuntime` and a provider factory to `AgentRuntime`.
`LazyChatService` takes `{ agent name, runtime, workspacePath, metrics }`;
OpenCode's options move to an OpenCode runtime factory that `cli.ts` passes
explicitly. The two adapter-level messages are templated on the agent name,
so OpenCode's wording is unchanged and a Claude Code failure no longer says
"OpenCode".

`ManagedProcess` and a bounded text capture move to a shared chat process
module. The capture takes an optional scrubber; OpenCode passes its password
scrubbing, which stays in the OpenCode stack. A per-conversation stdio child
(the next change) reuses both.

- Alternative: make `OpenCodeService` the generic base. Rejected: it models a
  long-lived loopback server with health probes, which the other agents do
  not have.

### D3. Agents declare their login; one constant per agent

`ChatAgentDescriptor` becomes `{ id, name, login: { command, hubManaged } }`.
It is the identity that reaches the browser in every availability state
(`AgentChatStatus.agent`) and on every conversation summary. Each agent's
descriptor is one exported constant in its own folder (for example
`src/chat/opencode/descriptor.ts` and `src/chat/claude/descriptor.ts`).
`cli.ts`, the e2e harness, `ACCOUNT_AGENTS`, `CLAUDE_LOGIN_COMMAND` and the
OpenCode 2.x `LOGIN_COMMAND` read from it. The Hub's account set stays an
explicit list of OpenCode and Claude Code, both `hubManaged: true`, with
commands `opencode auth login` and `claude auth login`.

`login-action.ts` drops `LOGIN_COMMANDS` and the `<id> login` fallback, and
takes the descriptor. It links to `/settings#agent-accounts/<id>` only when
the page is Hub-served and the login is Hub-managed; otherwise it renders the
existing "Run `<command>` where UatuCode runs." markup. `usageReadFailureLabel`
takes the agent name ("<name> could not answer"), and the `ui.ts` fallback
uses the conversation's agent name. Both read the same for Claude Code and
OpenCode today.

**API revision.** `ChatAgentDescriptor` is a closed object
(`additionalProperties: false` in `api/openapi.yaml`, and `expectKeys` in
`parseChatAgentDescriptor`). The compatibility gate
(`scripts/api-contract/compatibility.ts`) treats an added property on a closed
response object as breaking, because older validators reject it. So this
decision needs:

- the next `WORKSPACE_API_REVISION` in `src/shared/version.ts`, mirrored in
  `api/contract.json` and the OpenAPI `x-uatu-revisions` block. That is 38
  today, but upstream PR #625 already takes 38, so if #625 merges first this
  change takes 39;
- an `api/CHANGELOG.md` entry with migration guidance ("regenerate strict
  validators; read `login.hubManaged` before linking to Agent accounts");
- `BUNDLED_WEB_REVISION` 4 → 5, because a cached web client's validator
  rejects the new field. This is the same reason the visuals change bumped it.

`login` is required: every descriptor is produced by the server, and a
required field keeps clients from inventing a fallback command.

- Alternative: keep a client-side table keyed by agent id. No revision bump,
  but chat and the Hub would still hold two copies of each command, and a new
  agent would have to edit browser code. Rejected.
- Alternative: put `login` beside `agent` in `AgentChatStatus`. That object is
  closed too, so the bump is the same, and the descriptor is where identity
  already lives. Rejected.

### D4. A shared pending-interactions holder

`PendingInteractions` (`src/chat/pending-interactions.ts`) takes the pending
map and its rules out of the Claude Code provider:

- each request settles once, by answer, abandonment or cancellation;
- registration happens before the cancellation trigger is observed, and an
  already-fired trigger settles at once;
- `interaction.requested` is emitted on registration, `interaction.abandoned`
  (with the resolved, rejected card) on any unanswered end, and an answer
  emits nothing, because the adapter publishes resolutions it brokered;
- `abandon(conversationId, reason)` covers dispose, session end and failure,
  with today's reasons;
- `list(kind)` serves reconnect recovery;
- `require(conversationId, requestId, kind)` looks requests up by conversation,
  request and kind, and throws today's error when they do not match.

The cancellation trigger is explicit: an `AbortSignal`, or a subscribe function
that returns an unsubscribe. The Claude Agent SDK gives a signal, while the
Agent Client Protocol cancels with a `session/cancel` notification. The push
event queue (`PushQueue`) moves to its own module next to it. Agent-specific
payloads (permission suggestions, `onAnswer` and `onReject`) remain fields the
holder carries without interpreting.

### D5. The e2e harness routes any agent

`tests/e2e/server.ts` declares one list of fakes, each `{ descriptor, service }`
and keyed by agent id. The routers for one or more agents are built from
prefixes of that list. Qualifier stripping and the body's `agent` field use
the registered ids, so `agent` becomes a string checked against the list. The
`claude-fixture` fake keeps its `claude` registration, so existing specs do not
change.

## Risks / Trade-offs

- [Upstream PR #625 overlaps `adapter.ts` (the recovery condition near line
  1971, projection recover/replace/upsert, `mergeInteraction`),
  `claude/provider.ts`, `types.ts`, `validation.ts` and `tests/e2e/server.ts`]
  → This PR rebases onto #625 when it merges and takes the next free workspace
  revision. Where #625's `ChatTaskScheduler` makes ordering deterministic,
  commit 1's characterization tests use it.
- [Liveness behaviour could drift silently] → Commit 1 lands characterization
  tests before it moves any marker, and every existing visuals regression in
  `agents.test.ts`, `adapter.test.ts` and `visual-store.test.ts` must pass
  unchanged.
- [Persisted capture identities could change] → An identity test pins the
  three existing identity forms byte for byte.
- [Draft #358's `src/hub/mobile/live-agent-accounts.ts` hard-codes
  `["opencode", "claude"]`] → That list is still the Hub's account set after
  this change. Whoever rebases second derives it from the descriptors.
- [Draft #576 moves `CLAUDE.md` to `docs/agents/codebase.md`] → The folder-map
  update follows the file to wherever it lives at rebase time.
- [A strict external validator rejects the new descriptor field] → The
  revision bump and changelog migration guidance are the published signal.

## Migration Plan

No stored data changes: capture identities and conversation ids are
unchanged. The API revision bump and changelog entry tell external clients to
regenerate validators. Rollback is a revert of the PR. The `login` field
disappears, and clients built for the bumped revision get a validation failure
rather than wrong behaviour.
