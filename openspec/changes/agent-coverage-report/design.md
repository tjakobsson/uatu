## Context

See proposal.md — Why. The relevant current state:

- Claude Code: one normalizer, `src/chat/claude/normalization.ts`, with a
  handled switch over `type`/`subtype`, an `INTENTIONALLY_IGNORED` set, and a
  fallthrough that reports `ignored` or `unrecognized`. Content blocks inside
  `assistant`/`user` messages are walked by `if` chains with no `else`: an
  unknown block type is skipped and not counted. The normalizer has no
  try/catch, so a case that throws propagates into the adapter's event pump —
  the spec already requires `unparseable` here; OpenCode's normalizer has it.
- OpenCode: a generation seam (`src/chat/opencode/normalization.ts`,
  `GenerationMapper`) with v1 and v2 mappers, each contributing `own`,
  `toCanonical`, and an `ignored` set; `normalizeEventWith` resolves every
  event to `handled | ignored | unrecognized | unparseable`. Parts fall through
  `normalizePart` to `[]` uncounted.
- Tool rendering for both agents goes through `describeToolDetail` in
  `src/chat/tool-detail.ts`; anything outside its switch returns
  `kind: "generic"`.
- Vocabularies live in installed type declarations:
  - Claude: `@anthropic-ai/claude-agent-sdk/sdk.d.ts` (the `SDKMessage` union
    and its `type`/`subtype` literals; content-block unions), `sdk-tools.d.ts`
    (one `*Input` interface per tool the CLI can call), `manifest.json` (the
    bundled Claude Code CLI version).
  - OpenCode v1: `@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts` — the SDK's
    second client, which the 1.x provider imports (`Event*` members with
    `type: "…"` literals; the `Part` union).
  - OpenCode v2: `@opencode/schema/dist/event-manifest.d.ts` plus
    `session-event.d.ts` (which alone declares
    `session.message.content.updated`), and the `AssistantContent` union in
    `session-message.d.ts`.
  - Claude content blocks: `@anthropic-ai/sdk`'s `BetaContentBlock` union
    (the type `SDKAssistantMessage.message` refers to).
  - OpenCode does not enumerate tool names in either SDK (`tool: string`).
- `@anthropic-ai/claude-agent-sdk` is a caret range; both OpenCode packages
  are exact pins.
- Metrics already count discarded events as `chat.event.<outcome>.<type>`
  (`countDiscard` in `src/chat/adapter.ts`) with a cap on distinct types.

## Goals / Non-Goals

**Goals:**
- One generator, both agents, all outputs, deterministic.
- Classification by running the product code, so the matrix can't drift
  from behavior.
- Zero network at read time: no external badge or image URLs.
- The only test failure mode is staleness.

**Non-Goals:**
- Acting on any gap the first report reveals (scheduled wakeups are a
  separate change; the report names it).
- Any in-app coverage surface or in-app warning.
- Coverage of hooks, MCP server configuration, or agent *inputs* uatu sends
  (permission modes, models). The report covers what the SDK emits and the
  tools it can call.
- Percentages. Generic rendering is not "half done"; the badge counts gaps.

## Decisions

**D1 — Vocabulary comes from the installed declarations, extracted by pattern.**
The generator reads the `.d.ts` files listed in Context and pulls string
literals by regex, keyed per axis. Alternative: use the TypeScript compiler
API to walk the unions — exact, but a heavy dependency for a script, and the
literal patterns in these files are stable. Mitigation for brittleness: every
axis has a floor (Claude message types ≥ 30, Claude tools ≥ 30, OpenCode v2
events ≥ 80, and so on); below the floor the generator throws naming the file
and pattern. A layout change is a loud generator failure, never an empty
report.

**D2 — Classification by probing, not by reading lists.**
For each entry the generator builds a minimal synthetic payload and runs it
through the real code:
- Message types/subtypes → the agent's normalizer (`normalizeClaudeMessage`;
  `normalizeEventWith` with the v1/v2 mapper). `handled` or `unparseable` →
  **dedicated** (a case exists for it, even if the stub lacked its fields);
  `unrecognized` → **unhandled**; `ignored` → **ignored** when the product's
  own ignore set names it (`INTENTIONALLY_IGNORED`; a mapper's `ignored` or
  `CORE_IGNORED`), else **dedicated** — a case matched and chose to emit
  nothing for the stub (a live `user` echo, a `stream_event` with no open
  stream). Control probes (an invented type, subtype, block, and tool) must
  read unhandled/generic, or the generator fails.
- Content blocks/parts → a synthetic assistant message carrying one block of
  that type; updates produced → **dedicated**; otherwise → **unhandled**. The
  new skip counter (D5) is the observable that makes this honest.
