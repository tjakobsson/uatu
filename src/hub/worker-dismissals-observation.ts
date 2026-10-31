// Minimal trusted-child projection observer. Never reads browser activity
// claims, filters chat items, or serializes marks into shared transport data.
import { createHash } from "node:crypto";
import { workerDismissalIdentities } from "../chat/worker-dismissal-identity";
import { dismissalIdentifier, type WorkerDismissalEvidence, type WorkerDismissalsStore } from "./worker-dismissals";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function workerDismissalEvidence(value: unknown): WorkerDismissalEvidence | null {
  const item = record(value); if (!item) return null;
  const ids = workerDismissalIdentities(item); if (!ids.length) return null;
  if (item.activity === undefined) {
    if (!["completed", "failed", "stopped", "error", "cancelled"].includes(item.status as string)) return null;
    const signature = createHash("sha256").update(JSON.stringify(["terminal", item.status])).digest("hex");
    return { executionId: ids[0]!, signature, active: false, dismissible: true };
  }
  if (item.type !== "background_task") return null;
  const activity = record(item.activity);
  if (!activity || activity.executionId !== undefined && !dismissalIdentifier(activity.executionId)
    || !["working", "needs-answer", "checking", "session-active", "unavailable", "ended"].includes(activity.kind as string)
    || !["running", "completed", "failed", "stopped"].includes(item.status as string)) return null;
  const active = activity.kind === "working" || activity.kind === "needs-answer";
  const dismissible = !active && (item.status !== "running" || activity.kind === "unavailable" || activity.kind === "ended");
  if ((activity.generation !== undefined && (!Number.isSafeInteger(activity.generation) || (activity.generation as number) < 0))
    || (activity.endedAt !== undefined && (typeof activity.endedAt !== "number" || !Number.isFinite(activity.endedAt) || activity.endedAt < 0))) return null;
  const request = record(activity.request);
  if (activity.request !== undefined && (!request || !dismissalIdentifier(request.id) || (request.kind !== "permission" && request.kind !== "question"))) return null;
  const signature = createHash("sha256").update(JSON.stringify([activity.kind, activity.generation ?? null, activity.endedAt ?? null, item.status,
    request ? { id: request.id, kind: request.kind } : null])).digest("hex");
  return { executionId: ids[0]!, signature, active, dismissible };
}
export function workerDismissalEvidenceForItem(value: unknown): WorkerDismissalEvidence[] {
  const evidence = workerDismissalEvidence(value); if (!evidence) return [];
  // Only provider-proven immutable anchors. Never match a child/session id.
  return workerDismissalIdentities(value)
    .map(executionId => ({ ...evidence, executionId }));
}
export function observeWorkerProjection(store: WorkerDismissalsStore, workspaceId: string, conversationId: string, value: unknown): void {
  const projection = record(value); if (!projection) return;
  // Both event ownership and snapshot identity must match the Hub-selected
  // route/subscription. Pending canonical requests are never modified.
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
