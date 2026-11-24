// Reverse-proxy plumbing between the hub's public origin and a workspace
// session's loopback endpoint. Three transports cross here:
//
//   - plain HTTP: streamed request/response bodies, no buffering
//   - SSE: same path — the response body is a stream we never accumulate
//   - WebSocket: the hub accepts the browser-side upgrade and opens its own
//     client socket to the session, piping messages and close codes both ways
//
// The session was started with --base-path /s/<id>/, so proxied paths are
// forwarded VERBATIM — no stripping. The hub is a trusted intermediary: it
// has already authenticated the browser and validated its Origin against the
// hub's own host, so it forwards loopback-shaped Host/Origin headers and the
// session's localhost origin gate holds without modification (design D6).
//
// Addressing and trust come from the session link (src/session-contract/):
// it builds the session URL with the Hub-held token applied as `t`, so the
// session's credential checks pass without the token ever reaching a
// browser, shapes the forwarded headers, and signs chat policy. What the
// proxy does with a path is the contract's classification.

import type { ServerWebSocket } from "bun";
import { CHAT_OPERATION_RECEIPT_HEADER, HOP_BY_HOP_HEADERS } from "../session-contract/headers";
import type { SessionLink } from "../session-contract/link";
import { classifySessionRequest, sessionSuffix, snapshotConversationSegment } from "../session-contract/paths";
import { CHAT_ACTION_BODY_BYTES, CHILD_POLICY_HEADER, type VerifiedChatPolicy } from "../session-contract/policy";
import { HubOperationReceipts } from "./operation-receipts";

import type { RunningSession } from "./backend";

// No principal or policy crosses this degraded channel. Tokens are operation
// identifiers only, unguessable by another Hub account or workspace caller.
// Per-running-session keys live only in this Hub's memory, never in
// credentials. Hub state rather than contract, so it is kept here, keyed by
// the session's link.
const degradedReceipts = new WeakMap<SessionLink, HubOperationReceipts>();
function degradedReceiptState(link: SessionLink) {
  let state = degradedReceipts.get(link);
  if (!state) {
    state = new HubOperationReceipts();
    degradedReceipts.set(link, state);
  }
  return state;
}

// Structural subset of Bun.Server the bridge needs for the handshake.
export type UpgradableServer = {
  upgrade(request: Request, options?: { data?: unknown }): boolean;
};