- Tools → one stub input that satisfies every renderer's required field,
  run through each place a tool can get a dedicated surface: the normalizer
  (`TodoWrite` becomes the task-progress item, not a row),
  `claudeToolInteraction` (the question and plan cards, extracted from the
  provider's approval callback so the probe runs the same code), and
  `describeToolDetail`; any dedicated surface → **dedicated**, else
  **generic**. `describeToolDetail({ name })` alone would read every tool as
  generic: its cases fall back when their input field is missing. Claude's `sdk-tools.d.ts` names differ from
  wire names for a few tools (`FileEditInput` → `Edit`, `FileReadInput` →
  `Read`, `FileWriteInput` → `Write`, `AgentInput` → `Agent`/`Task`); the
  Claude annotations module holds that name map so the probe uses the wire
  name and the matrix shows both.
- OpenCode tools → no SDK vocabulary exists, so the candidates are the names
  the product itself knows (the `describeToolDetail` case labels and
  `COMMAND_TOOL_NAMES`), each kept only when the same stub probe confirms a
  dedicated surface.
Alternative: parse the switch statements. Rejected — it couples the report to
code shape, and OpenCode's `own` is a function, not a table.

**D3 — Annotations are the only hand-kept input, and they are validated.**
`src/chat/claude/sdk-coverage.ts` and `src/chat/opencode/sdk-coverage.ts`
export `{ reasons: Record<name, string>, behaviorMissing: Record<name, reason>, toolNames?: Record<inputTypeName, wireName> }`.
The generator rejects any key not present in the extracted vocabulary; the
freshness test therefore fails when an SDK drops something an annotation
still names. An ignored entry without a reason fails the generator, naming
it: the fix is a reason, or taking the type off the product's ignore list so
it counts and reports as unhandled — an ignore nobody can justify is a gap,
not a decision. A reason key ending in `*` covers every ignored entry under
the prefix (`2.x:pty.*`), the most specific key winning, so a family of
server-lifecycle events shares one sentence. The first pass took the Claude
types the SDK itself describes as user-visible (`local_command_output`,
`informational`, `conversation_reset`, `permission_denied`, `notification`)
and those no reason could be verified for (`auth_status`, `files_persisted`,
`elicitation_complete`; 2.x `session.inbox.cancelled`, `session.forked`,
`session.moved`, `session.skill.activated`) off the ignore lists.

**D4 — Outputs are files under version control, and deterministic.**
`docs/agents/claude-code.md`, `docs/agents/opencode.md`,
`docs/agents/claude-code.svg`, `docs/agents/opencode.svg`, and a README block
between `<!-- agent-coverage:start -->` / `<!-- agent-coverage:end -->`. No
timestamps anywhere: the header names versions only (Claude: SDK + bundled
CLI from `manifest.json`; OpenCode: both package versions as "1.x SDK a.b.c ·
2.x client d.e.f"). The badge is rendered with `badge-maker` (MIT; shields'
own renderer) into a static SVG. Alternative: the shields endpoint —
rejected, it makes every non-GitHub README render phone home.

**D5 — The Claude normalizer measures what it skips and survives a throw.**
Block loops gain a terminal branch that records the skipped block type on the
normalized event (`skippedBlocks: string[]`); the adapter counts them as
`chat.block.unrecognized.<type>` under the same distinct-type cap as events.
`normalizeClaudeMessage` gains the try/catch → `unparseable` boundary OpenCode
already has. The OpenCode `normalizePart` fallthrough gets the same skip
report, so the matrix's part axis is observed the same way for both agents.
The `system` branch's catch-all currently resolves every unmatched subtype
to `ignored`, and `INTENTIONALLY_IGNORED` is only consulted for top-level
types; an unmatched subtype becomes `unrecognized` unless that set names it,
and its discard is counted under `system.<subtype>`. Without this no system
subtype, the axis Claude Code grows fastest, could ever read as unhandled.
OpenCode 1.x sends `step-start`, `step-finish`, and `snapshot` parts on nearly
every step and none carries anything for the timeline (a step's cost and
tokens are restated on `message.updated`), so an `IGNORED_PARTS` set drops
them without counting; the part probe reports them as ignored.

**D6 — "Since previous version" is computed from the committed matrix.**
The generator parses the matrix it is about to overwrite — the version header
and the entry names per axis — and writes added/removed lists against that
version. No separate history file; git holds the history. While the versions stand
still the section is carried forward, and nothing in the working tree can
recompute it (its baseline is the previous SDK's vocabulary); its start
marker therefore carries a seal, a digest of its content and the version
line, and a carried-forward section whose seal does not match fails the
generator as a hand edit.

**D7 — Exact pin for the Claude SDK.** `"@anthropic-ai/claude-agent-sdk": "0.3.261"`
(the version currently in the lockfile). Renovate already opens bump PRs; the
freshness test turns each into the triage point.

**D8 — Where the generator lives.** `scripts/agent-coverage.ts` with its test
beside it, following `scripts/generate-formula.ts`. It imports product code
from `src/` (normalizers, `describeToolDetail`, annotations) — allowed for a
script; `src/` stays product-only.

## Risks / Trade-offs

- [Regex extraction misses a renamed union] → per-axis floors fail loudly
  (D1); the freshness test fails on the bump PR, which is where the fix goes.
- [A probe stub trips a case that expects fields and we misread `unparseable`
  as dedicated] → that is the intended reading: a case exists. The matrix
  shows the state, and a case that "exists" but cannot handle real payloads
  would show up in the `unparseable` metric in production, not here.
- [Probing runs product normalizers in a script with memory objects] → the
  normalizers are pure functions over records plus a memory arg; the probe
  creates fresh memory per entry.
- [`badge-maker` pulls transitive deps] → it has none of note; the license
  audit runs in CI regardless.
- [Contributors edit the README block by hand] → the freshness test rejects
  it; the markers say so in a comment.
- [First run of the OpenCode axis exposes many `unhandled` v2 events] → that
  is the report doing its job; nothing fails.

## Migration Plan

1. Land the change with the generator's first outputs committed.
2. From then on: bump an SDK → `bun run coverage:agents` → commit the
   regenerated files in the same PR. CONTRIBUTING.md's validation section
   says so.
Rollback: delete the outputs, the script entry, and the test; the normalizer
hardening (D5) stands on its own.
