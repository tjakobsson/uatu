import { afterEach, expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Server } from "bun";
import { startMediaHttpBoundary, type MediaHttpBoundary } from "./media-http-boundary";

const disposals: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });
type Dispatch = (request: Request, server: Server<{ context: string }>) => Response | undefined | Promise<Response | undefined>;
function fixture(dispatch: Dispatch, tls?: { cert: Buffer; key: Buffer }) {
  let boundary: MediaHttpBoundary<Server<{ context: string }>> | undefined;
  const inner = Bun.serve<{ context: string }>({ hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    fetch: (request, server) => dispatch(boundary?.normalizeRequest(request) ?? request, boundary?.server ?? server),
    websocket: { open(socket) { socket.send(socket.data.context); }, message(socket, value) { socket.send(value); } },
  });
  boundary = startMediaHttpBoundary({ server: inner, hostname: "127.0.0.1", port: 0, tls,
    isMediaRequest: request => new URL(request.url).pathname === "/api/media", fetch: dispatch,
  });
  disposals.push(() => boundary!.server.stop(true));
  return { ...boundary, inner };
}
async function until(check: () => boolean) {
  const end = Date.now() + 4000;
  while (!check()) { if (Date.now() > end) throw new Error("boundary condition timed out"); await Bun.sleep(5); }
}

test("only GET/HEAD media use Node framing, with the same dispatch and public facade", async () => {
  const observed: string[] = [];
  const app = fixture((request, server) => {
    observed.push(`${request.method}:${server.port}:${new URL(request.url).port}`);
    return new Response(request.method === "HEAD" ? null : new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4096)); controller.close(); } }), {
      status: request.method === "POST" ? 201 : 200, headers: { "content-length": "4096", "x-public-port": String(server.port) },
    });
  });
  await app.ready;
  expect(app.server.port).not.toBe(app.inner.port);
  for (const method of ["GET", "HEAD"]) {
    const response = await fetch(new URL("/api/media", app.server.url), { method });
    expect(response.status).toBe(200); expect(response.headers.get("content-length")).toBe("4096");
    expect((await response.arrayBuffer()).byteLength).toBe(method === "HEAD" ? 0 : 4096);
  }
  const post = await fetch(new URL("/api/media", app.server.url), { method: "POST" });
  expect(post.status).toBe(201); expect((await post.arrayBuffer()).byteLength).toBe(4096);
  expect(observed.every(value => value.split(":")[1] === String(app.server.port) && value.split(":")[2] === String(app.server.port))).toBe(true);
});

test("normal and media requests retain Host/Origin/cookies, streamed bodies and genuine client IP despite forged headers", async () => {
  const app = fixture(async (request, server) => Response.json({ url: request.url, peer: server.requestIP(request),
    host: request.headers.get("host"), origin: request.headers.get("origin"), cookie: request.headers.get("cookie"),
    forwarded: request.headers.get("x-forwarded-for"), body: request.method === "POST" ? await request.text() : null }));
  await app.ready;
  const call = (pathname: string, method = "GET") => new Promise<any>((resolve, reject) => {
    let clientPort = 0;
    const request = httpRequest({ hostname: "127.0.0.1", port: app.server.port, method, path: pathname,
      headers: { host: `example.test:${app.server.port}`, origin: `http://example.test:${app.server.port}`, cookie: "session=actual",
        "x-forwarded-for": "203.0.113.55", forwarded: "for=203.0.113.56", "x-uatu-client-ip": "203.0.113.57" } }, response => {
      const parts: Buffer[] = []; response.on("data", data => parts.push(data)); response.on("end", () => resolve({ ...JSON.parse(Buffer.concat(parts).toString()), clientPort }));
    });
    request.on("socket", socket => {
      const capture = () => { clientPort = socket.localPort!; };
      if (socket.connecting) socket.once("connect", capture); else capture();
    });
    request.on("error", reject); if (method === "POST") { request.write("first "); request.write("second"); } request.end();
  });
  for (const [pathname, method] of [["/ordinary?x=1", "POST"], ["/api/media?x=2", "GET"]]) {
    const value = await call(pathname!, method);
    expect(value.url).toBe(`http://example.test:${app.server.port}${pathname}`);
    expect(value.peer.address).toBe("127.0.0.1"); expect(value.peer.port).toBe(value.clientPort);
    expect(value.host).toBe(`example.test:${app.server.port}`); expect(value.origin).toBe(`http://example.test:${app.server.port}`);
    expect(value.cookie).toBe("session=actual"); expect(value.forwarded).toBe("203.0.113.55");
    expect(value.body).toBe(method === "POST" ? "first second" : null);
  }
});

