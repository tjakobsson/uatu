## Why

uatu renders two agents' activity — Claude Code through the Agent SDK and
OpenCode through its SDK — and both SDKs grow faster than the timeline does.
Today nobody can answer "what does the latest Claude Code emit that uatu
does not understand?" without reading the normalizers against the SDK's
type files by hand. A recent read found three message types and four
content-block types that are silently dropped, and a family of new tools
(`ScheduleWakeup`, `CronCreate`, `Monitor`, `Workflow`, …) that render
through the generic tool row — readable, but with no decision recorded
about whether that is enough, and in the wakeup case, hiding that the
scheduled work never fires. The gap is not the missing coverage; it is that
the coverage is unknowable, so it cannot be prioritized.

## What Changes

- A generator, `bun run coverage:agents`, that reads the installed SDK type
  declarations for each agent (`@anthropic-ai/claude-agent-sdk` and
  `@opencode-ai/sdk`) and classifies every message type, message subtype,
  content-block or part type, and tool name by what the product code already
  does with it: **dedicated** (purpose-built rendering or behavior),
  **generic** (reaches the user through a fallback), **ignored** (deliberately
  dropped, with a stated reason), or **unhandled** (dropped without a
  decision). Classification is derived from the normalizers and renderers,
  not from a hand-kept list.
- One annotations module per agent for what code cannot express: the reason
  a type is ignored, and a **behavior-missing** flag for items that render
  but do not work, with a reason that names the work that fixes it where
  some exists. Annotations may only name
  things the SDK actually declares.
- Committed outputs: a per-agent coverage matrix under `docs/agents/`,
  headed by the exact SDK and CLI versions it was generated against and
  listing what is new since the previous generation; a per-agent badge
  rendered locally as an SVG next to it; and a marked block in the README
  that shows each badge linked to its matrix.
- A freshness test: the committed outputs match what the generator produces
  for the installed SDKs. It fails on a stale report or a stale annotation,
  never on missing coverage.
- The Claude Code normalizer counts the content-block types it skips inside
  a recognized message, so unknown blocks are measured the same way unknown
  messages already are.
- `@anthropic-ai/claude-agent-sdk` is pinned to an exact version, matching
  the existing OpenCode SDK pin, so the report and the code always name the
  same SDK and a Renovate bump carries its new rows.
- No in-app surface: coverage is contributor information. No external image
  or badge service: READMEs rendered outside github.com would leak reader
  requests to that service.

## Capabilities

### New Capabilities
- `agent-coverage-report`: the generated per-agent SDK coverage matrix,
  badge, README block, annotations, and the freshness rule that keeps them
  truthful.

### Modified Capabilities
- `claude-code-chat`: "Claude Code activity is normalized into the shared
  timeline" gains the rule that unrecognized content blocks inside a
  recognized message are counted by type, not skipped silently.
- `repository-workflows`: "Repository README documents project usage and
  validation" gains the agent coverage block; "Repository tooling versions
  are kept current" gains the exact pin for agent SDKs whose types feed the
  coverage report.

## Impact

- New: `scripts/agent-coverage.ts` (generator), `src/chat/claude/sdk-coverage.ts`
  and `src/chat/opencode/sdk-coverage.ts` (annotations), `docs/agents/*.md`,
  `docs/agents/*.svg`, a freshness test, a `coverage:agents` script entry.
- Modified: `src/chat/claude/normalization.ts` (block skip counter),
  `README.md` (marked block), `package.json` (SDK pin, script), `CONTRIBUTING.md`
  or `docs/CHAT.md` (how to regenerate after an SDK bump).
- Dependencies: one new dev dependency for local badge rendering
  (`badge-maker`, MIT — the library shields.io itself uses), subject to the
  license audit.
- Renovate: an SDK bump PR now fails the freshness test until the report is
  regenerated in that PR, which is where new rows get seen.
- Out of scope: acting on any gap the first report reveals. Scheduled
  wakeups (`ScheduleWakeup`/`CronCreate`/`/loop`) are a separate change; the
  first report names it in their behavior-missing reasons.
