#!/usr/bin/env bun

import mermaidAsset from "mermaid/dist/mermaid.min.js" with { type: "file" };
import logoAsset from "./assets/uatu-logo.svg" with { type: "file" };

import index from "./index.html";
import { E2E_PORT, E2E_WORKSPACE_ROOT, resetE2EWorkspace } from "./e2e";
import {
  createWatchSession,
  getAssetRoots,
  renderDocument,
  resolveWatchedFileCandidates,
  resolveWatchRoots,
  SERVE_IDLE_TIMEOUT_SECONDS,
  type WatchEntry,
} from "./server";

let activeFilePath: string | null = null;
let activeEntries: WatchEntry[] = [];
let watchSession = await createSession();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: E2E_PORT,
  idleTimeout: SERVE_IDLE_TIMEOUT_SECONDS,
  routes: {
    "/": index,
    "/assets/mermaid.min.js": new Response(Bun.file(mermaidAsset), {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
      },
    }),
    "/assets/uatu-logo.svg": new Response(Bun.file(logoAsset), {
      headers: {
        "content-type": "image/svg+xml",
        "cache-control": "public, max-age=3600",
      },
    }),
    "/api/state": {
      GET: () => Response.json(watchSession.getStatePayload()),
    },
    "/api/document": {
      GET: async request => {
        const documentId = new URL(request.url).searchParams.get("id");
        if (!documentId) {
          return Response.json({ error: "missing document id" }, { status: 400 });
        }

        try {
          const document = await renderDocument(watchSession.getRoots(), documentId);
          return Response.json(document);
        } catch {
          return Response.json({ error: "document not found" }, { status: 404 });
        }
      },
    },
    "/api/events": {
      GET: () => watchSession.eventsResponse(),
    },
    "/api/scope": {
      POST: async request => {
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
          return Response.json({ scope: watchSession.setScope({ kind: "folder" }) });
        }

        if (kind === "file") {
          const documentId = (scope as { documentId?: unknown }).documentId;
          if (typeof documentId !== "string" || documentId.length === 0) {
            return Response.json({ error: "missing documentId" }, { status: 400 });
          }
          return Response.json({ scope: watchSession.setScope({ kind: "file", documentId }) });
        }

        return Response.json({ error: "unsupported scope kind" }, { status: 400 });
      },
    },
    "/__e2e/reset": {
      POST: async request => {
        let body: { file?: string } = {};
        try {
          const text = await request.text();
          if (text.length > 0) {
            body = JSON.parse(text) as { file?: string };
          }
        } catch {
          body = {};
        }

        await watchSession.stop();
        activeFilePath = typeof body.file === "string" ? body.file : null;
        watchSession = await createSession();
        return Response.json(watchSession.getStatePayload());
      },
    },
  },
  fetch: async request => {
    const requestUrl = new URL(request.url);
    const pathname = decodeURIComponent(requestUrl.pathname);
    for (const candidate of resolveWatchedFileCandidates(pathname, getAssetRoots(activeEntries))) {
      const file = Bun.file(candidate);
      if (await file.exists()) {
        return new Response(file, { headers: { "cache-control": "no-cache" } });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`http://127.0.0.1:${server.port}`);

const shutdown = async () => {
  await watchSession.stop();
  await server.stop(true);
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

async function createSession() {
  await resetE2EWorkspace();
  const entryPaths = activeFilePath
    ? [`${E2E_WORKSPACE_ROOT}/${activeFilePath}`]
    : [E2E_WORKSPACE_ROOT];
  const entries = await resolveWatchRoots(entryPaths, process.cwd());
  activeEntries = entries;
  const session = createWatchSession(entries, true, { usePolling: true });
  await session.start();
  return session;
}
