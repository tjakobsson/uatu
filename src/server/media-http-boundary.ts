import { createServer, request as httpRequest, Agent, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { connect, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { Server, SocketAddress } from "bun";

/** The existing Bun listener must be private HTTP on a loopback ephemeral port.
 * Keep its literal HTMLBundle routes and WebSocket handlers at their callsite.
 * Its fetch callback uses boundary.normalizeRequest(req) and boundary.server.
 */
export type MediaHttpBoundaryOptions<S extends Server<any>> = {
  server: S;
  hostname: string;
  port: number;
  tls?: { cert: string | Buffer; key: string | Buffer };
  isMediaRequest: (request: Request) => boolean;
  /** The SAME authenticated route/Hub dispatch used by the Bun assembly. */
  fetch: (request: Request, server: S) => Response | undefined | Promise<Response | undefined>;
};

export type MediaHttpBoundary<S extends Server<any>> = {
  /** Bun-compatible public listener facade, including stop, reload and upgrades. */
  server: S;
  /** Resolves after the public HTTP/TLS listener is accepting connections. */
  ready: Promise<void>;
  /** Restores public URL/TLS and peer context on internally proxied Bun requests. */
  normalizeRequest: (request: Request) => Request;
};

type Context = { url: string; peer: SocketAddress | null };

/** Only GET/HEAD media use the Node response writer. Other traffic is streamed
 * to the original Bun server, upgrades included. Peer provenance is correlated
 * by private upstream connection port, never by caller-supplied trust headers.
 */
export function startMediaHttpBoundary<S extends Server<any>>(options: MediaHttpBoundaryOptions<S>): MediaHttpBoundary<S> {
  const inner = options.server;
  if (!["127.0.0.1", "::1", "localhost"].includes(inner.hostname ?? "") || inner.url.protocol !== "http:" || inner.port === undefined) {
    throw new Error("The media boundary requires a private loopback HTTP Bun listener");
  }
  const innerHost = inner.hostname!;
  const innerPort = inner.port;
  const originProtocol = options.tls ? "https:" : "http:";
  const contexts = new Map<number, Context>();
  const requests = new WeakMap<Request, Context>();
  const originals = new WeakMap<Request, Request>();
  const timeouts = new WeakMap<Request, (seconds: number) => void>();
  const sockets = new Set<Socket>();
  const upstreams = new Set<Duplex>();
  const media = new Set<AbortController>();
  const agent = new Agent({ keepAlive: false });
  let facade!: S;
  let dispatchMedia = options.fetch;
  let stopping: Promise<void> | undefined;

  function contextFor(request: Request): Context | undefined {
    const direct = requests.get(request);
    if (direct) return direct;
    const address = inner.requestIP(originals.get(request) ?? request);
    return address ? contexts.get(address.port) : undefined;
  }
  function normalizeRequest(request: Request): Request {
    const context = contextFor(request);
    if (!context) return request;
    if (request.url === context.url) { requests.set(request, context); return request; }
    const normalized = new Request(context.url, request);
    requests.set(normalized, context); originals.set(normalized, request);
    return normalized;
  }
  function incomingContext(request: IncomingMessage): Context {
    const socket = request.socket;
    const host = request.headers.host ?? `${options.hostname}:${options.port}`;
    return { url: new URL(request.url ?? "/", `${originProtocol}//${host}`).href,
      peer: socket.remoteAddress ? { address: socket.remoteAddress, port: socket.remotePort ?? 0,
        family: socket.remoteFamily === "IPv6" ? "IPv6" : "IPv4" } : null };
  }
  function webRequest(request: IncomingMessage, context: Context, signal: AbortSignal): Request {
    const headers = new Headers();
    for (let i = 0; i < request.rawHeaders.length; i += 2) headers.append(request.rawHeaders[i]!, request.rawHeaders[i + 1]!);
    const result = new Request(context.url, { method: request.method, headers, signal });
    requests.set(result, context); return result;
  }
  function correlate(socket: Socket, context: Context): void {
    upstreams.add(socket);
    let port: number | undefined;
    const connected = () => { port = socket.localPort; if (port !== undefined) contexts.set(port, context); };
    if (socket.connecting) socket.once("connect", connected); else connected();
    socket.once("close", () => { upstreams.delete(socket); if (port !== undefined) contexts.delete(port); });
  }
  async function writeMedia(request: Request, response: ServerResponse, cancellation: AbortController): Promise<void> {
    media.add(cancellation);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelReader = () => { void reader?.cancel(cancellation.signal.reason).catch(() => {}); };
    try {
      const result = await dispatchMedia(request, facade);
      if (!result) throw new Error("Media dispatch did not return a response");
      if (cancellation.signal.aborted) { await result.body?.cancel(); return; }
      const headers: Record<string, string | string[]> = Object.fromEntries(result.headers);
      const cookies = result.headers.getSetCookie();
      if (cookies.length) headers["set-cookie"] = cookies;
      response.writeHead(result.status, result.statusText || undefined, headers);
      response.flushHeaders();
      if (request.method === "HEAD") { await result.body?.cancel(); response.end(); return; }
      if (result.body) {
        reader = result.body.getReader();
        cancellation.signal.addEventListener("abort", cancelReader, { once: true });
        if (cancellation.signal.aborted) cancelReader();
        for (;;) {
          const value = await reader.read();
          if (value.done) break;
          if (cancellation.signal.aborted) return;
          if (!response.write(value.value)) await new Promise<void>((resolve, reject) => {
            const cleanup = () => { response.off("drain", drained); cancellation.signal.removeEventListener("abort", aborted); };
            const drained = () => { cleanup(); resolve(); };
            const aborted = () => { cleanup(); reject(new Error("Media consumer disconnected")); };
            response.once("drain", drained); cancellation.signal.addEventListener("abort", aborted, { once: true });
            if (cancellation.signal.aborted) aborted();
          });
        }
      }
      if (!cancellation.signal.aborted) response.end();
    } catch { cancellation.abort(); response.destroy(); }
    finally {
      cancellation.signal.removeEventListener("abort", cancelReader);
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      media.delete(cancellation);
    }
  }
  function proxy(request: IncomingMessage, response: ServerResponse, context: Context): void {
    const upstream = httpRequest({ hostname: innerHost, port: innerPort, path: request.url, method: request.method,
      headers: request.rawHeaders, agent }, received => {
      response.writeHead(received.statusCode ?? 502, received.statusMessage, received.rawHeaders);
      received.on("error", () => response.destroy());
      received.on("aborted", () => response.destroy());
      received.on("close", () => { if (!received.complete) response.destroy(); });
      received.pipe(response);
    });
    upstream.on("socket", socket => correlate(socket, context));
    upstream.on("error", () => response.destroy());
    request.on("aborted", () => upstream.destroy());
    request.on("error", () => { upstream.destroy(); response.destroy(); });
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  }
  const receive = (request: IncomingMessage, response: ServerResponse) => {
    response.once("finish", () => { if (stopping) front.closeIdleConnections(); });
    try {
      const context = incomingContext(request);
      const cancellation = new AbortController();
      const candidate = webRequest(request, context, cancellation.signal);
      if ((request.method === "GET" || request.method === "HEAD") && options.isMediaRequest(candidate)) {
        timeouts.set(candidate, seconds => { response.setTimeout(seconds * 1000, () => response.destroy()); });
        response.on("close", () => cancellation.abort()); request.on("aborted", () => cancellation.abort());
        request.on("error", () => { cancellation.abort(); response.destroy(); });
        void writeMedia(candidate, response, cancellation);
      } else proxy(request, response, context);
    } catch { response.destroy(); }
  };
  let front: ReturnType<typeof createServer> | ReturnType<typeof createSecureServer>;
  try { front = options.tls ? createSecureServer(options.tls, receive) : createServer(receive); }
  catch (error) { agent.destroy(); void inner.stop(true); throw error; }
  front.requestTimeout = 0;
  front.timeout = 0;
  front.keepAliveTimeout = 0;
  front.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  front.on("upgrade", (request, socket, head) => {
    try {
      const context = incomingContext(request);
      const upstream = connect({ host: innerHost, port: innerPort });
      correlate(upstream, context);
      upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy()); upstream.on("close", () => socket.destroy());
      upstream.once("connect", () => {
        upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`);
        for (let i = 0; i < request.rawHeaders.length; i += 2) upstream.write(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}\r\n`);
        upstream.write("\r\n"); if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket);
      });
    } catch { socket.destroy(); }
  });
  const readiness = Promise.withResolvers<void>();
  // Callers that preserve Bun's synchronous start API can inspect port/url
  // immediately. CLI readiness announcements explicitly await ready.
  void readiness.promise.catch(() => {});
  front.once("listening", () => readiness.resolve());
  front.on("error", error => readiness.reject(error));
  const stop = (force = false): Promise<void> => {
    if (force) {
      for (const controller of media) controller.abort();
      for (const socket of sockets) socket.destroy();
      for (const socket of upstreams) socket.destroy();
      front.closeAllConnections(); agent.destroy();
      void inner.stop(true);
    }
    // A public request may have been accepted before its private connection
    // has completed. Keep Bun accepting those connections until the public
    // listener drains; stopping both listeners together loses that request.
    stopping ??= new Promise<void>(resolve => front.close(() => resolve()))
      .then(() => inner.stop(force)).then(() => { agent.destroy(); });
    front.closeIdleConnections();
    return stopping;
  };
  try { front.listen(options.port, options.hostname); }
  catch (error) { void inner.stop(true); throw error; }
  const address = front.address() as AddressInfo | null;
  if (!address) { void stop(true); throw new Error(`Could not bind media boundary at ${options.hostname}:${options.port}`); }
  const publicUrl = new URL(`${originProtocol}//${options.hostname.includes(":") ? `[${options.hostname}]` : options.hostname}:${address.port}/`);
  facade = new Proxy(inner, { get(target, property) {
    if (property === "port") return address.port;
    if (property === "hostname") return options.hostname;
    if (property === "url") return publicUrl;
    if (property === "stop") return stop;
    if (property === Symbol.asyncDispose) return () => stop(true);
    if (property === "requestIP") return (request: Request) => contextFor(request)?.peer ?? target.requestIP(originals.get(request) ?? request);
    if (property === "upgrade") return (request: Request, upgradeOptions: unknown) => target.upgrade(originals.get(request) ?? request, upgradeOptions as never);
    if (property === "timeout") return (request: Request, seconds: number) => {
      const direct = timeouts.get(request);
      if (direct) direct(seconds); else target.timeout(originals.get(request) ?? request, seconds);
    };
    if (property === "ref") return () => { front.ref(); target.ref(); };
    if (property === "unref") return () => { front.unref(); target.unref(); };
    if (property === "pendingRequests") return target.pendingRequests + media.size;
    if (property === "reload") return (reload: Parameters<S["reload"]>[0]) => {
      const fetch = reload.fetch;
      if (fetch) dispatchMedia = async (request, server) => await fetch.call(server, request as never, server) ?? undefined;
      target.reload(fetch ? { ...reload, fetch: (request: Request) => fetch.call(facade, normalizeRequest(request) as never, facade) } as never : reload);
      if (reload.routes) {
        const routes = reload.routes as Record<string, unknown>;
        dispatchMedia = async (request, server) => {
          const route = routes[new URL(request.url).pathname];
          if (route instanceof Response) return route.clone();
          const handler = typeof route === "function" ? route
            : route && typeof route === "object" ? (route as Record<string, unknown>)[request.method] : undefined;
          if (typeof handler === "function") return await handler(request, server) as Response | undefined;
          // Bun's fetch() invokes its current fallback, not its route table.
          return await target.fetch(request);
        };
      }
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { server: facade, ready: readiness.promise, normalizeRequest };
}
