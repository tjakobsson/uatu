import type { WorkerSessionReport } from "./types";

export type WorkerMessageModel = { model: string; createdAt: number; effort?: string };

/** Only a provider's authoritative session aggregate can price a session.
 * Message sums can omit compaction, reverted history and truncated pages.
 */
export function workerSessionReport(costUsd: number | null | undefined, models: ReadonlyMap<string, WorkerMessageModel> | undefined): WorkerSessionReport {
  let latest: { id: string; value: WorkerMessageModel } | undefined;
  for (const [id, value] of models ?? []) {
    if (!latest || value.createdAt > latest.value.createdAt || value.createdAt === latest.value.createdAt && id > latest.id) latest = { id, value };
  }
  return { ...(latest ? { model: latest.value.model } : {}), effort: latest?.value.effort ?? null, costUsd: typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : null };
}

export function formatWorkerCost(costUsd: number | null | undefined): string {
  if (costUsd == null) return "—";
  if (costUsd > 0 && costUsd < 0.0001) return "<$0.0001";
  return `$${costUsd.toFixed(costUsd > 0 && costUsd < 0.01 ? 4 : 2)}`;
}