export async function proxyHttp(request: Request, session: RunningSession, policy?: VerifiedChatPolicy,
  observeSnapshot?: (conversationId: string, value: unknown) => void): Promise<Response> {
  const { link } = session;
  const requestUrl = new URL(request.url);
  const target = link.url(requestUrl);
  const transport = classifyProxyTransport(requestUrl.pathname);
  const requestHeaders = link.forwardHeaders(request);
  let requestBody: BodyInit | null = request.body;
  let policyUnavailable = false;
  const pathClass = classifySessionRequest(request.method, requestUrl.pathname, link.basePath);
  const localDiscard = pathClass === "local-discard";
  if (policy && (localDiscard || pathClass === "policy-action")) {
    const reader = request.body?.getReader();
    let text = "";
    try {
      let bytes = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      if (reader) for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > CHAT_ACTION_BODY_BYTES) return Response.json({ error: "request body is too large" }, { status: 413 });
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } catch { return Response.json({ error: "invalid request body" }, { status: 400 }); }
    finally { if (reader) void reader.cancel().catch(() => undefined); }
    if (localDiscard) {
      // Discard has no correlation echo or automatic policy. Namespace only
      // its operation ID using the Hub-verified caller, never caller headers.
      // Preserve malformed IDs for the child's normal closed validator.
      let body: unknown;
      try { body = JSON.parse(text); } catch { /* Child owns JSON refusal. */ }
      if (body && typeof body === "object" && !Array.isArray(body) && "requestId" in body
        && typeof body.requestId === "string" && body.requestId.length > 0 && body.requestId.length <= 512
        && !/[\u0000-\u001f\u007f]/.test(body.requestId)) {
        try {
          const scoped = await degradedReceiptState(link).identify({ principal: policy.principal, method: request.method, pathname: requestUrl.pathname, requestId: body.requestId }, false);
          text = JSON.stringify({ ...body, requestId: scoped.token });
        } catch { return Response.json({ error: "operation receipt capacity unavailable" }, { status: 503, headers: { "cache-control": "no-store" } }); }
      }
    } else {
      const envelope = link.sign({ method: request.method, pathname: requestUrl.pathname, body: text }, policy);
      if (envelope) requestHeaders.set(CHILD_POLICY_HEADER, envelope);
      else {
        policyUnavailable = policy.autoBackgroundOnSteer || policy.unavailable === true;
        // Preserve the original requestId for browser/projection correlation.
        // Only the server-selected authenticated account selects this opaque
        // receipt namespace. It carries no automation permission to the child.
        let body: unknown;
        try { body = JSON.parse(text); } catch { /* The child's closed validator owns body refusal. */ }
        if (body && typeof body === "object" && "requestId" in body && typeof body.requestId === "string") {
          const state = degradedReceiptState(link);
          try {
            const first = await state.identify({ principal: policy.principal, method: request.method, pathname: requestUrl.pathname, requestId: body.requestId }, policyUnavailable);
            requestHeaders.set(CHAT_OPERATION_RECEIPT_HEADER, first.token);
            policyUnavailable = first.unavailable;
          }
          catch { return Response.json({ error: "operation receipt capacity unavailable" }, { status: 503, headers: { "cache-control": "no-store" } }); }
        }
      }
    }
    requestBody = text;
    requestHeaders.delete("content-length");
  }

  // Downstream abandonment has to reach the child, or a phone that walked out
  // of Wi-Fi mid-stream leaves the workspace holding a subscriber forever.
  // Nothing here buffers: the cancellation is a signal, not a drain.
  const upstreamAbort = new AbortController();
  let settled = false;
  const onDownstreamAbort = () => finish("cancelled");
  // Idempotent: downstream abort, body cancel, normal completion and upstream
  // failure can arrive in any order, and more than one may fire for the same
  // stream. Whichever is first names the outcome; the rest are no-ops.
  let statusCategory: ProxyStatusCategory = "unreachable";
  const finish = (outcome: StreamOutcome) => {
    if (settled) return;
    settled = true;
    request.signal.removeEventListener("abort", onDownstreamAbort);
    if (outcome !== "completed") upstreamAbort.abort();
    // Only live streams are diagnosed; an ordinary asset fetch ending is not
    // a lifecycle event anyone reads.
    if (transport !== "other") recordProxyStream({ transport, outcome, status: statusCategory });
  };

  // Already gone before we even reached the child: still a downstream
  // cancellation. Aborting the controller alone would let the fetch reject
  // into the catch below and file an ordinary abandonment as an unreachable
  // upstream — complete with the error log that is reserved for real
  // failures.
  if (request.signal.aborted) finish("cancelled");
  else request.signal.addEventListener("abort", onDownstreamAbort, { once: true });

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: requestHeaders,
      body: requestBody,
      redirect: "manual",
      signal: upstreamAbort.signal,
    });
  } catch {
    finish("failed");
    return new Response("session unreachable", { status: 502 });
  }

  statusCategory = statusCategoryOf(upstream.status);
  // Media must stay byte-for-byte even if a child supplies a compressible
  // MIME type. Honor no-transform for other representations as well.
  const noTransform = pathClass === "media"
    || /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(upstream.headers.get("cache-control") ?? "");
  // Bounded tap on the existing response body, not a tee/background reader:
  // observes history/initial snapshots without changing bytes or backpressure.
  // Oversized/invalid content is simply not trusted for retirement.
  const snapshotSegment = pathClass === "conversation-snapshot"
    ? snapshotConversationSegment(sessionSuffix(requestUrl.pathname, link.basePath)!) : null;
  if (observeSnapshot && snapshotSegment !== null && upstream.ok && upstream.body && upstream.headers.get("content-type")?.includes("application/json")) {
    let conversationId: string | null = null;
    try { conversationId = decodeURIComponent(snapshotSegment); } catch { /* Child owns malformed-route refusal. */ }
    if (conversationId !== null) {
      const id = conversationId; const chunks: Uint8Array[] = []; let bytes = 0; let oversized = false;
      const tap = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > 4 * 1024 * 1024 || chunks.length >= 4096) { oversized = true; chunks.length = 0; }
          if (!oversized && chunk.byteLength) chunks.push(chunk.slice());
          controller.enqueue(chunk);
        },
        flush() {
          if (oversized) return;
          try {
            const data = new Uint8Array(bytes); let offset = 0;
            for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
            observeSnapshot(id, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)));
          } catch { /* Personal observation never fails chat delivery. */ }
          finally { chunks.length = 0; }
        },
      });
      upstream = new Response(upstream.body.pipeThrough(tap), { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
    }
  }
  if (policyUnavailable && upstream.ok && upstream.headers.get("content-type")?.includes("application/json")) {
    try {
      const value = await upstream.json();
      const headers = new Headers(upstream.headers);
      headers.delete("content-length");
      headers.set("cache-control", "no-store");
      upstream = Response.json(value && typeof value === "object" && !Array.isArray(value) && value.delivery === "steer"
        ? { ...value, automaticBackground: "unavailable" } : value, { status: upstream.status, headers });
    } catch {
      finish("failed");
      return Response.json({ error: "Steer outcome unconfirmed; refresh status without repeating it", code: "operation_outcome_unknown" }, { status: 409, headers: { "cache-control": "no-store" } });
    }
  }
  if (!noTransform && upstream.status === 200 && upstream.headers.get("content-type")?.includes("text/html")) {
    upstream = new HTMLRewriter().on("head", { element(head) {
      head.prepend('<meta name="uatu-hub" content="true">', { html: true });
    } }).transform(upstream);
    upstream.headers.delete("content-length");
    upstream.headers.delete("etag");
  }

  // Stream the body through untouched — SSE depends on this staying
  // unbuffered. Strip hop-by-hop response headers; everything else
  // (content-type, set-cookie with the child's base-path scope, cache
  // headers) passes through verbatim.
  const headers = new Headers();
  // With identity encoding requested above the child's Content-Length
  // describes exactly the bytes we forward, so keep it — length-known
  // responses transit fronting proxies far better than open-ended chunked
  // streams. Only an (unexpected) encoded upstream body invalidates it.
  const upstreamEncoded = upstream.headers.has("content-encoding")
    && upstream.headers.get("content-encoding")?.toLowerCase() !== "identity";
  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === "content-encoding") continue;
    if (lower === "content-length" && upstreamEncoded) continue;
    headers.set(name, value);
  }
  // Compress compressible bodies for the browser-facing hop. The loopback
  // hop stays identity (above), but the hub→browser leg often crosses a
  // real network — a tailnet, a LAN, cellular — where the SPA's main chunk
  // (~12 MB of bundled syntax grammars) compresses roughly 6×. Compression
  // buffers, so streaming types (SSE, the NDJSON search feed) are excluded
  // by isCompressibleType and keep flowing incrementally.
  const contentLength = Number.parseInt(headers.get("content-length") ?? "", 10);
  const smallBody = Number.isFinite(contentLength) && contentLength <= 1400;
  if (
    !noTransform &&
    upstream.status === 200 &&
    upstream.body !== null &&
    !smallBody &&
    isCompressibleType(headers.get("content-type") ?? "") &&
    /\bgzip\b/.test(request.headers.get("accept-encoding") ?? "")
  ) {
    const compressed = Bun.gzipSync(new Uint8Array(await upstream.arrayBuffer()));
    finish("completed");
    headers.set("content-encoding", "gzip");
    headers.set("content-length", String(compressed.byteLength));
    headers.set("vary", "accept-encoding");
    return new Response(compressed, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  if (upstream.body === null) {
    finish("completed");
    return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers });
  }

  return new Response(cancellableBody(upstream.body, finish), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

// How a proxied stream ended. Fixed set — these names are the only stream
// lifecycle vocabulary the hub records (see design D6), so a diagnostic can
// never widen into request contents.
export type StreamOutcome = "completed" | "cancelled" | "failed";

// The transport classes the hub can name. Derived from the route shape alone,
// never from the workspace id, the query string, or any header — so the set
// is closed and a diagnostic cannot leak an identifier. Live streams are no
// longer proxied (the hub refuses the per-stream SSE routes and brokers
// `/api/hub/live` instead — see live-broker.ts), so the only proxied stream
// left to diagnose is the NDJSON search feed.
export const PROXY_TRANSPORT_CLASSES = ["search", "other"] as const;
export type ProxyTransportClass = (typeof PROXY_TRANSPORT_CLASSES)[number];

// Status is recorded as a category, not a code, and `unreachable` covers a
// fetch that never got an answer.
export const PROXY_STATUS_CATEGORIES = ["2xx", "3xx", "4xx", "5xx", "unreachable"] as const;
export type ProxyStatusCategory = (typeof PROXY_STATUS_CATEGORIES)[number];

export type ProxyStreamDiagnostic = {
  transport: ProxyTransportClass;
  outcome: StreamOutcome;
  status: ProxyStatusCategory;
};

export function classifyProxyTransport(pathname: string): ProxyTransportClass {
  if (pathname.endsWith("/api/search")) return "search";
  return "other";
}

export function statusCategoryOf(status: number): ProxyStatusCategory {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500) return "5xx";
  return "unreachable";
}

