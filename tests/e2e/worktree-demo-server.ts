#!/usr/bin/env bun
// Only this process serves the demo. Assets are bundled in memory; all
// workspace APIs are finite, in-memory adapters, with no production fallback.
import type { Server, ServerWebSocket } from "bun";
import { worktreePage, type WorktreePresentation } from "../../src/hub/worktree-pages";
import { dashboardPage } from "../../src/hub/pages";
import { escapeHtml as h } from "../../src/shared/html";
import { scenarios, WorktreeDemoState, type Scenario } from "./worktree-demo-state";
import { DemoWorkspaceContext } from "./worktree-demo-context";
import { DEMO_BUILD } from "./worktree-demo-build";
import { parsePersonalWorkspaceState } from "../../src/shell/personal-state";
import { dashboardScenarioScript } from "./worktree-demo-layout";

const ACTIONS = new Set(["create", "fetch", "register", "start", "delete", "forget", "rename", "refresh", "settings"]);
const VIEWS = new Set(["inventory", "create", "result", "settings", "delete", "forget", "configure", "rename", "folder", "onboarding"]);
type SocketData = { context: DemoWorkspaceContext; id: string };
type Stream = { controller: ReadableStreamDefaultController<Uint8Array>; ws: string; abort: AbortController; subscriptions: Map<string, { topic: string; key?: string }> };
let assets: Promise<Map<string, Blob>> | undefined;
function bundleAssets() {
  return assets ??= (async () => {
    const result = await Bun.build({ entrypoints: [new URL("../../src/index.html", import.meta.url).pathname, new URL("./worktree-demo-client.ts", import.meta.url).pathname], target: "browser", minify: true, define: { __UATU_BUILD__: JSON.stringify(DEMO_BUILD) } });
    if (!result.success) throw new Error(result.logs.join("\n"));
    return new Map(result.outputs.map(output => [`/${output.path.split("/").pop()}`, output]));
  })();
}

