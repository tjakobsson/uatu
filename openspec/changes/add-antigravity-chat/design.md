# Design — add-antigravity-chat

## Context

See `proposal.md` for motivation. This change ships as the top pull request of
a GitHub stack, `feat(chat): add Antigravity as a chat agent`. Both branches
live in `tjakobsson/uatu`. Its head is `feat/add-antigravity` and its base is
`refactor/generalize-chat-agent-seam`, the seam pull request's head. After the
seam pull request squash-merges, GitHub retargets and rebases this one onto
`main` automatically. Each pull request squash-merges into its own commit,
bottom-up, and both must be marked ready before the stack can merge.

**Prerequisite:** `generalize-chat-agent-seam`. This design relies on its
neutral liveness facts and sealable turn token (seam D1), the generic `PATH`
runtime, agent-neutral lazy service and shared process helpers (D2), the
declared login (D3), the shared pending-interactions holder (D4), and the e2e
harness keyed by agent id (D5).

### What a trial of `agy` showed

These observations come from a trial against `agy` 1.5.13 in November 2026.
They shape the decisions below and are the source of the test fixtures.

- `agy acp` speaks ACP version 1 over standard input and output. `initialize`
  answers in about 90 ms. The first `session/new` in a process takes about
  1 s while agy's backend starts, and later ones about 55 ms. Two sessions in
  one process worked.
- Closing standard input makes `agy` exit with status 0 within about
  100–185 ms. Standard error stayed empty.
- With a cached login, `session/new` works without `authenticate`. With no
  credentials, `session/new` and `session/list` fail with error -32000,
  "Authentication required".
- `session/load` with an unknown session id succeeds, and the next prompt then
  fails with -32603.
- After `session/load`, the session is back on agy's default model.
- agy never called the client's file-system or terminal methods.
- A gated tool reports `in_progress`, then `pending`, and then agy sends
  `session/request_permission`. The options offered were allow once and
  reject once.
- Read tools return no output over ACP. Command tools return
  `rawOutput: { output, exit_code }`. A denied tool is reported as failed, and
  the turn ends with `end_turn` and no text.
- `session/cancel` resolves the prompt as `cancelled` within milliseconds and
  kills a running command.
- A second `session/prompt` during a turn makes the first resolve `end_turn`,
  and the second carries the turn on.
- Text arrives in one to three chunks per message. Thoughts are rare.
- `usage_update` reports `used` and `size`. Per-turn `PromptResponse.usage` is
  only in the protocol's unstable schema.
- Models are exposed as ACP config options (a model family plus a
  `thought_level`) and as legacy model ids that encode the level, such as
  `gemini-4-neon-low`.

Not exercised in the trial: cancelling while a permission is pending,
plan-mode `plan` updates, quota-exhausted errors, and image prompts.

## Goals / Non-Goals

**Goals**

- Antigravity conversations with the capabilities in the `antigravity-chat`
  spec, built on the shared seam without adding agent names to shared code.
- No credential handling. UatuCode launches the official binary and nothing
  else.
- Deterministic tests that need neither the network nor a login.

**Non-Goals**

- A Hub Agent accounts card for Antigravity, or any Hub-side login flow.
- Rename, undo and revert, background workers, agent questions, subagents,
  and side questions. Scheduled wakeups wait for the model in draft #626.
- Switching a held message to a steer while a turn runs (D9).
- Live price lookups, and an "estimated" marker on cost (decided).
- A test against a real `agy`, which would need a login (decided).

## Decisions

### D1. Speak ACP through the official SDK, over `agy acp`

UatuCode spawns the discovered `agy` as `agy acp` and connects with
`@agentclientprotocol/sdk` 2.x (Apache-2.0, no runtime dependencies, `zod`
peer). Version 2.0 removed `ClientSideConnection`, so the connection is
`client(...).connectWith(ndJsonStream(stdout, stdin))`. `initialize` sends
protocol version 1 and advertises no file-system or terminal capability: agy
does not use them, and leaving them out keeps UatuCode from serving file
reads or commands on the agent's behalf. Per-turn usage comes from the SDK's
unstable schema types and is read defensively (D10).

- Alternative: hand-written JSON-RPC framing. Rejected: the SDK carries the
  protocol schema and types upstream maintains, and it adds no transitive
  dependencies.
- Alternative: drive agy's interactive interface or its own output formats.
  Rejected: undocumented, and it has no permission brokering.
- Risk gate: the SDK and `zod` must bundle into `dist/uatu`
  (`bun run build` and `bun run smoke`).

### D2. One process per live conversation, plus a listing process

