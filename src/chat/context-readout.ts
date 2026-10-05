// Which figure the context readout paints, chosen once for the meter and its
// breakdown. Two sources can speak: the agent's own context report (the
// authoritative breakdown, emitted after a turn or a compaction) and the
// per-message usage carriers (one API call's occupancy each, and the only
// source a reopened conversation has). Whichever is newest in the timeline
// wins — a carrier that landed after a report belongs to a later call, and a
// report that landed after the carriers is the settled truth for the turn.

import { contextTokens } from "./usage";
import type { ChatModel, ContextWindowMetadata, ConversationItem, ModelSelection, TokenUsage } from "./types";

export type ContextReadout = {
  // The item the readout was derived from; identity is what a painter
  // compares to skip repainting identical figures.
  source: ConversationItem;
  used: number;
  // The window measured against: the report's own, else the window the
  // session last stated for the model, else the catalog's figure. Absent
  // when none is known — or when the catalog's figure is smaller than the
  // observed occupancy, which proves it wrong for this session.
  limit?: number;
  // 0..1 when a limit is known.
  fraction?: number;
  model?: ModelSelection;
  window?: ContextWindowMetadata;
  rows: Array<[string, number]>;
};

function sameModel(left: ModelSelection, right: ModelSelection): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

export function contextReadout(items: readonly ConversationItem[], models: readonly ChatModel[], displayedModel: ModelSelection | undefined): ContextReadout | undefined {
  let zeroUsage: Extract<ConversationItem, { type: "assistant_message" }> | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.type === "context_report") return fromReport(item, items, models, displayedModel);
    if (item.type !== "assistant_message" || !item.usage) continue;
    // OpenCode starts a new assistant message with an all-zero report before
    // its real input/cache accounting arrives. Do not flash the meter to 0
    // between turns when an earlier meaningful occupancy is still known.
    if (!zeroUsage) zeroUsage = item;
    if (contextTokens(item.usage) > 0) return fromCarrier(item, item.usage, items, models, displayedModel);
  }
  return zeroUsage?.usage ? fromCarrier(zeroUsage, zeroUsage.usage, items, models, displayedModel) : undefined;
}

type Window = { limit: number; stated: boolean; metadata?: ContextWindowMetadata; observedAt?: number };
const sourceRank = (source: ContextWindowMetadata["source"] | undefined) => source === "estimate" ? 0 : source === "catalog" ? 1 : 2;

/**
 * The window for a model: the window the session itself last reported for
 * it, else the catalog's figure. The session's word wins because the
 * catalog's is a guess — a static manifest, or an id heuristic over a
 * catalog that carries no window field — and a login can run a model with
 * a larger window than the guess (Opus 5 served with 1M on a plain id,
 * issue #347). Newest-wins applies to the occupancy; the reported window is
 * a fact that outlives the report.
 */
function windowFor(models: readonly ChatModel[], model: ModelSelection | undefined, items: readonly ConversationItem[], contextKey?: string): Window | undefined {
  if (!model && !contextKey) return undefined;
  let latest: Window | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.type !== "context_report" && item.type !== "context_window") continue;
    if (contextKey ? item.contextKey !== contextKey : !item.model || !model || !sameModel(item.model, model)) continue;
    const limit = item.type === "context_report" ? item.max : item.limit;
    if (limit === undefined) continue;
    const metadata = item.window;
    const observedAt = metadata?.observedAt ?? item.createdAt;
    if (!latest || sourceRank(metadata?.source) > sourceRank(latest.metadata?.source) || (sourceRank(metadata?.source) === sourceRank(latest.metadata?.source) && observedAt > latest.observedAt!)) latest = { limit, stated: metadata?.source !== "estimate", metadata, observedAt };
  }
  const catalog = model ? models.find(candidate => sameModel(candidate.selection, model)) : undefined;
  const catalogWindow = catalog?.contextLimit === undefined ? undefined : { limit: catalog.contextLimit, stated: catalog.contextWindow !== undefined && catalog.contextWindow.source !== "estimate", metadata: catalog.contextWindow };
  if (latest?.metadata?.source === "estimate" && catalogWindow?.stated) return catalogWindow;
  return latest ?? catalogWindow;
}

