## Why

The composer chip reads "Plan 9% of 5h · 25% of 7d". Readers take "Plan" to mean this session and cannot tell what "7d" counts from; the reset times are hidden in a tooltip. Meanwhile the `/usage` read behind the chip returns far more than two numbers — subscription type, per-model weekly windows (Opus, Sonnet, and model-scoped buckets such as "Fable"), extra-usage credits, and the session's own cost and per-model token totals — all of which is dropped today.

## What Changes

- The chip is renamed to Claude Code's own vocabulary: "Session 9% · Week 25%" (the 5-hour window is what Claude Code's `/usage` dialog calls the current session; the 7-day window the current week). The chip turns to the warning colour when any window is at or past 80%.
- Clicking the chip opens a usage readout beside the composer, in the same floating pattern as the context breakdown: each window as a labelled meter with its percentage and reset time (absolute and relative), the plan name, per-model weekly windows where the login reports them, extra-usage credits where enabled, and this conversation's cost and per-model token totals.
- A new **Usage** sidebar pane, hidden by default, shows the same plan windows persistently for readers who want them always on. It is available from the panels menu like Git Log and Search, and the usage readout offers a "Keep in sidebar" pin when the sidebar is shown beside the chat.
- The Claude provider's `/usage` normalisation widens from two windows to the full window set, subscription type, extra usage, and session totals. Every new field is optional; a login that reports only the two windows renders exactly as today.
- The behaviours attribution block (`behaviors`) in the `/usage` response is deliberately not carried; see design.md.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `claude-code-chat`: the requirement *Session signals surface as status, not silence* gains the readable plan-usage summary and detail readout.
- `sidebar-shell`: a new *Usage pane* requirement joins the pane stack (following the Search-pane precedent), and *Fresh clients default to a lean pane set* names it hidden by default.

## Impact

- `src/chat/types.ts` — `PlanUtilization` widens (subscription, per-model windows, model-scoped buckets, extra usage); `ContextReportItem` gains `session` totals.
- `src/chat/claude/provider.ts` — `normalizePlanUtilization` and the session-totals normaliser.
- `src/chat/composer-status.ts` — chip label, warning level, readout model (rows, relative reset).
- `src/chat/ui.ts`, `src/index.html`, `src/styles.css` — chip → `<details>` readout; pin control.
- `src/shell/state.ts` (pane defs), `src/sidebar/` — Usage pane chrome; pane body rendered by a small chat-owned module.
- `src/chat/validation.ts` — wire validation for the new optional fields.
- Tests: `composer-status.test.ts`, `claude/provider.test.ts`, `validation.test.ts`, `shell/state.test.ts`; e2e in `chat-claude-polish.e2e.ts` (chip + readout) and `sidebar.e2e.ts` (pane).
- No change for OpenCode conversations (no plan data) beyond the chip staying hidden.
