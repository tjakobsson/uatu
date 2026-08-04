// The hub's HTTP surface: auth gate, login flow, dashboard + its APIs, and
// the /s/<id>/ proxy dispatch. Assembled as a single fetch handler so the
// gate provably runs before anything session- or dashboard-shaped executes.

import { promises as fs } from "node:fs";
import path from "node:path";

import type { ServerWebSocket } from "bun";

import hubMonoFontAsset from "../assets/fonts/HackNerdFontMono-Regular.woff2" with { type: "file" };

import {
  formatHubCookie,
  formatHubCookieClear,
  isSameOriginRequest,
  LoginRateLimiter,
  readHubSession,
  verifyLogin,
} from "./auth";
import { createSessionCookieValue } from "./auth";
import type { HubConfig } from "./config";
import { cloneTargetName, gitClone, gitInit, probeGitRepository } from "./git";
import { dashboardPage, loginPage, stoppedSessionPage } from "./pages";
import {
  bridgeWebSocketHandlers,
  childUrlFor,
  proxyHttp,
  upgradeToBridge,
  type BridgeData,
  type UpgradableServer,
} from "./proxy";
import type { WorkspaceRegistry } from "./registry";
import type { SessionManager } from "./sessions";
import type { TerminalSessionInfo } from "../terminal/server";

export type HubDeps = {
  config: HubConfig;
  registry: WorkspaceRegistry;
  sessions: SessionManager;
  signingKey: string;
};

type HubServer = UpgradableServer & {
  requestIP?(request: Request): { address: string } | null;
};

