import { createServer } from "node:net";
import { reviewHostingOptions, reviewRequestAllowed, validatePublicOrigin } from "./hosting";
import { buildEvidenceAssets } from "./hosting-evidence";
import { frontendFingerprint } from "./hosting-identity";
import { buildDesignSystemAssets, designSystemPrefix } from "./design-system-assets";
import { createSyntheticBackend, type Scenario } from "./backend";
import { createWorkspaceProtocols, terminalId } from "./protocols";
import { controller, controllerScript, scenarios, controls, dispatchControl } from "./controller";
import { reviewMethods, deserializeReviewValue, createReviewPersonalState, type ReviewMethod } from "./transport";

export type ApprovedAsset = { body: Blob | string; type: string };
export type ReviewAssets = ReadonlyMap<string, ApprovedAsset>;

/** Build the real workspace HTML through a test-only entry substitution. No
 * copied workspace markup, repository static directory or request-derived reads. */
export async function buildWorkspaceAssets(): Promise<ReviewAssets> {
  const result = await Bun.build({ entrypoints: [new URL("../../src/index.html", import.meta.url).pathname], target: "browser", minify: false, sourcemap: "none", plugins: [{ name: "mobile-review-entry", setup(build) {
    build.onResolve({ filter: /app\.ts$/ }, args => args.importer.endsWith("index.html") ? { path: new URL("./browser-entry.ts", import.meta.url).pathname } : undefined);
  } }], define: { __UATU_BUILD__: JSON.stringify({ version: "review", branch: "synthetic", commitSha: "0000000", commitShort: "0000000", buildTime: "2026-07-02T00:00:00Z", release: false }) } });
  if (!result.success) throw new AggregateError(result.logs, "Review frontend build failed");
  const assets = new Map<string, ApprovedAsset>();
  for (const output of result.outputs) {
    const path = `/${output.path.replace(/^.*\//, "")}`;
    if (assets.has(path)) throw new Error(`Colliding review build asset: ${path}`);
    assets.set(path, { body: path === "/index.html" ? await output.text() : output, type: output.type });
  }
  if (!assets.has("/index.html")) throw new Error("Review build has no actual workspace document");
  const staticAssets = [
    ["/assets/uatu-logo.svg", "../../src/assets/uatu-logo.svg", "image/svg+xml"],
    ["/assets/icon-192.png", "../../src/assets/icon-192.png", "image/png"],
    ["/assets/icon-512.png", "../../src/assets/icon-512.png", "image/png"],
    ["/manifest.webmanifest", "../../src/assets/manifest.webmanifest", "application/manifest+json"],
    ["/assets/fonts/HackNerdFontMono-Regular.woff2", "../../src/assets/fonts/HackNerdFontMono-Regular.woff2", "font/woff2"],
    ["/assets/fonts/LICENSE-hack.md", "../../src/assets/fonts/LICENSE-hack.md", "text/plain"],
    ["/assets/fonts/LICENSE-nerdfonts.txt", "../../src/assets/fonts/LICENSE-nerdfonts.txt", "text/plain"],
    ["/assets/fonts/NOTICES.md", "../../src/assets/fonts/NOTICES.md", "text/plain"],
  ] as const;
  for (const [route, path, type] of staticAssets) assets.set(route, { body: new Blob([await Bun.file(new URL(path, import.meta.url)).arrayBuffer()], { type }), type });
  return assets;
}

export async function assertFreePort(port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid review port");
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(error => error ? reject(error) : resolve()));
  });
}

async function boundedBody(request: Request, limit: number): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > limit) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder(); let text = "", size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) return text + decoder.decode();
    size += next.value.byteLength;
    if (size > limit) { await reader.cancel(); return null; }
    text += decoder.decode(next.value, { stream: true });
  }
}

/** Test-only loopback listener. Requests carry no live session meaning; cookies
 * and Authorization are neither read, forwarded, set nor written into logs. */
