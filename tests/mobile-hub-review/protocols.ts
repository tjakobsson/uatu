import type { StatePayload } from "../../src/shared/types";
import type { ConversationSnapshot, AgentChatStatus } from "../../src/chat/types";
import { FIXTURE_TIME } from "./backend";
import { continuityCorpus, continuityDocument, continuityConversation } from "./continuity-fixture";
import { createChatProtocolModel } from "./chat-protocol-model";
import { createTerminalProtocolModel } from "./terminal-protocol-model";

export const conversationId = "review:conversation-1";
export const terminalId = "11111111-1111-4111-8111-111111111111";
export const corpus: StatePayload = {
  workspaceApiRevision: 14, roots: [{ id: "synthetic", label: "Atlas", path: "/synthetic/atlas", hiddenCount: 0, docs: [{ id: "readme", rootId: "synthetic", name: "README.md", relativePath: "README.md", mtimeMs: FIXTURE_TIME, kind: "markdown" }] }],
  repositories: [], compareTarget: "base", initialFollow: false, defaultDocumentId: "readme", changedId: null, generatedAt: FIXTURE_TIME,
  build: { version: "review", branch: "synthetic", commitSha: "0000000", commitShort: "0000000", release: false, identifier: "synthetic@0000000", bundledWebRevision: 1 }, scope: { kind: "folder" }, terminal: "enabled",
};
const initialConversation: ConversationSnapshot = {
  conversation: { id: conversationId, title: "Synthetic conversation", createdAt: FIXTURE_TIME, updatedAt: FIXTURE_TIME, status: "idle", agent: { id: "review", name: "Synthetic agent" } },
  configuration: {}, generation: "review-1", cursor: "review-1:0", items: [], queued: [],
};
const statuses: AgentChatStatus[] = [{ agent: { id: "review", name: "Synthetic agent" }, availability: { state: "ready", version: "review-only", agent: { id: "review", name: "Synthetic agent", capabilities: ["attachments", "models", "commands", "conversation-rename"] } } }];

const attachmentPng = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6p1sAAAAASUVORK5CYII="), c => c.charCodeAt(0));

/** A bounded memory-only transport double, not the production service/router.
 * Upload bytes are discarded; a fixed harmless PNG is served for references.
 * This deliberately does not claim attachment sniffing/provider correctness. */