test("SSE remains incremental and WebSocket upgrades keep Bun handlers and public context", async () => {
  let events!: ReadableStreamDefaultController<Uint8Array>, cancelled = false;
  const app = fixture((request, server) => {
    const url = new URL(request.url);
    if (url.pathname === "/socket") {
      if (server.upgrade(request, { data: { context: `${request.url}|${server.requestIP(request)?.address}` } })) return;
      return new Response(null, { status: 400 });
    }
    if (url.pathname === "/events") return new Response(new ReadableStream<Uint8Array>({
      start(controller) { events = controller; controller.enqueue(new TextEncoder().encode(": ready\n\n")); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
    return new Response("status");
  });
  await app.ready;
  const abort = new AbortController();
  const stream = await fetch(new URL("/events", app.server.url), { signal: abort.signal });
  const reader = stream.body!.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toBe(": ready\n\n");
  expect(await (await fetch(new URL("/status", app.server.url))).text()).toBe("status");
  events.enqueue(new TextEncoder().encode("data: second\n\n"));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: second\n\n");
  const messages: string[] = [];
  const url = new URL("/socket", app.server.url); url.protocol = "ws:";
  const socket = new WebSocket(url);
  socket.onmessage = event => messages.push(String(event.data));
  await until(() => messages.length === 1);
  expect(messages[0]).toBe(`${new URL("/socket", app.server.url)}|127.0.0.1`);
  socket.send("echo"); await until(() => messages.length === 2); expect(messages[1]).toBe("echo");
  socket.close(); abort.abort(); await reader.cancel().catch(() => {}); await until(() => cancelled);
});

test("graceful stop drains a media response; force stop aborts a pending reader and can escalate graceful stop", async () => {
  for (const force of [false, true]) {
    const gate = Promise.withResolvers<void>();
    let aborted = false;
    const app = fixture(request => {
      request.signal.addEventListener("abort", () => { aborted = true; gate.resolve(); });
      let pulls = 0;
      return new Response(new ReadableStream({ async pull(controller) {
        if (pulls++) { await gate.promise; if (aborted) { controller.error(new Error("aborted")); return; } controller.enqueue(new Uint8Array(4096)); controller.close(); }
        else controller.enqueue(new Uint8Array(4096));
      } }, { highWaterMark: 0 }), { headers: { "content-length": "8192" } });
    });
    await app.ready;
    const response = await fetch(new URL("/api/media", app.server.url)); const reader = response.body!.getReader();
    expect((await reader.read()).value!.byteLength).toBe(4096);
    let stopped = false;
    const closing = app.server.stop(false).then(() => { stopped = true; });
    expect(stopped).toBe(false);
    if (force) {
      const killed = app.server.stop(true);
      await expect(reader.read()).rejects.toThrow(); await killed; expect(aborted).toBe(true);
    } else {
      gate.resolve(); let rest = 0; for (;;) { const next = await reader.read(); if (next.done) break; rest += next.value.byteLength; }
      expect(rest).toBe(4096);
    }
    await closing; expect(stopped).toBe(true);
  }
});

test("downstream abort cancels a pending body reader even when its producer does not observe the request signal", async () => {
  const gate = Promise.withResolvers<void>(); let cancelled = false;
  const app = fixture(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(65536)); },
    pull() { return gate.promise; },
    cancel() { cancelled = true; gate.resolve(); },
  }, { highWaterMark: 0 }), { headers: { "content-length": String(64 * 1024 * 1024) } }));
  await app.ready;
  const abort = new AbortController();
  const response = await fetch(new URL("/api/media", app.server.url), { signal: abort.signal });
  await response.body!.getReader().read(); abort.abort();
  await until(() => cancelled && app.server.pendingRequests === 0);
  expect(cancelled).toBe(true);
});