export async function startReviewServer(options: { port?: number; assets?: ReviewAssets; publicOrigin?: string; evidenceAssets?: ReviewAssets; designSystemAssets?: ReviewAssets; instanceId?: string } = {}) {
  const port = options.port ?? 4703;
  const publicOrigin = validatePublicOrigin(options.publicOrigin);
  if ([4700, 4701, 4702].includes(port)) throw new Error("Reserved review backend port");
  await assertFreePort(port);
  const assets = options.assets ?? await buildWorkspaceAssets();
  const designSystemAssets = options.designSystemAssets ?? (options.assets ? new Map() : await buildDesignSystemAssets());
  const instanceId = options.instanceId ?? crypto.randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(instanceId)) throw new Error("Invalid review instance identity");
  const version = { kind: "frontend-content-sha256", fingerprint: await frontendFingerprint(assets) };
  const synthetic = createSyntheticBackend();
  const protocols = createWorkspaceProtocols();
  const personal = createReviewPersonalState(path => protocols.documentPathAllowed(`/${path}`), terminalId);
  // Common synthetic corpus, independent protocol generations and personal state.
  // Identity comes only from the registered backend model, never a host path.
  const realms = new Map([["atlas", { protocols, personal }]]);
  const realmFor = (id: string) => {
    let realm = realms.get(id);
    if (!realm) {
      const protocols = createWorkspaceProtocols();
      realm = { protocols, personal: createReviewPersonalState(path => protocols.documentPathAllowed(`/${path}`), terminalId) };
      realms.set(id, realm);
    }
    return realm;
  };
  const missing: Array<{ method: string; contract: string }> = [];
  let stopped = false;
  const sockets = new Set<import("bun").ServerWebSocket<{ ready: boolean; sessionId: string; workspaceId: string }>>();
  const invalidationStreams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  synthetic.backend.subscribeInvalidation(event => {
    for (const controller of invalidationStreams) { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch { invalidationStreams.delete(controller); } }
    for (const [id, realm] of realms) if (event.scope === "authentication" || (event.scope === "workspace" && event.workspaceId === id)) {
      realm.protocols.reset(); for (const socket of sockets) if (socket.data.workspaceId === id) socket.close(1000, "Synthetic session invalidated");
    }
  });
  const server = Bun.serve<{ ready: boolean; sessionId: string; workspaceId: string }>({
    hostname: "127.0.0.1", port,
    websocket: {
      open(ws) { sockets.add(ws); realmFor(ws.data.workspaceId).protocols.terminal.attached(ws.data.sessionId, true); },
      message(ws, message) {
        if (typeof message !== "string") return; // typed input bytes are discarded, never echoed or executed
        let frame: { type?: unknown; cols?: unknown; rows?: unknown };
        try { frame = JSON.parse(message); } catch { ws.close(1008, "Unknown synthetic terminal frame"); return; }
        if (frame.type === "attach-ready" && !ws.data.ready && Number.isInteger(frame.cols) && Number.isInteger(frame.rows)) { ws.data.ready = true; ws.send(new TextEncoder().encode("Synthetic terminal — no shell is running.\r\n")); return; }
        if (frame.type === "resize" && ws.data.ready) return;
        ws.close(1008, "Unsupported synthetic terminal frame");
      },
      close(ws, code) { sockets.delete(ws); const { protocols } = realmFor(ws.data.workspaceId); if (code === 4001) protocols.terminal.remove(ws.data.sessionId); if (![...sockets].some(other => other.data.workspaceId === ws.data.workspaceId && other.data.sessionId === ws.data.sessionId)) protocols.terminal.attached(ws.data.sessionId, false); },
    },
    async fetch(request) {
      const url = new URL(request.url);
      const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'" };
      const reply = (body: Blob | string, status = 200, type = "text/plain") => new Response(body, { status, headers: { ...headers, "Content-Type": type } });
      const json = (value: unknown, status = 200) => reply(JSON.stringify(value), status, "application/json");
      if (!reviewRequestAllowed(request, server.port!, publicOrigin)) return reply("Review host/origin rejected", 403);
      const canonical = /^\/s\/([a-zA-Z0-9._:-]+)\//.exec(url.pathname);
      const workspaceId = canonical?.[1] ?? "atlas";
      const workspace = synthetic.inspect().workspaces.find(w => w.id === workspaceId);
      // Unknown canonical identities still get the normal frontend recovery,
      // but cannot allocate a protocol realm or access any workspace API.
      const { protocols, personal } = workspace ? realmFor(workspaceId) : realms.get("atlas")!;
      if (canonical) url.pathname = url.pathname.slice(canonical[0].length - 1);
      const workspaceAvailable = () => !!workspace && workspace.runtime.status === "running";
      if (canonical && !workspace && url.pathname.startsWith("/review/")) return reply("Unknown synthetic workspace", 404);
      // Exact allowlist is authoritative even after WHATWG URL normalization.
      // Encodings/backslashes are never meaningful review asset names.
      if (/%|\\|\0/.test(url.pathname.replace(/\/api\/chat\/conversations\/review%3Aconversation-[0-9]+/, "/api/chat/conversations/synthetic"))) return reply("Invalid review path", 400);
      if (url.search && ((url.pathname.startsWith("/review/") && url.pathname !== "/review/clone-events") || url.pathname.startsWith("/api/hub/"))) return reply("Unexpected review query", 400);
      if (url.pathname === "/review/design-system" || url.pathname.startsWith(designSystemPrefix)) {
        if (canonical || request.method !== "GET") return reply("Unknown reference route", 404);
        if (url.pathname === designSystemPrefix) return new Response(null, { status: 308, headers: { ...headers, Location: "/review/design-system" } });
        const path = url.pathname === "/review/design-system" ? designSystemPrefix + "design-system.html" : url.pathname;
        const asset = designSystemAssets.get(path);
        return asset ? reply(asset.body, 200, asset.type) : reply("Unknown reference asset", 404);
      }
      if (url.pathname === "/api/hub/state" && request.method === "GET") {
        const result = await synthetic.backend.readWorkspaces();
        if (result.status !== "available") return json({ error: result.problem.message }, result.problem.kind === "unauthorized" ? 401 : 503);
        return json({ workspaces: result.value.map(w => ({ id: w.id, displayName: w.displayName, path: w.path, running: w.runtime.status === "running" })) });
      }
      if (url.pathname === "/api/hub/sessions" && request.method === "GET") {
        const result = await synthetic.backend.readDevices();
        if (result.status !== "available") return json({ error: result.problem.message }, result.problem.kind === "unauthorized" ? 401 : 503);
        return json({ sessions: result.value });
      }
      if (url.pathname === "/review/invalidations" && request.method === "GET") {
        let controller: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; invalidationStreams.add(c); c.enqueue(encoder.encode(": connected\n\n")); }, cancel() { invalidationStreams.delete(controller); } });
        return new Response(stream, { headers: { ...headers, "Content-Type": "text/event-stream" } });
      }
      if (url.pathname.startsWith("/review/backend/") && request.method === "POST") {
        const method = url.pathname.slice("/review/backend/".length);
        if (!(reviewMethods as readonly string[]).includes(method)) { missing.push({ method: "POST", contract: "unimplemented-operation" }); if (missing.length > 200) missing.shift(); return json({ error: "Unknown synthetic operation" }, 501); }
        if (request.headers.get("content-type") !== "application/json") return reply("JSON required", 415);
        let text = await boundedBody(request, 1500000);
        if (text === null) return reply("Too large", 413);
        try {
          const args = deserializeReviewValue(JSON.parse(text));
          if (!Array.isArray(args) || args.length > 1) return reply("Invalid operation arguments", 400);
          const noArguments = ["readAuthentication", "signOut", "readWorkspaces", "readCredentials", "readTools", "readDevices", "readDefaultFolder"].includes(method);
          if (method !== "browseFolders" && args.length !== (noArguments ? 0 : 1)) return reply("Wrong synthetic operation arity", 400);
          // The named interface is exhaustively allowlisted above. No unknown
          // operation can be looked up, proxied, or reported as success.
          const operation = synthetic.backend[method as ReviewMethod] as (...args: never[]) => Promise<unknown>;
          const pending = operation(...args as never[]);
          // Operation preparation consumes validation facts synchronously. Do
          // not keep private wire strings/argument arrays across a held result.
          args.fill(null); text = "";
          return json(await pending);
        } catch { return json({ error: "Synthetic operation contract rejected" }, 400); }
      }
      if (url.pathname === "/review/clone-events" && request.method === "GET") {
        const jobId = url.searchParams.get("jobId"), afterEventId = Number(url.searchParams.get("afterEventId"));
        if (!jobId || !/^[a-zA-Z0-9._:-]{1,128}$/.test(jobId) || !Number.isSafeInteger(afterEventId) || afterEventId < 0 || [...url.searchParams.keys()].some(key => !["jobId", "afterEventId"].includes(key)) || url.searchParams.getAll("jobId").length !== 1 || url.searchParams.getAll("afterEventId").length !== 1) return reply("Invalid clone stream", 400);
        let unsubscribe = () => {};
        const stream = new ReadableStream<Uint8Array>({ start(c) { unsubscribe = synthetic.backend.subscribeClone({ jobId, afterEventId }, event => c.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))); }, cancel() { unsubscribe(); } });
        return new Response(stream, { headers: { ...headers, "Content-Type": "text/event-stream" } });
      }
      if (url.pathname === "/api/terminal" && request.method === "GET") {
        const sessionId = url.searchParams.get("sessionId") ?? "";
        if (!protocols.terminal.has(sessionId) || [...url.searchParams.keys()].some(key => !["sessionId", "takeover"].includes(key)) || url.searchParams.getAll("sessionId").length !== 1 || (url.searchParams.has("takeover") && url.searchParams.get("takeover") !== "1")) return reply("Unknown synthetic terminal session or takeover", 400);
        if (!synthetic.snapshot().authenticated) return reply("Synthetic session signed out", 401);
        if (!workspaceAvailable()) return reply("Synthetic workspace stopped or missing", 409);
        const existing = [...sockets].filter(socket => socket.data.workspaceId === workspaceId && socket.data.sessionId === sessionId);
        if (existing.length && url.searchParams.get("takeover") !== "1") return reply("Synthetic terminal already attached; takeover required", 409);
        for (const socket of existing) socket.close(4410, "Synthetic terminal taken over");
        if (server.upgrade(request, { data: { ready: false, sessionId, workspaceId } })) return;
        return reply("WebSocket upgrade required", 426);
      }
      if (url.pathname.startsWith("/api/")) {
        if (!synthetic.snapshot().authenticated) return reply("Synthetic session signed out", 401);
        if (!workspaceAvailable()) return reply("Synthetic workspace stopped or missing", 409);
        if (url.pathname === "/api/personal-state" && !url.search) {
          if (request.method === "GET") return json(personal.read());
          if (request.method === "PATCH") {
            if (request.headers.get("content-type") !== "application/json") return reply("JSON required", 415);
            const text = await boundedBody(request, 2048);
            if (text === null) return reply("Too large", 413);
            try { if (!personal.patch(JSON.parse(text))) return reply("Unsupported synthetic personal-state patch", 400); }
            catch { return reply("Invalid personal-state JSON", 400); }
            return json(personal.read());
          }
        }
        const response = await protocols.handle(request, url);
        if (response) { for (const socket of sockets) if (socket.data.workspaceId === workspaceId && !protocols.terminal.has(socket.data.sessionId)) socket.close(1000, "Synthetic terminal deleted"); for (const [key, value] of Object.entries(headers)) response.headers.set(key, value); return response; }
      } else if (url.search && !["/", "/settings", "/clone"].includes(url.pathname) && !protocols.documentPathAllowed(url.pathname)) return reply("Unexpected review query", 400);
      if (request.method === "GET") {
        const evidence = options.evidenceAssets?.get(url.pathname);
        if (evidence) return reply(evidence.body, 200, evidence.type);
        if (url.pathname === "/review/health") return json({ status: "ready", backend: "synthetic", assembly: "same-document-mobile", instanceId, pid: process.pid, version });
        if (url.pathname === "/review/controller") return reply(controller + '<p><a href="/review/design-system">Design system reference — local examples, not Settings</a></p>', 200, "text/html");
        if (url.pathname === "/review/capabilities") return json({ backend: "synthetic", warning: "Mock backend; do not enter real credentials", methods: reviewMethods, controls: Object.keys(controls), credentialFacts: ["protection", "lock", "userId"], factStates: ["known", "unknown", "not-applicable"], toolConfiguration: "savedOverride", cloneAttemptStates: ["accepted", "pending", "not-accepted", "expired", "unavailable"], attemptIdRequired: true, notAcceptedFencesLateSubmission: true });
        if (url.pathname === "/review/controller.js") return reply(controllerScript, 200, "text/javascript");
        if (url.pathname === "/review/state") return json({ ...synthetic.snapshot(), model: synthetic.inspect(), protocols: protocols.snapshot(), missing });
        const asset = assets.get(["/", "/settings", "/clone"].includes(url.pathname) || protocols.documentPathAllowed(url.pathname) ? "/index.html" : url.pathname);
        if (asset) {
          if (asset === assets.get("/index.html")) {
            const html = typeof asset.body === "string" ? asset.body : await asset.body.text();
            return reply(html.replace('<meta charset="utf-8"', `<meta name="uatu-review-workspace" content="${workspaceId}"><meta name="uatu-base-path" content="/s/${workspaceId}/"><meta charset="utf-8"`), 200, asset.type);
          }
          return reply(asset.body, 200, asset.type);
        }
      }
      if (request.method === "POST") {
        if (url.pathname === "/review/control/continuity-fixture") { protocols.enableContinuityFixture(); return json({ enabled: true }); }
        if (url.pathname === "/review/control/upload-hold") { protocols.holdUploads(); return json({ held: true }); }
        if (url.pathname === "/review/control/upload-settle") { protocols.settleUploads(); return json({ settled: true }); }
        if (url.pathname === "/review/control/upload-fail") { protocols.settleUploads(true); return json({ failed: true }); }
        if (url.pathname === "/review/control/chat-output") {
          const text = await boundedBody(request, 256); if (text === null) return json({ error: "Synthetic output control too large" }, 413);
          let id: string | undefined;
          try { if (text) { const body = JSON.parse(text); if (body.conversationId !== undefined && typeof body.conversationId !== "string") throw new Error(); id = body.conversationId; } } catch { return json({ error: "Invalid synthetic chat output control" }, 400); }
          return protocols.emitChat(id) ? json({ emitted: true }) : json({ error: "Unknown or full synthetic conversation" }, 409);
        }
        if (url.pathname === "/review/control/terminal-output") {
          const text = await boundedBody(request, 256); let id = terminalId;
          if (text === null) return json({ error: "Synthetic output control too large" }, 413);
          try { if (text) { const body = JSON.parse(text); if (body.sessionId !== undefined) id = body.sessionId; } } catch { return json({ error: "Invalid synthetic output control" }, 400); }
          if (!protocols.terminal.has(id)) return json({ error: "Unknown synthetic terminal output target" }, 404);
           let recipients = 0; for (const ws of sockets) if (ws.data.workspaceId === workspaceId && ws.data.ready && ws.data.sessionId === id) { ws.send(new TextEncoder().encode("Synthetic background output\r\n")); recipients++; } return json({ recipients });
        }
        if (url.pathname.startsWith("/review/control/")) {
          if (request.headers.get("content-type") !== "application/json") return reply("JSON required", 415);
          const text = await boundedBody(request, 4096);
          if (text === null) return reply("Too large", 413);
          try { const value = dispatchControl(synthetic, url.pathname.slice("/review/control/".length), JSON.parse(text)); return json({ applied: true, value }); }
          catch { return json({ error: "Synthetic control rejected" }, 400); }
        }
      }
      if (request.method === "POST" && url.pathname === "/review/reset") {
        if (request.headers.get("content-type") !== "application/json") return reply("JSON required", 415);
        if (Number(request.headers.get("content-length")) > 1024) return reply("Too large", 413);
        const text = await boundedBody(request, 1024);
        if (text === null) return reply("Too large", 413);
        let body: { scenario?: unknown };
        try { body = JSON.parse(text); } catch { return reply("Invalid JSON", 400); }
        if (!body || !(scenarios as readonly string[]).includes(String(body.scenario))) return reply("Unknown scenario", 400);
        synthetic.reset(body.scenario as Scenario); for (const realm of realms.values()) { realm.protocols.reset(); realm.personal.reset(); } for (const socket of sockets) socket.close(1000, "Synthetic reset"); missing.length = 0;
        return json({ reset: true });
      }
      // Deliberately do not retain arbitrary URL/path/query/body/credential data.
      missing.push({ method: ["GET", "POST", "PUT", "DELETE", "PATCH"].includes(request.method) ? request.method : "OTHER", contract: "unimplemented-route" });
      if (missing.length > 200) missing.shift();
      return json({ error: "Missing synthetic route contract; request blocked" }, 501);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, synthetic, protocols, stop() { if (!stopped) { stopped = true; synthetic.reset(); for (const realm of realms.values()) realm.protocols.reset(); for (const stream of invalidationStreams) { try { stream.close(); } catch {} } invalidationStreams.clear(); server.stop(true); } } };
}

if (import.meta.main) {
  const options = reviewHostingOptions(process.argv.slice(2));
  const review = await startReviewServer({ ...options, instanceId: process.env.UATU_MOBILE_REVIEW_INSTANCE_ID, evidenceAssets: await buildEvidenceAssets() });
  console.info(`Review origin: ${options.publicOrigin ?? review.url}; loopback backend: ${review.url}; evidence: /review/evidence`);
  console.info(`Mock backend; do not enter real credentials. Controller: ${review.url}/review/controller\nSame-document mobile frontend; synthetic backend only. Stop: Ctrl-C.`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { review.stop(); process.exit(0); });
}
