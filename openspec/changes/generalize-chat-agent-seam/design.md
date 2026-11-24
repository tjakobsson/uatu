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
takes the registered name of the agent it asked ("<name> could not answer").
Once the runtime has described itself, every `ui.ts` model-chooser surface
names the agent by the name its runtime declares. Before that, only the model
summary's fallback, which shows in the summary and the inline/touch chip, uses
the conversation's registered agent name ("Let <name> choose") instead of a
fixed "OpenCode"; the picker row and the trigger's accessible label keep main's
generic "the agent" wording. Both read the same
for Claude Code and OpenCode today.

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
- a signal is heard twice: on the source itself, in its listeners' order as
  before (a listener added after registration runs once the holder has
  cancelled, so its reply is refused), and through a dependent signal
  (`AbortSignal.any([signal])`) whose own abort event no listener on the
  source can suppress: it fires synchronously inside the source's `abort()`,
  after the source's own listeners, even when one of them calls
  `stopImmediatePropagation`. Whichever is heard first delivers the cancel;
  the other does nothing. An abort while the listeners are being attached is
  caught by a recheck once both are in place and delivered the same way. Every abort is then a cancel queued like any other
  call, in FIFO order, and reads (`require`, `list`) are plain snapshot reads
  that see the request until that cancel runs. Both listeners are released
  once, when the request settles. A signal already aborted at registration
  settles the request at once, unannounced, as before;
- registration happens before the cancellation trigger is observed, and an
  already-fired trigger settles at once, unannounced, emitting only
  `interaction.abandoned`, ahead of any call made meanwhile. A signal has
  fired when it is already aborted; a subscribe function reports a
  cancellation that came before registration (ACP's `session/cancel`
  arriving first) by returning `"cancelled"` instead of an unsubscribe. A
  `cancel` call, even during subscription, is a new cancellation and an
  operation of its own (see serialization below), so it waits behind calls
  made before it;
- `interaction.requested` is emitted on registration, `interaction.abandoned`
  (with the resolved, rejected card) on any unanswered end, and an answer
  emits nothing, because the adapter publishes resolutions it brokered;
- an answer's result type is not linked to the request's: replies arrive by
  conversation, request id and kind, with no typed handle, so the provider
  keeps them consistent with the request's `abandoned` result, and the
  holder checks at run time only that a result is synchronous and plain;
- `answer(conversationId, requestId, kind, map)` is the reply path: it claims
  the request, calls the agent's `map` inside the operation, and settles with
  its result, so a cancel `map` causes finds the request settled. It returns a
  promise for that answer's own outcome, settled once its turn has run. A
  `map` that throws (an answer the request refuses) releases the claim: the
  request stays pending, nothing is emitted, and the promise rejects with the
  error, as it does with today's error when no such request is pending;
