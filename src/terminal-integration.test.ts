// Integration tests for the terminal HTTP/WS surface. These spin up a real
// Bun.serve with the same handlers cli.ts wires (auth gates, WS upgrade,
// origin allowlist, cookie auth) and exercise them over the wire so the
// shape of requests and responses is what a browser actually sees. They do
// NOT exercise the PTY backend itself — `terminal-backend.test.ts` covers
// that — so these tests don't require node-pty to spawn shells.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  TERMINAL_COOKIE_NAME,
  constantTimeEqual,
  formatTerminalCookie,
  isAllowedOrigin,
  readCookie,
} from "./terminal-auth";

type ServeContext = {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  token: string;
  url: (path: string) => string;
  upgradesAttempted: number;
};

function startTestServer(token: string): ServeContext {
  let upgradesAttempted = 0;
  const ctx: Partial<ServeContext> = {
    upgradesAttempted: 0,
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      const url = new URL(request.url);
      if (url.pathname === "/api/terminal") {
        const queryToken = url.searchParams.get("t") ?? "";
        const cookieToken = readCookie(request.headers.get("Cookie"), TERMINAL_COOKIE_NAME);
        const tokenOk =
          constantTimeEqual(queryToken, token) || constantTimeEqual(cookieToken, token);
        if (!tokenOk) return new Response("unauthorized", { status: 401 });
        if (!isAllowedOrigin(request.headers.get("Origin"), srv)) {
          return new Response("forbidden origin", { status: 403 });
        }
        upgradesAttempted += 1;
        if (ctx.upgradesAttempted !== undefined) ctx.upgradesAttempted = upgradesAttempted;
        const ok = (srv.upgrade as (req: Request, opts: { data: unknown }) => boolean)(request, {
          data: { sessionId: `s${upgradesAttempted}` },
        });
        if (!ok) return new Response("upgrade failed", { status: 500 });
        return undefined;
      }
      if (url.pathname === "/api/auth" && request.method === "POST") {
        return handleAuth(request, token);
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(socket) {
        // Echo back any input so the client can verify a bidirectional path.
        socket.send(JSON.stringify({ type: "hello" }));
        // Acknowledge in `data` so we know per-socket state arrived.
        const data = (socket as unknown as { data?: { sessionId?: string } }).data;
        if (data?.sessionId) {
          socket.send(JSON.stringify({ type: "session", id: data.sessionId }));
        }
      },
      message(socket, msg) {
        const text = typeof msg === "string" ? msg : new TextDecoder().decode(msg as Uint8Array);
        socket.send(`echo:${text}`);
      },
      close() {
        // No-op.
      },
    },
  });

  ctx.server = server;
  ctx.port = server.port!;
  ctx.token = token;
  ctx.url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  return ctx as ServeContext;
}

async function handleAuth(request: Request, expected: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const provided = (body as { token?: unknown } | null)?.token;
  if (typeof provided !== "string" || provided.length === 0) {
    return Response.json({ error: "missing token" }, { status: 400 });
  }
  if (!constantTimeEqual(provided, expected)) {
    return Response.json({ error: "invalid token" }, { status: 401 });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": formatTerminalCookie(provided),
    },
  });
}

let ctx: ServeContext | null = null;

beforeEach(() => {
  ctx = startTestServer("test-token-1234567890abcdef");
});

afterEach(async () => {
  if (!ctx) return;
  ctx.server.stop(true);
  ctx = null;
});

describe("/api/auth", () => {
  it("rejects malformed JSON body with 400", async () => {
    const res = await fetch(ctx!.url("/api/auth"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing token field with 400", async () => {
    const res = await fetch(ctx!.url("/api/auth"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty token with 400", async () => {
    const res = await fetch(ctx!.url("/api/auth"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects wrong token with 401", async () => {
    const res = await fetch(ctx!.url("/api/auth"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "garbage" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts the correct token and returns Set-Cookie with HttpOnly + SameSite=Strict", async () => {
    const res = await fetch(ctx!.url("/api/auth"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: ctx!.token }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie!).toContain(`${TERMINAL_COOKIE_NAME}=`);
    expect(setCookie!).toContain("HttpOnly");
    expect(setCookie!).toContain("SameSite=Strict");
    expect(setCookie!).toContain("Path=/");
  });
});

describe("/api/terminal upgrade gates", () => {
  function wsHeaders(extras: Record<string, string> = {}): Record<string, string> {
    return {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version": "13",
      ...extras,
    };
  }

  it("returns 401 when no token is supplied", async () => {
    const res = await fetch(ctx!.url("/api/terminal"), {
      headers: wsHeaders({ Origin: ctx!.url("") }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is wrong", async () => {
    const res = await fetch(ctx!.url("/api/terminal?t=garbage"), {
      headers: wsHeaders({ Origin: ctx!.url("") }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 when token is valid but Origin is foreign", async () => {
    const res = await fetch(ctx!.url(`/api/terminal?t=${ctx!.token}`), {
      headers: wsHeaders({ Origin: "http://attacker.example" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 401 when both query and cookie are wrong", async () => {
    const res = await fetch(ctx!.url("/api/terminal"), {
      headers: wsHeaders({
        Origin: ctx!.url(""),
        Cookie: `${TERMINAL_COOKIE_NAME}=bad`,
      }),
    });
    expect(res.status).toBe(401);
  });

  it("upgrades successfully when token is in the URL and Origin is allowed", async () => {
    return new Promise<void>((resolve, reject) => {
      // Bun's WebSocket client accepts `{ headers }` as the second arg; the
      // standard DOM type lib only knows about `protocols`. Cast to the Bun
      // shape.
      const WS = WebSocket as unknown as new (url: string, opts: { headers: Record<string, string> }) => WebSocket;
      const ws = new WS(`ws://127.0.0.1:${ctx!.port}/api/terminal?t=${ctx!.token}`, {
        headers: { Origin: ctx!.url("") },
      });
      ws.binaryType = "arraybuffer";
      const t = setTimeout(() => reject(new Error("timeout waiting for ws open")), 1500);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        ws.close();
        resolve();
      });
      ws.addEventListener("error", err => {
        clearTimeout(t);
        reject(err);
      });
    });
  });

  it("upgrades successfully via cookie alone (PWA flow)", async () => {
    return new Promise<void>((resolve, reject) => {
      const WS = WebSocket as unknown as new (url: string, opts: { headers: Record<string, string> }) => WebSocket;
      const ws = new WS(`ws://127.0.0.1:${ctx!.port}/api/terminal`, {
        headers: {
          Origin: ctx!.url(""),
          Cookie: `${TERMINAL_COOKIE_NAME}=${ctx!.token}`,
        },
      });
      const t = setTimeout(() => reject(new Error("timeout waiting for ws open")), 1500);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        ws.close();
        resolve();
      });
      ws.addEventListener("error", err => {
        clearTimeout(t);
        reject(err);
      });
    });
  });
});
