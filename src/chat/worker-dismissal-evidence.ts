// Server-side compact evidence shared by the owned child read and trusted Hub
// observations. Never includes transcript text or account dismissal marks.
import { createHash } from "node:crypto";
import { backgroundTasksByTool } from "./background-tasks";
import { workerDismissalIdentities } from "./worker-dismissal-identity";
import { parseConversationItem } from "./validation";
import type { BackgroundTaskItem, ConversationItem } from "./types";

export type WorkerDismissalEvidence = { executionId: string; signature: string; active: boolean; dismissible: boolean };
export type WorkerEvidenceSnapshot = { version: 1; conversationId: string; complete: true; entries: WorkerDismissalEvidence[] };
export const WORKER_EVIDENCE_LIMIT = 8192;
export class WorkerEvidenceError extends Error {
  constructor(readonly code: "capacity" | "unavailable", message: string) { super(message); }
}
export function dismissalIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
type AssociationFacts = Record<string, string | number | boolean | undefined>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ambiguousSource = (): never => { throw new WorkerEvidenceError("unavailable", "ambiguous authoritative worker identity"); };
function associationFacts(item: ConversationItem): AssociationFacts {
  if (item.type === "tool") return { family: "tool", child: item.childConversationId, name: item.name.toLowerCase(), input: item.input === undefined ? undefined : hash(item.input), created: item.createdAt, completed: item.completedAt };
  if (item.type !== "background_task") return {};
  const strong = item.activity !== undefined;
  const calls = [...new Set([...(item.toolUseIds ?? []), ...(item.toolUseId ? [item.toolUseId] : [])])].sort();
  return { family: strong ? "strong-task" : "legacy-task", task: item.taskId, child: item.childConversationId, type: item.taskType, foreground: item.foreground ?? false,
    launch: item.activity?.launchRef, result: strong ? item.resultId : undefined,
    // Legacy terminal anchors explicitly support adding call/result aliases.
    // A strong occurrence's known immutable launcher set must instead agree.
    calls: strong && calls.length ? JSON.stringify(calls) : undefined };
}
function mergeAssociations(left: AssociationFacts, right: AssociationFacts): AssociationFacts {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (value === undefined) continue;
    if (merged[key] !== undefined && merged[key] !== value) ambiguousSource();
    merged[key] = value;
  }
  return merged;
}

/** Native history may coalesce call-scoped tasks after proving one occurrence.
 * Only an abstaining, fully contained old launcher row can be its shadow. This
 * is not a general shared-alias/task-id exception or new lifecycle authority. */
