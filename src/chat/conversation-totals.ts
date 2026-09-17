// What a conversation has cost, folded on the client from the items it
// holds, as a receipt: line items that sum to a total. The main agent's lines
// come from the per-message usage carriers (its own spend, the same source the
// context meter reads); a subagent's from the row that launched it, which
// states that TASK's own spend, and from the lines beneath that row — the
// subagents a subagent launched, which the client could not otherwise see.
// OpenCode prices each assistant message and restates the figure while the
// message streams; the adapter keeps one carrier per message (`usage:<id>`)
// and replaces it on every restatement, and splits a subagent's messages over
// the rows that gave it tasks, so every message is counted once and a reopened
// conversation restores its cost from history with no server-side ledger.
// Claude Code reports session totals itself, on a context report; that report
// wins where it exists, and carries no per-agent lines.

import { describeToolDetail } from "./tool-detail";
import { subagentLabel } from "./timeline-renderer";
import type { ConversationItem, SessionModelTotals, SessionTotals, TokenUsage } from "./types";

/** Tokens and money, summed. `costUsd` is absent when nothing priced contributed: listed, not asserted as free. */
export type ReceiptAmount = { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd?: number };

/** One line of the receipt itemized by agent. */
export type ReceiptLine = ReceiptAmount & {
  // A main agent's line is keyed by its name; a task's by the row (or nested
  // line) that launched it — what the timeline row and the drill-down use.
  id: string;
  // `main` is an agent the conversation ran under; `summary` the agent that
  // summarised it on the conversation's behalf; `task` one task given to a
  // subagent.
  kind: "main" | "summary" | "task";
  // The line that launched this one, for a subagent launched by a subagent.
  parentId?: string;
  depth: number;
  // The main agent's name, or the subagent's kind. Absent where the agent named none.
  agent?: string;
  description: string;
  label: string;
  // Every model that contributed, in the order first seen.
  models: string[];
  conversationId?: string;
  // The earlier line for the same subagent: this task was given to an agent
  // that already had one, and is not a new agent.
  sameAgentAs?: string;
};

/** One line of the receipt itemized by agent type. */
export type ReceiptTypeLine = ReceiptAmount & {
  id: string;
  label: string;
  kind: ReceiptLine["kind"];
  // Distinct subagents of this kind, at any depth, and the tasks they were
  // given. Absent on a main agent's line, which is one agent by definition.
  agents?: number;
  tasks?: number;
  models: string[];
};

/** A model row whose every contribution came unpriced: listed, not asserted as free. */
export type ConversationModelTotals = SessionModelTotals & { unpriced?: true; agents?: string[] };

export type Receipt = { lines: ReceiptLine[]; types: ReceiptTypeLine[]; models: ConversationModelTotals[]; total: ReceiptAmount };

/**
 * The wire's session totals with the receipt beside them. Client-only: the
 * receipt is derived from items the client holds, never sent, so the closed
 * `context_report.session` schema is untouched. Absent where the agent
 * tallies the session itself and reports no per-agent figures.
 */
export type ConversationTotals = SessionTotals & { models: ConversationModelTotals[]; receipt?: Receipt };

type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; costUsd?: number };

const SUMMARY_AGENT = "compaction";
const amount = (): ReceiptAmount => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function add(into: ReceiptAmount, usage: Usage | undefined): void {
  if (!usage) return;
  into.input += usage.input ?? 0;
  into.output += usage.output ?? 0;
  into.cacheRead += usage.cacheRead ?? 0;
  into.cacheWrite += usage.cacheWrite ?? 0;
  if (usage.costUsd !== undefined) into.costUsd = (into.costUsd ?? 0) + usage.costUsd;
}

function note<T>(list: T[], value: T | undefined): void {
  if (value !== undefined && !list.includes(value)) list.push(value);
}

/**
 * The conversation's receipt. Undefined when nothing is priced, or when every
 * priced figure is zero — OpenCode reports `0` for a model it has no price
 * for, and a "$0.00" readout on a free model reads as broken rather than
 * free. A carrier or row with no price contributes no money: absent is not
 * zero. `since` is left out — the history carries every message's price, so
 * the tally is whole.
 */
