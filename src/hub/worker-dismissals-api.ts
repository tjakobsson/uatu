// Hub-only personal resource. Child reads use the existing loopback/token
// authority, never forwarded client claims, usernames or provider mutations.
import { workerDismissalEvidenceForItem } from "./worker-dismissals-observation";
import type { RunningSession } from "./backend";
import { childRequestHeaders, childUrlFor } from "./proxy";
import { parseConversationSnapshot } from "../chat/validation";
import type { ConversationItem } from "../chat/types";
import { backgroundTasksByTool } from "../chat/background-tasks";
import { dismissalIdentifier, WorkerDismissalsError, type WorkerDismissalEvidence, type WorkerDismissalMutation, type WorkerDismissalsStore } from "./worker-dismissals";

export const WORKER_DISMISSALS_PATH = "/api/personal-worker-dismissals";
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
  const evidence = new Map<string, WorkerDismissalEvidence>(); let cursor: string | undefined; const cursors = new Set<string>();
  const signal = AbortSignal.timeout(10_000);
  const items: ConversationItem[] = [];
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${running.basePath}api/chat/conversations/${encodeURIComponent(conversationId)}`, "http://child.invalid");
    url.searchParams.set("limit", "100"); if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(childUrlFor(running, url), { headers: childRequestHeaders(running), signal, redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); throw new WorkerDismissalsError("unavailable", "authoritative worker status is unavailable"); }
    const snapshot = parseConversationSnapshot(JSON.parse(await boundedText(response, 4 * 1024 * 1024)));
    if (snapshot.conversation.id !== conversationId) throw new WorkerDismissalsError("unavailable", "authoritative conversation identity mismatch");
    for (const item of snapshot.items) {
      if (item.type !== "tool" && item.type !== "background_task") continue;
      if (items.length >= 8192) throw new WorkerDismissalsError("capacity", "worker dismissal source capacity reached");
      items.push(item);
    }
    if (!snapshot.olderCursor) break;
    if (cursors.has(snapshot.olderCursor)) throw new WorkerDismissalsError("unavailable", "authoritative worker pagination did not advance");
    cursor = snapshot.olderCursor; cursors.add(cursor);
    if (page === 19) throw new WorkerDismissalsError("unavailable", "authoritative worker history exceeds read budget");
  }
  // A completed launcher may have only launched still-running work. Resolve
  // aliases over every page before reading terminal evidence from tool rows.
  const aliases = backgroundTasksByTool(items);
  for (const item of items) {
    if (item.type === "tool" && (aliases.has(item.id) || !item.id.startsWith("tool:") && aliases.has(`tool:${item.id}`))) continue;
    // Observation clocks age on every read. They are not evidence revisions.
    // Kind/generation/end/outcome changes fence old actions durably.
    for (const observed of workerDismissalEvidenceForItem(item)) {
      const prior = evidence.get(observed.executionId);
      if (prior && (prior.signature !== observed.signature || prior.active !== observed.active || prior.dismissible !== observed.dismissible)) {
        throw new WorkerDismissalsError("unavailable", "ambiguous authoritative worker identity");
      }
      if (!prior && evidence.size >= 8192) throw new WorkerDismissalsError("capacity", "worker dismissal evidence capacity reached");
      evidence.set(observed.executionId, observed);
    }
  }
  return [...evidence.values()];
}

export async function handleWorkerDismissals(request: Request, deps: {
  user: string; workspaceId: string; store?: WorkerDismissalsStore;
  read(conversationId: string): Promise<WorkerDismissalEvidence[]>;
}): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return new Response(null, { status: 405, headers: { ...NO_STORE, allow: "GET, POST" } });
  const url = new URL(request.url);
  if (request.headers.has("x-hub-user") || request.headers.has("x-hub-account") || request.headers.has("x-uatu-hub-principal")) return json(400, { error: "personal identity selectors are not supported" });
  try {
    let conversationId: unknown; let mutation: WorkerDismissalMutation | undefined;
    if (request.method === "GET") {
      if ([...url.searchParams.keys()].some(key => key !== "conversationId") || url.searchParams.getAll("conversationId").length !== 1) invalid();
      conversationId = url.searchParams.get("conversationId");
    } else {
      if (url.search !== "") invalid();
      let input: unknown;
      try { input = JSON.parse(await boundedText(request, 4096)); } catch (error) {
        if (error instanceof WorkerDismissalsError && error.code === "capacity") return json(413, { error: error.message });
        return json(400, { error: "invalid JSON body" });
      }
      if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
      const record = input as Record<string, unknown>;
      if (Object.keys(record).some(key => !["version", "conversationId", "executionId", "expectedRevision", "operation"].includes(key))
        || record.version !== 1 || !dismissalIdentifier(record.executionId) || !Number.isSafeInteger(record.expectedRevision)
        || (record.expectedRevision as number) < 0 || (record.operation !== "dismiss" && record.operation !== "retire")) invalid();
      conversationId = record.conversationId;
      mutation = { executionId: record.executionId as string, expectedRevision: record.expectedRevision as number, operation: record.operation as "dismiss" | "retire" };
    }
    if (!dismissalIdentifier(conversationId) || !/^[a-z][a-z0-9-]*:.+/.test(conversationId)) invalid();
    if (!deps.store) return json(503, { error: "worker dismissals are unavailable" });
    const parent = conversationId as string;
    return json(200, await deps.store.reconcile({ user: deps.user, workspaceId: deps.workspaceId, conversationId: parent }, () => deps.read(parent), mutation));
  } catch (error) {
    if (error instanceof WorkerDismissalsError) return json({ "invalid-input": 400, conflict: 409, capacity: 507, unavailable: 503, "not-found": 404 }[error.code], { error: error.message });
    return json(503, { error: "authoritative worker status or dismissal storage is unavailable" });
  }
}