function nativeAliasShadow(member: ConversationItem, canonical: ConversationItem, laterSource = false): boolean {
  if (member.type !== "background_task" || canonical.type !== "background_task" || !laterSource && member.id === canonical.id) return false;
  const native = (item: BackgroundTaskItem) => {
    if (item.taskType !== "agent" || item.foreground || !item.childConversationId || !item.toolUseId
      || item.id !== `task:${item.taskId}` || !item.taskId.endsWith(`:${item.toolUseId}`)) return;
    const prefix = item.taskId.slice(0, -item.toolUseId.length - 1);
    if (!prefix.startsWith("v2:") || prefix.length <= 3) return;
    const calls = new Set([item.toolUseId, ...(item.toolUseIds ?? [])]);
    const ids = new Set(workerDismissalIdentities(item));
    // One positively anchored native execution alias per immutable launch.
    if (ids.size !== calls.size || ![...ids].every(id => /^v1:[a-f0-9]{64}$/.test(id))) return;
    return { prefix, calls, ids };
  };
  const small = native(member), full = native(canonical);
  if (!small || !full || small.prefix !== full.prefix || member.childConversationId !== canonical.childConversationId
    || member.subagentType !== undefined && member.subagentType !== canonical.subagentType
    || full.calls.size <= small.calls.size || ![...small.calls].every(call => full.calls.has(call))
    || ![...small.ids].every(id => full.ids.has(id))) return false;
  const activity = member.activity, current = canonical.activity;
  if (!activity || !current || member.status !== "running" || activity.kind !== "unavailable"
    || member.resultId !== undefined || member.terminalReportedAt !== undefined || activity.request !== undefined || activity.endedAt !== undefined
    || activity.generation !== undefined && activity.generation !== current.generation
    || activity.launchRef !== undefined && activity.launchRef !== current.launchRef) return false;
  // Never resolve a positive/nondismissible vs terminal conflict by selecting
  // a canonical task. Both sides must already independently permit dismissal.
  return workerDismissalEvidence(member)?.dismissible === true && workerDismissalEvidence(canonical)?.dismissible === true;
}
export function workerDismissalEvidence(value: unknown): WorkerDismissalEvidence | null {
  const item = record(value); if (!item) return null;
  const ids = workerDismissalIdentities(item); if (!ids.length) return null;
  if (item.activity === undefined) {
    if (!["completed", "failed", "stopped", "error", "cancelled"].includes(item.status as string)) return null;
    const signature = createHash("sha256").update(JSON.stringify(["terminal", item.status, ...(item.outcomeWithheld === true ? ["outcome-withheld"] : [])])).digest("hex");
    return { executionId: ids[0]!, signature, active: false, dismissible: item.outcomeWithheld !== true };
  }
  if (item.type !== "background_task") return null;
  const activity = record(item.activity);
  if (!activity || activity.executionId !== undefined && !dismissalIdentifier(activity.executionId)
    || !["working", "needs-answer", "checking", "session-active", "unavailable", "ended"].includes(activity.kind as string)
    || !["running", "completed", "failed", "stopped"].includes(item.status as string)) return null;
  const active = activity.kind === "working" || activity.kind === "needs-answer";
  const dismissible = item.outcomeWithheld !== true && !active && (item.status !== "running" || activity.kind === "unavailable" || activity.kind === "ended");
  if ((activity.generation !== undefined && (!Number.isSafeInteger(activity.generation) || (activity.generation as number) < 0))
    || (activity.endedAt !== undefined && (typeof activity.endedAt !== "number" || !Number.isFinite(activity.endedAt) || activity.endedAt < 0))) return null;
  const request = record(activity.request);
  if (activity.request !== undefined && (!request || !dismissalIdentifier(request.id) || (request.kind !== "permission" && request.kind !== "question"))) return null;
  const signature = createHash("sha256").update(JSON.stringify([[...ids].sort(), activity.kind, activity.generation ?? null, activity.endedAt ?? null, item.status,
    request ? { id: request.id, kind: request.kind } : null, ...(item.outcomeWithheld === true ? ["outcome-withheld"] : [])])).digest("hex");
  return { executionId: ids[0]!, signature, active, dismissible };
}
export function workerDismissalEvidenceForItem(value: unknown): WorkerDismissalEvidence[] {
  const evidence = workerDismissalEvidence(value); if (!evidence) return [];
  return workerDismissalIdentities(value).map(executionId => ({ ...evidence, executionId }));
}
/** Validate a single current source BEFORE any row-id or occurrence collapse.
 * Observational clocks/text may differ; occurrence, association and lifecycle
 * facts may not. Supplemental page rows must agree with complete coverage.
 * Independently owned later recovery/live updates are validated separately. */