- `abandon(conversationId, reason)` ends a whole conversation's requests, for
  a provider whose conversation is its session. A registration may carry a
  caller's `token`; `abandonRegistrations(tokens, reason)` ends exactly
  those registrations, visibly and in the holder's own order (a redelivery
  keeps its original's place), leaving any already settled or superseded;
  it reads the tokens inside its own turn, so anything their iteration sets
  off waits behind it. A Claude Code session's claims (its tokens and its
  swept mark) exist before its query is built, so a callback the query
  factory fires at once is owned too. Shutdown ends a conversation's
  requests across all its tracked sessions (live, displaced, closing) in one
  call, so they end in the holder's order whichever session asked them.
  Claude Code sweeps by session, never by conversation: each session records
  the tokens of the registrations it made, and every session-scoped cleanup
  (retire, stream end, failure, a revert's survivors, dispose) ends only
  those, with today's reasons, so one session's end never touches another
  session's requests in the same conversation, even under the same request
  id;
- `list(kind)` serves reconnect recovery;
- `require(conversationId, requestId, kind)` looks requests up by conversation,
  request and kind, and throws today's error when they do not match. Requests
  are keyed by all three, where the Claude Code provider keyed them by request
  id alone: there, a second conversation's request, or a question, with the
  same id overwrote the first, which then could not be answered, listed or
  abandoned. Now they stay independent. Claude Code's ids are unique, with
  one exception: a tool request may carry an empty id. Two conversations
  that both asked under the empty id used to collide, one card replacing the
  other; now both cards stay answerable;
- operations are serialized. Registration, an answer, an abandonment, a sweep
  and a cancel each run as one operation. Settlement is claimed before any
  agent code (a mapper, an unsubscribe, a subscribe function) runs, so the
  first end wins. A call into the holder that agent code makes during an
  operation is deferred, and deferred calls run in order, synchronously,
  before the outermost operation returns; a deferred `await` behaves as if it
  had been called then. A sweep ends the requests it finds, and a request
  delivered during it registers afterwards as a new request: the holder knows
  conversations, not sessions, so keeping a late request out of an ended
  session is its provider's job. `require` and `list` are reads and run at
  once, even when called back in during an operation; this is an approved
  decision: they see the holder's current state, so a mutation still queued
  (a registration a mapper made, say) is not visible to them until it has
  run, before the outermost operation returns. The Claude Code provider's callbacks never call back in, so nothing
  changes for it;
- a request redelivered with the same conversation, kind and request id while
  the original waits replaces it, as today: the new card is announced, and
  replies, lists and abandonment reach it. Unlike before, the original no
  longer hangs: once the new request is announced, the original settles
  quietly through its own abandoned result, emitting nothing (an abandoned
  card would reject the id the new request shows), and its trigger is
  released. That gives the one intended visible difference under newest
  wins: before, a late abort of the original deleted the replacement and
  emitted `interaction.abandoned` for the shared card, so the next reply
  failed; now the replacement stays visible and answerable. A subscribe
  function that throws rejects the new request, unannounced, and restores the
  original as it was; cancels delivered meanwhile then apply in order, so the
  original's own cancel abandons it visibly. An already-aborted new request is
  abandoned visibly, and the original is superseded quietly;
- an agent's `abandoned` mapper that throws, or returns a thenable (or a
  result whose `then` cannot be inspected, by the same descriptor check as an
  answer's, running no code), still ends its request: the entry is removed,
  its trigger released, the abandoned card emitted (except on quiet
  supersession), and the request's promise rejects with the mapper's error
  or a `TypeError`, never adopting the thenable. Its type is synchronous, as
  an answer mapping's and `whenRefused`'s are. One helper is the only place
  the agent's promise is settled; its last step is that check, right before
  `resolve` and after every callback (an unsubscribe, an emit) that could
  have changed the result, so settlement adopts a thenable on no path;
  an `abandon` sweep goes on to the next request. Each trigger is released at
  most once;
- each call's error reaches that call's own caller. `answer` rejects its own
  promise. An `await` promise rejects in three cases, which a provider must
  handle: the registration was refused (a field that throws, a card that is
  not plain data, an unsupported kind, a request id that is not a string, a
  conflicting owner; see below), its subscribe function threw (after the rollback
  described below, and never through `whenRefused`), or the agent's `abandoned`
  mapper threw when the request ended. A refused registration registers and
  emits nothing. Every registration field is read once, and a field that
  cannot be read rejects the request. A registration that gives
  `whenRefused` settles with that result instead of rejecting only when its
  card's data is refused (Claude Code's resolves with the request's own
  abandoned result, on the holder's own promise, so its timing is unchanged); only failures after registration, such as an emit, follow
  the reporting rules below. A call that ran at once (an `abandon`, a
  `settle`, a handle's `abandon`, a trigger's cancel) throws its first error after the calls it deferred have
  run. A cancel delivered by a signal has no caller either (EventTarget would
  surface a rethrow as uncaught), so its errors go to `report` too. A call
  that was deferred has already returned, so its failure goes to the holder's
  `report` option (`console.error` by default). A reporter that
  throws falls back to `console.error`, and the holder keeps draining its
  queue whatever throws;
- cards must be plain data: the card and everything in it are strings,
  numbers (any number, `Infinity`, `NaN` and `-0` included, copied
  faithfully), booleans, null, arrays without holes, and objects whose
  prototype is `Object.prototype` or null, with string keys and enumerable
  data properties only; an object property may be `undefined` for an absent
  optional field. No accessor is allowed at any depth, and no getter is ever
  run: registration reads each property once from its descriptor while it
  copies the card. Anything else (a Proxy, detected without running a trap,
  a class instance, an accessor, a `Map`, a function, a cycle) is refused at
  registration. A cycle is a back-edge to a node still being copied; a node
  shared by several fields is not one: it is read and copied once, and the
  copy keeps that sharing, as `structuredClone` does for every later copy. The identity comes from that
  copy, read as own data only (a field the card left out is absent, whatever a
  prototype provides; the same holds for every later read of the copy): the
  kind must be `permission` or `question` and the request id a
  string (the empty one included, which Claude Code's tool requests may
  carry), and an owner the card names (`conversationId`, which the UI
  addresses replies to) must be the conversation it is registered under. A
  card naming none stays without one, as Claude Code's do. The holder keeps
  the copy private: `list` and both announcements get fresh copies, and
  `require` and an answer's mapper get a fresh frozen handle (the request's
  identity, a copy of the card, its detail, and `settle`/`abandon`). The
  holder's own paths (triggers, sweeps, supersession) never go through a
  handle, so nothing a caller does to one reaches them. Claude Code registers
  its cards as built, so in-process payloads and lists are what they were (an
  MCP schema's `Infinity` stays `Infinity`; only the wire turns it into
  `null`, as before). The SDK's data is parsed JSON and so plain data; a card
  the holder refuses anyway (a BigInt, a cycle) could never have been shown,
  so its callback ends at once with the request's own abandoned result and
  nothing is announced. Claude Code's history is read from transcripts, not
  the holder;
