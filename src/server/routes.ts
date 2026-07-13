// Shared Bun.serve route table used by both the production CLI server
// (cli.ts) and the e2e test harness server (tests/e2e/server.ts). Twelve
// of the fourteen routes are identical between the two; the rest are gated
// on the `mode` discriminator below.
//
// This module is the single home for the HTTP surface: the static route
// table (`buildRoutes`) plus the catch-all fetch fallback
// (`buildFetchFallback`) that handles the terminal WebSocket upgrade,
// `/api/auth`, the terminal-sessions inventory, and navigation dispatch.
// Both server entry points obtain both pieces here with mode-specific deps.

import { getDocumentDiff } from "../document/diff";
import { collectFileFacts } from "../document/file-facts";
import {
  authProbeResponse,
  constantTimeEqual,
  formatTerminalCookie,
  hasValidTerminalCredentials,
  isAllowedOrigin,
} from "../terminal/auth";
import type { createTerminalServer } from "../terminal/server";
import { handleTerminalSessionsRoute } from "../terminal/sessions-route";
import { findDocument, isReviewCompareTarget, isViewMode } from "../shared/types";
import { renderDocument } from "./render-dispatch";
import { canSetFileScope, type WatchSession } from "./watch-session";

// Bun.serve's idleTimeout. 0 = disabled: SSE connections and long-lived
// terminal WebSockets must never be reaped by an idle timer.
export const SERVE_IDLE_TIMEOUT_SECONDS = 0;

export type RouteAssets = {
  // The HTML entry (`import index from "./index.html"`) is intentionally
  // NOT here. `Bun.serve`'s bundler analyzes the route literal at the call
  // site to detect HTMLBundle entries and emit their chunk URLs into the
  // compiled binary. If the HTMLBundle is reached through a function-call
  // indirection (like `buildRoutes(...)`), the bundler can't see it and
  // the chunks fail to serve in compiled mode. So `"/": index` stays
  // inline at the Bun.serve call site; only the remaining assets are
  // routed through this builder.
  //
  // The remaining assets are file *paths* produced by `import x from "…"
  // with { type: "file" }`. They're served via `Bun.file(path)`.
  mermaid: string;
  logo: string;
  icon192: string;
  icon512: string;
  manifest: string;
  sw: string;
  // Bundled web fonts. Same `with { type: "file" }` mechanism — the
  // strings here are file paths embedded in the compiled binary, served
  // as woff2 (or plain text for the license/notice siblings).
  fonts: {
    hackMono: string;
    hackLicense: string;
    nerdFontsLicense: string;
    notices: string;
  };
};

type BaseDeps = {
  assets: RouteAssets;
  // Factory rather than direct reference: the e2e harness re-creates the
  // session on every `/__e2e/reset`, so the routes must read through to the
  // current instance each time they're invoked.
  getSession: () => WatchSession;
};

export type ProdRouteDeps = BaseDeps & {
  mode: "prod";
  // `/debug/metrics` returns 404 unless --debug was passed; the snapshot
  // function is only consulted when `debug` is true.
  debug: boolean;
  getMetricsSnapshot: () => unknown;
};

export type E2ERouteDeps = BaseDeps & {
  mode: "e2e";
  // The reset handler mutates module-level state in tests/e2e/server.ts
  // (active file path, workspace root, follow mode, etc.) and re-creates
  // the watch session, so it stays a callback owned by the caller.
  handleE2EReset: (request: Request) => Promise<Response>;
};

export type BuildRoutesDeps = ProdRouteDeps | E2ERouteDeps;

