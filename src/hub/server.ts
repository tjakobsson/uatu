// The hub's HTTP surface: auth gate, login flow, dashboard + its APIs, and
// the /s/<id>/ proxy dispatch. Assembled as a single fetch handler so the
// gate provably runs before anything session- or dashboard-shaped executes.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ServerWebSocket } from "bun";

import hubMonoFontAsset from "../assets/fonts/HackNerdFontMono-Regular.woff2" with { type: "file" };
import hubIcon192Asset from "../assets/icon-192.png" with { type: "file" };
import hubIcon512Asset from "../assets/icon-512.png" with { type: "file" };

import {
  clientKeyForRateLimit,
  formatHubCookie,
  formatHubCookieClear,
  isSameOriginRequest,
  LoginRateLimiter,
  readHubSession,
  safeReturnPath,
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
import type { PersonalWorkspaceStateStore } from "./personal-state";
import type { SessionManager } from "./sessions";
import type { TerminalSessionInfo } from "../terminal/server";
import { BUILD, formatBuildIdentifier } from "../shared/version";

export type HubDeps = {
  config: HubConfig;
  registry: WorkspaceRegistry;
  sessions: SessionManager;
  signingKey: string;
  personalState: PersonalWorkspaceStateStore;
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
  const { config, registry, sessions, signingKey, personalState } = deps;
  const limiter = new LoginRateLimiter();

  // Whether the browser-facing connection is HTTPS: either the hub
  // terminates TLS itself, or a fronting proxy (tailscale serve, Caddy,
  // nginx) says so via X-Forwarded-Proto. The header can only ADD the
  // Secure attribute — a forged value on a plain-HTTP hop hardens the
  // cookie, never weakens it — so trusting it needs no proxy allowlist.
  const secureCookies = (request: Request): boolean =>
    config.tls !== null ||
    (request.headers.get("x-forwarded-proto") ?? "").toLowerCase().includes("https");

  // The gate's verdict: a structurally valid, unexpired, correctly signed
  // cookie AND a user that still exists in the config. Removing a user
  // from the config (plus a restart) revokes their outstanding cookies —
  // without this, only rotating the signing key would.
  const authenticatedSession = (request: Request) => {
    const session = readHubSession(request, signingKey);
    if (!session) return null;
    if (!config.users.some(user => user.name === session.user)) return null;
    return session;
  };

  const handleLogin = async (request: Request, server: HubServer): Promise<Response> => {
    // The validated return-to target, carried by the gate's redirect
    // (?next=…) and echoed through the form so the POST can honor it.
    const nextTarget = safeReturnPath(new URL(request.url).searchParams.get("next"));
    if (request.method === "GET") {
      if (authenticatedSession(request)) {
        return Response.redirect(nextTarget, 303);
      }
      return htmlResponse(loginPage({ next: nextTarget === "/" ? undefined : nextTarget }));
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    if (!isSameOriginRequest(request)) {
      return htmlResponse(loginPage({ error: "cross-origin login rejected" }), 403);
    }

    const ip = clientKeyForRateLimit(
      server.requestIP?.(request)?.address ?? null,
      request.headers.get("x-forwarded-for"),
    );
    if (!limiter.allow(ip)) {
      return htmlResponse(loginPage({ error: "too many attempts — wait a minute and try again" }), 429);
    }

    let name = "";
    let password = "";
    // Browser form flow only — native JSON logins have no page to return to.
    let postedNext: string | null = null;
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
        const rawNext = form.get("next");
        postedNext = typeof rawNext === "string" && rawNext ? rawNext : null;
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
        // Back to the page the gate bounced from, when a validated target
        // rode the form; the dashboard otherwise.
        location: postedNext ? safeReturnPath(postedNext) : nextTarget,
        "set-cookie": formatHubCookie(createSessionCookieValue(user.name, signingKey), {
          secure: secureCookies(request),
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
            // Bounded: a wedged child that accepts but never answers must
            // degrade to an omitted summary, not hang the whole dashboard
            // state endpoint. Two seconds is generous for a loopback call.
            const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
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
    // `local` lets clients adapt to the trusted loopback mode — the SPA's
    // workspace switcher hides its sign-out entry when there is no login.
    return json(200, { version: formatBuildIdentifier(BUILD), local: config.local, workspaces });
  };

  // GET /api/hub/browse?path=<abs> — one level of the hub host's directory
  // tree, for the dashboard's Add Folder drill-down (and the desktop's
  // clone-destination picker). Directories only, dot-directories hidden,
  // symlinks not followed (a symlinked dirent is not a directory dirent).
  // Filesystem visibility here is within the documented trust model: hub
  // users already hold shell access through the embedded terminal.
  const browse = async (url: URL): Promise<Response> => {
    const requested = url.searchParams.get("path") ?? os.homedir();
    if (!path.isAbsolute(requested)) {
      return json(400, { error: "path must be absolute" });
    }
    const resolved = path.resolve(requested);
    let dirents;
    try {
      dirents = await fs.readdir(resolved, { withFileTypes: true });
    } catch {
      return json(404, { error: `cannot read directory: ${resolved}` });
    }
    const dirs = await Promise.all(
      dirents
        .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith("."))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(async dirent => {
          const folder = path.join(resolved, dirent.name);
          // A repository root carries .git — a directory normally, a file
          // for linked worktrees. Decoration only; registration re-probes.
          const git = await fs
            .stat(path.join(folder, ".git"))
            .then(() => true)
            .catch(() => false);
          const registered = registry.byPath(folder);
          return { name: dirent.name, git, registeredId: registered?.id ?? null };
        }),
    );
    const parent = path.dirname(resolved);
    return json(200, { path: resolved, parent: parent === resolved ? null : parent, dirs });
  };

  // POST /api/hub/workspaces {path, init?} — registers any absolute folder
  // path. The git preflight mirrors the desktop launcher's rules: a
  // definitive not-a-repository answer yields a 409 {needsInit:true} the
  // client turns into a confirmation; confirming re-posts with init:true.
  // Declining posts nothing — no registration. An indeterminate probe skips
  // the offer and serves; the CLI's own preflight reports (and --force is
  // never passed).
  // body.start === false registers without starting a session — the
  // desktop's one-time recents import needs registered-but-stopped entries.
  const createWorkspace = async (request: Request): Promise<Response> => {
    let body: { path?: unknown; init?: unknown; start?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
    const requested = typeof body.path === "string" ? body.path : "";
    if (requested === "" || !path.isAbsolute(requested)) {
      return json(400, { error: "an absolute folder path is required" });
    }
    const folder = path.resolve(requested);
    let isDirectory = false;
    try {
      isDirectory = (await fs.stat(folder)).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      return json(404, { error: `no such folder: ${folder}` });
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
    if (body.start === false) {
      return json(200, { id: entry.id, running: false });
    }
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

  // POST /api/hub/clone {url, dest} — clones into a browsed destination
  // directory, then registers and serves the checkout.
  const cloneWorkspace = async (request: Request): Promise<Response> => {
    let body: { url?: unknown; dest?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (url === "" || cloneTargetName(url) === null) {
      return json(400, { error: "a git clone URL is required" });
    }
    const dest = typeof body.dest === "string" ? body.dest : "";
    if (dest === "" || !path.isAbsolute(dest)) {
      return json(400, { error: "an absolute destination directory is required" });
    }
    const cloned = await gitClone(url, path.resolve(dest));
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

    // Un-gated: the login flow and the dashboard's static assets. In local
    // mode there is no login to serve — /login and /logout fall through to
    // the (always-passing) gate and end at 404, so a local hub never even
    // hints at a credential surface.
    if (!config.local && pathname === "/login") {
      return handleLogin(request, server);
    }
    if (!config.local && pathname === "/logout" && request.method === "POST") {
      if (!isSameOriginRequest(request)) {
        return json(403, { error: "cross-origin request rejected" });
      }
      return new Response(null, {
        status: 303,
        headers: {
          location: "/login",
          "set-cookie": formatHubCookieClear({ secure: secureCookies(request) }),
        },
      });
    }
    if (pathname === "/hub-assets/mono.woff2") {
      return new Response(Bun.file(hubMonoFontAsset), {
        headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" },
      });
    }
    // The hub's own web-app manifest, ungated: install-time fetches may be
    // anonymous (Safari fetches it when adding to the home screen) and a
    // 401 would silently degrade installs — the manifest carries only
    // branding. Scope "/" makes the whole hub origin — login, dashboard,
    // and every /s/<id>/ session — one installed app, so navigating
    // between them never shows iOS's out-of-scope browser chrome.
    if (pathname === "/manifest.webmanifest") {
      return Response.json(
        {
          name: "UatuCode Hub",
          short_name: "Uatu Hub",
          description: "Self-hosted hub for UatuCode sessions.",
          start_url: "/",
          scope: "/",
          display: "standalone",
          background_color: "#ffffff",
          theme_color: "#0a1c38",
          icons: [
            { src: "/hub-assets/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
            { src: "/hub-assets/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
          ],
        },
        {
          headers: {
            "content-type": "application/manifest+json",
            "cache-control": "public, max-age=3600",
          },
        },
      );
    }
    if (pathname === "/hub-assets/icon-192.png" || pathname === "/hub-assets/icon-512.png") {
      const asset = pathname.endsWith("icon-192.png") ? hubIcon192Asset : hubIcon512Asset;
      return new Response(Bun.file(asset), {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
      });
    }

    // The gate. Everything below requires an authenticated hub session
    // belonging to a still-configured user — except in local mode, where
    // every request IS the implicit local user (loopback-only bind is
    // enforced at startup; the trust model is `uatu serve`'s).
    const session = config.local
      ? { user: "local", issuedAt: 0 }
      : authenticatedSession(request);
    if (!session) {
      const wantsHtml = (request.headers.get("accept") ?? "").includes("text/html");
      if (request.method === "GET" && wantsHtml && !pathname.startsWith("/api/")) {
        // Carry the originally requested path so a successful sign-in
        // returns here instead of dumping the user on the dashboard —
        // critical for installed webapps launching straight into a
        // session URL. Validated again at login time; "/" is the noise
        // case not worth carrying.
        const next = safeReturnPath(pathname + url.search);
        return Response.redirect(next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`, 303);
      }
      return json(401, { error: "authentication required" });
    }

    // Proxied session traffic. Validate the browser's origin BEFORE any
    // rewriting: SameSite=Lax still attaches the cookie on same-site
    // cross-origin requests (another port, a sibling subdomain), and the
    // proxy deliberately replaces Origin with a loopback one the child
    // trusts — so an unchecked hostile Origin here would ride the rewrite
    // straight past the child's own gate to an interactive shell. Browsers
    // always send Origin on WebSocket upgrades and cross-origin fetches;
    // absent Origin (same-origin GETs, non-browser clients) passes.
    const sessionMatch = SESSION_PATH.exec(pathname);
    if (sessionMatch) {
      if (!isSameOriginRequest(request)) {
        return json(403, { error: "cross-origin request rejected" });
      }
      let workspaceId: string;
      try {
        workspaceId = decodeURIComponent(sessionMatch[1]!);
      } catch {
        return json(400, { error: "malformed workspace id" });
      }
      const suffix = pathname.slice(sessionMatch[0].endsWith("/") ? sessionMatch[0].length - 1 : sessionMatch[0].length);
      if (suffix === "/api/personal-state") {
        if (!registry.byId(workspaceId)) {
          return json(404, { error: `unknown workspace: ${workspaceId}` });
        }
        if (request.method === "GET") {
          return json(200, personalState.get(session.user, workspaceId));
        }
        if (request.method !== "PATCH") {
          return new Response(JSON.stringify({ error: "method not allowed" }), {
            status: 405,
            headers: { "content-type": "application/json", allow: "GET, PATCH" },
          });
        }
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return json(400, { error: "invalid JSON body" });
        }
        try {
          const state = await sessions.runExclusive(workspaceId, async () => {
            if (!registry.byId(workspaceId)) throw new Error(`unknown workspace: ${workspaceId}`);
            return personalState.patch(session.user, workspaceId, body);
          });
          return json(200, state);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith("unknown workspace:")) return json(404, { error: message });
          if (/personal state|documentPath|follow|previewMode|compareTarget|filesFilter|lastPtyId|unknown/.test(message)) {
            return json(400, { error: message });
          }
          return json(500, { error: "failed to persist personal state" });
        }
      }
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
      return htmlResponse(dashboardPage({ local: config.local }));
    }
    if (pathname === "/api/hub/state" && request.method === "GET") {
      return hubState();
    }
    if (pathname === "/api/hub/browse" && request.method === "GET") {
      return browse(url);
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
        try {
          await sessions.runWhileStopped(workspaceId, () =>
            personalState.forgetWorkspace(workspaceId, () => registry.remove(workspaceId))
          );
          return json(200, { id: workspaceId, forgotten: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("before forgetting")) return json(409, { error: message });
          return json(500, { error: "failed to forget workspace" });
        }
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
