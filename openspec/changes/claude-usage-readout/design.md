## Context

After each turn the Claude provider calls the SDK's `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` alongside `getContextUsage()` and attaches the result to the `context_report` item as `plan: { fiveHour?, sevenDay? }` (`normalizePlanUtilization`, `claude/provider.ts`). `composer-status.ts` picks the newest report and formats "Plan 37% of 5h · 12% of 7d"; `ui.ts` writes it into `#chat-plan-usage`, a plain span, with the 5-hour reset in a tooltip.

The SDK response also carries `subscription_type`, `rate_limits.seven_day_opus / seven_day_sonnet / seven_day_oauth_apps`, `rate_limits.model_scoped[] { display_name, utilization, resets_at }`, `rate_limits.extra_usage`, `session { total_cost_usd, total_api_duration_ms, total_duration_ms, total_lines_added, total_lines_removed, model_usage: Record<modelId, { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD, contextWindow, ... }> }`, and `behaviors` (a local-transcript scan attributing weekly usage to skills / agents / MCP servers). The method is marked experimental.

The context readout next to the chip is already a `<details>` whose body floats over the timeline (`.chat-context-breakdown`, `position: absolute`) so opening it never pushes the composer.

The sidebar pane stack is defined by `ALL_PANE_DEFS` in `shell/state.ts`; panes are `<section class="sidebar-pane" data-pane-id>` in `index.html` with collapse / hide / resize wired by `sidebar/panes.ts`. The Search pane is the precedent for a hidden-by-default pane. `shell/tab-bar.ts` already imports from `chat/`, so sidebar → chat imports have precedent.

See proposal.md — Why.

## Goals / Non-Goals

**Goals:**
- Plan vocabulary matches Claude Code's own dialog so the two never disagree.
- Every reported window is visible somewhere, with its reset.
- A stay-on view for readers who want it, without taking timeline height from those who don't.

**Non-Goals:**
- Carrying `behaviors` (see D6).
- A generic popover/dialog primitive; the `<details>` pattern is enough.
- Showing plan usage for OpenCode conversations (it has no plan).
- Charts: meters are horizontal bars with a percentage label, matching the context meter's restraint.

## Decisions

**D1. Widen `PlanUtilization`, keep it optional-everything.**
```
PlanUtilization = {
  subscription?: string;                 // 'pro' | 'max' | 'team' | 'enterprise' | other
  fiveHour?, sevenDay?, sevenDayOpus?, sevenDaySonnet?, sevenDayOauthApps?: PlanUtilizationWindow;
  modelScoped?: Array<PlanUtilizationWindow & { label: string }>;
  extraUsage?: { enabled: boolean; usedCredits?: number; monthlyLimit?: number; utilization?: number; currency?: string };
}
```
and `ContextReportItem.session?: { costUsd, apiDurationMs, durationMs, linesAdded, linesRemoved, models: Array<{ id, input, output, cacheRead, cacheWrite, costUsd }> }`. Existing consumers (`latestPlanUtilization`, `sameUsage`, validation) keep working because the two base windows keep their names. Alternative: a fresh `plan_report` item. Rejected: the plan already rides the context report and its newest-wins rule; a second item would need its own.

**D2. Chip is the `<details>` summary; readout is its body.** `#chat-plan-usage` becomes `<details class="chat-plan-usage"><summary>Session 9% · Week 25%</summary><div class="chat-plan-readout">…</div></details>`, floated exactly like `.chat-context-breakdown`. Composer-rail grid columns are unchanged (the chips row is its own line under the actions). Alternative: a dialog like the configuration picker. Rejected: heavier, and the neighbour already sets the pattern.

**D3. Readout rows are computed in `composer-status.ts`, rendered in `ui.ts`.** `planReadoutRows(plan, now)` returns `[{ key, label, utilization?, resetsAt?, resetLabel }]` in a fixed order: Session (5h), Week (7d), Week · Opus, Week · Sonnet, Week · <model_scoped label>…, Week · OAuth apps, Extra usage. `relativeReset(resetsAt, now)` gives "in 4d 11h" / "in 35m". A once-a-minute tick refreshes relative labels while the readout is open. The pane reuses the same rows.

**D4. Warning level.** `planUtilizationLevel(plan)` → `"warning"` when any window ≥ 80, else `"normal"`; the chip takes `data-level`, coloured like the rate-limit badge's warning. The rate-limit badge stays: it reports an event (the server said warn/reject); the chip reports a reading.

**D5. Usage pane.** `ALL_PANE_DEFS` gains `{ id: "usage", label: "Usage" }` with default `{ visible: false, collapsed: false, height: 160 }`. Pane chrome in `index.html` after Git Log. Body rendered by `src/chat/usage-pane.ts` (chat owns the data and the row model; sidebar owns chrome). `ui.ts` calls `renderUsagePane(latestPlan)` whenever a context report with a plan lands on any Claude conversation the client holds — the pane is per-login, so "newest report from any conversation" is the right source; the client already holds projections for the conversations it has opened. The pin button in the readout appears only when `html[data-ui-mode="desktop"]` and the sidebar is expanded (the touch layout puts the sidebar in the Files tab, where the panels menu already reaches the pane); pinning sets `appState.panes.usage.visible = true`, persists, and re-renders the sidebar through the existing owner functions.

**D6. `behaviors` is not carried.** It scans every local transcript on the machine, is explicitly approximate, is null for non-subscribers, and answers a different question ("what is eating my week") from the readout's ("how much is left"). Left as a follow-up once the base readout has been lived with.

**D7. Session totals ride the same context report.** They are per conversation and refresh with the plan; the readout's "This conversation" block reads them from the same newest report. Model ids are shown through the existing model catalog name resolution where a match exists, else raw. A login without plan limits (API key, Bedrock, Vertex) reports an empty plan beside real session totals; the chip then reads "$1.23 this conversation" and the readout is the "This conversation" block alone — no plan name, no meters, no pin — so the cost stays reachable where the windows are not. The SDK's `/usage` session counters cover the current `query()` only and a resumed query starts fresh, while the provider retires an idle conversation's query after every turn — so the provider keeps a per-conversation ledger for the process lifetime, folds each retired query's last read into it (scalars summed, per-model rows merged by id), and reports ledger plus current query with a `since` (when this process first started a query for the conversation). The readout's block reads "This conversation" when `since` is at or before the first user message and "This conversation · since HH:MM" otherwise (a workspace restarted mid-conversation); no transcript scan reconstructs earlier spend.

**D8. Validation.** `validation.ts` accepts the new optional fields and rejects wrong types; unknown windows the SDK adds later are ignored, not rejected.

## Risks / Trade-offs

- [SDK shape changes under the experimental method] → every field optional; a normaliser test pins the current shape; missing fields degrade to today's two windows.
- [Relative reset drifts while the readout is open] → one-minute tick, cleared when the details closes.
- [Pane shows a stale login after switching workspaces] → the pane is keyed to the client's newest report; a new report replaces it wholesale, and the pane shows the report's time ("as of 21:33").
- [Chip width grows in narrow composers] → the chips row already wraps under the actions; "Session 9% · Week 25%" is shorter than today's label.
- [Readout height on phones] → capped with internal scroll like the context breakdown; the pane is the stay-on answer, not the readout.

## Migration Plan

No storage migration; a stored pane state without `usage` gets the default (hidden). No wire break: the widened `plan` is a superset.
