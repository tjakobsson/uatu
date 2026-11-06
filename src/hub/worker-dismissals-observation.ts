// Minimal trusted-child projection observer. Never reads browser activity
// claims, filters chat items, or serializes marks into shared transport data.
import { workerDismissalEvidenceForItem } from "../chat/worker-dismissal-evidence";
import type { WorkerDismissalsStore } from "./worker-dismissals";
export { workerDismissalEvidence, workerDismissalEvidenceForItem } from "../chat/worker-dismissal-evidence";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function observeWorkerProjection(store: WorkerDismissalsStore, workspaceId: string, conversationId: string, value: unknown): void {
  const projection = record(value); if (!projection) return;
  if (projection.type === "item.upsert" && projection.conversationId === conversationId) {
    const evidence = workerDismissalEvidenceForItem(projection.item).filter(item => item.active);
    if (evidence.length) store.observe(workspaceId, conversationId, evidence);
  } else if (record(projection.conversation)?.id === conversationId && Array.isArray(projection.items)) {
    for (const item of projection.items) {
      const evidence = workerDismissalEvidenceForItem(item).filter(item => item.active);
      if (evidence.length) store.observe(workspaceId, conversationId, evidence);
    }
  }
}
