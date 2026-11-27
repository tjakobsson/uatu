import type { TokenUsage, WorkerSessionReport } from "./types";
import { hasPrice } from "./usage";

export type WorkerMessageModel = { model: string; createdAt: number; effort?: string };

/** Only a provider's authoritative session aggregate can price a session.
 * Message sums can omit compaction, reverted history and truncated pages.
 * One exception: an OpenCode total of zero means OpenCode priced none of the
 * session's steps, and where Uatu priced them at list prices
 * (`opencode/v2/list-prices.ts`) the session costs their sum, as OpenCode's
 * own total sums its steps. `steps` is the session's per-message usage.
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
  if (costUsd > 0) return costUsd;
  let listed = 0;
  for (const usage of steps?.values() ?? []) listed += usage.costUsd ?? 0;
  return listed;
}

/** A dash for an unreported or unpriced session; the label says which. */
export function formatWorkerCost(costUsd: number | null | undefined): string {
  if (!hasPrice(costUsd)) return "—";
  if (costUsd < 0.0001) return "<$0.0001";
  return `$${costUsd.toFixed(costUsd < 0.01 ? 4 : 2)}`;
}
