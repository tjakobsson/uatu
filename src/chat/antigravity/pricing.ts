import type { TokenUsage } from "../types";
import { LEVELS } from "./catalog";
import { ANTIGRAVITY_PRICES } from "./prices";

/** USD per million tokens. A model without a cache-read rate prices cached reads as input. */
export type ModelRates = { input: number; output: number; cacheRead?: number };

export type AntigravityPriceTable = {
  // Where the rates came from and when they were read; `snapshot` is null
  // until the table has been generated from that source.
  source: string;
  snapshot: string | null;
  models: Record<string, ModelRates & { from: string }>;
  // Models with no price of their own, priced as the named family.
  families: Record<string, string>;
};

/**
 * The rates for an agy model (a family id; thinking levels share it),
 * directly or through its family. A legacy id that names one thinking level
 * of a family (`gemini-4-neon-low`, offered alone so the picker keeps it as
 * it is) is priced as that family when it has no price of its own.
 */
export function ratesFor(modelId: string, table: AntigravityPriceTable = ANTIGRAVITY_PRICES): ModelRates | undefined {
  const level = LEVELS.find(name => modelId.endsWith(`-${name}`));
  return ownRatesFor(modelId, table) ?? (level ? ownRatesFor(modelId.slice(0, -(level.length + 1)), table) : undefined);
}

/** The rates the table names for this exact id, or through its family: what makes an id a model of its own. */
export function ownRatesFor(modelId: string, table: AntigravityPriceTable = ANTIGRAVITY_PRICES): ModelRates | undefined {
  return table.models[modelId] ?? (table.families[modelId] ? table.models[table.families[modelId]!] : undefined);
}

/**
 * What a turn cost (design D11): input and output at their rates, with
 * thinking inside agy's output count (ACP's total is input + output + cache,
 * so thoughts are not added again), cached reads at the cache-read rate and
 * cache writes unpriced. Undefined when the model has no price: unpriced is
 * not free.
 */
export function priceTurn(usage: TokenUsage, modelId: string | undefined, table: AntigravityPriceTable = ANTIGRAVITY_PRICES): number | undefined {
  const rates = modelId ? ratesFor(modelId, table) : undefined;
  if (!rates) return undefined;
  const cost = (usage.input ?? 0) * rates.input + (usage.output ?? 0) * rates.output + (usage.cacheRead ?? 0) * (rates.cacheRead ?? rates.input);
  return cost / 1_000_000;
}
