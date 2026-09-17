## Why

The conversation cost readout is meant to be a receipt — a total, and line items that add up to it — but it bills some work more than once and hides other work. When OpenCode hands an existing subagent a further task (its `task_id` continuation, 87 of 498 launches on the production hub, 20 of 81 subagent conversations), every row for that subagent shows the subagent's whole spend, so the total is overstated: a real priced conversation that cost $0.0951 reads $0.11. When a subagent launches its own subagent, the nested work is folded unlabelled into the launcher's line, and the main agent's line lumps `build`, `plan` and OpenCode's `compaction` together as "This agent". The per-row token figure is wrong in the released v0.7.0; the dollar receipt is unreleased, so fixing it now means no stable build ever shows a wrong invoice.

Evidence, from one real conversation on a priced model (Berget Qwen3.8 27B; four layers deep, one subagent given two tasks): `screenshots/before-real-*.png` (the app before this change, $0.11), `screenshots/after-real-*.png` (the same conversation after it, $0.0951 — what OpenCode's store says was spent), and `screenshots/mock-proposed-vs-before.png` (the design mock the receipt was agreed from). The remaining `after-*.png` are the fixture-driven e2e evidence.

## What Changes

- **Each line bills its own work once.** A subagent row's figure — on the receipt, the timeline row, and the composer's subagent list — becomes the spend of *that task alone*: the replies the subagent produced to that task's prompt. A subagent given a second task gets a second line carrying only the second task's spend, marked as the same agent as the earlier line. The total counts every message once.
- **Nested subagents are listed, not absorbed.** A subagent launched by a subagent gets its own line beneath its launcher, at any depth; the launcher's line states only the launcher's own spend.
- **Main agents are named.** "This agent" becomes the name OpenCode gives it (`build`, `plan`), one line per name the conversation ran under, and `compaction` gets its own line.
- **One receipt, three itemizations.** A three-way control — Agents, Types, Models — switches how the same total is itemized; Types counts distinct subagents per kind (`3 × general`), stating the task count where it differs. A total line closes the list. The choice is remembered on the device. This replaces the two stacked tables (Model always, Agent when subagents exist).
- **The composer's subagent list counts honestly**: "3 subagents · 4 tasks finished" when an agent was given more than one task; unchanged otherwise.
- **BREAKING (workspace API):** a tool item's `usage` changes meaning from "the child session's aggregate, descendants included" to "this task's own spend"; tool items gain the nested lines beneath them, and usage carriers gain the name of the agent that produced the message. Closed wire objects, so the workspace API revision increments (19 → 20) with a changelog migration section.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: "Chat reports what an OpenCode conversation has cost" is rewritten around the receipt (own-task lines, nesting, named main agents, three itemizations, total line); "Chat reports context usage and subagent cost" changes a subagent row's token attribution from the child session's aggregate to the task's own; a new requirement covers how the composer's subagent list counts agents and tasks.

## Impact

- `src/chat/adapter.ts` — child attribution re-keyed from (parent, child session) to the launching task; inclusive propagation replaced by nested lines; reconstruction from stored history follows.
- `src/chat/opencode/normalization.ts`, `sdk-v2-provider.ts` — carry the prompt an assistant message answers and the agent that produced it, live and from the store.
- `src/chat/conversation-totals.ts`, `src/chat/ui.ts`, `src/chat/timeline-renderer.ts`, `src/index.html`, `src/styles.css` — the receipt model, the three-way control, nested/same-agent lines, total line, composer list wording.
- `src/chat/types.ts`, `src/chat/validation.ts`, `api/` (openapi.yaml, contract.json, CHANGELOG.md), `src/shared/version.ts` — wire shape and revision 20.
- Claude Code conversations are unaffected: Claude reports session totals itself, per model only, and keeps its current readout.
- Release notes: the token-figure correction is a visible `fix` (broken in v0.7.0); the dollar-receipt correction stabilizes an unreleased feature and takes the Release Please override.