- per-session cleanup, approved as a deliberate difference: when two Claude
  Code queries for one conversation race, ending one never abandons another
  query's requests while that query is still running (before, a session's
  end swept the whole conversation);
- one deliberate change to Claude Code behaviour, approved, which predates
  this change: a tool, elicitation or dialog callback whose session has
  already been swept no longer registers. Disposal sweeps a session's
  requests before it interrupts the query, so a callback arriving during
  shutdown, with a signal that never aborts, used to announce a card after
  the sweep that stayed pending forever. Every path that sweeps a session
  marks that session object as swept, and the provider is marked disposed at
  the start of `dispose()`. A callback refuses only when its own session is
  marked swept or the provider is disposed: it resolves at once with its own
  abandoned result and announces nothing. Committing a staged revert marks
  the live session swept, interrupts it (the SDK's abort ends its pending
  requests with the interrupted reason, as before), then sweeps any survivor
  with the retire reason before the replacement starts, since its stream's
  end no longer does. Startup is otherwise exactly as before, races
  included: a query a racing start displaces from the live map is not swept
  while it runs, so its requests register and work as they always have.
  Every started session is tracked until it ends, displaced ones included,
  and each knows its own pending requests: when a displaced session's stream
  ends or fails, its own requests are swept and it is marked, leaving the
  live session's alone; shutdown reaches every tracked session (see below),
  so no agent process outlives the workspace. A teardown already under way
  (a retire, a revert's close) keeps its session reachable for shutdown
  until it finishes. A session closing for a revert is swept by the revert,
  with the retire reason, even if its stream ends during the interrupt,
  unless shutdown has started, which then sweeps it. A query factory that
  registers a request through a callback and then throws leaves no session
  behind, so its claims are swept with the failure reason before the caller
  hears the error. A plan approval asked by the conversation's live query
  behaves exactly as before (that query switches, the return mode is saved,
  the restore intent cleared, `plan.approved` published). One asked by a
  displaced query switches only that query (its claims carry it), leaving
  the conversation's saved mode, restore intent and published configuration
  as they are, and restores the mode its own card offered (captured when the
  card was announced), not the conversation's restore intent, which the live
  query's approval may already have cleared; one whose query has ended
  switches nothing. An approved difference: a displaced query's approval
  emits no `plan.approved` and leaves the conversation's mode unchanged;
- Claude Code's shutdown (`dispose()`) is one ordered sequence. Once it has
  started, no session-scoped cleanup sweeps on its own (a retirement, a
  revert's close, a stream's end or failure): every tracked session (live,
  displaced, closing) stays reachable for the steps below.
  - (a) The provider is marked disposed. New admitted work is refused with
    the disposed error before any side effect: an undo, redo, revert,
    restore or revert commit, a release (even one that arrives once
    shutdown has cleared the live sessions, so it is never reported done)
    or wakeup cancel (a live wakeup's or a paused one's, admitted before its
    transcript lookup), a prompt. A
    start still waiting on its transcript check (its last wait) starts no
    query and fails the same way.
  - (b) Every pending request ends once, with the shutdown reason; an abort
    delivered later for one of them finds it settled, and a callback
    arriving later is answered at once. Conversations end one at a time, as
    before: for each live session in order, its conversation's requests
    (whichever of its tracked sessions asked them) in the holder's order,
    then the lost wakeups of each of those sessions; then each conversation
    left with only displaced or closing sessions, in the order they were
    started. With one session per conversation, requests A1, B1, A2 end as
    A1, A2, A's lost wakeups, B1. A session whose own operation decides its
    wakeups (a release or wakeup cancel under way) is left for (f). A
    wakeup shutdown has reported stays settled: a Stop during the grace
    never republishes it as pending, and one first seen then is reported as
    shutdown reports it, lost or paused, at once or, for a session left for
    (f), there. A session left for (f) is still reconciled as usual by a
    Stop in the grace, without republishing anything as pending, for the
    whole grace (the sweep marks it, so this holds after its own release
    or cancel has finished), so a wakeup that fired then keeps its fired
    row and (f) settles only those still pending. Nor does a settled wakeup fire in a query the grace keeps
    open: its turn is blocked at the prompt hook, as a cancelled wakeup's
    is. During shutdown, for both, settled and cancelled (a cancel in
    flight keeps its session out of the sweep, so only the cancellation
    guard holds its wakeups back), a prompt the SDK marks as a wakeup's
    (source `schedule_wakeup` or `loop_wakeup`) is blocked even while a
    typed prompt is pending; one without a source is blocked only while
    none is, since the person may have typed the same words. Outside
    shutdown the cancelled-wakeup guard is unchanged: it blocks a matching
    prompt only while no prompt is outstanding, whatever its source.
  - (c) Admitted work in flight gets a bounded grace to finish: the grace
    (`SHUTDOWN_GRACE_MS`, half a second) bounds shutdown's first wait for
    it, and is sized so that it, the SDK's close budget and an estimated
    margin for the drain and flush (`SHUTDOWN_FLUSH_MARGIN_MS`) sum to no
    more than the Hub's three-second SIGTERM-to-SIGKILL deadline. It
    waits for undo, redo, revert and restore, a rewind's reply included; a
    release, from its write to its publication; a wakeup cancel; a deferred
    rename's native write already under way; a manual rename, its wait
    behind that write included (one asked after shutdown began is refused,
    as other new work is); and every prompt until the provider accepts it
    or queues its rollback, so one already holding its session
    (reading its attachments, say) is accepted. Acceptance means delivery,
    and delivered means the SDK's input iterator has taken the prompt while
    its query is open: such a prompt is acknowledged only once taken, never
    reported accepted and then dropped, and one nothing takes before the
    close is refused and rolled back. Until it is taken it is no turn
    either, so a stream that ends meanwhile ends no turn, and the refusal is
    all its caller hears. A query whose stream has ended or
    failed is not open, even while shutdown still holds it, so a prompt for
    it is refused. Nor is one whose SDK cleanup has closed the transport
    before the provider has seen its stream end: the SDK's input loop can
    still take an envelope then and never write it, so a prompt taken after
    that close is refused and rolled back too. A replacement for a staged revert, at any time, is
    acknowledged, and the revert finalized, only once the SDK has taken it
    in the same way; if it is not taken it is refused and the revert rolled
    back, so the boundary and Redo stay. A prompt acknowledged before
    shutdown began keeps its acknowledgement. A deliberate
    difference from `main`: a cancel that lands before a staged replacement
    is delivered now rejects it and rolls the revert back, where before the
    replacement was reported accepted without being delivered. None of
    these waits on a callback, which (b) has settled. An admitted release
    can still reach `retireSession()` in the grace and await the SDK's
    close of its query; the grace bounds shutdown's initial wait for it,
    and (d) waits for that close as it does for any closing session's,
    within the SDK's close budget, so waiting cannot deadlock.
  - (d) Every query closes, all at once (the usage and catalog probes'
    included), since one SDK close may take up to two seconds waiting for
    its child to exit (`SDK_CLOSE_BUDGET_MS`, from the SDK's own close):
    its interrupt is sent but not waited on (it has no deadline), and
    closing the transport fails whatever is still out (an interrupt, a
    rewind), including one a closing session's own teardown waits on. A
    usage read still finding its target when shutdown began starts no
    probe afterwards and writes nothing, so no query outlives this step. Closing
    is this step's alone: once shutdown has started, idle retirement (after
    a context report or a usage read) closes nothing, so a session left
    idle by the sweep stays open in the grace for a prompt still on its
    way.
  - (e) What remains drains: an operation the close cut short writes its
    correction or rollback (a rejected rewind rolls its staged boundary
    back, a prompt its configuration or staged revert). The drain waits
    for admitted work again with no deadline, including work the close
    does not unblock (a redo restoring files, say), so the margin is an
    estimate, not a bound. A drain that runs past the Hub's deadline is
    cut off by SIGKILL, the same exposure `main` has.
  - (f) A session left for this step gets shutdown's outcome for what its
    own operation did not settle. A release that released the session has
    emitted `session.released` with the rows cancelled, and shutdown adds
    nothing; a release refused or failed leaves shutdown to emit that
    session's `wakeups.lost` (lost or paused). A wakeup cancel has reported
    its wakeup `wakeup.cancelled`, never paused or lost, and shutdown
    reports the session's other wakeups. This is the one ordering
    difference from before, and it applies only when a release or cancel is
    in flight at shutdown: that session's `wakeups.lost` comes after every
    other conversation's abandonments, because requests must be settled
    first, in (b), to avoid the callback deadlock.
    A wakeup whose cancel is still being written stays that cancel's: a
    Stop, in the grace or before it, neither settles nor drops it, but its
    word on the wakeup is kept (the latest Stop's, except that a recorded
    fire stands against a later Stop that only finds the wakeup still gone).
    The cancel reports it
    `wakeup.cancelled` once its write has succeeded, unless a Stop reported
    it fired meanwhile: that fired row stands, as before, and is not
    relabelled; if the write fails, the
    wakeup takes that kept outcome (fired, with its turn, or reconciled as
    listed), and one still scheduled is settled as any other, here by
    shutdown. Outside shutdown, a failed cancel whose wakeup the CLI had
    dropped rechecks the session as a successful cancel does: with nothing
    left holding it, the conversation is idle again and its session
    retires.
  - (g) Persistence flushes. No write lands after `dispose()` returns, a
    durable write never reports success without writing, and a failed prompt
    that changed nothing durable writes nothing. One exception keeps
    `main`'s behaviour: a rename asked for before the transcript exists is
    acknowledged at once and its state write is not awaited, so if that
    write fails the title can be lost on restart, as on `main`. A deferred
    rename (one asked for before the transcript existed) stays recorded
    until its native write succeeds, so a write made meanwhile, or a
    failure, leaves it for the next start. Only one native write of it runs
    at a time, and a newer rename writes only once that one has landed, so
    the newer title is the one that stands. While a manual rename's native
    write is out, a turn ending starts no write of the deferred title (an
    in-memory marker, owned by that rename, holds it back), but the record
    itself stays, in memory and in every snapshot. Only a manual rename that
    has landed drops it, on disk too, so a restart cannot apply the stale
    title over it; a failed one leaves the record as it was and releases the
    marker only if it still owns it. Manual renames of one conversation
    write one after another, in the order they claimed their turn, so the
    newest one that succeeds is the title that stands. If the state write
    dropping the record fails, the rename still reports success (its native
    write has landed) and the stale title can reapply after a restart, the
    same exposure `main` has for a failed state write. A deferred rename
    already being written when shutdown starts finishes in (c); one not
    started is not written once shutdown has started, even when a turn ends
    in the grace: it is durable, so the next start writes it after that
    conversation's next turn.

  A known limitation, which already exists on `main` and is outside this
  change: a rewind still unanswered when the grace ends is cut off by the
  close and rolls its boundary back, even if Claude Code had already
  applied it, so Redo is lost.

  A second known limitation, of what delivery can observe: the SDK's input
  iterator taking the envelope is the last point the provider sees, and
  delivery stays defined there. The SDK then writes the prompt to the
  CLI's stdin; if the CLI exits after that write and before it reads its
  own input, the prompt is lost, and for a staged replacement that is after
  the revert has been finalized. It needs the CLI to exit in that window;
  nothing the provider can observe tells it apart from a prompt the CLI
  read;
- the Claude Code provider's replies keep their timing. A reply the adapter
  makes runs at once, so the provider learns the holder's own outcome
  synchronously through `tryAnswer` (settled, refused with its error, or
  deferred with a promise): today's "no pending" error, a refused answer and
  a result the holder refuses throw from the reply method as before, a plan
  switches modes only after its approval actually settled, and each reply settles in the same microtask turn it always
  did, so concurrent replies resolve in the order they were made;
- an answer's mapping is synchronous, and every result (an answer's, a
  `settle`'s, an `abandoned` or `whenRefused` mapping's) must be one whose
  resolution can run no code: a primitive, or an object that is not a Proxy,
  whose prototype chain, walked as it actually is, holds only
  `Array.prototype` and `Object.prototype` (each at most once) before null,
  with no `then` on the object or any link, read by descriptor. The Proxy check comes first and runs no trap
  (`types.isProxy` from `node:util`); the prototype is then read with
  `Object.getPrototypeOf` and `then` by descriptor, both guarded, so none of
  the result's code runs. Anything else (a Proxy, a promise, a class
  instance, an object inheriting from a Proxy, an own `then` of any kind, a
  result that cannot be inspected) is refused. On an
  answer this is like an answer the request does not accept (the claim
  released, the request left pending, nothing emitted, the call rejected with
  a `TypeError`); a handle's `settle` throws the `TypeError`. Claude Code's
  results (allow and deny with `updatedInput` and `updatedPermissions`, MCP
  accept, decline and cancel, dialog results, plan approval) are all object
  literals, so they pass. A custom `then` is never called, and no species
  code runs. The holder contains the rejection of a refused promise, through
  the `then` and species getter captured at module load, only when it is an
  exact same-realm `Promise` (prototype `Promise.prototype`, no own
  `constructor`), `Promise.prototype.constructor` is still `Promise`, and the
  species getter is still the original; otherwise, and for every other
  refused thenable (a `Promise` subclass, another realm's promise, a custom
  thenable), handling its eventual rejection is the mapper's responsibility.
  An answer settles the agent's promise before any cleanup (its unsubscribe)
  runs, so cleanup cannot change a checked result; answers publish nothing,
  so the order of everything observable is unchanged. Every abandonment,
  quiet supersession included, settles after its cleanup, so its result is
  checked as cleanup left it. The type refuses
  promise-returning mappings at compile time;
- publication never blocks settlement. An `emit` that throws leaves the
  request settled with its result or its mapper's error (or, for
  `interaction.requested`, registered and listed for recovery), and the
  operation and any sweep continue. The error is the running call's,
  delivered as above. An unsubscribe that throws is different: cleanup is
  best-effort and no caller's outcome depends on it, so its error always
  goes to `report`. `await` never throws: its caller holds
  only the request's promise, so a publication failure during it goes to
  `report`.

The cancellation trigger is explicit: an `AbortSignal`, or a subscribe function
that returns an unsubscribe (or `"cancelled"`). The Claude Agent SDK gives a signal, while the
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
