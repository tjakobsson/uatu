// Hub-only personal resource. Child reads use the existing loopback/token
// authority, never forwarded client claims, usernames or provider mutations.
import type { RunningSession } from "./backend";
import { childRequestHeaders, childUrlFor } from "./proxy";
import { WORKER_EVIDENCE_LIMIT } from "../chat/worker-dismissal-evidence";
import { dismissalIdentifier, WorkerDismissalsError, type WorkerDismissalEvidence, type WorkerDismissalChanges, type WorkerDismissalState, type WorkerDismissalsStore } from "./worker-dismissals";

export const WORKER_DISMISSALS_PATH = "/api/personal-worker-dismissals";
// The child's covered-history read allows 25 seconds (chat/adapter.ts).
// Leave five seconds for transport/publication instead of cutting it short.
const WORKER_EVIDENCE_TIMEOUT_MS = 30_000;
const NO_STORE = { "cache-control": "no-store" };
const json = (status: number, body: unknown) => Response.json(body, { status, headers: NO_STORE });
const invalid = (): never => { throw new WorkerDismissalsError("invalid-input", "invalid worker dismissal request"); };

async function boundedText(response: Response | Request, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true }); let bytes = 0; let text = "";
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new WorkerDismissalsError("capacity", "worker dismissal payload is too large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function readAuthoritativeWorkerEvidence(running: RunningSession, conversationId: string): Promise<WorkerDismissalEvidence[]> {
  const url = new URL(`${running.basePath}api/chat/conversations/${encodeURIComponent(conversationId)}/worker-evidence`, "http://child.invalid");
  const response = await fetch(childUrlFor(running, url), { headers: childRequestHeaders(running), signal: AbortSignal.timeout(WORKER_EVIDENCE_TIMEOUT_MS), redirect: "error" });
  if (!response.ok) { await response.body?.cancel(); throw new WorkerDismissalsError(response.status === 507 ? "capacity" : "unavailable", "authoritative worker status is unavailable"); }
  const malformed = (): never => { throw new WorkerDismissalsError("unavailable", "invalid authoritative worker evidence"); };
  let input: unknown;
  try { input = JSON.parse(await boundedText(response, 4 * 1024 * 1024)); } catch (error) {
    if (error instanceof WorkerDismissalsError) throw error;
    return malformed();
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return malformed();
  const snapshot = input as Record<string, unknown>;
  if (Object.keys(snapshot).sort().join(",") !== "complete,conversationId,entries,version" || snapshot.version !== 1
    || snapshot.conversationId !== conversationId || snapshot.complete !== true || !Array.isArray(snapshot.entries)) return malformed();
  if (snapshot.entries.length > WORKER_EVIDENCE_LIMIT) throw new WorkerDismissalsError("capacity", "worker dismissal evidence capacity reached");
  const seen = new Set<string>();
  for (const item of snapshot.entries) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort().join(",") !== "active,dismissible,executionId,signature"
      || !dismissalIdentifier(item.executionId) || !dismissalIdentifier(item.signature) || typeof item.active !== "boolean" || typeof item.dismissible !== "boolean"
      || item.active && item.dismissible || seen.has(item.executionId)) return malformed();
    seen.add(item.executionId);
  }
  return snapshot.entries as WorkerDismissalEvidence[];
}

export async function handleWorkerDismissals(request: Request, deps: {
  user: string; workspaceId: string; store?: WorkerDismissalsStore;
  read(conversationId: string): Promise<WorkerDismissalEvidence[]>;
  runExclusive?(operation: () => Promise<WorkerDismissalState>): Promise<WorkerDismissalState>;
}): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return new Response(null, { status: 405, headers: { ...NO_STORE, allow: "GET, POST" } });
  const url = new URL(request.url);
  if (request.headers.has("x-hub-user") || request.headers.has("x-hub-account") || request.headers.has("x-uatu-hub-principal")) return json(400, { error: "personal identity selectors are not supported" });
  try {
    let conversationId: unknown; let mutation: WorkerDismissalChanges | undefined;
    if (request.method === "GET") {
      if ([...url.searchParams.keys()].some(key => key !== "conversationId") || url.searchParams.getAll("conversationId").length !== 1) invalid();
      conversationId = url.searchParams.get("conversationId");
    } else {
      if (url.search !== "") invalid();
      let input: unknown; let text = "";
      try { text = await boundedText(request, 4 * 1024 * 1024); input = JSON.parse(text); } catch (error) {
        if (error instanceof WorkerDismissalsError && error.code === "capacity") return json(413, { error: error.message });
        if (Buffer.byteLength(text) > 4096) return json(413, { error: "worker dismissal payload is too large" });
        return json(400, { error: "invalid JSON body" });
      }
      if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
      const record = input as Record<string, unknown>;
      conversationId = record.conversationId;
      if (record.targets !== undefined) {
        if (Object.keys(record).sort().join(",") !== "conversationId,operation,targets,version" || record.version !== 1 || record.operation !== "dismiss"
          || !Array.isArray(record.targets) || !record.targets.length || record.targets.length > WORKER_EVIDENCE_LIMIT) invalid();
        const seen = new Set<string>();
        mutation = (record.targets as unknown[]).map(value => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
          const target = value as Record<string, unknown>;
          if (Object.keys(target).sort().join(",") !== "executionId,expectedRevision" || !dismissalIdentifier(target.executionId)
            || !Number.isSafeInteger(target.expectedRevision) || (target.expectedRevision as number) < 0 || seen.has(target.executionId)) return invalid();
          seen.add(target.executionId);
          return { executionId: target.executionId, expectedRevision: target.expectedRevision as number, operation: "dismiss" as const };
        });
      } else {
        if (Buffer.byteLength(text) > 4096) return json(413, { error: "worker dismissal payload is too large" });
        if (Object.keys(record).some(key => !["version", "conversationId", "executionId", "expectedRevision", "operation"].includes(key))
          || record.version !== 1 || !dismissalIdentifier(record.executionId) || !Number.isSafeInteger(record.expectedRevision)
          || (record.expectedRevision as number) < 0 || (record.operation !== "dismiss" && record.operation !== "retire")) invalid();
        mutation = { executionId: record.executionId as string, expectedRevision: record.expectedRevision as number, operation: record.operation as "dismiss" | "retire" };
      }
    }
    if (!dismissalIdentifier(conversationId) || !/^[a-z][a-z0-9-]*:.+/.test(conversationId)) invalid();
    if (!deps.store) return json(503, { error: "worker dismissals are unavailable" });
    const parent = conversationId as string;
    return json(200, await deps.store.withAdmission({ user: deps.user, workspaceId: deps.workspaceId, conversationId: parent }, mutation,
      reconcile => deps.runExclusive ? deps.runExclusive(() => reconcile(() => deps.read(parent))) : reconcile(() => deps.read(parent)), request.signal));
  } catch (error) {
    if (error instanceof WorkerDismissalsError) return json({ "invalid-input": 400, conflict: 409, capacity: 507, unavailable: 503, "not-found": 404 }[error.code], { error: error.message });
    return json(503, { error: "authoritative worker status or dismissal storage is unavailable" });
  }
}