export function createWorktreeDemo(options: { publicOrigin?: string } = {}) {
  const publicUrl = options.publicOrigin === undefined ? undefined : new URL(options.publicOrigin);
  if (publicUrl && (publicUrl.protocol !== "https:" || publicUrl.origin !== options.publicOrigin || publicUrl.username || publicUrl.password)) {
    throw new Error("UATU_WORKTREE_DEMO_ORIGIN must be an exact HTTPS origin (no path, credentials, query or fragment)");
  }
  const state = new WorktreeDemoState();
  const contexts = new Map<string, DemoWorkspaceContext>();
  const streams = new Map<string, Stream>();
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const delays = new Map<string, number>();
  const pendingReads = new Set<() => void>();
  const encoder = new TextEncoder();
  const context = (id: string) => {
    const row = state.rows.find(row => row.id === id);
    if (!row) return null;
    if (!contexts.has(id)) contexts.set(id, new DemoWorkspaceContext(id, row.name, state.generation, row.path));
    return contexts.get(id)!;
  };
  const send = (stream: Stream, name: string, data: unknown) => {
    try { stream.controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { stream.abort.abort(); }
  };
  const invalidate = () => { for (const stream of streams.values()) send(stream, "worktrees", { ws: stream.ws }); };
  const closeStreams = () => {
    for (const stream of streams.values()) { stream.abort.abort(); try { stream.controller.close(); } catch {} }
    streams.clear();
  };
  const resetContexts = () => {
    delays.clear(); for (const release of pendingReads) release(); pendingReads.clear();
    closeStreams();
    for (const socket of sockets) socket.close();
    sockets.clear();
    for (const workspace of contexts.values()) workspace.dispose();
    contexts.clear();
  };
  const controls = () => `<aside id="demo-controls"><details><summary>SIMULATION · scenarios and reset</summary><p>Actual Uatu frontend · all workspace data and operations simulated. No Git, shells, credentials or providers.</p><form><label>Scenario<select name="scenario">${Object.entries(scenarios).map(([key, label]) => `<option value="${key}"${state.scenario === key ? " selected" : ""}>${h(label)}</option>`).join("")}</select></label><label>Operation latency<select name="latency"><option value="0">Instant</option><option value="1200">Slow · 1.2 seconds</option><option value="3000">Very slow · 3 seconds</option></select></label><button>Reset scenario</button></form><button id="demo-discover">Simulate external discovery</button><button id="demo-reconnect">Simulate disconnect / reconnect</button><a href="/__demo/ledger" target="_blank">Request ledger</a></details></aside><style>#demo-controls{position:fixed;right:8px;bottom:58px;z-index:1000;max-width:min(420px,calc(100vw - 16px));padding:8px;border:1px solid #b68400;border-radius:8px;background:light-dark(#fff8d8,#332b10);color:light-dark(#302400,#fff1bc);font:12px system-ui}#demo-controls details[open]{max-height:55dvh;overflow:auto}#demo-controls summary{cursor:pointer}#demo-controls label{display:grid;margin:8px 0}#demo-controls button,#demo-controls select{min-height:36px;max-width:100%;margin:4px}#demo-controls a{color:inherit}</style>`;
  async function attach(stream: Stream, subscriptions: Array<{ topic: string; key?: string }>) {
    const workspace = context(stream.ws);
    if (!workspace) return;
    for (const subscription of subscriptions) {
      stream.subscriptions.set(`${subscription.topic}:${subscription.key ?? ""}`, subscription);
      const envelope = { ws: stream.ws, topic: subscription.topic, key: subscription.key, cursor: "demo" };
      if (subscription.topic === "document") send(stream, "live", { ...envelope, event: { kind: "data", data: workspace.snapshot() } });
      if (subscription.topic === "conversation" && subscription.key) {
        try {
          const { events } = await workspace.chat.subscribe(subscription.key, { signal: stream.abort.signal });
          void (async () => { for await (const entry of events) {
            if (stream.abort.signal.aborted) break;
            send(stream, "live", { ...envelope, cursor: `${entry.generation}:${entry.sequence}`, event: { kind: "data", data: entry } });
          } })();
        } catch { /* unavailable conversation stays isolated */ }
      }
      send(stream, "live", { ...envelope, event: { kind: "ready" } });
    }
  }
  function fetchHandler(request: Request): Promise<Response>;
  function fetchHandler(request: Request, server: Server<SocketData>): Promise<Response | undefined>;
  async function fetchHandler(request: Request, server?: Server<SocketData>): Promise<Response | undefined> {
    const url = new URL(request.url), path = url.pathname;
    const entry = { method: request.method, path, outcome: "pending" }; state.ledger.push(entry);
    const json = (value: unknown, status = 200) => {
      const response = Response.json(value, { status, headers: { "cache-control": "no-store" } });
      const delay = request.method === "GET" ? delays.get(path) : undefined;
      if (delay === undefined) { entry.outcome = String(status); return response; }
      delays.delete(path); entry.outcome = "pending delayed read";
      const generation = state.generation;
      return new Promise<Response>(resolve => {
        const release = () => { clearTimeout(timer); pendingReads.delete(release); entry.outcome = generation === state.generation ? `${status} delayed read` : "409 reset cancelled"; resolve(generation === state.generation ? response : Response.json({ error: "Reset cancelled read" }, { status: 409 })); };
        const timer = setTimeout(release, delay); pendingReads.add(release);
      });
    };
    const html = (content: string) => { entry.outcome = "200 presentation"; return new Response(content, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'" } }); };
    if (request.headers.has("host") && request.headers.get("host") !== url.host) return json({ error: "Host mismatch" }, 403);
    const external = publicUrl !== undefined && url.host === publicUrl.host && ["http:", "https:"].includes(url.protocol);
    const navigationOrigin = external ? publicUrl!.origin : url.origin;
    if (!external && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return json({ error: "Loopback or configured host required" }, 403);
    if (!["GET", "HEAD"].includes(request.method) || request.headers.get("upgrade") === "websocket") {
      const expectedOrigin = external ? publicUrl!.origin : url.origin;
      if (request.headers.has("origin") && request.headers.get("origin") !== expectedOrigin) return json({ error: "Same-origin required" }, 403);
    }
    const requestedGeneration = request.headers.get("x-demo-generation");
    if (requestedGeneration !== null && Number(requestedGeneration) !== state.generation) return json({ error: "Scenario reset cancelled pending simulation" }, 409);
    if (request.method === "POST" && path === "/__demo/reset") {
      const form = await request.formData(), scenario = String(form.get("scenario") ?? "populated");
      if (!(scenario in scenarios)) return json({ error: "Unknown scenario" }, 400);
      state.reset(scenario as Scenario, Number(form.get("latency"))); resetContexts();
      return json({ redirect: "/s/atlas/" });
    }
    if (request.method === "POST" && path === "/__demo/discover") { state.discover(); invalidate(); return json({ ok: true }); }
    if (request.method === "POST" && path === "/__demo/reconnect") { state.discover(); closeStreams(); return json({ ok: true }); }
    if (request.method === "POST" && path === "/__demo/delay") {
      const body = await request.json() as { ws: string; route: string; ms: number };
      if (!state.rows.some(row => row.id === body.ws) || !["/api/document", "/api/terminal/sessions", "/api/chat/conversations"].includes(body.route)) return json({ error: "Unknown delay target" }, 400);
      delays.set(`/s/${body.ws}${body.route}`, Math.min(5000, Math.max(0, body.ms))); return json({ ok: true });
    }
    if (request.method === "POST" && path === "/__demo/late-event") {
      const body = await request.json() as { ws: string };
      const workspace = context(body.ws); if (!workspace) return json({ error: "Unknown workspace" }, 404);
      for (const stream of streams.values()) for (const subscription of stream.subscriptions.values()) {
        const data = subscription.topic === "document" ? workspace.snapshot() : subscription.topic === "inventory" ? { type: "conversation.inventory" } : { type: "item.upsert", generation: workspace.chat.generation, sequence: 1, conversationId: `demo-${body.ws}:conversation-1`, item: { id: "late-source-only", type: "assistant_message", createdAt: 1, markdown: `Late transcript from ${body.ws}` } };
        send(stream, "live", { ws: body.ws, ...subscription, cursor: "late-demo", event: { kind: "data", data } });
      }
      for (const socket of sockets) if (socket.data.context.id === body.ws) socket.send(encoder.encode(`\r\nLate output for ${body.ws} only\r\n`));
      return json({ ok: true });
    }
    if (request.method === "POST" && path === "/__demo/inventory") {
      const body = await request.json() as { ws: string };
      for (const stream of streams.values()) if (stream.ws === body.ws) send(stream, "live", { ws: body.ws, topic: "inventory", cursor: "demo-inventory", event: { kind: "data", data: { type: "conversation.inventory" } } });
      return json({ ok: true });
    }
    if (request.method === "GET" && path === "/__demo/generation") return json({ generation: state.generation });
    if (request.method === "GET" && path === "/__demo/ledger") return json({ simulation: true, ledger: state.ledger, rows: state.rows, branches: state.branches, sourceSelection: state.sourceSelection, generation: state.generation,
      contexts: await Promise.all([...contexts.values()].map(async workspace => ({ id: workspace.id, personal: workspace.personal, files: [...workspace.files.keys()], terminals: [...workspace.terminals.values()], conversations: await workspace.chat.listConversations() }))) });
    if (request.method === "GET" && path === "/api/hub/credentials") return json({ credentials: [] });
    if (request.method === "GET" && path === "/api/hub/state") return json({ worktreeNavigation: "/worktrees", dashboardWorktreeNavigation: "/hub-worktrees", workspaces: state.rows.filter(row => row.registered).map(row => {
      const policy = state.effective(row);
      return { id: row.id, displayName: row.name, path: row.path, running: row.running, parentId: row.parentId, repositoryId: row.repositoryId, branch: row.branch, detached: row.detached, sourceRef: row.sourceRef, ownership: row.ownership, availability: row.availability,
        credentialAssignments: { authentication: policy.authentication && policy.authentication !== "none" ? [policy.authentication] : [], signing: policy.signing && policy.signing !== "none" ? [policy.signing] : [] },
        ...(row.ownership === "main" ? { createWorktree: `/worktrees?view=create&source=${row.id}` } : {}), policy };
    }) });
    if (request.method === "GET" && path === "/api/hub/live") {
      const ws = url.searchParams.get("ws") ?? "atlas";
      if (!context(ws)) return json({ error: "Unknown workspace" }, 404);
      const id = crypto.randomUUID();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const stream: Stream = { controller, ws, abort: new AbortController(), subscriptions: new Map() }; streams.set(id, stream);
          send(stream, "demo-generation", { generation: state.generation });
          controller.enqueue(encoder.encode("retry: 250\n: open\n\n")); send(stream, "hello", { streamId: id });
          for (const row of state.rows) send(stream, "live", { ws: row.id, topic: "activity", cursor: "", event: { kind: "data", data: { running: row.running, working: false, awaiting: false } } });
          void attach(stream, JSON.parse(url.searchParams.get("subs") ?? "[]"));
        },
        cancel() { streams.get(id)?.abort.abort(); streams.delete(id); },
      });
      entry.outcome = "200 simulated stream";
      return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    }
    const subscription = /^\/api\/hub\/live\/([^/]+)\/subscriptions$/.exec(path);
    if (request.method === "POST" && subscription) {
      const stream = streams.get(subscription[1]!);
      if (!stream) return json({ error: "Unknown stream" }, 404);
      const body = await request.json() as { add?: Array<{ topic: string; key?: string }> };
      await attach(stream, body.add ?? []); return json({ ok: true });
    }
    const start = /^\/api\/hub\/sessions\/([^/]+)\/start$/.exec(path);
    if (request.method === "POST" && start) {
      state.mutate("start", { id: start[1]! }); invalidate();
      return json(state.error ? { error: state.message } : { ok: true }, state.error ? 409 : 200);
    }
    const stop = /^\/api\/hub\/sessions\/([^/]+)\/stop$/.exec(path);
    if (request.method === "POST" && stop) {
      const row = state.rows.find(row => row.id === stop[1]);
      if (!row) return json({ error: "Unknown workspace" }, 404);
      if (state.scenario === "stop-failure") return json({ error: "Could not stop the simulated session. No state changed." }, 409);
      row.running = false; invalidate(); return json({ ok: true });
    }
    const rename = /^\/api\/hub\/workspaces\/([^/]+)\/display-name$/.exec(path);
    if (request.method === "POST" && rename) {
      const body = await request.json() as { displayName?: string };
      state.mutate("rename", { id: rename[1]!, name: body.displayName ?? "" });
      invalidate(); return json(state.error ? { error: state.message } : { ok: true }, state.error ? 409 : 200);
    }
    const forget = /^\/api\/hub\/workspaces\/([^/]+)\/forget$/.exec(path);
    if (request.method === "POST" && forget) {
      const row = state.rows.find(row => row.id === forget[1]);
      if (!row || row.running) return json({ error: "Stop the registered workspace before removing it from Hub." }, 409);
      state.mutate("forget", { id: row.id, source: row.parentId ?? row.id, confirm: "1" });
      contexts.get(row.id)?.dispose(); contexts.delete(row.id);
      invalidate(); return json(state.error ? { error: state.message } : { ok: true }, state.error ? 409 : 200);
    }
    const operationPrefix = path.startsWith("/hub-worktrees/") ? "/hub-worktrees" : "/worktrees";
    if (request.method === "POST" && path.startsWith(`${operationPrefix}/`)) {
      const action = path.slice(operationPrefix.length + 1);
      if (!ACTIONS.has(action)) return json({ error: "Unknown mutation refused; no backend fallback" }, 405);
      const fields = new Set(["source", "configuration", "mode", "selection", "query", "branch", "base", "name", "local", "remote", "cached", "start", "authentication", "signing", "fetchCredential", "id", "confirm"]);
      const data = Object.fromEntries([...await request.formData()].filter(([key]) => fields.has(key)).map(([key, value]) => [key, String(value)]));
      for (const [field, allowed] of [["authentication", ["none", "demo-auth"]], ["signing", ["none", "demo-signing"]], ["fetchCredential", ["none", "demo-auth"]]] as const) {
        if (data[field] !== undefined && !(allowed as readonly string[]).includes(data[field]!)) return json({ error: "Only synthetic credential selections are accepted; no secret is retained" }, 400);
      }
      const generation = state.generation;
      await Bun.sleep(state.latency);
      if (generation !== state.generation) return json({ error: "Scenario reset cancelled pending simulation" }, 409);
      const redirect = state.mutate(action, data).replace(/^\/worktrees/, operationPrefix);
      for (const [id, workspace] of contexts) if (!state.rows.some(row => row.id === id && row.registered)) { workspace.dispose(); contexts.delete(id); }
      const destination = new URL(redirect, navigationOrigin);
      const completed = state.rows.find(row => row.id === destination.searchParams.get("id"));
      const completion = !state.error && ((action === "create" || action === "register") && completed
        ? { message: `${action === "register" && completed.ownership !== "uatu" ? "Registered" : "Created"} ${completed.branch}`, id: completed.id, source: completed.parentId ?? completed.id }
        : action === "delete" ? { message: "Worktree deleted. Branch kept.", deleted: data.id, source: data.source ?? "atlas" } : undefined);
      invalidate(); return json({ redirect, ...(completion ? { completion } : {}) });
    }
    const session = /^\/s\/([a-z0-9-]+)\/(.*)$/.exec(path);
    if (session) {
      const navigationGeneration = url.searchParams.get("demoGeneration");
      if (request.method === "GET" && request.headers.get("accept")?.includes("text/html") && navigationGeneration !== null && Number(navigationGeneration) !== state.generation) { entry.outcome = "302 reset navigation"; return Response.redirect(`${navigationOrigin}/s/atlas/`, 302); }
      const workspace = context(session[1]!);
      const row = state.rows.find(row => row.id === session[1]);
      if (!workspace || !row?.registered || !row.running || row.availability) return json({ error: "Fixture workspace is not running" }, 409);
      const route = `/${session[2]}`, method = request.method;
      if (route === "/api/state" && method === "GET") return json(workspace.snapshot());
      if (route === "/api/personal-state" && method === "GET") return json(workspace.personal);
      if (route === "/api/personal-state" && method === "PATCH") { workspace.personal = parsePersonalWorkspaceState({ ...workspace.personal, ...await request.json() }); return json(workspace.personal); }
      if (route === "/api/document" && method === "GET") { const result = workspace.render(url.searchParams.get("id") ?? "", url.searchParams.get("view")); return result ? json(result) : json({ error: "Unknown document" }, 404); }
      if (route === "/api/auth" && method === "GET") { entry.outcome = "204 synthetic auth"; return new Response(null, { status: 204 }); }
      if (route === "/api/terminal/sessions" && method === "GET") return json({ sessions: [...workspace.terminals.values()].map(({ output, ...session }) => session) });
      if (route === "/api/terminal/sessions" && method === "POST") {
        const session = { id: crypto.randomUUID(), createdAt: Date.now(), attached: false };
        workspace.terminals.set(session.id, { ...session, output: `\r\nSIMULATED TERMINAL — ${workspace.name}\r\ncheckout: ${workspace.path}\r\nNo commands are executed.\r\n${workspace.id}> ` });
        return json(session, 201);
      }
      const terminal = /^\/api\/terminal\/sessions\/([a-f0-9-]+)$/.exec(route);
      if (terminal && method === "DELETE") {
        if (!workspace.terminals.delete(terminal[1]!)) return json({ error: "Unknown terminal" }, 404);
        for (const socket of sockets) if (socket.data.context === workspace && socket.data.id === terminal[1]) socket.close();
        return json({ ok: true });
      }
      if (route === "/api/terminal" && request.headers.get("upgrade") === "websocket" && server) {
        const id = url.searchParams.get("sessionId");
        if (!id || !/^[a-f0-9-]{36}$/.test(id)) return json({ error: "Invalid terminal identity" }, 400);
        if (!workspace.terminals.has(id)) workspace.terminals.set(id, { id, createdAt: Date.now(), attached: false, output: `\r\nSIMULATED TERMINAL — ${workspace.id}\r\nNo shell is running.\r\n${workspace.id}> ` });
        if (server.upgrade(request, { data: { context: workspace, id } })) { entry.outcome = "101 simulated terminal"; return; }
        return json({ error: "Upgrade failed" }, 400);
      }
      if (route === "/api/chat/status" && method === "GET") return json({ agents: await workspace.chat.status() });
      if (route === "/api/chat/models" && method === "GET") return json({ models: await workspace.chat.models(`demo-${workspace.id}`) });
      if (route === "/api/chat/modes" && method === "GET") return json({ modes: await workspace.chat.modes(`demo-${workspace.id}`) });
      if (route === "/api/chat/commands" && method === "GET") return json({ commands: await workspace.chat.commands(`demo-${workspace.id}`) });
      if (route === "/api/chat/conversations" && method === "GET") return json({ conversations: await workspace.chat.listConversations() });
      if (route === "/api/chat/conversations" && method === "POST") return json(await workspace.chat.createConversation(`demo-${workspace.id}`), 201);
      const chat = /^\/api\/chat\/conversations\/([^/]+)(?:\/(prompts|attachments|undo|redo))?$/.exec(route);
      if (chat) {
        const id = decodeURIComponent(chat[1]!);
        if (!id.startsWith(`demo-${workspace.id}:`)) return json({ error: "Conversation belongs to another workspace" }, 404);
        try {
          if (!chat[2] && method === "GET") return json(await workspace.chat.history(id));
          if (chat[2] === "prompts" && method === "POST") { const body = await request.json(); return json(await workspace.chat.prompt(id, body.requestId, body.text), 202); }
          if (chat[2] === "attachments" && method === "POST") { const file = (await request.formData()).get("file"); if (!(file instanceof Blob)) return json({ error: "Image required" }, 400); return json(await workspace.chat.saveAttachment(new Uint8Array(await file.arrayBuffer())), 201); }
        } catch (error) { return json({ error: String(error) }, 400); }
      }
      const attachment = /^\/api\/chat\/attachments\/([^/]+)$/.exec(route);
      if (attachment && method === "GET") { const stored = workspace.attachments.get(attachment[1]!); if (!stored) return json({ error: "Unknown image" }, 404); entry.outcome = "200 in-memory attachment"; return new Response(Uint8Array.from(stored.bytes), { headers: { "content-type": stored.record.mimeType } }); }
      if (method === "GET") {
        const bundle = await bundleAssets();
        const base = `/s/${workspace.id}/`;
        if (route === "/" || workspace.files.has(decodeURIComponent(session[2]!))) {
          const shell = await bundle.get("/index.html")!.text();
          const relocated = shell.replace(/(src|href)="([^"]+)"/g, (match, attr: string, value: string) => {
            const name = `/${value.split("/").pop()}`;
            if (bundle.has(name)) return `${attr}="${base}${name.slice(1)}"`;
            return value.startsWith("/") && !value.startsWith("//") ? `${attr}="${base}${value.slice(1)}"` : match;
          });
          return html(relocated.replace("<head>", `<head><meta name="uatu-base-path" content="${base}"><meta name="demo-generation" content="${state.generation}"><script src="/__demo/client.js"></script>`).replace("</body>", `${controls()}</body>`));
        }
        const asset = bundle.get(route);
        if (asset) { entry.outcome = "200 bundled asset"; const body = asset.type.includes("css") ? (await asset.text()).replace(/url\(\s*(['"]?)\/(?!\/)/g, `url($1${base}`) : asset; return new Response(body, { headers: { "content-type": asset.type } }); }
        if (route === "/manifest.webmanifest") return json({ name: "Uatu simulated workspaces", start_url: base, display: "standalone" });
      }
      return json({ error: "Unknown session route; no production fallback" }, 404);
    }
    if (request.method === "GET" && path === "/__demo/client.js") { const bundle = await bundleAssets(); entry.outcome = "200 test-only controls"; return new Response(bundle.get("/worktree-demo-client.js")!, { headers: { "content-type": "text/javascript" } }); }
    if (request.method === "GET" && path === "/hub-assets/mono.woff2") { const bundle = await bundleAssets(); entry.outcome = "200 bundled font"; return new Response([...bundle.entries()].find(([name]) => name.endsWith(".woff2"))![1]); }
    if (request.method === "GET" && path === "/worktrees" && url.searchParams.get("fragment") !== "1") { entry.outcome = "302 real frontend"; return Response.redirect(`${navigationOrigin}/s/atlas/`, 302); }
    if (request.method === "GET" && path === "/") return html(dashboardPage("Demo reviewer").replace("<head>", `<head>${dashboardScenarioScript}`).replace("</body>", '<aside class="wt-notice">SIMULATION · no real Git, credentials or processes. <a href="/s/atlas/">Open actual workspace</a></aside></body>'));
    if (request.method === "GET" && path === "/hub-worktrees" && url.searchParams.get("fragment") !== "1") {
      const target = `${path}${url.search}`;
      return html(dashboardPage("Demo reviewer").replace("<head>", `<head>${dashboardScenarioScript}`).replace("</body>", `<aside>SIMULATION · no real Git, credentials or processes.</aside><script>window.addEventListener('load',()=>openWorktreePicker(${JSON.stringify(target).replace(/</g, "\\u003c")},document.body))</script></body>`));
    }
    if (request.method === "GET" && ["/", "/worktrees", "/hub-worktrees", "/clone"].includes(path)) {
      const view = path === "/clone" ? "onboarding" : url.searchParams.get("view") ?? "inventory";
      if (!VIEWS.has(view)) return json({ error: "Unknown view" }, 404);
      const model = state.presentation(view as WorktreePresentation["view"], url.searchParams.get("id") ?? undefined, url.searchParams.get("source") ?? undefined);
      model.creationMode = url.searchParams.get("mode") ?? undefined;
      if (model.creationMode) { model.draft = {}; model.message = undefined; model.error = false; model.conflictId = undefined; }
      if (path !== "/worktrees") model.prefix = "/hub-worktrees";
      return html(worktreePage(model, path === "/worktrees" ? "" : '<aside class="wt-notice">SIMULATION · secondary Hub entry. No real Git, workspace children or persistent state. <a href="/s/atlas/">Return to actual workspace</a></aside>', "", url.searchParams.get("fragment") === "1"));
    }
    return json({ error: "Unknown route; isolated demo has no fallback" }, request.method === "GET" ? 404 : 405);
  }
  return { state, contexts, fetch: fetchHandler, close: resetContexts,
    websocket: {
      open(socket: ServerWebSocket<SocketData>) { sockets.add(socket); socket.data.context.terminals.get(socket.data.id)!.attached = true; },
      message(socket: ServerWebSocket<SocketData>, message: string | Buffer) {
        const terminal = socket.data.context.terminals.get(socket.data.id);
        if (!terminal || socket.data.context.generation !== state.generation) return;
        if (typeof message === "string") { try { if (JSON.parse(message).type === "attach-ready") socket.send(encoder.encode(terminal.output)); } catch {} }
        else { const output = `\r\n[simulated input received; no command executed]\r\n${socket.data.context.id}> `; terminal.output += output; socket.send(encoder.encode(output)); }
      },
      close(socket: ServerWebSocket<SocketData>) { sockets.delete(socket); const terminal = socket.data.context.terminals.get(socket.data.id); if (terminal) terminal.attached = false; },
    },
  };
}

if (import.meta.main) {
  await bundleAssets();
  const demo = createWorktreeDemo({ publicOrigin: process.env.UATU_WORKTREE_DEMO_ORIGIN });
  const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.UATU_WORKTREE_DEMO_PORT ?? "4788"), idleTimeout: 0, fetch: demo.fetch, websocket: demo.websocket });
  console.log(`uatu-worktree-demo ${JSON.stringify({ origin: server.url.origin, pid: process.pid })}`);
  process.on("SIGTERM", () => { demo.close(); server.stop(true); process.exit(0); });
}