export type ProxyStreamDiagnosticSink = (record: ProxyStreamDiagnostic) => void;

// Expected endings — a phone sleeping, a tab closing — are the common case on
// mobile and would drown the log. Only an unexpected upstream failure speaks,
// and it says nothing but its class and status category.
const defaultSink: ProxyStreamDiagnosticSink = record => {
  if (record.outcome !== "failed") return;
  console.error(`uatu hub: proxied ${record.transport} stream failed (${record.status})`);
};

let diagnosticSink: ProxyStreamDiagnosticSink = defaultSink;

export function setProxyStreamDiagnostics(sink: ProxyStreamDiagnosticSink | null): void {
  diagnosticSink = sink ?? defaultSink;
}

function recordProxyStream(record: ProxyStreamDiagnostic): void {
  try {
    diagnosticSink(record);
  } catch {
    // A diagnostic must never take a proxied stream down with it.
  }
}

// Re-wraps the child's body so that a downstream cancel becomes an upstream
// cancel. `highWaterMark: 0` keeps it a pass-through: one chunk moves only
// when the browser asks for one, so SSE and NDJSON keep their latency and
// nothing accumulates in the hub.
function cancellableBody(
  body: ReadableStream<Uint8Array>,
  finish: (outcome: StreamOutcome) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finish("completed");
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch {
        // A truncated representation is a failed transfer, never clean EOF.
        // Do not forward the fetch error: it can contain the credentialed URL.
        finish("failed");
        controller.error(new Error("session response interrupted"));
      }
    },
    cancel(reason) {
      // Cancel the reader first, then abort the fetch. Aborting makes the
      // in-flight cancel reject with AbortError — an expected consequence of
      // the teardown we just asked for, not a failure to report.
      const released = reader.cancel(reason).catch(() => undefined);
      finish("cancelled");
      return released;
    },
  }, { highWaterMark: 0 });
}

