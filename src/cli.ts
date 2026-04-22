#!/usr/bin/env bun

import mermaidAsset from "mermaid/dist/mermaid.min.js" with { type: "file" };
import index from "./index.html";
import {
  parseCommand,
  renderDocument,
  resolveWatchRoots,
  createWatchSession,
  openBrowser,
  SERVE_IDLE_TIMEOUT_SECONDS,
  usageText,
} from "./server";
import { VERSION } from "./version";

async function main() {
  let parsed;

  try {
    parsed = parseCommand(Bun.argv.slice(2));
  } catch (error) {
    console.error(`uatu: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usageText(VERSION));
    process.exit(1);
  }

  if (parsed.kind === "help") {
    console.log(usageText(VERSION));
    return;
  }

  if (parsed.kind === "version") {
    console.log(VERSION);
    return;
  }

  const rootPaths = await resolveWatchRoots(parsed.options.rootPaths, process.cwd());
  const watchSession = createWatchSession(rootPaths, parsed.options.follow);
  await watchSession.start();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: parsed.options.port,
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
    },
  });

  const url = `http://127.0.0.1:${server.port}`;
  console.log(url);

  if (parsed.options.openBrowser) {
    const opened = await openBrowser(url);
    if (!opened) {
      console.error(`uatu: unable to open browser automatically; open ${url}`);
    }
  }

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
}

void main();