Each conversation that has a turn running, a pending permission, or an open
history read gets its own `agy acp` process. The process is released after
5 minutes with none of these. The constant lives in the provider and can be
tuned without a spec change. Listing conversations and checking the login use
a separate short-lived process that exits after it answers.

Processes are ended with the seam's shared process helpers: close standard
input first (agy exits within about 200 ms), then SIGTERM, a grace period,
and SIGKILL. Standard error is captured with the shared bounded capture for
failure diagnostics.

- Why per conversation: a hung or crashed process affects one conversation,
  cancel and kill map one-to-one to the conversation, and releasing an idle
  conversation is just ending its process. The cost is about 1 s of backend
  start the first time a conversation is used after release.
- Alternative: one shared process for all conversations (the trial showed two
  sessions in one process work). Rejected for now: one stuck session would
  block or take down every conversation, and the provider would need
  per-session cancellation and error attribution on a shared stream.

### D3. Runtime and login check

Antigravity is a `PathAgentRuntime` configuration: binary `agy`, display name
"Antigravity", a version parser for `agy --version` that takes the leading
semantic version, and the generic message templates (for example
"Antigravity is not installed or is not available on PATH."). Its descriptor
is `{ id: "antigravity", name: "Antigravity", login: { command: "agy",
hubManaged: false } }`. It is registered last in `src/cli.ts`, so OpenCode
stays the default.

The version probe says nothing about the login. The login state comes from
the listing process: a -32000 "Authentication required" answer to
`session/list` or `session/new` sets `login: "missing"`. A later successful
listing sets it back to `"ok"`. Listing runs when the chooser reads the
inventory, on retry, and before a prompt to a conversation with a missing
login, so signing in through `agy` clears the notice without a restart. Hub
account-change notices do not concern Antigravity.

### D4. Identity and liveness

Conversation ids are `antigravity:<sessionId>`. Visual capture identities are
`antigravity:message:<id>`. When agy supplies a message id, `<id>` is that
id. Otherwise `<id>` is derived from the session id, the turn's position and
the message's position within the turn, which replay reproduces.

The normalizer writes the seam's neutral facts. A reply's text is sealed with
an explicit end when the next non-text update for the turn arrives, or when
the prompt resolves. Every reply in a live turn shares one provisional turn
token, which the adapter seals from the in-order prompt result. Replayed
history comes from finished turns only, so its tokens are complete and
authoritative.

User messages that UatuCode publishes live (the opening prompt and any
immediate steer, D9) get the id that replay derives for the same position in
the turn, so reopening the conversation shows each one once.

### D5. Normalization

| ACP `session/update` | Timeline |
|---|---|
| `user_message_chunk` (replay) | `user_message` |
| `agent_message_chunk` | `assistant_message`, chunks appended |
| `agent_thought_chunk` | `reasoning` |
| `tool_call`, `tool_call_update` | `command` for kind `execute` (output and exit code from `rawOutput`), `file_change` for `edit`/`delete`/`move` with diff content, `tool` otherwise |
| `plan` | `task_progress` (untested; see Risks) |
| `available_commands_update` | the session's command list |
| `current_mode_update`, `config_option_update` | configuration events (mode, model, thinking level) |
| `usage_update` | context report (`used` against `size`) |
| `session_info_update` | conversation title |

A tool row that is `in_progress` or `pending` with an open permission request
is presented as waiting for permission. The last prompt's stop reason ends
the turn. An earlier prompt that agy ended because a steer arrived does not
end it (D9). Otherwise: `end_turn` completes it, `cancelled` interrupts it, and `max_tokens`,
`max_turn_requests` and `refusal` fail it with a message that names the
reason. JSON-RPC errors fail the turn with agy's message. -32000 is a login
failure; other codes are reported as "Antigravity could not answer: <message>".
Unknown update kinds are dropped and counted, so the coverage report shows
them as unhandled.

### D6. Permissions

`session/request_permission` registers with the shared pending-interactions
holder. Its cancellation trigger is explicit (seam D4): a `session/cancel`
sent by UatuCode, or the process exiting, abandons the request, and the
holder answers agy with the `cancelled` outcome as ACP requires. The card
offers the options agy sent, mapped by kind (`allow_once` to "Allow once",
`reject_once` to "Deny"). The agent declares no `permissionScopeNote`.
Cancelling while a permission is pending was not exercised in the trial, so
a fixture-driven test covers UatuCode's side and the docs list it as
untested against agy.

### D7. Models, thinking levels, and modes