/**
 * The fill against a window. A catalog guess the occupancy exceeds is not
 * a window — an API call cannot occupy more than the window allows — so it
 * is dropped rather than painted as a full, red 100%; the session's own
 * statement of an over-full window (a compaction boundary it has run past)
 * is kept and reads as full.
 */
function measured(used: number, window: Window | undefined): { limit?: number; fraction?: number; window?: ContextWindowMetadata } {
  if (!window || (!window.stated && used > window.limit)) return {};
  return { limit: window.limit, fraction: Math.min(1, used / window.limit), ...(window.metadata ? { window: window.metadata } : {}) };
}

function limitRows(rows: Array<[string, number]>, limit: number | undefined, window?: ContextWindowMetadata): void {
  if (limit === undefined) return;
  const label = window?.source === "estimate" ? "Estimated limit" : window?.freshness === "cached" ? "Cached limit" : window?.kind === "compaction" ? "Compaction window" : "Limit";
  rows.push([label, limit]);
  if (window?.capacity !== undefined) rows.push(["Model capacity", window.capacity]);
  if (window?.compactionThreshold !== undefined) rows.push(["Auto-compaction threshold", window.compactionThreshold]);
}

function fromCarrier(source: ConversationItem, usage: TokenUsage, items: readonly ConversationItem[], models: readonly ChatModel[], displayedModel: ModelSelection | undefined): ContextReadout {
  const model = source.type === "assistant_message" && source.model ? source.model : displayedModel;
  const used = contextTokens(usage);
  const { limit, fraction, window } = measured(used, windowFor(models, model, items, source.type === "assistant_message" ? source.contextKey : undefined));
  const rows: Array<[string, number]> = [["In context", used]];
  limitRows(rows, limit, window);
  if (usage.input !== undefined) rows.push(["Input", usage.input]);
  if (usage.cacheRead !== undefined) rows.push(["Cache read", usage.cacheRead]);
  if (usage.cacheWrite !== undefined) rows.push(["Cache write", usage.cacheWrite]);
  if (usage.reasoning !== undefined) rows.push(["Reasoning", usage.reasoning]);
  if (usage.output !== undefined) rows.push(["Output", usage.output]);
  return { source, used, ...(limit === undefined ? {} : { limit, fraction: fraction!, ...(window ? { window } : {}) }), ...(model ? { model } : {}), rows };
}

function fromReport(source: Extract<ConversationItem, { type: "context_report" }>, items: readonly ConversationItem[], models: readonly ChatModel[], displayedModel: ModelSelection | undefined): ContextReadout {
  const model = source.model ?? displayedModel;
  // A compaction report states the total only; the window comes from the
  // last report that stated one for this model, else the catalog.
  const known = windowFor(models, model, items, source.contextKey);
  const own = source.max !== undefined ? { limit: source.max, stated: source.window?.source !== "estimate", metadata: source.window } : undefined;
  const { limit, fraction, window } = measured(source.total, known?.observedAt !== undefined ? known : own ?? known);
  const rows: Array<[string, number]> = [["In context", source.total]];
  limitRows(rows, limit, window);
  // The agent's own categories, used rows only: they are what occupies the
  // window and they sum to the total. Free space and deferred schemas are
  // not occupancy and would make the list disagree with the fill.
  for (const category of source.categories ?? []) {
    if (category.kind === "used" && category.tokens > 0) rows.push([category.name, category.tokens]);
  }
  return { source, used: source.total, ...(limit === undefined ? {} : { limit, fraction: fraction!, ...(window ? { window } : {}) }), ...(model ? { model } : {}), rows };
}