export function buildRoutes(deps: BuildRoutesDeps) {
  const { assets, getSession } = deps;

  const modeRoutes =
    deps.mode === "prod"
      ? buildProdRoutes(deps)
      : buildE2ERoutes(deps);

  return {
    "/assets/mermaid.min.js": new Response(Bun.file(assets.mermaid), {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
      },
    }),
    "/assets/uatu-logo.svg": new Response(Bun.file(assets.logo), {
      headers: {
        "content-type": "image/svg+xml",
        "cache-control": "public, max-age=3600",
      },
    }),
    "/assets/icon-192.png": new Response(Bun.file(assets.icon192), {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=86400",
      },
    }),
    "/assets/icon-512.png": new Response(Bun.file(assets.icon512), {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=86400",
      },
    }),
    "/manifest.webmanifest": new Response(Bun.file(assets.manifest), {
      headers: {
        "content-type": "application/manifest+json",
        "cache-control": "public, max-age=3600",
      },
    }),
    "/sw.js": new Response(Bun.file(assets.sw), {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        // No-cache: when a uatu upgrade changes the SW logic, the new
        // worker must reach the user on the next reload instead of
        // being shadowed by a cached older version.
        "cache-control": "no-cache",
        // Allow the worker to control the entire site even though it's
        // served from /sw.js (no path-prefix nesting needed).
        "service-worker-allowed": "/",
      },
    }),
    "/assets/fonts/HackNerdFontMono-Regular.woff2": new Response(Bun.file(assets.fonts.hackMono), {
      headers: {
        "content-type": "font/woff2",
        // Immutable: the file is part of the compiled binary and only
        // changes on a new uatu release.
        "cache-control": "public, max-age=31536000, immutable",
      },
    }),
    "/assets/fonts/LICENSE-hack.md": new Response(Bun.file(assets.fonts.hackLicense), {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
    }),
    "/assets/fonts/LICENSE-nerdfonts.txt": new Response(Bun.file(assets.fonts.nerdFontsLicense), {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
    }),
    "/assets/fonts/NOTICES.md": new Response(Bun.file(assets.fonts.notices), {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
    }),
    "/api/state": {
      GET: () => Response.json(getSession().getStatePayload()),
    },
    "/api/document": {
      GET: async (request: Request) => {
        const url = new URL(request.url);
        const documentId = url.searchParams.get("id");
        if (!documentId) {
          return Response.json({ error: "missing document id" }, { status: 400 });
        }

        const rawView = url.searchParams.get("view");
        const view = rawView && isViewMode(rawView) ? rawView : undefined;

        try {
          const document = await renderDocument(getSession().getRoots(), documentId, { view });
          return Response.json(document);
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (message === "document is binary") {
            return Response.json({ error: "document is not viewable" }, { status: 415 });
          }
          return Response.json({ error: "document not found" }, { status: 404 });
        }
      },
    },
    "/api/document/diff": {
      GET: async (request: Request) => {
        const url = new URL(request.url);
        const documentId = url.searchParams.get("id");
        if (!documentId) {
          return Response.json({ error: "missing document id" }, { status: 400 });
        }

        try {
          const roots = getSession().getRoots();
          const payload = await getDocumentDiff(
            roots,
            documentId,
            getSession().getCompareTarget(),
          );
          // Attach file facts so a diff-first load (the /api/document payload
          // was never fetched) can still populate the facts strip's
          // author/sha segments.
          const doc = findDocument(roots, documentId);
          const rootPath = doc ? roots.find(root => root.id === doc.rootId)?.path : undefined;
          const fileFacts = doc && rootPath
            ? await collectFileFacts({ absolutePath: doc.id, rootPath })
            : undefined;
          return Response.json({ ...payload, ...(fileFacts ? { fileFacts } : {}) });
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (message === "document not found") {
            return Response.json({ error: "document not found" }, { status: 404 });
          }
          return Response.json({ error: "document diff failed" }, { status: 500 });
        }
      },
    },
    "/api/events": {
      GET: () => getSession().eventsResponse(),
    },
    "/api/compare-target": {
      // Server-session view state shared across clients (mirrors /api/scope).
      // Setting it recomputes review snapshots and rebroadcasts over SSE; the
      // client receives the updated burden + anchor through the event stream.
      POST: async (request: Request) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 });
        }

        const target = (body as { target?: unknown } | null)?.target;
        if (!isReviewCompareTarget(target)) {
          return Response.json({ error: "invalid compare target" }, { status: 400 });
        }

        return Response.json({ compareTarget: getSession().setCompareTarget(target) });
      },
    },
    "/api/scope": {
      POST: async (request: Request) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 });
        }

        const scope = (body as { scope?: unknown } | null)?.scope;
        if (!scope || typeof scope !== "object") {
          return Response.json({ error: "missing scope" }, { status: 400 });
        }

        const kind = (scope as { kind?: unknown }).kind;
        if (kind === "folder") {
          return Response.json({ scope: getSession().setScope({ kind: "folder" }) });
        }

        if (kind === "file") {
          const documentId = (scope as { documentId?: unknown }).documentId;
          if (typeof documentId !== "string" || documentId.length === 0) {
            return Response.json({ error: "missing documentId" }, { status: 400 });
          }
          if (!canSetFileScope(getSession().getRoots(), documentId)) {
            return Response.json({ error: "document not found" }, { status: 404 });
          }
          return Response.json({ scope: getSession().setScope({ kind: "file", documentId }) });
        }

        return Response.json({ error: "unsupported scope kind" }, { status: 400 });
      },
    },
    ...modeRoutes,
  };
}

function buildProdRoutes(deps: ProdRouteDeps) {
  const { debug, getMetricsSnapshot } = deps;
  return {
    "/debug/metrics": {
      GET: () => {
        if (!debug) {
          return new Response("Not found", { status: 404 });
        }
        return Response.json(getMetricsSnapshot());
      },
    },
  };
}

