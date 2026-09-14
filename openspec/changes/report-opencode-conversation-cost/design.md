## Context

See proposal.md — Why.

OpenCode's `AssistantMessage.cost` (USD) sits beside `tokens` on every
`message.updated` event and on stored-history reads; `StepFinishPart.cost` is
the per-step figure and `Model.cost` the price list. Our OpenCode adapter emits
one `usage:<messageId>` carrier item per assistant message (an empty-markdown
`assistant_message` with `usage` + `model`), rebuilt on each restatement so the
latest cumulative figure wins. The client already folds carriers for the
context meter (`context-readout.ts`) and mirrors a child session's usage onto
the launching tool row.

The Claude Code provider emits a `context_report` item whose `session:
SessionTotals` the chip (`planSummaryLabel`) and readout (`paintPlanSession`)
draw. OpenCode emits no such report.

`TokenUsage` is closed on the wire (`additionalProperties: false`), so a new
property is a breaking workspace-API change under the contract policy.

## Goals / Non-Goals

**Goals:**
- Reuse the existing `SessionTotals` surface; no second cost UI.
- Cost survives a reopen and a workspace restart with no server-side ledger.
- Zero new dependencies, no new wire item type.

**Non-Goals:**
- Recomputing cost from `Model.cost` price lists — OpenCode's figure is the
  figure.
- Folding a subagent's cost into its parent's total (OpenCode's own session
  cost does not; the subagent row shows it separately).
- API/wall-clock time and lines changed for OpenCode — left absent; the
  readout already omits zero parts.

## Decisions

**D1 — Cost travels on `TokenUsage` as `costUsd`, not a new item.**
The carrier keyed per message is already the unit that cannot double-count,
and `storedMessageUsage` / the subagent mirror copy `TokenUsage` whole, so a
field on it reaches history reads and subagent rows with no new plumbing.
Alternative: a sibling `costUsd` on `AssistantMessageItem` — same breaking
change, and the subagent mirror and stored-history path would each need a
second copy line. `costUsd` is **not** added to `TOKEN_USAGE_COMPONENTS`
(that list is summed as tokens); `sameUsage` compares it explicitly.

**D2 — The fold is client-side, from carriers, like the context meter.**
A `conversationTotals(items)` (new module beside `context-readout.ts`) sums
`usage.costUsd` over assistant-message carriers, grouped by the carrier's
`model` into `SessionModelTotals[]` (tokens summed per model too), returning
`undefined` when no carrier has a cost or every cost is zero. `since` is
omitted. Alternative: have the OpenCode provider emit a `context_report`
with `session` — needs a server ledger keyed by conversation, breaks on
restart (the "since HH:MM" caveat Claude Code has), and restates what the
carriers already say.

**D3 — One resolver picks the totals the UI paints.** The newest
`context_report` that speaks to the plan decides (Claude Code): its
`session`, or nothing when it carries none — totals ride the same report as
the plan, so a newer plan report without them means the agent reported none,
and an older report's figure is not resurrected. Only when no report speaks
to the plan does the carrier fold apply (OpenCode). `paintPlanSession` and
`planChip` take the resolved `SessionTotals | undefined` instead of reading
`report.session` directly. The Claude Code path is unchanged in behavior
(the polish e2e that retires totals on a minimal report still passes).

**D4 — Zero-cost conversations show nothing.** `cost: 0` is how OpenCode
reports "no price known" for local/proxy models. A `$0.00` chip on a free
model reads as broken. Rule: total omitted when the sum is 0; a carrier with
no `costUsd` contributes nothing (absent ≠ zero, matching the token rule).

**D5 — Revision bump 17 → 18.** `TokenUsage.costUsd: { type: number,
minimum: 0 }` in `api/openapi.yaml`; `workspaceApiRevision` in
`api/contract.json`; `WORKSPACE_API_REVISION` in `src/shared/version.ts`;
`## Hub 5 / Workspace 18 - Unreleased` in `api/CHANGELOG.md` with
`Compatibility: breaking (workspace)` and a Migration paragraph naming
the conversations domain. Verify with CI's "Enforce compatibility" step run
locally.

## Risks / Trade-offs

- [OpenCode restates `cost` cumulatively per message; a mid-stream figure is
  partial] → the carrier is replaced on every restatement, so the sum only
  ever includes the latest figure per message; the chip may tick up during a
  turn, which is the intended live behavior.
- [Currency is assumed USD] → OpenCode reports USD only today; `formatUsd`
  is the existing formatter. If OpenCode ever reports a currency, the field
  name stays honest (`costUsd`) and a new field would carry the other.
- [Subagent-vs-parent totals could be read as double counting] → the
  parent's total excludes children (D2); the subagent row is the only place
  a child's cost appears.
- [Revision bump touches four files and CI compatibility] → checklist in D5;
  run the compatibility step before pushing.