export function conversationTotals(items: readonly ConversationItem[]): ConversationTotals | undefined {
  const mains = new Map<string, ReceiptLine>();
  const tasks: ReceiptLine[] = [];
  const byModel = new Map<string, ConversationModelTotals & { mains: string[]; kinds: Map<string, Set<string>> }>();
  const firstLineOf = new Map<string, string>();
  let priced = false;

  const count = (line: ReceiptLine, modelId: string | undefined, usage: Usage | undefined) => {
    add(line, usage);
    note(line.models, modelId);
    if (usage?.costUsd !== undefined) priced = true;
    const id = modelId ?? "unknown";
    const row = byModel.get(id) ?? { id, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpriced: true as const, mains: [], kinds: new Map() };
    const before = row.costUsd;
    add(row as ReceiptAmount, usage);
    row.costUsd = usage?.costUsd === undefined ? before : before + usage.costUsd;
    // Zero is OpenCode's "no price for this model", not free: the row stays
    // unpriced until something positive is reported for it.
    if ((usage?.costUsd ?? 0) > 0) delete row.unpriced;
    if (line.kind === "task") {
      const kind = line.agent ?? "subagent";
      row.kinds.set(kind, (row.kinds.get(kind) ?? new Set()).add(line.conversationId ?? line.id));
    } else note(row.mains, line.label);
    byModel.set(id, row);
  };

  const task = (id: string, parentId: string | undefined, depth: number, description: string, agent: string | undefined, conversationId: string | undefined, model: string | undefined, usage: Usage | undefined) => {
    const line: ReceiptLine = {
      ...amount(), id, kind: "task", depth, description,
      ...(parentId === undefined ? {} : { parentId }),
      ...(agent === undefined ? {} : { agent }),
      label: subagentLabel({ id, description, ...(agent === undefined ? {} : { subagent: agent }), status: "completed" }),
      models: [],
      ...(conversationId === undefined ? {} : { conversationId }),
    };
    if (conversationId !== undefined) {
      const first = firstLineOf.get(conversationId);
      if (first === undefined) firstLineOf.set(conversationId, id);
      else line.sameAgentAs = first;
    }
    count(line, model, usage);
    tasks.push(line);
  };

  for (const item of items) {
    if (item.type === "assistant_message") {
      // Unpriced carriers (an agent that prices nothing) are not the main
      // agent's spend to list; the context meter reads them separately.
      if (item.usage?.costUsd === undefined) continue;
      const key = item.agent ?? "";
      const label = item.agent ?? "This agent";
      const line = mains.get(key) ?? { ...amount(), id: `main:${key}`, kind: item.agent === SUMMARY_AGENT ? "summary" as const : "main" as const, depth: 0, ...(item.agent === undefined ? {} : { agent: item.agent }), description: label, label, models: [] };
      mains.set(key, line);
      count(line, item.model?.modelId, item.usage);
    } else if (item.type === "tool") {
      const detail = describeToolDetail(item);
      if (detail.kind !== "agent") continue;
      const beneath = item.descendants ?? [];
      if (item.usage === undefined && beneath.length === 0) continue;
      task(item.id, undefined, 0, detail.description, detail.subagent, item.childConversationId, item.model, item.usage);
      // Depth-first, so every line follows what launched it.
      const launched = (parentId: string, depth: number) => {
        for (const line of beneath) {
          if (line.parentId !== parentId) continue;
          task(line.id, parentId, depth, line.description, line.subagent, line.conversationId, line.model, line.usage);
          launched(line.id, depth + 1);
        }
      };
      launched(item.id, 1);
    }
  }

  const lines = [...mains.values(), ...tasks];
  const total = amount();
  for (const line of lines) add(total, line);
  if (!priced || (total.costUsd ?? 0) <= 0) return undefined;

  // By type: the main agents as they are, then one line per kind of subagent.
  const types: ReceiptTypeLine[] = [...mains.values()].map(line => ({ ...amountOf(line), id: line.id, label: line.label, kind: line.kind, models: [...line.models] }));
  const kinds = new Map<string, ReceiptTypeLine & { seen: Set<string> }>();
  for (const line of tasks) {
    const kind = line.agent ?? "subagent";
    const group = kinds.get(kind) ?? { ...amount(), id: `type:${kind}`, label: kind, kind: "task" as const, agents: 0, tasks: 0, models: [], seen: new Set<string>() };
    add(group, line);
    group.seen.add(line.conversationId ?? line.id);
    group.agents = group.seen.size;
    group.tasks = (group.tasks ?? 0) + 1;
    for (const model of line.models) note(group.models, model);
    kinds.set(kind, group);
  }
  for (const { seen: _seen, ...group } of kinds.values()) types.push(group);

  const models = [...byModel.values()].map(({ mains: mainNames, kinds: modelKinds, ...row }) => ({
    ...row,
    agents: [...mainNames, ...[...modelKinds].map(([kind, agents]) => agents.size === 1 ? kind : `${agents.size} × ${kind}`)],
  }));

  return { costUsd: total.costUsd ?? 0, apiDurationMs: 0, durationMs: 0, linesAdded: 0, linesRemoved: 0, models, receipt: { lines, types, models, total } };
}

function amountOf(line: ReceiptAmount): ReceiptAmount {
  return { input: line.input, output: line.output, cacheRead: line.cacheRead, cacheWrite: line.cacheWrite, ...(line.costUsd === undefined ? {} : { costUsd: line.costUsd }) };
}

/**
 * What one subagent itself spent across every task it was given, in the
 * conversation that holds `items` — its rows, or the lines beneath a row.
 * The subagents it launched are not part of it. Undefined when it reported
 * nothing.
 */
export function subagentSpend(items: readonly ConversationItem[], conversationId: string): TokenUsage | undefined {
  const total = amount();
  let reported = false;
  const take = (usage: TokenUsage | undefined) => {
    if (!usage) return;
    reported = true;
    add(total, usage);
  };
  for (const item of items) {
    if (item.type !== "tool") continue;
    if (item.childConversationId === conversationId) take(item.usage);
    for (const line of item.descendants ?? []) if (line.conversationId === conversationId) take(line.usage);
  }
  return reported ? total : undefined;
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
