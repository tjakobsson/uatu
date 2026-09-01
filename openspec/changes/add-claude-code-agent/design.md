# Design — add-claude-code-agent

## Context

See `proposal.md` for motivation. What matters for the approach:

- `src/chat/provider.ts` already defines a provider seam
  (`OpenCodeProvider`) with a positively-declared `ChatAgent` capability
  model, and the adapter/UI already gate controls on declarations. But
  the seam leaks: `ProviderMessage`/`ProviderEvent` are raw
  `Record<string, unknown>` OpenCode payloads, and the ~1,000-line
  OpenCode wire normalization (`normalization.ts`) sits **above** the
  seam inside the adapter. The runtime (`OpenCodeService`) is hardwired
  into `LazyOpenCodeChatService`.
- The client learns the agent from `ChatAvailability` alone; nothing on
  a conversation names its agent. `ConversationSnapshot`,
  `ConversationSummary`, and the inventory protocol have no agent field.
- Claude Code has no server mode. The Claude Agent SDK
  (`@anthropic-ai/claude-agent-sdk`) runs `query()` sessions — one
  process per live conversation — with `resume: <sessionId>` continuing
  a native session, `canUseTool` for permission brokering, and live
  `setPermissionMode`/`setModel` controls. Native history lives in
  `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
- Field evidence from established open-source multi-agent clients
  validates this shape: they wrap the Claude Agent SDK (not raw CLI
  stream-json), normalize inside per-agent providers into a shared
  timeline model, and treat effort levels as per-model options and
  permission modes as the mode axis.

## Goals / Non-Goals

**Goals**

- One shared chat pipeline (adapter machinery, replay, receipts, queue,
  inventory, attachment store, timeline model, all client UI) serving N
  agents, with per-agent code confined to per-agent folders.
- Claude Code conversations at full capability: the core loop (create,
  resume, prompt, stream, interrupt, permissions, questions, modes,
  models+effort, usage, commands) plus attachments, subagent
  drill-down, reversible history, plan-approval intents, and the
  task-progress surface.
- A wire contract where every conversation names its agent, and
  availability is per-agent.

**Non-Goals**

- Importing Claude Code sessions from working directories other than
  the canonical workspace directory (deferred; see proposal).
- Any change to hub proxying, auth, or the terminal subsystem.
- Dynamic agent registration; the agent set is fixed at server assembly.

## Decisions

### D1. Integrate via the Claude Agent SDK, not raw CLI stream-json

`query()` from `@anthropic-ai/claude-agent-sdk` with streaming input,
one session per live conversation, `resume` for continuation.

- Why: the SDK owns process spawning, transcript persistence, session
  resume, interrupt, and in-session mode/model switching — everything we
  would otherwise reimplement against an undocumented stream. Both
  reference implementations independently chose it.
- Alternative — spawn `claude -p --input-format stream-json` ourselves:
  more control, no SDK dependency, but reimplements session lifecycle
  and tracks an undocumented wire format. Rejected.
- Alternative — tail `~/.claude` transcripts as the live channel:
  read-only, no permission brokering. Rejected for live use; retained
  for enumeration (D6).
- Risk gate: an early spike task must prove the SDK works under Bun and
  bundles into the compiled `dist/uatu` binary (it spawns subprocesses
  and reads files at runtime — different from the pure-HTTP OpenCode
  SDK). If bundling fails, fallback is shipping the SDK's runtime
  requirements documented as an install prerequisite — decided at the
  spike, not silently.

### D2. Push normalization below the provider seam

The provider interface stops trafficking in raw payloads. Providers
return shared-model values: `listMessages` yields normalized
`ConversationItem[]` pages; `events()` yields normalized provider
updates (upsert/text-delta/remove/status/lifecycle) tagged with the
conversation id. `normalization.ts` moves to `src/chat/opencode/` as an
implementation detail of the OpenCode provider; the Claude provider gets
its own normalizer beside it.

- Why: this is the one structural fix that makes the adapter's ~3k lines
  of queue/replay/receipt/recovery machinery genuinely agent-neutral.
  Matches both reference codebases (per-provider mappers, shared
  timeline contracts).
- Alternative — teach the adapter a second wire format behind a
  `kind` switch: rejected; every future agent would grow the adapter.

### D3. Agent identity: a registry above per-agent service stacks

A registry maps `agentId` → an agent entry: descriptor (id, name),
runtime (lifecycle: status/retry/dispose), and lazily-built
adapter+provider stack. The workspace chat service becomes a thin
router: conversation-scoped calls resolve the owning agent and delegate
to that agent's adapter; status/inventory fan out and merge.

- Conversation ids are qualified on the wire (`<agentId>:<providerId>`)
  so ids from different agents cannot collide and every request names
  its owner without a lookup table. The adapter already namespaces
  provider ids; qualification happens once at the service boundary.
- `ConversationSummary`, `ConversationSnapshot`, and inventory
  announcements gain a required `agent` field (id + name). This is the
  **BREAKING** API revision; there are no external consumers beyond the
  bundled client and desktop webviews, so no compatibility shim — the
  OpenAPI contract and its tests are revised in the same change.
- Existing OpenCode conversations keep their provider ids; the qualified
  form is additive at the boundary. No persisted-state migration exists
  because uatu persists no conversation state of its own.
- Alternative — a `ChatAvailability` list with an ambient "active
  agent": rejected; it recreates the single-agent assumption one level
  up and makes cross-agent inventory a special case.

### D4. Runtime becomes a per-agent seam; readiness differs by nature

`OpenCodeService` already models "one server, N sessions, health
probes". The Claude runtime is different in kind: availability =
executable discovery (reusing `src/chat/executable.ts` generalized to
any binary name) + a bounded `claude --version`-style probe; there is no
long-lived idle process. Sessions are owned per-conversation by the
provider, supervised the way `superviseEventPump` works today, and
killed on dispose.

- The shared surface is minimal on purpose: `status()`, `retry()`,
  `dispose()`, plus a per-agent way for the service to know a provider
  can be built. OpenCode keeps its two-phase startup diagnostics
  untouched; Claude reports `not-installed`/`startup-failed` with the
  same `ChatStartupDiagnostics` shape (probe outcomes reused, endpoint
  absent).

### D5. Claude interaction mapping

- **Permissions**: the SDK's `canUseTool` callback becomes a pending
  `PermissionRequest` held by the provider (uatu-side pending map — the
  inverse of OpenCode's server-held list). Reply resolves the callback:
  `once`/`reject` map directly; `always` additionally records a
  session-scoped allow (via the SDK's permission-update mechanism) so
  repeats stop prompting. Session end rejects all pending callbacks and
  resolves their cards to interrupted — nothing stays pending forever.
- **Questions**: a `canUseTool` invocation for `AskUserQuestion` is
  classified as a `QuestionRequest` instead (options, descriptions,
  multi-select preserved; answers returned in the tool's expected
  shape). One callback, two card kinds — the field-proven mapping.
- **Modes**: permission modes (`auto`, `default`, `acceptEdits`, `plan`)
  are the agent's `ChatMode` list, in Claude Code's own vocabulary and
  order; `auto` is declared the default and a fresh conversation runs it
  explicitly. Switching uses the SDK's in-session `setPermissionMode`
  plus per-prompt options. `bypassPermissions` is offered only behind an
  explicit serve-level operator opt-in, matching the security posture
  spec's stance on agent authority; `dontAsk` is deliberately not
  offered — it removes the permission surface Chat is built around
  without the operator gate bypass has.
- **Models/effort** (amended during apply): the CLI's own catalog is the
  authority — `supportedModels()`/`supportedCommands()` answer over the
  SDK's control channel before any turn, so the first picker read
  hydrates from a short-lived promptless probe session in the workspace
  (which writes no transcript); a static manifest remains only as the
  probe-failure fallback. The catalog's `default` entry is offered
  first-class (`ChatModel.default`, its resolution named via
  `resolvesTo`, the CLI's descriptions as `detail`), effort levels ride
  as `variants`, and context windows are derived from the `[1m]` variant
  marker because no ModelInfo field carries one. Session-reported model
  ids join back to catalog ids through a two-pass alias map (exact
  resolved ids first, marker-stripped spellings into vacant keys) so
  usage attribution and the context gauge always land on a catalog
  entry.
- **Usage/context**: `result`/assistant usage maps onto the existing
  `TokenUsage` carrier semantics unchanged.
- **Attachments**: `ProviderAttachment` already carries `absolutePath`;
  the provider reads stored bytes and sends base64 image blocks with
  the prompt. Store, upload routes, bounds, and composer are reused
  unchanged; `imageInput` comes from the model manifest. History replay
  maps image blocks back to stored references where recoverable, else
  the existing labeled-placeholder path renders.
- **Plan approvals**: `ExitPlanMode` through `canUseTool` is classified
  as a plan approval. `PermissionRequest` gains an optional
  agent-provided approval-choice list (additive shared-type extension,
  absent for OpenCode); the chosen intent maps to approve + mode
  restoration (implement = stay out of plan; implement-and-restore =
  set the pre-plan mode via `setPermissionMode`). Reject keeps plan
  mode.

### D6. Enumeration and history read native storage; live turns never do

`listSessions`/`listMessages` for idle conversations parse
`~/.claude/projects/<encoded-cwd>/*.jsonl` (the cwd encoding ported as a
small, test-covered function). Live turns and
resume go exclusively through the SDK. Unparseable files are skipped and
counted, never fatal.

- Why: gives restart-surviving inventory and turn-free history rendering
  without keeping processes alive.
- Trade-off: the transcript format is internal to Claude Code. Contained
  by (a) validating shape per-line and skipping unknowns, (b) confining
  all knowledge of it to one module with fixture-based tests, (c) the
  live path never depending on it.

### D7. Subagents: sidechain reconstruction behind synthetic child ids

Claude Code subagents have no session of their own — they are sidechain
entries in the parent's stream and transcript, keyed by the launching
tool use. The provider tracks sidechains live (SDK subagent
forwarding + hook observations) and reconstructs them from the
transcript on replay, folding both into per-run child transcripts. Each
run gets a synthetic child conversation id derived from its tool-use
id; the provider serves it read-only through the same
history/subscribe paths, which is exactly what the existing
`ToolItem.childConversationId` drill-down mechanism expects. Child ids
never enter inventory.

- Why: reuses the shared drill-down UI and the spec's existing
  navigation contract wholesale; the only new mechanism is the
  tracker, which is the irreducible cost of Claude's subagent model.
- Alternative — flatten subagent activity into the parent timeline:
  rejected; loses the parent's legibility and the drill-down spec.

### D8. Reversible history through the SDK's rewind

Undo/redo/revert/restore map onto the SDK's rewind operations
(conversation restore to a message boundary + file checkpoint
restoration). The adapter's existing boundary state machine (staging,
queue pausing, draft restoration) is reused; the provider implements
the same provider-level reversible operations the OpenCode provider
does. Failures propagate as the spec requires: report, never claim.

### D9. Task progress is a new shared timeline item kind

A `task_progress` conversation item (one per turn-scope, upserted in
place) carries the task list's current items and states. It is a
shared-type addition rendered by the shared timeline renderer,
emitted today only by the Claude provider (from its todo tool
activity, live and on replay). OpenCode conversations simply never
contain one. This follows the established extension rule: capabilities
and item kinds are added one at a time by the change that needs them.

### D10. Module layout and naming

`src/chat/` keeps shared code at its root (types, adapter, service
machinery, replay, receipts, UI); agent-specific code moves under
`src/chat/opencode/` (runtime, sdk-v2 provider, normalization) and
`src/chat/claude/` (runtime probe, provider, normalization, transcript
reader, model manifest). Shared types drop the OpenCode prefix
(`OpenCodeProvider` → `ChatProvider`, `LazyOpenCodeChatService` →
routed multi-agent service) in this change — the (B) restructuring
forces those files open anyway; a separate rename change would conflict
with itself.

## Risks / Trade-offs

- [SDK under Bun / single-binary bundling fails] → spike task first in
  the task list; fallback decided there (documented runtime
  prerequisite), not discovered at release.
- [Claude transcript format changes silently] → per-line shape
  validation, skip-and-count, fixtures pinned to observed format, live
  path independent of it (D6).
- [Per-conversation processes leak on crash/dispose] → sessions
  registered with the runtime; dispose kills the process group;
  supervision mirrors the existing event-pump pattern with capped
  backoff.
- [Permission "always" semantics drift from Claude Code's own] → map
  conservatively (session-scoped allow only); never persist allows
  beyond the session uatu brokered.
- [Breaking API revision strands a stale client] → the existing
  client/server freshness handshake already forces reload on build
  mismatch; contract tests updated in the same change.
- [Two agents double e2e surface] → e2e uses a provider double for
  Claude (as OpenCode e2e does today); real-binary integration tests
  stay opt-in like `real-opencode.integration.test.ts`.
- [Sidechain reconstruction is the change's deepest mechanism] → it is
  isolated in one tracker module with live and replay sources folded
  through one observation model, fixture-tested against recorded
  transcripts; the core loop does not depend on it, so a defect
  degrades drill-down, not conversations.
- [SDK rewind semantics may not cover every boundary the shared undo
  contract allows] → the provider reports unsupported boundaries as
  failed operations (spec: report, never claim); capability stays
  declared only if the core undo path proves out in the spike-adjacent
  fixtures.

## Migration Plan

Single release; no data migration (uatu persists no conversation state).
Order inside the change: (1) seam refactor with OpenCode-only behavior
proven unchanged, (2) agent registry + API revision + client agent axis,
(3) Claude provider core loop, (4) Claude extended capabilities
(attachments, plan intents, task progress, rewind, subagents — deepest
last). The UX is the deliverable: each user-facing surface is demoed on
a scripted agent double as it lands, so the interface is reviewable
long before the real provider is complete, and implementation details
beneath the specs stay at the implementer's discretion. Rollback =
revert the release; OpenCode history and Claude native sessions are
both external and unaffected.

## Open Questions

- Whether the effort manifest should also drive a default effort per
  model (cosmetic default only; safe to decide during implementation).
- Exact operator opt-in spelling for offering `bypassPermissions`
  (flag name on `serve`; does not affect specs, which only require the
  gate to exist).