const COMPRESSIBLE_TYPES = /^(text\/|application\/(javascript|json|manifest\+json|xml)|image\/svg)/;

// Compressible = safe to buffer. Incremental feeds are excluded explicitly:
// SSE (live reload) and NDJSON (project search) lose their point buffered.
export function isCompressibleType(contentType: string): boolean {
  if (contentType.includes("text/event-stream")) return false;
  if (contentType.includes("ndjson")) return false;
  return COMPRESSIBLE_TYPES.test(contentType);
}

// ---------------------------------------------------------------------------
// WebSocket bridging

export type BridgeData = {
  bridge: WebSocketBridge;
};

// One browser⇄child WebSocket pair. The browser side is a Bun server socket;
// the child side is a standard WebSocket client aimed at the loopback
// endpoint. Messages and close events pass through in both directions with
// app close codes (4001 kill, 4409 collision, 4410 takeover) preserved.
//
// The two handshakes are independent: the hub accepts the browser before
// it knows whether the child will, so a bridge can end from either side at
// any point — before the child opened, before the browser attached, or
// after both. Ending is one idempotent step (`closed` is set once, by
// whichever side went first), after which every later event is a no-op:
// a late child `open` is closed again rather than becoming a holder for a
// browser that has left, queued browser input is dropped rather than
// flushed into it, and a browser that attaches after the child already
// failed is closed with the child's verdict instead of waiting on nothing.
export class WebSocketBridge {
  private browser: ServerWebSocket<BridgeData> | null = null;
  private child: WebSocket;
  // Browser messages that arrive before the child socket opens.
  private pending: (string | Uint8Array<ArrayBuffer>)[] = [];
  private childOpen = false;
  // The close this bridge ended with, once it has. The code is what the
  // side still open is closed with, so an application code (4001 from the
  // browser, 4410 from the child) keeps its meaning across the bridge.
  private closed: { code: number; reason: string } | null = null;

