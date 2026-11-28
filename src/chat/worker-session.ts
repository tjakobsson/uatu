import type { TokenUsage, WorkerSessionReport } from "./types";
import { hasPrice } from "./usage";

export type WorkerMessageModel = { model: string; createdAt: number; effort?: string };

/** Only a provider's authoritative session aggregate can price a session.
 * Message sums can omit compaction, reverted history and truncated pages.
 * The steps OpenCode reported as costing 0 and Uatu priced at list prices
 * (`listPriced`, from `opencode/v2/list-prices.ts`) are not in that aggregate,
 * so they are added to it: OpenCode's figure stands, and the session costs
 * what the receipt counts for it. `steps` is the session's per-message usage.
 */
export function workerSessionReport(costUsd: number | null | undefined, models: ReadonlyMap<string, WorkerMessageModel> | undefined, steps?: ReadonlyMap<string, TokenUsage>): WorkerSessionReport {
  let latest: { id: string; value: WorkerMessageModel } | undefined;
  for (const [id, value] of models ?? []) {
    if (!latest || value.createdAt > latest.value.createdAt || value.createdAt === latest.value.createdAt && id > latest.id) latest = { id, value };
  }
  return { ...(latest ? { model: latest.value.model } : {}), effort: latest?.value.effort ?? null, costUsd: sessionCost(costUsd, steps) };
}

function sessionCost(costUsd: number | null | undefined, steps: ReadonlyMap<string, TokenUsage> | undefined): number | null {
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) return null;
  let listed = 0;
  for (const usage of steps?.values() ?? []) if (usage.listPriced) listed += usage.costUsd ?? 0;
  return costUsd + listed;
}

/** A dash for an unreported or unpriced session; the label says which. */
export function formatWorkerCost(costUsd: number | null | undefined): string {
  if (!hasPrice(costUsd)) return "—";
  if (costUsd < 0.0001) return "<$0.0001";
  return `$${costUsd.toFixed(costUsd < 0.01 ? 4 : 2)}`;
}