function buildE2ERoutes(deps: E2ERouteDeps) {
  const { getSession, handleE2EReset } = deps;
  return {
    "/__e2e/terminal-token": {
      // Tests don't see the URL token (the e2e server doesn't print it to
      // stdout the way cli.ts does), so this exposes it directly. Localhost-
      // only by Bun.serve's hostname binding; not a real auth bypass — only
      // present in the e2e build.
      GET: () => {
        const session = getSession();
        return Response.json({
          token: session.getTerminalToken(),
          enabled: session.isTerminalEnabled(),
        });
      },
    },
    "/__e2e/reset": {
      POST: (request: Request) => handleE2EReset(request),
    },
  };
}

// ---------------------------------------------------------------------------
// Catch-all fetch fallback — the request paths Bun's static route table can't
// express: the WebSocket upgrade (needs the live server handle), /api/auth
// (sets a cookie from the session's rotating token), and the terminal
// sessions inventory. Previously duplicated near-verbatim between cli.ts and
// tests/e2e/server.ts; this builder is the single source of truth.

type TerminalServerInstance = ReturnType<typeof createTerminalServer>;

// Structural subset of Bun.Server the fallback needs: just `upgrade` for
// the WebSocket handshake. The Origin allowlist deliberately does NOT see
// the server handle — it compares against the request's Host header, so it
// keeps working when the browser reaches uatu through a mapped port.
export type FetchFallbackServer = {
  upgrade(request: Request, options?: { data?: unknown }): boolean;
};

export type FetchFallbackDeps = {
  // Nullable: the PTY backend may be unavailable (old Bun, Windows).
  getTerminalServer: () => TerminalServerInstance | null;
  getTerminalToken: () => string;
  navigationFetch: (request: Request) => Promise<Response>;
};

export function buildFetchFallback(deps: FetchFallbackDeps) {
  const handleTerminalUpgrade = (
    request: Request,
    requestUrl: URL,
    srv: FetchFallbackServer,
  ): Response | undefined => {
    const terminalServer = deps.getTerminalServer();
    if (!terminalServer) {
      return new Response("terminal disabled", { status: 503 });
    }
    // Accept either the URL token (first-visit path) or the Host-port-scoped
    // auth cookie (PWA / subsequent visits). PWA installs share cookies with
    // the browser session that minted them, so a user who visited /?t=<token>
    // once before installing keeps working — no re-auth needed.
    if (!hasValidTerminalCredentials(request, requestUrl, deps.getTerminalToken())) {
      return new Response("unauthorized", { status: 401 });
    }
    const origin = request.headers.get("Origin");
    if (!isAllowedOrigin(origin, requestUrl)) {
      return new Response("forbidden origin", { status: 403 });
    }
    const sessionId = requestUrl.searchParams.get("sessionId") ?? "";
    const takeover = requestUrl.searchParams.get("takeover") === "1";
    const result = terminalServer.prepareSession(sessionId, { takeover });
    if (result.kind === "invalid") {
      return new Response("invalid or missing sessionId", { status: 400 });
    }
    if (result.kind === "collision") {
      return new Response("sessionId in use", { status: 409 });
    }
    const upgraded = srv.upgrade(request, { data: { sessionId, takeover } });
    if (!upgraded) {
      return new Response("upgrade failed", { status: 500 });
    }
    // Bun docs: when `upgrade()` succeeds, return `undefined` so the runtime
    // doesn't race a stub response against the WebSocket handshake.
    return undefined;
  };

  // POST /api/auth { token } — validate the token and set a same-origin
  // HttpOnly cookie. The cookie is what makes the PWA install path work:
  // `start_url` is "/" with no query, so without persisted credentials a
  // freshly-launched PWA window has nothing to authenticate with. The
  // cookie is HttpOnly (no JS access — token can't be exfiltrated by an
  // XSS in any sibling document) and SameSite=Strict (no cross-site
  // request can carry it).
  const handleAuth = async (request: Request, requestUrl: URL): Promise<Response> => {
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
    if (!constantTimeEqual(provided, deps.getTerminalToken())) {
      return Response.json({ error: "invalid token" }, { status: 401 });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        // Named for the request's Host port so instances on different host
        // ports keep independent credentials (see terminalCookieName).
        "set-cookie": formatTerminalCookie(provided, requestUrl),
      },
    });
  };

  return (request: Request, srv: FetchFallbackServer): Response | Promise<Response> | undefined => {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname === "/api/terminal") {
      return handleTerminalUpgrade(request, requestUrl, srv);
    }
    if (requestUrl.pathname === "/api/auth" && request.method === "POST") {
      return handleAuth(request, requestUrl);
    }
    if (requestUrl.pathname === "/api/auth" && request.method === "GET") {
      return authProbeResponse(request, requestUrl, deps.getTerminalToken());
    }
    const sessionsResponse = handleTerminalSessionsRoute(
      request,
      requestUrl,
      deps.getTerminalServer(),
      deps.getTerminalToken,
    );
    if (sessionsResponse) {
      return sessionsResponse;
    }
    return deps.navigationFetch(request);
  };
}
