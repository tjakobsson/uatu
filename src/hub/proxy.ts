// Reverse-proxy plumbing between the hub's public origin and a session
// child's loopback endpoint. Three transports cross here:
//
//   - plain HTTP: streamed request/response bodies, no buffering
//   - SSE: same path — the response body is a stream we never accumulate
//   - WebSocket: the hub accepts the browser-side upgrade and opens its own
//     client socket to the child, piping messages and close codes both ways
//
// The child was spawned with --base-path /s/<id>/, so proxied paths are
// forwarded VERBATIM — no stripping. The hub is a trusted intermediary: it
// has already authenticated the browser and validated its Origin against the
// hub's own host, so it forwards loopback-shaped Host/Origin headers and the
// child's localhost origin gate holds without modification (design D6).
//
// Token brokering (design D6): the child's per-session token is appended as
// the `t` query parameter on proxied requests, so the child's terminal
// credential checks pass without the token ever reaching a browser. The
// child ignores `t` on routes that don't read it.

import type { ServerWebSocket } from "bun";

import type { RunningSession } from "./backend";

// Structural subset of Bun.Server the bridge needs for the handshake.
export type UpgradableServer = {
  upgrade(request: Request, options?: { data?: unknown }): boolean;
};

// Hop-by-hop headers never forwarded in either direction (RFC 9110 §7.6.1).
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

function childOrigin(session: RunningSession): string {
  return `http://${session.endpoint.hostname}:${session.endpoint.port}`;
}

// Builds the child-side URL for a proxied request: same (prefixed) path and
// query against the loopback endpoint, with the brokered token applied.
// Applied means OVERWRITTEN, not merely filled in: a browser-supplied `?t=`
// is at best a stale value the SPA captured earlier and at worst arbitrary —
// preserving it would make the child reject credentials the hub is supposed
// to broker, stranding the user at a token prompt for a token that is never
// exposed to them.
export function childUrlFor(session: RunningSession, requestUrl: URL): URL {
  const target = new URL(requestUrl.pathname + requestUrl.search, childOrigin(session));
  if (session.token) {
    target.searchParams.set("t", session.token);
  }
  return target;
}

function forwardedHeaders(request: Request, session: RunningSession): Headers {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers.set(name, value);
  }
  headers.set("host", `${session.endpoint.hostname}:${session.endpoint.port}`);
  // Identity encoding from the child: the loopback hop gains nothing from
  // compression, and an unencoded upstream body means its Content-Length
  // stays truthful after fetch() — which we then pass through, so fronting
  // proxies (tailscale serve, Caddy, nginx) see length-known responses
  // instead of unknown-length chunked streams.
  headers.set("accept-encoding", "identity");
  // Loopback-shape the Origin so the child's localhost origin gate holds;
  // the hub validated the caller's real Origin (when present) before
  // proxying. Injected even when absent: browsers always send Origin on
  // cross-origin and mutating requests, so an Origin-less request is a
  // native client the hub has already authenticated — mirroring the
  // WebSocket bridge, which injects the loopback Origin unconditionally.
  headers.set("origin", childOrigin(session));
  return headers;
}

export async function proxyHttp(request: Request, session: RunningSession): Promise<Response> {
  const requestUrl = new URL(request.url);
  const target = childUrlFor(session, requestUrl);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: forwardedHeaders(request, session),
      body: request.body,
      redirect: "manual",
    });
  } catch {
    return new Response("session unreachable", { status: 502 });
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
  const upstreamEncoded = upstream.headers.has("content-encoding");
  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
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
    upstream.status === 200 &&
    upstream.body !== null &&
    !smallBody &&
    isCompressibleType(headers.get("content-type") ?? "") &&
    /\bgzip\b/.test(request.headers.get("accept-encoding") ?? "")
  ) {
    const compressed = Bun.gzipSync(new Uint8Array(await upstream.arrayBuffer()));
    headers.set("content-encoding", "gzip");
    headers.set("content-length", String(compressed.byteLength));
    headers.set("vary", "accept-encoding");
    return new Response(compressed, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
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
export class WebSocketBridge {
  private browser: ServerWebSocket<BridgeData> | null = null;
  private child: WebSocket;
  // Browser messages that arrive before the child socket opens.
  private pending: (string | Uint8Array<ArrayBuffer>)[] = [];
  private childOpen = false;

  constructor(session: RunningSession, requestUrl: URL) {
    const target = childUrlFor(session, requestUrl);
    target.protocol = "ws:";
    this.child = new WebSocket(target, {
      headers: {
        // The child's origin gate compares Origin against its own Host.
        origin: childOrigin(session),
      },
    } as unknown as string[]);
    this.child.binaryType = "arraybuffer";

    this.child.addEventListener("open", () => {
      this.childOpen = true;
      for (const message of this.pending.splice(0)) {
        this.child.send(message);
      }
    });
    this.child.addEventListener("message", event => {
      const data = event.data as string | ArrayBuffer;
      this.browser?.send(typeof data === "string" ? data : new Uint8Array(data));
    });
    this.child.addEventListener("close", event => {
      this.closeBrowser(event.code, event.reason);
    });
    this.child.addEventListener("error", () => {
      this.closeBrowser(1011, "upstream error");
    });
  }

  attachBrowser(socket: ServerWebSocket<BridgeData>): void {
    this.browser = socket;
  }

  browserMessage(data: string | Buffer): void {
    const message: string | Uint8Array<ArrayBuffer> =
      typeof data === "string" ? data : new Uint8Array(data);
    if (!this.childOpen) {
      this.pending.push(message);
      return;
    }
    this.child.send(message);
  }

  browserClosed(code: number, reason: string): void {
    this.closeChild(code, reason);
  }

  private closeBrowser(code: number, reason: string): void {
    try {
      this.browser?.close(sendableCloseCode(code), reason);
    } catch {
      try {
        this.browser?.close();
      } catch {
        // Already closed.
      }
    }
  }

  private closeChild(code: number, reason: string): void {
    try {
      this.child.close(sendableCloseCode(code), reason);
    } catch {
      try {
        this.child.close();
      } catch {
        // Already closed.
      }
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
