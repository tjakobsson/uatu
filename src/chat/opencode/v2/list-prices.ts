// What OpenCode usage costs at pay-per-token list prices, for the steps
// OpenCode itself reports as costing 0.
//
// Signed in with a ChatGPT plan, OpenCode 2.x clears the price of the models
// the plan covers (anomalyco/opencode v2.3.0,
// packages/core/src/plugin/provider/openai.ts and chatgpt.ts), so every step
// reports cost 0 and no OpenCode API exposes the list price it cleared. Uatu
// prices those steps itself from the catalog OpenCode reads, with OpenCode's
// arithmetic, so a subscription conversation shows a cost the way Claude Code's
// estimate does on a Pro/Max plan. A reported nonzero cost is never touched; a
// model the catalog does not list under the exact provider stays unpriced.
//
// The catalog is fetched lazily, the first time a zero needs pricing, and
// never waited for: until it arrives, and whenever it cannot be had, usage
// keeps OpenCode's zero. It follows OpenCode's own catalog settings
// (`OPENCODE_MODELS_URL`, `OPENCODE_MODELS_PATH`,
// `OPENCODE_DISABLE_MODELS_FETCH`; packages/cli/src/server-process.ts).

import type { TokenUsage } from "../../types";
import { totalTokens } from "../../usage";

/** USD per million tokens, and the context size above which a tier applies. */
type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number; above?: number };

/** Each model's base rates and context tiers, keyed `<providerId>/<modelId>`. */
export type PriceTable = ReadonlyMap<string, readonly Rates[]>;

/** A fresh table and its ETag, or "unchanged" for a 304. Throws when the catalog cannot be had. */
export type CatalogLoad = (etag: string | undefined) => Promise<{ table: PriceTable; etag?: string } | "unchanged">;

export type ModelRef = { providerId: string; modelId: string };

// The catalog's own Cache-Control is an hour.
const TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_SOURCE = "https://models.opencode.ai";
// OpenCode's v2 catalog (packages/core/src/models-dev.ts `catalogPath`); chat models are the ones sessions run.
const CATALOG_PATH = "/experimental/v2.0/api.json?type=chat";

type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const price = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

// OpenCode keeps one cache-write price: the first TTL listed, else the explicit cache's (models-dev.ts `cacheWrite`).
function cacheWrite(cache: Json | undefined): number | undefined {
  const first = (write: unknown) => object(write) ? price(Object.values(write as Json)[0]) : price(write);
  return first(cache?.write) ?? first(object(cache?.explicit)?.write);
}

// A `when` that names only a context size is a tier; any other condition is left out (models-dev.ts `cost`).
function tierSize(when: unknown): number | undefined {
  const condition = object(when);
  if (!condition || Object.keys(condition).length !== 1) return undefined;
  const context = object(condition.context);
  return price(context?.gt) ?? price(context?.gte);
}

/** A model's rates, as OpenCode builds them from the catalog (models-dev.ts `cost`). */
function modelRates(cost: unknown): Rates[] | undefined {
  const text = object(object(cost)?.text);
  const input = object(text?.input), output = object(text?.output);
  const perToken = (side: Json) => side.unit === undefined || side.unit === "token";
  if (!input || !output || !perToken(input) || !perToken(output)) return undefined;
  const inputPrice = price(input.price), outputPrice = price(output.price);
  if (inputPrice === undefined || outputPrice === undefined) return undefined;
  const cache = object(input.cache);
  const base: Rates = { input: inputPrice, output: outputPrice, cacheRead: price(cache?.read) ?? 0, cacheWrite: cacheWrite(cache) ?? 0 };
  // An override merges field by field, so a tier keeps every base price it does not set.
  const tiers = new Map<number, Rates>();
  const tier = (when: unknown) => {
    const size = tierSize(when);
    return size === undefined ? undefined : tiers.get(size) ?? { ...base, above: size };
  };
  for (const value of Array.isArray(input.overrides) ? input.overrides : []) {
    const override = object(value), entry = tier(override?.when);
    if (!override || !entry) continue;
    const overrideCache = object(override.cache);
    tiers.set(entry.above!, { ...entry, input: price(override.price) ?? entry.input, cacheRead: price(overrideCache?.read) ?? entry.cacheRead, cacheWrite: cacheWrite(overrideCache) ?? entry.cacheWrite });
  }
  for (const value of Array.isArray(output.overrides) ? output.overrides : []) {
    const override = object(value), entry = tier(override?.when);
    if (override && entry) tiers.set(entry.above!, { ...entry, output: price(override.price) ?? entry.output });
  }
  return [base, ...tiers.values()];
}

