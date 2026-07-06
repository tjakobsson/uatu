// Integration tests for the terminal HTTP/WS surface. These spin up a real
// Bun.serve with the same handlers cli.ts wires (auth gates, WS upgrade,
// origin allowlist, cookie auth) and exercise them over the wire so the
// shape of requests and responses is what a browser actually sees. They do
// NOT exercise the PTY backend itself — `terminal-backend.test.ts` covers
// that — so these tests don't require node-pty to spawn shells.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  authProbeResponse,
  constantTimeEqual,
  formatTerminalCookie,
  hasValidTerminalCredentials,
  isAllowedOrigin,
  terminalCookieName,
} from "./auth";
import { handleTerminalSessionsRoute } from "./sessions-route";
import type { TerminalServer } from "./server";

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
        if (!hasValidTerminalCredentials(request, url, token)) {
          return new Response("unauthorized", { status: 401 });
        }
        if (!isAllowedOrigin(request.headers.get("Origin"), url)) {
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
        return handleAuth(request, url, token);
      }
      if (url.pathname === "/api/auth" && request.method === "GET") {
        return authProbeResponse(request, url, token);
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

async function handleAuth(request: Request, requestUrl: URL, expected: string): Promise<Response> {
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
      "set-cookie": formatTerminalCookie(provided, requestUrl),
    },
  });
}

let ctx: ServeContext | null = null;

// The Host-port-scoped cookie name for the live test server (its port is
// picked by the OS at bind time).
function cookieName(): string {
  return terminalCookieName(new URL(ctx!.url("/")));
}

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
    expect(setCookie!).toContain(`${cookieName()}=`);
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
        Cookie: `${cookieName()}=bad`,
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
          Cookie: `${cookieName()}=${ctx!.token}`,
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

// The client classifies a close-before-open WebSocket failure by probing
// `GET /api/auth`, so the probe's verdict must agree with the upgrade
// gate's verdict for the same credentials × origin shape — a divergence
// would make the client show the wrong recovery UI. Exercised over the
// wire against the same live server that gates the upgrade.
describe("auth probe agrees with the upgrade gate", () => {
  const cases: Array<{ name: string; validToken: boolean; allowedOrigin: boolean }> = [
    { name: "valid credentials, allowed origin", validToken: true, allowedOrigin: true },
    { name: "valid credentials, rejected origin", validToken: true, allowedOrigin: false },
    { name: "invalid credentials, allowed origin", validToken: false, allowedOrigin: true },
    { name: "invalid credentials, rejected origin", validToken: false, allowedOrigin: false },
  ];

  for (const shape of cases) {
    it(shape.name, async () => {
      const token = shape.validToken ? ctx!.token : "garbage";
      const origin = shape.allowedOrigin ? ctx!.url("") : "http://localhost:9";
      const headers = {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
        Origin: origin,
      };
      const upgrade = await fetch(ctx!.url(`/api/terminal?t=${token}`), { headers });
      const probe = await fetch(ctx!.url(`/api/auth?t=${token}`), {
        headers: { Origin: origin },
      });

      if (!shape.validToken) {
        expect(upgrade.status).toBe(401);
        expect(probe.status).toBe(401);
      } else if (!shape.allowedOrigin) {
        expect(upgrade.status).toBe(403);
        expect(probe.status).toBe(403);
      } else {
        // Both gates passed. The plain-fetch upgrade then dies at
        // srv.upgrade() (500, no real WebSocket handshake behind fetch) —
        // the point is that neither side answered 401/403 when the probe
        // said 204.
        expect(probe.status).toBe(204);
        expect(upgrade.status).not.toBe(401);
        expect(upgrade.status).not.toBe(403);
      }
    });
  }
});

// Route-level tests for the session inventory endpoints. The handler is
// exercised directly with a stub TerminalServer — the PTY-backed behavior
// of listSessions/killSession is covered in server.test.ts.
describe("handleTerminalSessionsRoute", () => {
  const TOKEN = "sessions-route-token-0001";
  const stubSessions = [
    { id: "11111111-1111-4111-8111-111111111111", attached: true, createdAt: 1, cols: 80, rows: 24, label: "zsh" },
  ];
  function stubTerminal(killResult = true): TerminalServer {
    return {
      isAvailable: async () => true,
      prepareSession: () => ({ kind: "fresh" as const }),
      listSessions: async () => stubSessions,
      killSession: () => killResult,
      open: async () => undefined,
      message: () => undefined,
      close: () => undefined,
      disposeAll: () => undefined,
    };
  }
  function run(
    path: string,
    init: { method?: string; cookie?: boolean; query?: string } = {},
    terminal: TerminalServer | null = stubTerminal(),
  ): Response | Promise<Response> | null {
    const url = new URL(`http://127.0.0.1:4711${path}${init.query ?? ""}`);
    const headers = new Headers();
    if (init.cookie) {
      headers.set("Cookie", `${terminalCookieName(url)}=${encodeURIComponent(TOKEN)}`);
    }
    const request = new Request(url, { method: init.method ?? "GET", headers });
    return handleTerminalSessionsRoute(request, url, terminal, () => TOKEN);
  }

  it("ignores unrelated paths", () => {
    expect(run("/api/terminal")).toBeNull();
    expect(run("/api/terminal/sessionsish")).toBeNull();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const response = await run("/api/terminal/sessions");
    expect(response).not.toBeNull();
    expect((response as Response).status).toBe(401);
  });

  it("lists sessions for an authenticated GET (cookie or query token)", async () => {
    const viaCookie = (await run("/api/terminal/sessions", { cookie: true })) as Response;
    expect(viaCookie.status).toBe(200);
    expect(viaCookie.headers.get("cache-control")).toBe("no-store");
    const body = await viaCookie.json();
    expect(body.sessions).toEqual(stubSessions);

    const viaQuery = (await run("/api/terminal/sessions", {
      query: `?t=${encodeURIComponent(TOKEN)}`,
    })) as Response;
    expect(viaQuery.status).toBe(200);
  });

  it("DELETE kills a known session (204) and 404s an unknown one", async () => {
    const ok = (await run(`/api/terminal/sessions/${stubSessions[0]!.id}`, {
      method: "DELETE",
      cookie: true,
    })) as Response;
    expect(ok.status).toBe(204);

    const missing = (await run("/api/terminal/sessions/22222222-2222-4222-8222-222222222222", {
      method: "DELETE",
      cookie: true,
    }, stubTerminal(false))) as Response;
    expect(missing.status).toBe(404);
  });

  it("answers 405 for unsupported methods and 503 with no terminal server", async () => {
    const wrongMethod = (await run("/api/terminal/sessions", {
      method: "POST",
      cookie: true,
    })) as Response;
    expect(wrongMethod.status).toBe(405);

    const disabled = (await run("/api/terminal/sessions", { cookie: true }, null)) as Response;
    expect(disabled.status).toBe(503);
  });
});