  constructor(session: RunningSession, requestUrl: URL) {
    const { link } = session;
    const target = link.url(requestUrl);
    target.protocol = "ws:";
    this.child = new WebSocket(target, {
      headers: {
        // The child's origin gate compares Origin against its own Host.
        origin: link.origin,
      },
    } as unknown as string[]);
    this.child.binaryType = "arraybuffer";

    this.child.addEventListener("open", () => {
      if (this.closed) {
        // The browser departed (or its upgrade failed) while the child was
        // still opening. Nothing queued reaches the child, and the child
        // sees a close rather than an attach-ready that would make it the
        // PTY's holder on behalf of nobody.
        this.closeChild(this.closed.code, this.closed.reason);
        return;
      }
      this.childOpen = true;
      for (const message of this.pending.splice(0)) {
        this.child.send(message);
      }
    });
    this.child.addEventListener("message", event => {
      if (this.closed) return;
      const data = event.data as string | ArrayBuffer;
      this.browser?.send(typeof data === "string" ? data : new Uint8Array(data));
    });
    this.child.addEventListener("close", event => {
      this.endFromChild(event.code, event.reason);
    });
    this.child.addEventListener("error", () => {
      this.endFromChild(1011, "upstream error");
    });
  }

  attachBrowser(socket: ServerWebSocket<BridgeData>): void {
    if (this.closed) {
      // The child already ended (a refused upgrade answers faster than the
      // browser handshake completes): the browser must not be left open on
      // a bridge with nothing behind it.
      closeSocket(socket, this.closed.code, this.closed.reason);
      return;
    }
    this.browser = socket;
  }

  browserMessage(data: string | Buffer): void {
    if (this.closed) return;
    const message: string | Uint8Array<ArrayBuffer> =
      typeof data === "string" ? data : new Uint8Array(data);
    if (!this.childOpen) {
      this.pending.push(message);
      return;
    }
    this.child.send(message);
  }

  browserClosed(code: number, reason: string): void {
    this.endFromBrowser(code, reason);
  }

  // The browser-side upgrade did not complete after the child connection
  // was already started: release the child. 1001 (going away) is an
  // ordinary departure to the child — a detach, never a kill.
  dispose(): void {
    this.endFromBrowser(1001, "browser upgrade failed");
  }

  get isClosed(): boolean {
    return this.closed !== null;
  }

  private endFromChild(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = { code: sendableCloseCode(code), reason };
    this.pending = [];
    if (this.browser) closeSocket(this.browser, this.closed.code, reason);
  }

  private endFromBrowser(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = { code: sendableCloseCode(code), reason };
    this.pending = [];
    // A child still connecting is closed too: Bun fails the connection, and
    // should `open` fire regardless, the handler above closes it again.
    this.closeChild(this.closed.code, reason);
  }

  private closeChild(code: number, reason: string): void {
    try {
      this.child.close(code, reason);
    } catch {
      try {
        this.child.close();
      } catch {
        // Already closed.
      }
    }
  }
}

function closeSocket(socket: ServerWebSocket<BridgeData>, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }
}

// 1005 (no status) and 1006 (abnormal) are report-only codes that cannot be
// sent on the wire; everything else — including the app-defined 4xxx codes —
// passes through so the far side sees exactly what the near side saw.
export function sendableCloseCode(code: number): number {
  if (code === 1005 || code === 1006) return 1000;
  return code;
}

// Attempts the browser-side upgrade for a proxied WebSocket. Returns
// undefined when the upgrade succeeded (Bun takes over the connection).
export function upgradeToBridge(
  request: Request,
  server: UpgradableServer,
  session: RunningSession,
): Response | undefined {
  const requestUrl = new URL(request.url);
  const bridge = new WebSocketBridge(session, requestUrl);
  const upgraded = server.upgrade(request, { data: { bridge } satisfies BridgeData });
  if (!upgraded) {
    // The child connection was already started; without a browser to
    // bridge it must not linger (or, worse, be attached by a late message).
    bridge.dispose();
    return new Response("upgrade failed", { status: 500 });
  }
  return undefined;
}

// Bun.serve websocket handlers for the hub server.
export const bridgeWebSocketHandlers = {
  open(socket: ServerWebSocket<BridgeData>) {
    socket.data.bridge.attachBrowser(socket);
  },
  message(socket: ServerWebSocket<BridgeData>, data: string | Buffer) {
    socket.data.bridge.browserMessage(data);
  },
  close(socket: ServerWebSocket<BridgeData>, code: number, reason: string) {
    socket.data.bridge.browserClosed(code, reason);
  },
};
