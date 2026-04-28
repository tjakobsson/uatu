#!/usr/bin/env bun

import readline from "node:readline";

import mermaidAsset from "mermaid/dist/mermaid.min.js" with { type: "file" };
import logoAsset from "./assets/uatu-logo.svg" with { type: "file" };
import index from "./index.html";
import {
  parseCommand,
  renderDocument,
  resolveWatchRoots,
  createWatchSession,
  openBrowser,
  canSetFileScope,
  SERVE_IDLE_TIMEOUT_SECONDS,
  staticFileResponse,
  usageText,
  versionText,
  printStartupBanner,
} from "./server";

async function main() {
  let parsed;

  try {
    parsed = parseCommand(Bun.argv.slice(2));
  } catch (error) {
    console.error(`uatu: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usageText());
    process.exit(1);
  }

  if (parsed.kind === "help") {
    console.log(usageText());
    return;
  }

  if (parsed.kind === "version") {
    console.log(versionText());
    return;
  }

  const rootEntries = await resolveWatchRoots(parsed.options.rootPaths, process.cwd());
  const watchSession = createWatchSession(rootEntries, parsed.options.follow, {
    respectGitignore: parsed.options.respectGitignore,
  });
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
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            if (message === "document is binary") {
              return Response.json({ error: "document is not viewable" }, { status: 415 });
            }
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
            if (!canSetFileScope(watchSession.getRoots(), documentId)) {
              return Response.json({ error: "document not found" }, { status: 404 });
            }
            return Response.json({ scope: watchSession.setScope({ kind: "file", documentId }) });
          }

          return Response.json({ error: "unsupported scope kind" }, { status: 400 });
        },
      },
    },
    fetch: async request => {
      const requestUrl = new URL(request.url);
      const response = await staticFileResponse(requestUrl.pathname, rootEntries, {
        respectGitignore: parsed.options.respectGitignore,
      });
      if (response) {
        return response;
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  const url = `http://127.0.0.1:${server.port}`;
  printStartupBanner(process.stdout);
  console.log(url);

  if (parsed.options.openBrowser) {
    const opened = await openBrowser(url);
    if (!opened) {
      console.error(`uatu: unable to open browser automatically; open ${url}`);
    }
  }

  let shuttingDown = false;
  const hardExit = (code: number) => {
    try {
      process.exit(code);
    } catch {
      // process.exit throwing should be impossible, but if it does, fall through to SIGKILL.
    }
    // Belt-and-braces: if process.exit hasn't taken hold within 50ms
    // (has happened with Bun + macOS fsevents holding native handles), self-SIGKILL.
    setTimeout(() => {
      try {
        process.kill(process.pid, "SIGKILL");
      } catch {
        // If even that fails, there's nothing more we can do.
      }
    }, 50);
  };

  const shutdown = () => {
    if (shuttingDown) {
      console.error("uatu: received second interrupt — force exiting");
      hardExit(1);
      return;
    }
    shuttingDown = true;
    console.error("uatu: shutting down");

    // Best-effort cleanup. We do NOT await these — if either hangs
    // (chokidar/fsevents sometimes never resolves close()), waiting would
    // block the shutdown indefinitely. The OS reclaims everything once we exit.
    void Promise.resolve()
      .then(() => watchSession.stop())
      .catch(() => undefined);
    void Promise.resolve()
      .then(() => server.stop(true))
      .catch(() => undefined);

    hardExit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);

  // Some terminals don't reliably deliver SIGINT to Bun-compiled binaries when
  // the user presses Ctrl+C. Put stdin into raw mode and catch the Ctrl+C byte
  // (0x03) directly, plus 'q' and Ctrl+D as convenience quit keys. Signal
  // handlers above remain active for `kill <pid>` and headless runs.
  const stdin = process.stdin;
  if (stdin.isTTY) {
    try {
      readline.emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", (chunk: Buffer) => {
        for (const byte of chunk) {
          if (byte === 0x03 || byte === 0x04) {
            shutdown();
            return;
          }
          if (byte === 0x71 || byte === 0x51) {
            // 'q' or 'Q'
            shutdown();
            return;
          }
        }
      });
      process.on("exit", () => {
        try {
          stdin.setRawMode(false);
        } catch {
          // Ignore — terminal may already have been torn down.
        }
      });
    } catch {
      // If raw mode isn't supported for any reason, the signal handlers above
      // still cover the common cases.
    }
  }
}

void main();