The model picker is built from the session's config options: the model
family option gives the models, and `thought_level` gives each model's
variants. When agy offers only legacy model ids, ids that share a family and
differ by a level suffix (such as `gemini-4-neon-low`) are folded into one
model with variants, and a choice is applied by selecting the legacy id
(`session/set_model`, outside the stable ACP methods). When agy offers config
options but no legacy ids, the thinking levels the options advertise belong to
the current model. Modes come from the session's modes: default, accept
edits, and plan. After every `session/new`, `session/load` or resume, the
provider reapplies the conversation's stored model, thinking level and mode
before the next prompt, because agy resets a loaded session to its default.

### D8. Commands and attachments

`available_commands_update` populates the slash-command list with
descriptions. A chosen command is sent as ordinary prompt text, which is how
agy expects it. If `initialize` reports `promptCapabilities.image`,
attachments are declared and images are sent as ACP image content blocks from
the attachment store. Otherwise attachments are not declared. Image prompts
were not exercised in the trial, so commit 3 verifies them against a fixture.

### D9. A new `immediate-steering` capability for agy's mid-turn prompts

agy accepts a second `session/prompt` during a turn: the first prompt
resolves `end_turn` and the second carries the turn on. Chat's `steering`
capability cannot describe this. It requires that a steer stays pending with
the agent until a safe step boundary and can be withdrawn or switched back to
the queue until then (`opencode-chat`: "OpenCode 2.x conversations can steer
the running turn"). agy has no pending state and no withdrawal.

This change therefore adds an agent-neutral capability, `immediate-steering`,
specified in the `chat-agents` delta. The name keeps it next to `steering` in
the `ChatCapability` vocabulary, because users see the same thing: busy Send
and Enter steer, and Alt/Option+Enter and the Send hold queue. The difference
is that the steer is delivered at once. `mid-turn-delivery` was considered,
but it hides that relationship and reads like a transport detail.

Shared behaviour (composer, dock and adapter, built and tested with a stub
agent in commit 2, before the Antigravity provider exists):

- The composer's busy deliveries, guidance and hold-to-queue gesture are the
  ones a `steering` conversation has. Commands and attachment drafts still
  queue.
- A steer goes to the provider at once. There is no `conversation.queue` steer
  entry, no Steer badge, no paused state and no withdrawal, edit or
  switch-to-queue action. If the provider refuses it, the draft and
  attachments return to the composer. If the outcome is unknown, the steer is
  kept as an unconfirmed entry under the existing rules and never resent.
- The provider publishes the accepted steer as a `user_message` at the point
  agy took it in: when the prompt before it answered. Sending it moves
  nothing in the stream, so a steer refused before that leaves the running
  reply and the ids after it as they were, and only steers agy took in hold
  user positions, as in replay. Replayed history deduplicates it by turn and
  message position, so it appears once (D4).
- For Antigravity, acceptance needs evidence about the steer itself. ACP
  has no acknowledgement for a prompt, and agy ends the earlier prompt with
  an ordinary `end_turn`, the same stop reason a natural end has (the trial
  showed no other), so the earlier prompt ending proves nothing: it can end
  on its own, be cancelled, hit its token limit or fail on its login just
  before agy refuses the steer. Only the steer's own answer counts. A result
  other than `cancelled` means agy took it. An error answer is a definite
  refusal, and the earlier prompt's end, held meanwhile, is then reported as
  it came. A `cancelled` result or the connection ending is an unknown
  outcome: unconfirmed, never resent. A steer is therefore confirmed only
  when its own prompt is answered, usually when the turn carrying it ends.
  Waiting for that must block nothing: the provider answers the steer at
  once as sent, with a confirmation that settles later, and the adapter
  answers the client "sent, awaiting confirmation" (`awaitingConfirmation`)
  and frees the conversation's admission lane at once, so a queued
  follow-up goes into the dock and stays editable, and a second steer can be
  sent. The client keeps the steer as an unconfirmed draft. Acceptance puts
  its row, carrying the request id, where agy took it in, which settles the
  draft; a refusal adds a `steer-refused` notice, which returns the draft to
  the composer with agy's reason; an unknown outcome leaves the draft
  unconfirmed, never resent. An admission that answers after the steer
  admission bound settles the same way, so a late "sent" waits for its
  confirmation too. The client reconciles a refusal with the receipt in
  either order, and a refusal it did not see live (another conversation was
  open, or the history was reread) settles the draft from the history when
  the conversation is shown. The published notice schema is closed and has
  no request field, so the notice's id names the request
  (`notice:steer-refused:<requestId>`): a new `code` value and an id in an
  existing open string, additive under `api/CONVENTIONS.md`, with no
  revision change.
- The provider publishes no status, and no completion signal, for the earlier
  prompt's end, so the adapter keeps the conversation running, sends no
  completion notification and does not drain the held queue. The seam's
  repeat fact is not used here: a completed status that carries it still
  drives settlement and held-message delivery. The provider keeps a single
  turn token across the steer, so liveness for image capture follows the
  whole turn.
- Send now keeps the existing rule for agents without `steering`: it is
  offered only while the held queue is dormant or the conversation is idle.
  Switching a held message to a steer mid-turn is left for later.

The capability rides the existing open capability list. Clients ignore names
they do not know (`parseChatAgent`), and the request reuses the existing
`steer` delivery value, so no workspace API revision is needed. Commit 2
confirms this against `api/openapi.yaml` and the compatibility gate.

Antigravity declares `immediate-steering` and `send-now`, not `steering`. The
provider serializes prompts: a steer is the only prompt sent while another
is in flight, and queued prompts wait for the carried turn to end.

### D10. History: replay first, transcript second

`session/load` replay is the source of history: messages, thoughts and final
tool calls. Before loading, the provider checks the id against
`session/list`, because loading an unknown id appears to succeed and breaks
the next prompt.

The transcript reader then reads
`~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`
(resolved against the workspace process's home directory) read-only and with
a size bound on the bytes one open handle yields. It validates each line's
shape and adds permission outcomes, file-read output, and per-turn tokens and
model to the matching replayed rows. The transcript records no tool call ids,
so a turn is matched by identity, the user's words agy recorded for it, and
its tools by their order within it; once words prove the transcript, a turn
without words (images only) is the one recorded without words at the same
position, and a conversation of images alone matches a transcript whose
requests are all without words, as many and at the same positions; a turn
whose words do not match keeps its
replayed rows, and a transcript with no matching turn is another
conversation's. A missing file, an unreadable file,
or a file whose shape is not recognized leaves the replayed history unchanged
and is logged at debug level only. When agy refuses to load a listed
conversation because its login has expired, the transcript alone gives its
history (messages, replies, thoughts and tool rows under the ids replay
uses). That is the only logged-out reading (decided), during a turn too,
where the read is built beside the running turn's rows rather than over
them: without a readable
transcript, opening the conversation shows the sign-in notice, and UatuCode
keeps no copy of Antigravity conversations of its own, so a conversation's
in-memory history goes with its released process. Live turns take tokens from
`PromptResponse.usage` prompt by prompt: an input whose own prompt reported
none (the opening prompt or an accepted steer) takes the transcript's tokens
for that request after the turn, never both.

### D11. Cost from a built-in price snapshot

agy reports tokens only. The provider prices each turn and sets
`TokenUsage.costUsd` on the turn's usage carrier, so the existing conversation
totals and cost receipt work unchanged. The receipt has one main-agent line
and one line per model. There is no runtime network request.

The price table `src/chat/antigravity/prices.ts` is generated, and records
its source and snapshot date. `scripts/update-antigravity-prices.ts`
regenerates it from models.dev. Running the script fetches models.dev, so it
needs approval each time. It is a development step, never part of a build or
test. Rules:

- Google Standard tier at the Global endpoint.
- Thinking tokens are billed at the output rate, cached reads at the cache-read
  rate where one is listed, and cache writes are not priced.
- The Claude and GPT-OSS models agy offers use Google's partner-model prices as
  recorded in models.dev's `google-vertex` entries.
- A model without its own entry borrows its family's price through a
  hand-kept map in the script: `gemini-pro-orchestrator-neon` uses Neon, and
  `gemini-pro-orchestrator-g1-pro` ("Orchestrator (Argon)") uses Argon.
- Thinking levels do not change rates.
- Base rates only: long-context price tiers are not applied, because a turn's
  usage is not broken down per request.

A reopened conversation gets earlier turns' cost from the transcript's tokens
and models (D10). Cost is shown like any other agent's, without an
"estimated" marker (decided). `docs/CHAT.md` explains where the figure comes
from and its limits.

Known limitation: models.dev does not record Argon's price change of
1 December 2026 or Gemini 3.8 Flash's of 1 January 2027, so the snapshot is
only as current as its last regeneration.

### D12. Google's consumer-plan policy is documented, not enforced

Antigravity's FAQ (https://antigravity.google/docs/faq.md) says that wrapping
`agy` in third-party coding agents or applications "is not supported under
consumer plans", and recommends Gemini Enterprise or Google AI Studio API keys
for third-party agents. Section 6 of the Additional Terms
(https://antigravity.google/terms/) treats third-party access using
Antigravity OAuth as a breach. The ACP page
(https://antigravity.google/docs/ide/extensions/acp/) says "Any ACP client can
launch Antigravity CLI".

UatuCode only launches the official binary, which uses its own login, and
never handles Antigravity credentials. `docs/CHAT.md`'s Antigravity
prerequisites state the policy with these links, and users decide whether to
use a personal plan. There is no UI notice (decided).

### D13. Coverage report

`scripts/agent-coverage.ts` gains `extractAntigravity()`. The installed ACP
package (2.9.1) ships no `schema/meta.json`, so it reads the agent and client
methods from the package's exported `AGENT_METHODS` and `CLIENT_METHODS`, and
the session update discriminants from its `schema/v1/schema.json`
(`$defs.SessionUpdate`). It fails loudly,
naming the file, if an axis yields nothing. The probes feed each kind through
the Antigravity normalizer, and ACP's tool kinds through its tool rows. A
method counts as used when the provider or connection names it; an unused
one is ignored only with a stated reason. `src/chat/antigravity/sdk-coverage.ts` gives
reasons for ignored entries (for example, the client file-system and terminal
methods: UatuCode does not advertise them) and states that ACP does not
enumerate agy's tool names. CONTRIBUTING.md's list of agent SDKs whose bumps
need no regeneration gains `@agentclientprotocol/sdk`. The published
dashboard is issue #480.

### D14. Tests

A fake `agy` executable (a Bun script under `tests/fixtures/antigravity/`,
put on `PATH` by the test) answers `--version` and `acp`. It replays redacted
fixtures recorded from the trial: initialize, new, load and list, prompt
streams, a permission flow, a denial, a cancel, a command with output, the
authentication error, the unknown-id failure, and a second prompt sent mid-turn. Fixtures keep no plan,
tier or account data, no emails, and no user paths. Unit tests drive the real
provider and runtime against the fake process. The e2e harness registers an
`antigravity` fake service for the picker order, the login notice without an
Agent accounts link, a basic conversation, and a mid-turn steer that
appears once and shows no pending Steer entry. There is no real-agent
integration test (decided).

### D15. No presentation guidance for Antigravity

`add-agent-chat-visuals` gives managed Claude Code and OpenCode sessions
guidance on supported image embeds. ACP has no channel for system
instructions, and adding the guidance to user prompts would change the
conversation agy records. Antigravity therefore gets no guidance. Images it
writes in Markdown still render under the shared rules.

## Risks / Trade-offs

- [Google's terms restrict consumer-plan use with third-party clients] →
  Documented with sources (D12). UatuCode handles no credentials and launches
  only the official binary. The choice stays with the user.
- [agy changes its ACP behaviour or unstable fields such as usage and legacy
  model ids] → Read defensively, fixture tests pin today's shapes, and the
  coverage report surfaces new vocabulary on SDK bumps.
- [The transcript format changes] → Quiet fallback to replay-only history
  (D10). Enrichment is best-effort by design.
- [Prices go stale] → The snapshot date is recorded, the docs state the
  limitation, and a script regenerates the table.
- [Untested against agy: cancelling with a pending permission, plan updates,
  quota-exhausted errors, image prompts] → Fixture tests cover UatuCode's
  side, and the docs and PR list them as untested. Quota errors fall through
  to the generic "could not answer" failure with agy's message.
- [Process count when many conversations are opened] → Idle release (D2).
  Listing uses one short-lived process.
- [agy's mid-turn behaviour changes, for example a second prompt starts being
  rejected or queued by agy] → A fixture pins today's behaviour. A refused
  steer returns to the composer, so the failure is visible, and dropping
  `immediate-steering` from the declaration falls back to queuing.
- [A new capability touches shared composer and dock code] → It lands in its
  own commit with stub-agent unit and e2e tests. The `steering` and
  no-steering paths keep their existing tests unchanged.
- [Changes to the seam PR before it merges] → This branch is rebased when
  `refactor/generalize-chat-agent-seam` changes. After the squash merge,
  GitHub's stack retargets and rebases it onto `main`.
- [Bundling the SDK and `zod` into the single-file binary] → Proven in
  commit 1, before any provider code.

## Migration Plan

This change is additive: a new agent, with no change to stored data or wire
shapes. Rollback means reverting the PR. Antigravity conversations stay in
agy's own storage and are unaffected.

## Open Questions

- The exact `agy --version` output, which affects only the version parser
  and is pinned by a fixture.
- Whether agy supplies message ids on chunks. D4 covers both cases.
