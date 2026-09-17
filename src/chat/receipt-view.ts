// The conversation's cost receipt as DOM rows, and the wording that goes with
// it. Pure builders over the folded receipt (conversation-totals.ts), so the
// readout's three itemizations, the opened transcript's title and the
// composer list's summary are each said in one place and can be tested
// without standing the whole chat surface up.

import { subagentSpend, type ConversationModelTotals, type ConversationTotals, type ReceiptAmount } from "./conversation-totals";
import { subagentLabel, type SubagentEntry } from "./timeline-renderer";
import type { ConversationItem } from "./types";
import { formatTokens, formatUsd } from "./usage";

/** How the receipt is itemized. The same total, three ways. */
export type ReceiptView = "agents" | "types" | "models";
export const RECEIPT_VIEWS: readonly ReceiptView[] = ["agents", "types", "models"];
// Indentation is a fixed set of steps in the stylesheet; anything deeper
// shares the last one rather than marching off the side of a narrow callout.
const MAX_INDENT = 4;

export function parseReceiptView(value: unknown): ReceiptView | undefined {
  return RECEIPT_VIEWS.find(view => view === value);
}

/** The first column's heading for an itemization. */
export function receiptHeading(view: ReceiptView): string {
  return view === "agents" ? "Agent" : view === "types" ? "Type" : "Model";
}

type ModelName = (id: string) => string;
// `dash` is whether the cost cell says "no price reported" instead of a figure.
type Row = { label: string; title?: string; count?: number; note: string; amount: ReceiptAmount; dash: boolean; depth?: number; kind?: string };

/**
 * The receipt's rows for one itemization. Totals that carry no receipt — an
 * agent that tallies the session itself reports per model only — have just
 * the one itemization, whatever is asked for.
 */
export function buildReceiptRows(document: Document, totals: ConversationTotals, view: ReceiptView, modelName: ModelName): HTMLTableRowElement[] {
  return receiptRows(totals, view, modelName).map(row => {
    const element = document.createElement("tr");
    element.className = "chat-receipt-row";
    if (row.kind) element.dataset.kind = row.kind;
    if (row.depth) element.dataset.depth = String(Math.min(row.depth, MAX_INDENT));
    const name = document.createElement("td");
    name.title = row.title ?? row.label;
    if (row.count !== undefined) {
      const count = document.createElement("span");
      count.className = "chat-receipt-count";
      count.textContent = `${row.count} × `;
      name.append(count);
    }
    name.append(row.label);
    if (row.note) {
      const note = document.createElement("span");
      note.className = "chat-plan-session-agent-model";
      note.textContent = row.note;
      name.append(note);
    }
    element.append(name, ...amountCells(document, row.amount, row.dash));
    return element;
  });
}

/** The line that closes the receipt: what the items above it sum to. */
export function buildReceiptTotal(document: Document, total: ReceiptAmount): HTMLTableRowElement {
  const element = document.createElement("tr");
  element.className = "chat-receipt-total";
  const name = document.createElement("th");
  name.scope = "row";
  name.textContent = "Total";
  element.append(name, ...amountCells(document, total, false));
  return element;
}

function amountCells(document: Document, amount: ReceiptAmount, dash: boolean): HTMLTableCellElement[] {
  const priced = !dash;
  return [
    [formatTokens(amount.input + amount.cacheRead + amount.cacheWrite), `${amount.input.toLocaleString()} input · ${amount.cacheRead.toLocaleString()} cache read · ${amount.cacheWrite.toLocaleString()} cache write`],
    [formatTokens(amount.output), `${amount.output.toLocaleString()} output`],
    [priced ? formatUsd(amount.costUsd ?? 0) : "—", priced ? "" : "No price reported"],
  ].map(([text, title]) => {
    const cell = document.createElement("td");
    cell.textContent = text!;
    if (title) cell.title = title;
    return cell;
  });
}

function receiptRows(totals: ConversationTotals, view: ReceiptView, modelName: ModelName): Row[] {
  // For an agent or a type, absent or zero is "no price reported" — OpenCode's
  // zero is a model it has no price for — and reads as a dash, never as free.
  const receipt = totals.receipt;
  const models = (ids: readonly string[]) => ids.map(modelName).join(", ");
  const said = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(" · ");
  const role = (kind: string) => kind === "main" ? "main agent" : kind === "summary" ? "summarised the conversation" : undefined;
  if (receipt && view === "agents") {
    const described = new Map(receipt.lines.map(line => [line.id, line.description]));
    return receipt.lines.map(line => ({
      label: line.label,
      note: said(models(line.models), role(line.kind), line.sameAgentAs === undefined ? undefined : `same agent as “${described.get(line.sameAgentAs) ?? "an earlier task"}”`),
      amount: line, dash: !line.costUsd, depth: line.depth, kind: line.kind,
    }));
  }
  if (receipt && view === "types") {
    return receipt.types.map(line => ({
      label: line.label,
      ...(line.agents === undefined ? {} : { count: line.agents }),
      // Tasks are only worth stating where they are not one per agent.
      note: said(models(line.models), role(line.kind), line.agents !== undefined && (line.tasks ?? 0) > line.agents ? `${line.tasks} tasks` : undefined),
      amount: line, dash: !line.costUsd, kind: line.kind,
    }));
  }
  // The agent's own totals are plain session rows; the folded ones also say
  // who ran each model and whether anything priced contributed.
  return (totals.models as readonly ConversationModelTotals[]).map(model => ({
    label: modelName(model.id), title: model.id,
    note: model.agents?.join(" · ") ?? "",
    amount: model,
    // A row whose every contribution came unpriced says so rather than
    // asserting the model was free; any other row states what was reported.
    dash: model.unpriced === true,
  }));
}

/**
 * What an opened subagent transcript is titled: the subagent, and what it
 * ITSELF spent across every task it was given — not one task's figure, and
 * not the subagents it launched, which have transcripts and lines of their own.
 */
export function subagentTranscriptTitle(entries: readonly SubagentEntry[], items: readonly ConversationItem[], conversationId: string): string {
  const entry = entries.find(candidate => candidate.conversationId === conversationId);
  if (!entry) return "Subagent";
  const spent = subagentSpend(items, conversationId)?.costUsd;
  return spent ? `${subagentLabel(entry)} · ${formatUsd(spent)}` : subagentLabel(entry);
}

/**
 * The composer list's one-line summary. The list has a row per task, but a
 * subagent given three tasks is one subagent: where the two counts differ
 * both are stated, and where every task has its own subagent it reads as it
 * always has.
 */
export function subagentTrackSummary(entries: readonly SubagentEntry[]): string {
  const working = entries.filter(entry => entry.status === "running" || entry.status === "pending");
  const agents = new Set(entries.map(entry => entry.conversationId ?? entry.id)).size;
  const noun = agents === 1 ? "subagent" : "subagents";
  if (agents === entries.length) {
    return working.length > 0 ? `${working.length} of ${entries.length} ${noun} working · ${working[0]!.description}` : `${entries.length} ${noun} finished`;
  }
  return working.length > 0
    ? `${agents} ${noun} · ${working.length} of ${entries.length} tasks working · ${working[0]!.description}`
    : `${agents} ${noun} · ${entries.length} tasks finished`;
}
