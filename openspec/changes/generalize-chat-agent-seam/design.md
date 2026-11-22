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
  `src/chat/executable.ts`, a coalesced `--version` probe killed after 10 s,
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
   execution evidence (OpenCode's execution marker today). This fact is not a
   separate annotation: it is the authoritative turn token below, open for yes
   and closed for no. Unknown, a reply without a token, keeps today's
   fallback: live while the conversation streams, unless the reply has a
   completion time that is not text-only.

Per status update:

3. **Turn continues despite this failed status.** A failed status, not a
   repeat, that is not the end of the turn: a retryable failed step
   (OpenCode's step marker, the only writer today). It neither seals the
   turn's replies nor finalizes their captures. On any other status it means
   nothing and is ignored, as at base.
4. **Repeat status, not a capture boundary.** A restated `completed` status
   that must not end a newer turn's captures (OpenCode 1.x's restated idle,
   its completion alias, the only writer today). The flag scopes visual
   liveness only: the public `completed` status still reaches the adapter's
   lifecycle handling, which clears live-turn tracking, records settlement and
   schedules held-message delivery, as at base. The continuation the adapter
   derives from it (OpenCode's alias-live marker today) becomes adapter state,
   not a normalizer fact: an ordered repeat continues the turn only if that
   turn was still live, or continuing, when the repeat arrived. The
   continuation holds in the live stream and in a snapshot a reloading client
   reads, for `completed` only, as at base. On any other status the repeat
   marker is ignored: the status is processed normally, so a failed or
   interrupted one ends the turn. Inherited from base, and out of scope here:
   background reconciliation can end a repeat continuation, because the
   `background` status the adapter reports for a still-running worker is not
   live.

`isVisualTurnLive` moves to a shared module. It reads fact 3 and the
continuation the adapter derives from fact 4, never the repeat flag itself, so
an idle alias that arrives after a genuine end does not make that turn live
again.

**Shared sealable turn token.** Claude Code's turn token becomes a neutral
token any normalizer may attach to every reply of one turn. The adapter is
the only place that freezes, copies, seals or preserves tokens (today's
`snapshotClaudeItem`, `orderedClaudeItem`, `preserveClaudeTurn`, the terminal
sealing in `statusUpdate`, and the recovery comparison). Each token is either:

- **provisional**: in live projection the producer's own completion is
  ignored, and only the in-order status sequence seals it (Claude Code's live
  token today); or
- **authoritative**: the producer's completion is adopted wherever the token
  appears, in either direction (OpenCode 2.x stored-history execution evidence
  today).

These rules describe replies that keep one token kind. For a provisional
reply, a closed token is never reopened by a row with an open provisional
token or with no token, at every entry point (recover, seed, replace, upsert,
ordered apply). For an authoritative reply, stored rows (seed, replace,
recovery and direct upserts) adopt the evidence in either direction; ordered
provider input (`apply`) that carries it is treated as carrying no token. A row
without a token merges sparsely and keeps the projection's evidence (a token,
a text seal or a `completedAt` written as an explicit undefined counts as
absent; no current path writes one), except a full replacement, which takes
the row as given. For a row whose public JSON is
unchanged, covered-history recovery decides whether to stage it from the turn
token alone: a token appearing on a row that had none (an OpenCode 2.x row
first seen live gaining its first stored execution boundary), or a same-kind
open/closed change. A staged row is merged over the projected one, as any
recovered row is: the facts it carries, its text seal included, replace the
projected ones, and facts it omits, such as a text seal seen live, are kept.
No wire frame is published. A change to any other fact, such as a text seal
alone, does not trigger staging: that read returns it, but the projection
keeps its row. The live subscription router keeps a capture it has finished: a later
row carrying open evidence does not reopen it.

**The liveness contract.** These are obligations on each normalizer, and
each normalizer's conformance test checks them:

1. **Reply facts travel with whole items.** A reply's facts are its text seal
   (either form, including the `completedAt` the completion form relies on)
   and its turn token. A normalizer sends a change to them as an item upsert
   (or on the item that creates the row), never on a later text update: a
   text update may carry only the row's own token object, and a different
   token object counts as a change even in the same state. A producer may
   close a shared token in place only at a turn boundary (a terminal status or
   a turn footer). Closing the producer's token is not what ends the turn for
   live subscribers: a footer closes only the producer's token, and so the
   snapshot and transcript evidence, while the live projection holds its own
   frozen copy that only an ordered terminal status seals. Every agent must
   therefore emit an ordered terminal status to end a turn for live
   subscribers; a footer alone leaves the live projection open (inherited
   from base).
2. **One token kind per reply.** For its whole life a reply carries either
   provisional tokens (a live producer turn) or authoritative tokens (stored
   history evidence on snapshot, history and recovery rows), never both, and
   no live item carries an authoritative token. This is a normalizer
   obligation only, enforced by the per-normalizer conformance tests. How the
   adapter handles a reply that mixes kinds is out of contract and
   unspecified: it keeps base behaviour, and nothing may rely on it.
3. **A status is a repeat or a continuation, never both.** The repeat flag
   appears only on a completed status, and the turn-continues flag only on a
   failed one.

The adapter reads the facts from the item that creates a row, item upserts,
and snapshot, history and recovery rows. It applies these rules after the
update coalescer has merged one window. Its text-item merge follows the
projection's rules for reply facts: within a window a later text update's item
is merged over the buffered one by the same sparse rule as the projection's
(`withRetainedReplyFacts`), so facts it carries replace the buffered ones and
reach a row the window creates, while facts it omits or carries as explicit
undefined keep the buffered values. An upsert for the row buffered in between
is a barrier for reply facts only: the later item still replaces the buffered
one as at base (its start time and other fields included), but it keeps the
buffered item's text seal, `completedAt` and turn token, or none when the
buffered entry had none or no item, so a later text item's facts never create,
seal or change a row ahead of that upsert. No current normalizer puts
`completedAt` on a text update's item, so treating it as a reply fact here
changes nothing visible. This is the whole guarantee: the coalescer does not
make reply facts independent of window boundaries in general. Two inherited
orderings, kept as at base and out of scope for this change, still depend on
the window:

- Consecutive upserts for a row in one window fold together at the first
  one's position, so a text delta buffered between them sees the later
  upsert's facts. For example Claude Code's block start, a delta ending in
  `![shot]` and the block stop in one window publish the row already
  completed, and the delta lands on it; in separate windows the delta stays
  provisional until the stop arrives.
- Text still merges into the earlier buffered entry across an upsert: for
  OpenCode 1.x a covered trailing delta after a text end can briefly publish
  doubled text that the end's upsert then corrects.
Outside the contract, the adapter deterministically ignores, without
throwing, exactly these inputs:

- a text update's facts for a row that already exists;
- an authoritative token on ordered `apply` input (treated as no token);
- an open provisional or unannotated row that would reopen a closed
  provisional token;
- a repeat flag on any status other than completed: it is dropped, and the
  status is processed normally;
- a turn-continues flag on any status other than failed, including a
  completed repeat: it is dropped, and the status (or repeat) applies as usual.

The flag invalid for a status is dropped first, then the other is evaluated.
On `failed`, a repeat flag is dropped and a turn-continues flag is honoured,
so a failed status carrying both keeps its turn live; with the repeat flag
alone it ends the turn. On `completed`, a turn-continues flag is dropped and
the repeat flag applies. On `interrupted`, both are dropped and the turn ends.

Mixing token kinds on one reply is not on this list and is not accepted
either: its handling is unspecified, as rule 2 says. Every other input the
adapter receives is within the contract.

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
through `executable.ts`, one coalesced probe whose child is killed 10 s after
it starts, shadowed executables in diagnostics, and idle, starting, ready and
unavailable states. The kill is a deadline for the child, not for the probe's
answer: the probe still waits for both output pipes to close, so a descendant
that keeps a pipe open can hold startup pending past it (inherited, unchanged
here). A hard answer deadline for new PATH agents is deferred to the
Antigravity change, which owns the requirement that `agy --version` answers
within its budget.
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
(the next change) reuses both. OpenCode keeps leader-based escalation: after
the grace period, SIGKILL is sent only if `opencode serve` itself is still
running, and the capture is then awaited as today. A stdio child that starts
its own workers opts into group escalation instead: SIGKILL goes to the whole
process group if any member is still alive after the grace, even once the
child itself has exited, and every wait after SIGTERM is bounded, so a worker
that holds the child's stderr open cannot make shutdown hang. A capture still
open at its deadline is released: its read is cancelled, which frees the pipe
and keeps the bytes collected. Group escalation is POSIX-only. On Windows
there are no process groups here, so both modes signal only the direct child,
as today.

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
