// What a conversation has cost, folded on the client from the per-message
// usage carriers — the same source the context meter reads. OpenCode prices
// each assistant message and restates the figure while the message streams;
// the adapter keeps one carrier per message (`usage:<id>`) and replaces it on
// every restatement, so summing the carriers counts each message once, at its
// latest figure, and a reopened conversation restores its cost from history
// with no server-side ledger. Claude Code reports session totals itself, on a
// context report; that report wins where it exists.

import type { ConversationItem, SessionModelTotals, SessionTotals } from "./types";

/**
 * The conversation's own cost and per-model tokens from its usage carriers.
 * Undefined when no carrier is priced, or when every priced carrier says
 * zero — OpenCode reports `0` for a model it has no price for, and a "$0.00"
 * readout on a free model reads as broken rather than free. A carrier with
 * no price contributes nothing: absent is not zero. `since` is left out —
 * the history carries every message's price, so the tally is whole.
 */
export function conversationTotals(items: readonly ConversationItem[]): SessionTotals | undefined {
  const byModel = new Map<string, SessionModelTotals>();
  let costUsd = 0;
  let priced = false;
  for (const item of items) {
    if (item.type !== "assistant_message" || item.usage?.costUsd === undefined) continue;
    priced = true;
    const usage = { ...item.usage, costUsd: item.usage.costUsd };
    const id = item.model?.modelId ?? "unknown";
    const row = byModel.get(id) ?? { id, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
    row.input += usage.input ?? 0;
    row.output += usage.output ?? 0;
    row.cacheRead += usage.cacheRead ?? 0;
    row.cacheWrite += usage.cacheWrite ?? 0;
    row.costUsd += usage.costUsd;
    costUsd += usage.costUsd;
    byModel.set(id, row);
  }
  if (!priced || costUsd <= 0) return undefined;
  return { costUsd, apiDurationMs: 0, durationMs: 0, linesAdded: 0, linesRemoved: 0, models: [...byModel.values()] };
}

/**
 * The totals the readout paints. An agent that reports plan utilization
 * tallies the session itself (Claude Code), and the totals ride the same
 * report as the plan so the two refresh together: the newest plan-speaking
 * report decides, and one without totals means the agent reported none —
 * an older report's figure is not resurrected. A report that speaks to
 * neither (a compaction's post-count) is skipped. Where no report speaks to
 * the plan at all, the carriers are folded (OpenCode).
 */
export function resolveSessionTotals(items: readonly ConversationItem[]): SessionTotals | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "context_report" && (item.plan !== undefined || item.session !== undefined)) return item.session;
  }
  return conversationTotals(items);
}
