// Shared Bun.serve route table used by both the production CLI server
// (cli.ts) and the e2e test harness server (tests/e2e/server.ts). Twelve
// of the fourteen routes are identical between the two; the rest are gated
// on the `mode` discriminator below.
//
// This module is deliberately *just* a router factory. Authentication,
// terminal WebSocket upgrade, and the navigation fallback continue to live
// at the call sites because they need access to call-site-local state
// (terminalServer instance, navigation handler, etc.) that doesn't belong
// in a route table.

import { getDocumentDiff } from "../document/diff";
import { isViewMode } from "../shared/types";
import {
  canSetFileScope,
  renderDocument,
  type WatchSession,
} from "./session";

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
          const payload = await getDocumentDiff(getSession().getRoots(), documentId);
          return Response.json(payload);
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