export function createWorkspaceProtocols() {
  const chat = createChatProtocolModel(initialConversation);
  const terminal = createTerminalProtocolModel(terminalId, FIXTURE_TIME);
  let conversation = structuredClone(initialConversation);
  let expandedCorpus: StatePayload | null = null;
  const currentCorpus = () => expandedCorpus ?? corpus;
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const chatStreams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const uploads = new Set<(response: Response) => void>();
  let holdUploads = false;
  let uploaded = false;
  let uploadAttempts = 0;
  let epoch = 0;
  const encoder = new TextEncoder();
  const channels = new Map<ReadableStreamDefaultController<Uint8Array>, string>();
  chat.subscribe((id, frame) => { for (const [controller, channel] of channels) if (channel === id) { try { controller.enqueue(encoder.encode(frame)); } catch { channels.delete(controller); } } });
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const sse = (request: Request, initial: string, chat = false, channel?: string) => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const close = () => { channels.delete(controller); chatStreams.delete(controller); if (streams.delete(controller)) { try { controller.close(); } catch {} } };
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; streams.add(c); if (chat) chatStreams.add(c); c.enqueue(encoder.encode(initial)); request.signal.addEventListener("abort", close, { once: true }); }, cancel() { channels.delete(controller); streams.delete(controller); chatStreams.delete(controller); request.signal.removeEventListener("abort", close); } });
    if (channel) channels.set(controller!, channel);
    request.signal.addEventListener("abort", () => channels.delete(controller), { once: true });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
  };
  const uploadResult = () => { uploaded = true; return json({ id: "synthetic-attachment", mimeType: "image/png", sizeBytes: attachmentPng.byteLength }); };
  return {
    terminal,
    documentPathAllowed(path: string) { return currentCorpus().roots.some(root => root.docs.some(doc => `/${doc.relativePath}` === path)); },
    snapshot: () => ({ uploadAttempts, pendingUploads: uploads.size, streams: streams.size }),
    enableContinuityFixture() { expandedCorpus = continuityCorpus(corpus); conversation = continuityConversation(initialConversation); chat.reset(conversation); },
    holdUploads() { holdUploads = true; },
    emitChat(id = conversationId) {
      return chat.complete(id);
    },
    settleUploads(fail = false) { holdUploads = false; for (const settle of uploads) settle(fail ? json({ error: "Synthetic upload failure" }, 503) : uploadResult()); uploads.clear(); },
    reset() { chat.reset(); terminal.reset(); channels.clear(); epoch++; expandedCorpus = null; conversation = structuredClone(initialConversation); uploaded = false; holdUploads = false; uploadAttempts = 0; for (const settle of uploads) settle(json({ error: "Synthetic review reset" }, 409)); uploads.clear(); for (const c of streams) { try { c.close(); } catch {} } streams.clear(); chatStreams.clear(); },
    async handle(request: Request, url: URL): Promise<Response | null> {
      const path = url.pathname;
      const queries: Record<string, string[]> = {
        "/api/state": ["compareTarget", "scope"], "/api/events": ["compareTarget", "scope", "reconnect"], "/api/document": ["compareTarget", "scope", "id", "view"],
        "/api/chat/models": ["agent"], "/api/chat/commands": ["agent"], "/api/chat/modes": ["agent"], "/api/chat/conversations/events": ["reconnect"],
        [`/api/chat/conversations/${encodeURIComponent(conversationId)}`]: ["limit"],
        [`/api/chat/conversations/${encodeURIComponent(conversationId)}/events`]: ["cursor", "reconnect"],
      };
      const conversationRoute = /^\/api\/chat\/conversations\/([^/]+)(\/events)?$/.exec(path);
      const allowedQuery = new Set(conversationRoute && conversationRoute[1] !== "events" ? conversationRoute[2] ? ["cursor", "reconnect"] : ["cursor", "limit"] : queries[path] ?? []);
      if ([...url.searchParams.keys()].some(key => !allowedQuery.has(key))) return json({ error: "Unsupported synthetic query" }, 400);
      for (const key of allowedQuery) if (url.searchParams.getAll(key).length > 1) return json({ error: "Duplicate synthetic query" }, 400);
      if (url.searchParams.has("compareTarget") && url.searchParams.get("compareTarget") !== "base") return json({ error: "Missing synthetic comparison contract" }, 501);
      if (url.searchParams.has("scope") && url.searchParams.get("scope") !== "folder") return json({ error: "Missing synthetic scope contract" }, 501);
      const terminalResponse = await terminal.handle(request, url); if (terminalResponse) return terminalResponse;
      const chatResponse = await chat.handle(request, url); if (chatResponse) return chatResponse;
      if (request.method === "GET" && path === "/api/chat/conversations/events") return sse(request, ": synthetic inventory stream\n\n", false, "inventory");
      if (request.method === "GET" && conversationRoute?.[2]) {
        const id = decodeURIComponent(conversationRoute[1]!);
        if (!chat.has(id)) return json({ error: "Unknown synthetic conversation" }, 404);
        return sse(request, chat.replay(id, url.searchParams.get("cursor")), false, id);
      }
      if (request.method === "GET") {
        if (path === "/api/state") return json(currentCorpus());
        if (path === "/api/personal-state") return json({ version: 1 });
        if (path === "/api/events") return sse(request, `event: state\ndata: ${JSON.stringify(currentCorpus())}\n\n`);
        if (path === "/api/document") {
          const document = currentCorpus().roots.flatMap(root => root.docs).find(doc => doc.id === url.searchParams.get("id"));
          if (!document || !["rendered", "source"].includes(url.searchParams.get("view") ?? "rendered")) return json({ error: "Unknown synthetic document/view" }, 404);
          const view = url.searchParams.get("view") ?? "rendered";
          if (expandedCorpus) return json({ id: document.id, title: "Synthetic review document", path: document.relativePath, kind: "markdown", view, language: "markdown", html: view === "rendered" ? continuityDocument : '<pre class="uatu-source-pre"><code># Synthetic continuity document</code></pre>' });
          return json({ id: "readme", title: "Synthetic review document", path: "README.md", kind: "markdown", view, language: "markdown", html: view === "source" ? '<pre class="uatu-source-pre"><code># Synthetic review document\n\nNo live workspace was read.</code></pre>' : '<h1 id="synthetic-review-document">Synthetic review document</h1><p>No live workspace was read.</p>' });
        }
        if (path === "/api/auth") return new Response(null, { status: 204 });
        if (path === "/api/terminal/sessions") return json({ sessions: [{ id: terminalId, label: "Synthetic terminal", attached: false, createdAt: FIXTURE_TIME }] });
        if (path === "/api/chat/status") return json({ agents: statuses });
        if (path === "/api/chat/conversations") return json({ conversations: [conversation.conversation] });
        if (path === "/api/chat/conversations/events") return sse(request, ": synthetic inventory stream\n\n");
        if (["/api/chat/models", "/api/chat/commands", "/api/chat/modes"].includes(path)) {
          if (url.searchParams.get("agent") !== "review") return json({ error: "Unknown synthetic agent" }, 404);
          return json({ [path.split("/").pop()!]: [] });
        }
        if (path === `/api/chat/conversations/${encodeURIComponent(conversationId)}`) return json(conversation);
        if (path === `/api/chat/conversations/${encodeURIComponent(conversationId)}/events`) return sse(request, ": synthetic chat stream\n\n", true);
        if (path === "/api/chat/attachments/synthetic-attachment" && uploaded) return new Response(attachmentPng, { headers: { "Content-Type": "image/png" } });
      }
      const attachmentRoute = /^\/api\/chat\/conversations\/([^/]+)\/attachments$/.exec(path);
      if (request.method === "POST" && attachmentRoute) {
        if (!chat.has(decodeURIComponent(attachmentRoute[1]!))) return json({ error: "Unknown synthetic upload conversation" }, 404);
        uploadAttempts++;
        // Drain a bounded body without parsing/retaining filenames or file bytes.
        const reader = request.body?.getReader(); let size = 0;
        if (!reader) return json({ error: "Missing synthetic upload body" }, 400);
        const started = epoch;
        while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 1_048_576) { await reader.cancel(); return json({ error: "Review upload limit is 1 MiB" }, 413); } }
        if (started !== epoch) return json({ error: "Synthetic review reset" }, 409);
        if (!holdUploads) return uploadResult();
        return new Promise<Response>(resolve => {
          const settle = (response: Response) => { uploads.delete(settle); request.signal.removeEventListener("abort", abort); resolve(response); };
          const abort = () => settle(json({ error: "Synthetic upload aborted" }, 409));
          uploads.add(settle); request.signal.addEventListener("abort", abort, { once: true });
          if (request.signal.aborted) abort();
        });
      }
      return null;
    },
  };
}