export function validatedWorkerDismissalSource(items: readonly ConversationItem[], supplemental: readonly ConversationItem[] = []): ConversationItem[] {
  const sources = [items, supplemental].map(values => values.filter(item => item.type === "tool" || item.type === "background_task"));
  if (sources.some(source => source.length > WORKER_EVIDENCE_LIMIT)) throw new WorkerEvidenceError("capacity", "worker dismissal source capacity reached");
  // Preserve the DTO validation the old Hub display-snapshot reader supplied.
  // A malformed active row must not disappear beside a valid terminal alias.
  try { for (const source of sources) for (const item of source) parseConversationItem(item); }
  catch { throw new WorkerEvidenceError("unavailable", "invalid authoritative worker source"); }
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const ambiguous = (): never => { throw new WorkerEvidenceError("unavailable", "ambiguous authoritative worker identity"); };
  const rows = new Map<string, { item: ConversationItem; fingerprint: string; authority: string; ids: string[] }>();
  for (let index = 0; index < sources.length; index++) for (const item of sources[index]!) {
    const ids = workerDismissalIdentities(item).sort();
    const activity = item.type === "background_task" ? item.activity : undefined;
    // Keep established provider semantics: legacy terminal rows may add bare
    // aliases across distinct source rows, while strong envelopes name their
    // complete alias namespace. Nonterminal/withheld rows still participate
    // in conflict detection even though they produce no dismissible evidence.
    const authority = workerDismissalEvidence(item)?.signature ?? digest(["unsettled", item.status, activity?.kind ?? null,
      activity?.generation ?? null, activity?.endedAt ?? null, activity?.request ? [activity.request.kind, activity.request.id] : null]);
    const fingerprint = digest([item.type, authority, ids, item.childConversationId ?? null,
      item.type === "tool" ? [item.name, item.input === undefined ? null : digest(item.input), item.createdAt, item.completedAt ?? null]
        : [item.taskId, item.taskType ?? null, item.foreground ?? false, item.resultId ?? null,
          [...new Set([...(item.toolUseIds ?? []), ...(item.toolUseId ? [item.toolUseId] : [])])].sort(), activity?.launchRef ?? null]]);
    const prior = rows.get(item.id);
    if (prior && prior.fingerprint !== fingerprint) ambiguous();
    if (index === 1) { if (!prior) ambiguous(); } // Complete coverage cannot omit a visible worker.
    else rows.set(item.id, { item, fingerprint, authority, ids });
  }
  // A different DTO type sharing a worker's row id is also not a safe duplicate.
  for (const values of [items, supplemental]) for (const item of values) if (rows.has(item.id) && item.type !== "tool" && item.type !== "background_task") ambiguous();
  // Same-row and supplemental coverage checks above remain strict. Only now
  // discard certified native abstaining shadows, before alias cohort checks.
  const candidates = [...rows.values()];
  const byAlias = new Map<string, typeof candidates>();
  for (const row of candidates) if (row.item.type === "background_task") for (const id of row.ids) {
    const bucket = byAlias.get(id);
    if (bucket) bucket.push(row);
    else {
      if (byAlias.size >= WORKER_EVIDENCE_LIMIT) throw new WorkerEvidenceError("capacity", "worker dismissal evidence capacity reached");
      byAlias.set(id, [row]);
    }
  }
  const retained = candidates.filter(row => !(byAlias.get(row.ids[0]!) ?? []).some(other => other.ids.length > row.ids.length && nativeAliasShadow(row.item, other.item)));
  const source = retained.map(row => row.item);
  const aliases = backgroundTasksByTool(source);
  type Group = { authority: string; facts: AssociationFacts; bareTask: boolean; parent?: Group };
  const root = (group: Group): Group => {
    let result = group; while (result.parent) result = result.parent;
    while (group.parent) { const next = group.parent; group.parent = result; group = next; }
    return result;
  };
  const identities = new Map<string, Group>();
  for (const row of retained) {
    const item = row.item;
    // Launcher completion does not settle its background task. This is the
    // existing exact launcher reconciliation, not a child-session alias.
    if (item.type === "tool" && (aliases.has(item.id) || !item.id.startsWith("tool:") && aliases.has(`tool:${item.id}`))) continue;
    const group: Group = { authority: row.authority, facts: associationFacts(item), bareTask: item.type === "background_task" && !item.activity && row.ids.includes(`worker-dismissal:task:${item.taskId}`) };
    for (const id of row.ids) {
      const prior = identities.get(id), current = prior && root(prior);
      if (current && current !== group) {
        if (current.authority !== row.authority) ambiguous();
        group.facts = mergeAssociations(group.facts, current.facts);
        group.bareTask ||= current.bareTask;
        current.parent = group;
      }
      if (prior === undefined && identities.size >= WORKER_EVIDENCE_LIMIT) throw new WorkerEvidenceError("capacity", "worker dismissal evidence capacity reached");
      identities.set(id, group);
    }
    if (group.bareTask && group.facts.task === group.facts.child) ambiguous();
  }
  return source;
}