/**
 * The base models a v2 catalog prices. Modes (`<model>-fast` and the like)
 * are left out: they are not the exact model a step names here, so they stay
 * unpriced.
 */
export function priceTable(catalog: unknown): PriceTable {
  const table = new Map<string, Rates[]>();
  for (const value of Object.values(object(catalog) ?? {})) {
    const provider = object(value);
    if (typeof provider?.id !== "string") continue;
    for (const entry of Object.values(object(provider.models) ?? {})) {
      const model = object(entry);
      const rates = typeof model?.id === "string" ? modelRates(model.cost) : undefined;
      if (rates) table.set(`${provider.id}/${model!.id}`, rates);
    }
  }
  return table;
}

/**
 * One step's cost, as OpenCode computes it (packages/core/src/session/usage.ts
 * `calculateCost`): the step's context — input plus cache read and write —
 * picks the largest tier it exceeds, and reasoning is priced as output.
 */
export function stepCost(rates: readonly Rates[], usage: TokenUsage): number {
  const input = usage.input ?? 0, cacheRead = usage.cacheRead ?? 0, cacheWrite = usage.cacheWrite ?? 0;
  const context = input + cacheRead + cacheWrite;
  const tier = rates.filter(rate => rate.above !== undefined && context > rate.above).sort((a, b) => b.above! - a.above!)[0];
  const rate = tier ?? rates.find(candidate => candidate.above === undefined);
  if (!rate) return 0;
  return (input * rate.input + ((usage.output ?? 0) + (usage.reasoning ?? 0)) * rate.output + cacheRead * rate.cacheRead + cacheWrite * rate.cacheWrite) / 1_000_000;
}

/** The list prices one process holds: loaded lazily, refreshed after the TTL, never waited for. */
export class ListPrices {
  private table: PriceTable | undefined;
  private etag: string | undefined;
  private attemptedAt = Number.NEGATIVE_INFINITY;
  private loading: Promise<void> | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly load: CatalogLoad | undefined, options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Starts a load when there is none yet or it is older than the TTL. A failure waits out the TTL too. */
  warm(): void {
    if (!this.load || this.loading || this.now() - this.attemptedAt < this.ttlMs) return;
    this.attemptedAt = this.now();
    this.loading = this.load(this.etag).then(result => {
      if (result === "unchanged") return;
      this.table = result.table;
      this.etag = result.etag;
    }, () => undefined).finally(() => { this.loading = undefined; });
  }

  /** Settles when the load in flight has. */
  settled(): Promise<void> {
    return this.loading ?? Promise.resolve();
  }

  /** `usage` with OpenCode's zero replaced by its list price, where the exact model has one; otherwise `usage` itself. */
  price(usage: TokenUsage, model: ModelRef | undefined): TokenUsage {
    if (usage.costUsd !== 0 || !model || totalTokens(usage) === 0) return usage;
    this.warm();
    const rates = this.table?.get(`${model.providerId}/${model.modelId}`);
    const costUsd = rates ? stepCost(rates, usage) : 0;
    return costUsd > 0 ? { ...usage, costUsd } : usage;
  }
}

/** Loads the catalog the way OpenCode's settings say to; undefined when they disable it. */
export function catalogLoader(env: NodeJS.ProcessEnv = process.env, fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch): CatalogLoad | undefined {
  const file = env.OPENCODE_MODELS_PATH;
  if (file) return async () => ({ table: priceTable(await Bun.file(file).json()) });
  const disabled = env.OPENCODE_DISABLE_MODELS_FETCH;
  if (disabled === "1" || disabled?.toLowerCase() === "true") return undefined;
  const url = `${env.OPENCODE_MODELS_URL || DEFAULT_SOURCE}${CATALOG_PATH}`;
  return async etag => {
    const response = await fetchImpl(url, { headers: etag ? { "If-None-Match": etag } : {}, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (etag && response.status === 304) return "unchanged";
    if (!response.ok) throw new Error(`OpenCode's model catalog answered ${response.status}`);
    const table = priceTable(await response.json());
    const tag = response.headers.get("etag");
    return { table, ...(tag ? { etag: tag } : {}) };
  };
}

let shared: ListPrices | undefined;

/** The process's list prices, from OpenCode's catalog settings in its environment. */
export function sharedListPrices(): ListPrices {
  return shared ??= new ListPrices(catalogLoader());
}