test("TLS termination retains public HTTPS URL, Origin, cookies and peer for both dispatch paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "uatu-media-boundary-tls-"));
  disposals.push(() => rm(directory, { recursive: true, force: true }));
  const key = path.join(directory, "key.pem"), cert = path.join(directory, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-days", "1", "-nodes", "-subj", "/CN=localhost"], { stdio: "ignore" });
  const app = fixture((request, server) => {
    if (new URL(request.url).pathname === "/socket") {
      if (server.upgrade(request, { data: { context: request.url } })) return;
      return new Response(null, { status: 400 });
    }
    return Response.json({ url: request.url, origin: request.headers.get("origin"), cookie: request.headers.get("cookie"), peer: server.requestIP(request)?.address });
  },
    { key: await readFile(key), cert: await readFile(cert) });
  await app.ready;
  for (const pathname of ["/ordinary", "/api/media"]) {
    const response = await fetch(new URL(pathname, app.server.url), { tls: { rejectUnauthorized: false }, headers: { origin: app.server.url.origin, cookie: "session=secure" } });
    expect(await response.json()).toEqual({ url: new URL(pathname, app.server.url).href, origin: app.server.url.origin, cookie: "session=secure", peer: "127.0.0.1" });
  }
  const address = new URL("/socket", app.server.url); address.protocol = "wss:";
  // lib.dom omits Bun's supported client TLS options.
  const socket = new WebSocket(address, { tls: { rejectUnauthorized: false } } as never);
  let message: string | undefined; socket.onmessage = event => { message = String(event.data); };
  await until(() => message !== undefined); expect(message).toBe(new URL("/socket", app.server.url).href); socket.close();
});

test("reload and fetch remain Bun-compatible through the public facade", async () => {
  const app = fixture(() => new Response("before")); await app.ready;
  app.server.reload({ fetch(request, server) { return new Response(`${new URL(request.url).port}:${server.port}:after`); } });
  expect(await (await fetch(app.server.url)).text()).toBe(`${app.server.port}:${app.server.port}:after`);
  expect(await (await fetch(new URL("/api/media", app.server.url))).text()).toBe(`${app.server.port}:${app.server.port}:after`);
  expect(await (await app.server.fetch(new Request(app.server.url))).text()).toBe(`${app.server.port}:${app.server.port}:after`);
  app.server.reload({ routes: { "/api/media": { GET: (request, server) => new Response(`route:${new URL(request.url).port}:${server.port}`) } } });
  expect(await (await fetch(new URL("/api/media", app.server.url))).text()).toBe(`route:${app.server.port}:${app.server.port}`);
  app.server.reload({ routes: {} });
  expect(await (await fetch(new URL("/api/media", app.server.url))).text()).toBe(`${app.server.port}:${app.server.port}:after`);
});

test("force stop releases an upgraded connection and both listeners", async () => {
  const app = fixture((request, server) => server.upgrade(request, { data: { context: "ready" } }) ? undefined : new Response(null, { status: 400 }));
  await app.ready;
  const address = new URL("/socket", app.server.url); address.protocol = "ws:";
  const socket = new WebSocket(address); let opened = false, closed = false;
  socket.onmessage = () => { opened = true; }; socket.onclose = () => { closed = true; };
  await until(() => opened); await app.server.stop(true); await until(() => closed);
  await expect(fetch(app.server.url)).rejects.toThrow(); await expect(fetch(app.inner.url)).rejects.toThrow();
});

test("a public bind failure releases the already-created private Bun listener", async () => {
  const occupying = fixture(() => new Response("occupied")); await occupying.ready;
  const inner = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("private") });
  const privateUrl = new URL(inner.url);
  try {
    expect(() => startMediaHttpBoundary({ server: inner, hostname: "127.0.0.1", port: occupying.server.port!,
      isMediaRequest: () => false, fetch: () => new Response("unused") })).toThrow();
    await until(() => inner.pendingRequests === 0);
    await expect(fetch(privateUrl)).rejects.toThrow();
  } finally { await inner.stop(true); }
});

test("invalid public TLS configuration releases the private Bun listener", async () => {
  const inner = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("private") });
  const privateUrl = new URL(inner.url);
  try {
    expect(() => startMediaHttpBoundary({ server: inner, hostname: "127.0.0.1", port: 0,
      tls: { cert: "not a certificate", key: "not a key" }, isMediaRequest: () => false, fetch: () => new Response("unused") })).toThrow();
    await expect(fetch(privateUrl)).rejects.toThrow();
  } finally { await inner.stop(true); }
});

test("graceful shutdown retains a public request whose private connection has not yet completed", async () => {
  const inner = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("accepted before stop") });
  let boundary!: MediaHttpBoundary<typeof inner>;
  let closing: Promise<void> | undefined;
  boundary = startMediaHttpBoundary({ server: inner, hostname: "127.0.0.1", port: 0,
    isMediaRequest: () => { queueMicrotask(() => { closing = boundary.server.stop(false); }); return false; },
    fetch: () => new Response("unused"),
  });
  disposals.push(() => boundary.server.stop(true)); await boundary.ready;
  const response = await fetch(boundary.server.url);
  expect(await response.text()).toBe("accepted before stop"); await closing;
});
