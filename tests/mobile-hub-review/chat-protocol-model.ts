import type { ChatEvent, ChatModel, ChatCommand, ConversationSnapshot, ConversationStatus } from "../../src/chat/types";

const models: ChatModel[] = [{ selection: { providerId: "synthetic", modelId: "review-small" }, provider: "Synthetic (no provider)", name: "Synthetic review small", default: true, imageInput: true }];
const commands: ChatCommand[] = [{ name: "status", description: "Synthetic status; no tools or provider", argumentHint: "", kind: "command" }];
type Change = ChatEvent extends infer E ? E extends ChatEvent ? Omit<E, "generation" | "sequence" | "conversationId"> : never : never;

/** Bounded, disposable protocol projection. Input text is never stored or logged.
 * The fixed replacement text is intentional: review must not retain secrets. */
export function createChatProtocolModel(initial: ConversationSnapshot) {
  const records = new Map<string, { snapshot: ConversationSnapshot; sequence: number; events: ChatEvent[] }>();
  const listeners = new Set<(id: string, frame: string) => void>();
  let serial = 1;
  let outputs = 0;
  const reset = (seed = initial) => { records.clear(); records.set(seed.conversation.id, { snapshot: structuredClone(seed), sequence: 0, events: [] }); serial = 1; outputs = 0; };
  reset();
  const inventory = () => { for (const listener of listeners) listener("inventory", 'event: inventory\ndata: {"type":"conversation.inventory"}\n\n'); };
  const frame = (event: ChatEvent) => `id: ${event.generation}:${event.sequence}\nevent: ${event.type === "resync" ? "resync" : "chat"}\ndata: ${JSON.stringify(event)}\n\n`;
  const emit = (id: string, change: Change) => {
    const record = records.get(id)!;
    const event = structuredClone({ ...change, generation: record.snapshot.generation, sequence: ++record.sequence, conversationId: id }) as ChatEvent;
    record.snapshot.cursor = `${event.generation}:${event.sequence}`;
    record.events.push(event); if (record.events.length > 256) record.events.shift();
    for (const listener of listeners) listener(id, frame(event));
  };
  const status = (id: string, value: ConversationStatus) => { records.get(id)!.snapshot.conversation.status = value; emit(id, { type: "conversation.status", status: value }); inventory(); };
  const complete = (id = initial.conversation.id) => {
    const record = records.get(id); if (!record) return false;
    if (record.snapshot.items.length >= 200) return false;
    const item = { id: `synthetic-answer-${++serial}`, type: "assistant_message" as const, createdAt: initial.conversation.createdAt, markdown: `Synthetic streamed response ${++outputs}. No provider was invoked.` };
    record.snapshot.items.push(item); emit(id, { type: "item.upsert", item });
    status(id, "completed");
    const next = record.snapshot.queued?.shift();
    if (next) {
      emit(id, { type: "conversation.queue", queued: record.snapshot.queued!, change: { kind: "delivered", messageId: next.id } });
      const item = { id: `message:${next.id}`, type: "user_message" as const, createdAt: next.queuedAt, text: next.text, requestId: next.requestId };
      record.snapshot.items.push(item); emit(id, { type: "item.upsert", item }); status(id, "running");
    }
    return true;
  };
  return {
    reset, complete,
    has: (id: string) => records.has(id),
    subscribe(listener: (id: string, frame: string) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    replay(id: string, cursor: string | null) {
      const record = records.get(id)!;
      if (!cursor || cursor === record.snapshot.cursor) return ": synthetic chat stream\n\n";
      const prefix = `${record.snapshot.generation}:`, n = Number(cursor.slice(prefix.length));
      if (!cursor.startsWith(prefix) || !Number.isSafeInteger(n) || n < 0 || n > record.sequence || n < (record.events[0]?.sequence ?? 1) - 1) return frame({ type: "resync", reason: "retention-gap", generation: record.snapshot.generation, sequence: record.sequence, conversationId: id });
      return record.events.filter(event => event.sequence > n).map(frame).join("");
    },
    async handle(request: Request, url: URL): Promise<Response | null> {
      const path = url.pathname, json = Response.json;
      if (!path.startsWith("/api/chat/") || path.endsWith("/events") || path.includes("/attachments")) return null;
      const fail = (error: string, status = 400) => json({ error }, { status });
      if (["models", "commands", "modes"].some(name => path === `/api/chat/${name}`)) {
        if (request.method !== "GET") return fail("Synthetic catalog is read-only", 405);
        if (url.searchParams.get("agent") !== "review") return fail("Unknown synthetic agent", 404);
        return json(path.endsWith("models") ? { models } : path.endsWith("commands") ? { commands } : { modes: [] });
      }
      if (path === "/api/chat/status") return null;
      const match = /^\/api\/chat\/conversations(?:\/([^/]+)(.*))?$/.exec(path);
      if (!match) return fail("Unsupported synthetic chat operation", 501);
      let body: Record<string, unknown> = {};
      if (request.method !== "GET") {
        const reader = request.body?.getReader(); let text = "", size = 0; const decoder = new TextDecoder();
        if (reader) while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 16384) { await reader.cancel(); return fail("Synthetic chat body limit", 413); } text += decoder.decode(chunk.value, { stream: true }); }
        try { body = text ? JSON.parse(text) : {}; if (!body || Array.isArray(body) || typeof body !== "object") throw new Error(); } catch { return fail("Invalid synthetic chat JSON"); }
      }
      if (!match[1]) {
        if (request.method === "GET") return json({ conversations: [...records.values()].map(r => r.snapshot.conversation) });
        if (request.method !== "POST") return fail("Unsupported synthetic inventory method", 405);
        if (body.agentId !== undefined && body.agentId !== "review") return fail("Unknown synthetic agent", 404);
        if (records.size >= 16) return fail("Synthetic conversation limit", 409);
        const snapshot = structuredClone(initial); snapshot.items = []; snapshot.queued = []; snapshot.conversation.id = `review:conversation-${++serial}`; snapshot.conversation.title = "New synthetic conversation";
        records.set(snapshot.conversation.id, { snapshot, sequence: 0, events: [] }); inventory(); return json(snapshot);
      }
      const id = decodeURIComponent(match[1]), record = records.get(id), action = match[2] || "";
      if (!record) return fail("Unknown synthetic conversation", 404);
      const snapshot = record.snapshot;
      if (!action && request.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 50);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) return fail("Invalid synthetic snapshot limit");
        if (url.searchParams.has("cursor")) return fail("Synthetic older history unavailable", 409);
        return json({ ...snapshot, items: snapshot.items.slice(-limit) });
      }
      if (!action && request.method === "PATCH") {
        if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 100) return fail("Invalid synthetic title");
        snapshot.conversation.title = "Renamed synthetic conversation"; emit(id, { type: "conversation.updated", conversation: snapshot.conversation }); inventory(); return json({ conversation: snapshot.conversation });
      }
      if (action === "/prompts" && request.method === "POST") {
        if (typeof body.requestId !== "string" || body.requestId.length > 100 || typeof body.text !== "string" || (!body.text.trim() && !Array.isArray(body.attachments))) return fail("Invalid synthetic prompt");
        if (body.text.startsWith("/") && body.text.trim() !== "/status") return fail("Unknown synthetic command; only /status is supported", 422);
        if (body.model && JSON.stringify(body.model) !== JSON.stringify(models[0]!.selection)) return fail("Unknown synthetic model", 422);
        if (body.mode || body.variant) return fail("Synthetic agent has no modes or variants", 422);
        if (snapshot.items.length >= 200 || (snapshot.queued?.length ?? 0) >= 8) return fail("Synthetic conversation capacity reached", 409);
        if (body.model) { snapshot.configuration = { model: models[0]!.selection }; emit(id, { type: "conversation.configuration", configuration: snapshot.configuration }); }
        const messageId = `synthetic-message-${++serial}`, text = body.text === "/status" ? "Synthetic status request" : "Synthetic prompt (input discarded)";
        const held = snapshot.conversation.status === "running";
        if (held) { snapshot.queued ??= []; snapshot.queued.push({ id: messageId, text, requestId: body.requestId, queuedAt: initial.conversation.createdAt }); emit(id, { type: "conversation.queue", queued: snapshot.queued, change: { kind: "held", messageId } }); }
        else { const item = { id: `message:${messageId}`, type: "user_message" as const, text, requestId: body.requestId, createdAt: initial.conversation.createdAt }; snapshot.items.push(item); emit(id, { type: "item.upsert", item }); status(id, "running"); }
        return json({ messageId, held, configuration: snapshot.configuration, conversation: snapshot.conversation });
      }
      if (action === "/cancel" && request.method === "POST") { const cancelled = snapshot.conversation.status === "running"; status(id, "interrupted"); return json({ cancelled }); }
      if (action.startsWith("/queue/") && request.method === "DELETE") {
        const messageId = decodeURIComponent(action.slice(7)); const before = snapshot.queued?.length ?? 0;
        snapshot.queued = snapshot.queued?.filter(item => item.id !== messageId) ?? [];
        if (snapshot.queued.length === before) return fail("Unknown synthetic queued message", 404);
        emit(id, { type: "conversation.queue", queued: snapshot.queued, change: { kind: "removed", messageId } }); return json({ removed: true });
      }
      return fail("Unsupported synthetic conversation action (no provider capability)", 501);
    },
  };
}
