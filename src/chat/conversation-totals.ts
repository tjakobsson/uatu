// What a conversation has cost, folded on the client from the items it
// holds — the per-message usage carriers (the main agent's own spend, the
// same source the context meter reads) and the subagent tool rows (each
// child session's aggregate, mirrored onto the row that launched it).
// OpenCode prices each assistant message and restates the figure while the
// message streams; the adapter keeps one carrier per message (`usage:<id>`)
// and replaces it on every restatement, so summing the carriers counts each
// message once, at its latest figure, and a reopened conversation restores
// its cost from history with no server-side ledger. Claude Code reports
// session totals itself, on a context report; that report wins where it
// exists.

import { describeToolDetail } from "./tool-detail";
import { subagentLabel } from "./timeline-renderer";
import type { ConversationItem, SessionModelTotals, SessionTotals } from "./types";

/** One agent's share: the main agent, or a subagent by its launching row. */
export type AgentTotals = {
  // The main agent's row is keyed "main"; a subagent's by its tool item id,
  // which is what the timeline row and the drill-down are keyed by too.
  id: string;
  label: string;
  main: boolean;
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  // Absent when the agent reported no price: listed, not asserted as free.
  costUsd?: number;
};

/**
 * The wire's session totals with a per-agent breakdown beside the per-model
 * one. Client-only: the breakdown is derived from items the client holds,
 * never sent, so the closed `context_report.session` schema is untouched.
 */
export type ConversationTotals = SessionTotals & { models: ConversationModelTotals[]; agents?: AgentTotals[] };

/** A model row whose every contribution came unpriced: listed, not asserted as free. */
export type ConversationModelTotals = SessionModelTotals & { unpriced?: true };

const emptyModel = (id: string): ConversationModelTotals => ({ id, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpriced: true });

/**
 * The conversation's cost and per-model tokens, with the per-agent split.
 * The main agent's row is its carriers; each subagent's is the aggregate on
 * its tool row, and both count toward the total and the model rows — the
 * figure presented is what the whole conversation cost. Undefined when
 * nothing is priced, or when every priced figure is zero — OpenCode reports
 * `0` for a model it has no price for, and a "$0.00" readout on a free model
 * reads as broken rather than free. A carrier or row with no price
 * contributes nothing: absent is not zero. `since` is left out — the history
 * carries every message's price, so the tally is whole.
 */
export function conversationTotals(items: readonly ConversationItem[]): ConversationTotals | undefined {
  const byModel = new Map<string, ConversationModelTotals>();
  const main: AgentTotals = { id: "main", label: "This agent", main: true, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const agents: AgentTotals[] = [main];
  let priced = false;
  const add = (agent: AgentTotals, modelId: string | undefined, usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; costUsd?: number }) => {
    agent.input += usage.input ?? 0;
    agent.output += usage.output ?? 0;
    agent.cacheRead += usage.cacheRead ?? 0;
    agent.cacheWrite += usage.cacheWrite ?? 0;
    if (usage.costUsd !== undefined) {
      priced = true;
      agent.costUsd = (agent.costUsd ?? 0) + usage.costUsd;
    }
    const id = modelId ?? "unknown";
    const row = byModel.get(id) ?? emptyModel(id);
    row.input += usage.input ?? 0;
    row.output += usage.output ?? 0;
    row.cacheRead += usage.cacheRead ?? 0;
    row.cacheWrite += usage.cacheWrite ?? 0;
    if (usage.costUsd !== undefined) {
      row.costUsd += usage.costUsd;
      // Zero is OpenCode's "no price for this model", not free: the row
      // stays unpriced until something positive is reported for it.
      if (usage.costUsd > 0) delete row.unpriced;
    }
    byModel.set(id, row);
  };
  for (const item of items) {
    if (item.type === "assistant_message") {
      // Unpriced carriers (an agent that prices nothing) are not the main
      // agent's spend to list; the context meter reads them separately.
      if (item.usage?.costUsd === undefined) continue;
      add(main, item.model?.modelId, item.usage);
    } else if (item.type === "tool" && item.usage) {
      const detail = describeToolDetail(item);
      if (detail.kind !== "agent") continue;
      const agent: AgentTotals = { id: item.id, label: subagentLabel({ id: item.id, description: detail.description, ...(detail.subagent === undefined ? {} : { subagent: detail.subagent }), status: item.status }), main: false, ...(item.model === undefined ? {} : { model: item.model }), input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      add(agent, item.model, item.usage);
      agents.push(agent);
    }
  }
  const costUsd = agents.reduce((sum, agent) => sum + (agent.costUsd ?? 0), 0);
  if (!priced || costUsd <= 0) return undefined;
  return { costUsd, apiDurationMs: 0, durationMs: 0, linesAdded: 0, linesRemoved: 0, models: [...byModel.values()], agents };
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
export function resolveSessionTotals(items: readonly ConversationItem[]): ConversationTotals | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "context_report" && (item.plan !== undefined || item.session !== undefined)) return item.session;
  }
  return conversationTotals(items);
}
