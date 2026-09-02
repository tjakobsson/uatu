## Context

`activitySegments()` in `src/chat/timeline-renderer.ts` already folds runs of 3+ finished activity rows (tool, command, reasoning, background task) into one `<details class="chat-activity-group">`. It deliberately exempts the trailing run of a live turn ("that is the work the reader is watching happen"). The renderer keeps member nodes with per-item identity and only reparents them, and the `expanded` set in `ui.ts` remembers open groups by id (`group:<firstItemId>`), so opening survives re-renders.

Separately, `#chat-waiting` in `index.html` (pulsing square + "Working · 12s") is shown by `ui.ts` only while nothing newer than the prompt has arrived; it hides when the first item lands and the flat rows take over.

See proposal.md — Why.

## Goals / Non-Goals

**Goals:**
- One element carries a running turn from "accepted" to "done"; the timeline stays quiet while work happens.
- No loss of inspectability: every member row keeps its identity, state, streaming output and expansion behaviour.
- No new state: reuse `expanded` and the existing group id scheme.

**Non-Goals:**
- Whimsical progress verbs or any per-step summarising beyond what `groupSummary` already does.
- Changing how retry / compaction states are shown (they stay on the composer status).
- Touching the subagent drill-down's rendering other than inheriting the same rule.

## Decisions

**D1. The live tail always collapses, from the first step.** Alternative: apply `GROUP_MIN` (3) to the live tail too. Rejected: the first two steps would render flat and then jump into a fold, which is exactly the flicker the reader wants gone; and the user's stated preference is to click when they want to watch output. The `finished` and `GROUP_MIN` conditions keep applying to *non-tail* runs, so a turn that speaks ("Let me look"), runs one tool, and speaks again still shows that single finished tool flat, as today.

**D2. The live group id is `group:<firstItemId>` — the same id it will have when finished.** So an open live group stays open through completion with no extra bookkeeping. Consequence: if the first item of the run is a `background_task` the id is still stable. Edge: when the turn ends and the run is shorter than `GROUP_MIN`, the group dissolves into flat rows (existing behaviour, already tested — "a dissolved group reparents its members back to the top level").

**D3. The waiting row becomes an empty live group.** `activitySegments` gains an "awaiting" segment when the conversation is live and nothing after the last prompt has arrived (the same predicate `awaitingFirstResponse()` computes in `ui.ts` today — move it into the renderer next to `activitySegments`, where it is pure over items + status). The renderer emits the live group with zero members and the "Working · Ns" label; `#chat-waiting` and `syncWaiting` are deleted. Id for the empty form: `group:<lastUserMessageId>` — but that would change once a real first item arrives. Decision: the empty group and the populated group are *different* elements (keyed differently); the empty one is never opened (nothing to open — render it without a summary cursor), so there is no open state to carry across. Visually they are identical, so the swap is invisible.

**D4. Header content while live.** `[dot] Working · 20s   <current step label + subject>` where the current step is the last member that is running or pending, else the last member. The elapsed time is the turn's (`workingSince` already tracked per conversation in `ui.ts` presentation); the renderer receives it as an argument the way it receives `expanded`, and `ui.ts` keeps ticking it once a second as it does for the composer status. Alternative: show `groupSummary(run)` live. Rejected: a rolling "Fetch … · WebSearch ×3" reads as a ledger, not a status.

**D5. Status dot, not header tint.** `.chat-group-dot` before the count; `data-outcome="live|clean|failed"` on the group. Live = `--accent` with the existing `chat-waiting-pulse` keyframes (moved/renamed to the group); clean = `--border-soft`-ish neutral; failed = `--danger`. Text colour unchanged. Reduced motion guard as elsewhere.

**D6. Auto-open of running members inside the group is unchanged.** `autoOpen(status, output)` already opens a running tool once it has output; since the member node is the same, opening the group shows it already open. Nothing to do; assert it in a test.

**D7. Viewport following.** The timeline follows its end; a collapsed group is short, so following gets *easier*. Opening the group mid-turn adds height at the end, which the existing "expand away from the timeline end" bookkeeping already handles for member rows; groups go through the same `toggle` listener. Verify in e2e rather than design around it.

## Risks / Trade-offs

- [Reader misses that a step failed mid-turn] → the live group's dot turns red as soon as any member fails (outcome is computed live, not only at settle). The failed row is also one click away.
- [Empty-group / populated-group swap flickers] → identical markup and CSS; e2e screenshot pair at the swap boundary.
- [Elapsed clock ticks re-render the group] → tick updates `textContent` of the label only; no `render()` pass, mirroring the composer status clock.
- [`chat-claude-polish.e2e.ts` and `chat-panels.e2e.ts` assert the live tail is flat] → those assertions invert; screenshots regenerated.

## Migration Plan

No data or storage migration. Persisted `expanded` ids keep their meaning.