export function workerSourceIsProtected(item: ConversationItem): boolean {
  if (item.type === "background_task" && item.outcomeWithheld) return true;
  if (item.type !== "background_task" || !item.activity) return false;
  return item.activity.kind === "working" || item.activity.kind === "needs-answer"
    || item.status === "running" && (item.activity.kind === "checking" || item.activity.kind === "session-active");
}

/** Retained presentation, absence and weaker inventory cannot grant dismissal
 * over a current source witness. A mixed/changed view fails closed; a fresh
 * source read, not a cache write or a clock, must establish weaker activity. */
export function workerDismissalSourceStrength(source: readonly ConversationItem[]): (items: readonly ConversationItem[]) => void {
  const witnesses = validatedWorkerDismissalSource(source).flatMap(item => {
    if (item.type !== "background_task" || !item.activity) return [];
    const active = item.activity.kind === "working" || item.activity.kind === "needs-answer";
    const protectedRow = workerSourceIsProtected(item);
    return [{ item, id: item.id, ids: workerDismissalIdentities(item), facts: associationFacts(item), generation: item.activity.generation, active, protectedRow }];
  });
  return items => {
    const current = validatedWorkerDismissalSource(items), rows = new Map(current.map(item => [item.id, item]));
    const aliases = new Map(current.flatMap(item => workerDismissalIdentities(item).map(id => [id, item] as const)));
    const weakened = (): never => { throw new WorkerEvidenceError("unavailable", "authoritative worker source was weakened without newer evidence"); };
    for (const witness of witnesses) {
      const item = witness.ids.map(id => aliases.get(id)).find(Boolean) ?? rows.get(witness.id);
      if (!item) { if (witness.protectedRow) return weakened(); continue; }
      const ids = workerDismissalIdentities(item);
      if (witness.ids.length && !witness.ids.some(id => ids.includes(id))) { if (witness.protectedRow) return weakened(); continue; }
      // Separately validated recovery may enrich the same native call key;
      // contradictory same-row members within either source still fail above.
      if (!nativeAliasShadow(witness.item, item, true)) mergeAssociations(witness.facts, associationFacts(item));
      if (item.type !== "background_task" || !item.activity) return weakened();
      const active = item.activity.kind === "working" || item.activity.kind === "needs-answer";
      const protectedRow = workerSourceIsProtected(item);
      const explicitReplacement = witness.item.outcomeWithheld && item.status !== "running" && !item.stateUncertain && !!item.resultId;
      if (witness.active && !active || witness.protectedRow && !protectedRow && !explicitReplacement) weakened();
      if (witness.generation !== undefined && (item.activity.generation === undefined || item.activity.generation < witness.generation)) weakened();
    }
  };
}
export function compactWorkerEvidence(items: readonly ConversationItem[]): WorkerDismissalEvidence[] {
  const source = validatedWorkerDismissalSource(items);
  const aliases = backgroundTasksByTool(source);
  const evidence = new Map<string, WorkerDismissalEvidence>();
  for (const item of source) {
    if (item.type === "tool" && (aliases.has(item.id) || !item.id.startsWith("tool:") && aliases.has(`tool:${item.id}`))) continue;
    for (const observed of workerDismissalEvidenceForItem(item)) {
      const prior = evidence.get(observed.executionId);
      if (prior && (prior.signature !== observed.signature || prior.active !== observed.active || prior.dismissible !== observed.dismissible)) throw new WorkerEvidenceError("unavailable", "ambiguous authoritative worker identity");
      if (!prior && evidence.size >= WORKER_EVIDENCE_LIMIT) throw new WorkerEvidenceError("capacity", "worker dismissal evidence capacity reached");
      evidence.set(observed.executionId, observed);
    }
  }
  return [...evidence.values()];
}