const SESSION_PATH = /^\/s\/([^/]+)(\/|$)/;

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export function createHubFetchHandler(deps: HubDeps) {
  const { config, registry, sessions, signingKey } = deps;
  const limiter = new LoginRateLimiter();
  const secureCookies = config.tls !== null;

  const handleLogin = async (request: Request, server: HubServer): Promise<Response> => {
    if (request.method === "GET") {
      const session = readHubSession(request, signingKey);
      if (session) {
        return Response.redirect("/", 303);
      }
      return htmlResponse(loginPage());
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    if (!isSameOriginRequest(request)) {
      return htmlResponse(loginPage({ error: "cross-origin login rejected" }), 403);
    }

    const ip = server.requestIP?.(request)?.address ?? "unknown";
    if (!limiter.allow(ip)) {
      return htmlResponse(loginPage({ error: "too many attempts — wait a minute and try again" }), 429);
    }

    let name = "";
    let password = "";
    const contentType = request.headers.get("content-type") ?? "";
    try {
      if (contentType.includes("application/json")) {
        const body = (await request.json()) as { name?: unknown; password?: unknown };
        name = typeof body.name === "string" ? body.name : "";
        password = typeof body.password === "string" ? body.password : "";
      } else {
        const form = await request.formData();
        name = String(form.get("name") ?? "");
        password = String(form.get("password") ?? "");
      }
    } catch {
      return htmlResponse(loginPage({ error: "malformed login request" }), 400);
    }

    const user = await verifyLogin(config, name, password);
    if (!user) {
      limiter.recordFailure(ip);
      // Deliberately identical for wrong password and unknown user.
      return htmlResponse(loginPage({ error: "invalid credentials" }), 401);
    }
    limiter.reset(ip);

    return new Response(null, {
      status: 303,
      headers: {
        location: "/",
        "set-cookie": formatHubCookie(createSessionCookieValue(user.name, signingKey), {
          secure: secureCookies,
        }),
      },
    });
  };

  const hubState = async (): Promise<Response> => {
    const workspaces = await Promise.all(
      registry.list().map(async entry => {
        const running = sessions.get(entry.id);
        let shells: Pick<TerminalSessionInfo, "attached" | "label">[] | undefined;
        if (running) {
          try {
            const url = childUrlFor(running, new URL(`http://x/s/${entry.id}/api/terminal/sessions`));
            const response = await fetch(url);
            if (response.ok) {
              const payload = (await response.json()) as { sessions?: TerminalSessionInfo[] };
              shells = (payload.sessions ?? []).map(({ attached, label }) => ({ attached, label }));
            }
          } catch {
            // Shell summary is best-effort decoration.
          }
        }
        return {
          id: entry.id,
          path: entry.path,
          backend: entry.backend,
          running: running !== undefined,
          shells,
        };
      }),
    );
    return json(200, { workspaces });
  };

  // GET /api/hub/folders — the direct subfolders of the workspaces root,
  // each with its git status and registration, so the dashboard offers a
  // picker instead of a free-text server path.
  const listFolders = async (): Promise<Response> => {
    let entries: { name: string; git: boolean; registeredId: string | null; running: boolean }[] = [];
    try {
      const dirents = await fs.readdir(config.workspacesDir, { withFileTypes: true });
      entries = await Promise.all(
        dirents
          .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith("."))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(async dirent => {
            const folder = path.join(config.workspacesDir, dirent.name);
            // The root itself is guaranteed non-repo at startup, so a
            // subfolder is a repository iff it carries its own .git.
            const git = await Bun.file(path.join(folder, ".git", "HEAD")).exists();
            const registered = registry.byPath(folder);
            return {
              name: dirent.name,
              git,
              registeredId: registered?.id ?? null,
              running: registered ? sessions.isRunning(registered.id) : false,
            };
          }),
      );
    } catch {
      // Unreadable root reads as empty — the dashboard shows the empty state.
    }
    return json(200, { workspacesDir: config.workspacesDir, folders: entries });
  };

  // Resolves a workspace-creation folder name strictly against the
  // workspaces root: names only, no separators or dot segments.
  const resolveWorkspaceFolder = (name: string): string | null => {
    if (name === "" || name === "." || name === ".." || /[/\\]/.test(name)) {
      return null;
    }
    return path.join(config.workspacesDir, name);
  };

  // POST /api/hub/workspaces {name, init?} — the desktop launcher's git
  // preflight, remote: a definitive not-a-repository answer yields a 409
  // {needsInit:true} the dashboard turns into a confirmation; confirming
  // re-posts with init:true. Declining posts nothing — no registration.
  // An indeterminate probe skips the offer and serves; the CLI's own
  // preflight reports (and --force is never passed).
  const createWorkspace = async (request: Request): Promise<Response> => {
    let body: { name?: unknown; init?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const folder = name === "" ? null : resolveWorkspaceFolder(name);
    if (folder === null) {
      return json(400, { error: "name must be a folder directly inside the workspaces root" });
    }
    let isDirectory = false;
    try {
      isDirectory = (await fs.stat(folder)).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      return json(404, { error: `no such folder in the workspaces root: ${name}` });
    }

    const probe = await probeGitRepository(folder);
    if (probe.kind === "not-a-repository") {
      if (body.init !== true) {
        return json(409, { needsInit: true, error: `${folder} is not a git repository` });
      }
      const initialized = await gitInit(folder);
      if (!initialized.ok) {
        return json(500, { error: `git init failed: ${initialized.error}` });
      }
    }

    const entry = await registry.register(folder);
    try {
      await sessions.start(entry.id);
    } catch (error) {
      // A folder that fails to serve is not left registered — mirroring the
      // launcher rule that a declined/failed folder leaves no trace.
      await registry.remove(entry.id);
      return json(500, { error: error instanceof Error ? error.message : String(error) });
    }
    return json(200, { id: entry.id });
  };

  const cloneWorkspace = async (request: Request): Promise<Response> => {
    let body: { url?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (url === "" || cloneTargetName(url) === null) {
      return json(400, { error: "a git clone URL is required" });
    }
    const cloned = await gitClone(url, config.workspacesDir);
    if (!cloned.ok) {
      return json(500, { error: `git clone failed: ${cloned.error}` });
    }
    const entry = await registry.register(cloned.path);
    try {
      await sessions.start(entry.id);
    } catch (error) {
      await registry.remove(entry.id);
      return json(500, { error: error instanceof Error ? error.message : String(error) });
    }
    return json(200, { id: entry.id });
  };

  return async (request: Request, server: HubServer): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Un-gated: the login flow and the dashboard's static assets.
    if (pathname === "/login") {
      return handleLogin(request, server);
    }
    if (pathname === "/logout" && request.method === "POST") {
      if (!isSameOriginRequest(request)) {
        return json(403, { error: "cross-origin request rejected" });
      }
      return new Response(null, {
        status: 303,
        headers: {
          location: "/login",
          "set-cookie": formatHubCookieClear({ secure: secureCookies }),
        },
      });
    }
    if (pathname === "/hub-assets/mono.woff2") {
      return new Response(Bun.file(hubMonoFontAsset), {
        headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" },
      });
    }

    // The gate. Everything below requires an authenticated hub session.
    const session = readHubSession(request, signingKey);
    if (!session) {
      const wantsHtml = (request.headers.get("accept") ?? "").includes("text/html");
      if (request.method === "GET" && wantsHtml && !pathname.startsWith("/api/")) {
        return Response.redirect("/login", 303);
      }
      return json(401, { error: "authentication required" });
    }

    // Proxied session traffic.
    const sessionMatch = SESSION_PATH.exec(pathname);
    if (sessionMatch) {
      const workspaceId = decodeURIComponent(sessionMatch[1]!);
      const running = sessions.get(workspaceId);
      if (!running) {
        return htmlResponse(stoppedSessionPage(workspaceId, registry.byId(workspaceId) !== undefined), 503);
      }
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return upgradeToBridge(request, server, running);
      }
      return proxyHttp(request, running);
    }

    // Dashboard + its APIs.
    if (pathname === "/" && request.method === "GET") {
      return htmlResponse(dashboardPage());
    }
    if (pathname === "/api/hub/state" && request.method === "GET") {
      return hubState();
    }
    if (pathname === "/api/hub/folders" && request.method === "GET") {
      return listFolders();
    }

    // State-changing endpoints: POST-only + same-origin (CSRF).
    if (pathname.startsWith("/api/hub/")) {
      if (request.method !== "POST") {
        return json(405, { error: "method not allowed" });
      }
      if (!isSameOriginRequest(request)) {
        return json(403, { error: "cross-origin request rejected" });
      }
      if (pathname === "/api/hub/workspaces") {
        return createWorkspace(request);
      }
      if (pathname === "/api/hub/clone") {
        return cloneWorkspace(request);
      }
      const action = /^\/api\/hub\/sessions\/([^/]+)\/(start|stop)$/.exec(pathname);
      if (action) {
        const workspaceId = decodeURIComponent(action[1]!);
        if (!registry.byId(workspaceId)) {
          return json(404, { error: `unknown workspace: ${workspaceId}` });
        }
        if (action[2] === "start") {
          try {
            await sessions.start(workspaceId);
            return json(200, { id: workspaceId, running: true });
          } catch (error) {
            return json(500, { error: error instanceof Error ? error.message : String(error) });
          }
        }
        const stopped = await sessions.stop(workspaceId);
        return json(200, { id: workspaceId, running: false, wasRunning: stopped });
      }

      // Forget = unregister only. The folder stays on disk and reappears in
      // the folder listing as an unregistered candidate; a running session
      // must be stopped first so a forget can never orphan a live shell.
      const forget = /^\/api\/hub\/workspaces\/([^/]+)\/forget$/.exec(pathname);
      if (forget) {
        const workspaceId = decodeURIComponent(forget[1]!);
        if (!registry.byId(workspaceId)) {
          return json(404, { error: `unknown workspace: ${workspaceId}` });
        }
        if (sessions.isRunning(workspaceId)) {
          return json(409, { error: `stop the session for '${workspaceId}' before forgetting it` });
        }
        await registry.remove(workspaceId);
        return json(200, { id: workspaceId, forgotten: true });
      }
      return json(404, { error: "not found" });
    }

    return new Response("Not Found", { status: 404 });
  };
}

// Starts the hub's Bun.serve with TLS when configured and the WebSocket
// bridge handlers wired.
export function startHubServer(deps: HubDeps) {
  const handler = createHubFetchHandler(deps);
  return Bun.serve<BridgeData>({
    hostname: deps.config.host,
    port: deps.config.port,
    // SSE and long-lived terminal sockets must never be idle-reaped.
    idleTimeout: 0,
    ...(deps.config.tls
      ? { tls: { cert: Bun.file(deps.config.tls.cert), key: Bun.file(deps.config.tls.key) } }
      : {}),
    fetch: (request, server) => handler(request, server),
    websocket: {
      open(socket: ServerWebSocket<BridgeData>) {
        bridgeWebSocketHandlers.open(socket);
      },
      message(socket: ServerWebSocket<BridgeData>, data: string | Buffer) {
        bridgeWebSocketHandlers.message(socket, data);
      },
      close(socket: ServerWebSocket<BridgeData>, code: number, reason: string) {
        bridgeWebSocketHandlers.close(socket, code, reason);
      },
    },
  });
}
