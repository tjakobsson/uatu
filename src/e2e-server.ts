#!/usr/bin/env bun

import mermaidAsset from "mermaid/dist/mermaid.min.js" with { type: "file" };

import index from "./index.html";
import { E2E_PORT, E2E_WORKSPACE_ROOT, resetE2EWorkspace } from "./e2e";
import { createWatchSession, renderDocument, SERVE_IDLE_TIMEOUT_SECONDS } from "./server";

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
    "/__e2e/reset": {
      POST: async () => {
        await watchSession.stop();
        watchSession = await createSession();
        return Response.json(watchSession.getStatePayload());
      },
    },
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
  const session = createWatchSession([E2E_WORKSPACE_ROOT], true);
  await session.start();
  return session;
}
