#!/usr/bin/env bun

import readline from "node:readline";

import mermaidAsset from "mermaid/dist/mermaid.min.js" with { type: "file" };
import logoAsset from "./assets/uatu-logo.svg" with { type: "file" };
import index from "./index.html";
import {
  createNavigationFetchHandler,
  parseCommand,
  renderDocument,
  resolveWatchRoots,
  findNonGitWatchEntries,
  createWatchSession,
  openBrowser,
  canSetFileScope,
  SERVE_IDLE_TIMEOUT_SECONDS,
  usageText,
  versionText,
  printStartupBanner,
  printIndexingStatus,
  type WatchEntry,
  type WatchOptions,
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

  try {
    await runWatch(parsed.options);
  } catch (error) {
    console.error(`uatu: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function runWatch(options: WatchOptions) {
  const rootEntries = await resolveWatchRoots(options.rootPaths, process.cwd());
  const nonGitEntries = await findNonGitWatchEntries(rootEntries);
  if (nonGitEntries.length > 0) {
    const paths = formatWatchEntryPaths(nonGitEntries.map(result => result.entry));
    const plural = nonGitEntries.length === 1 ? "path is" : "paths are";
    if (!options.force) {
      throw new Error(`watch ${plural} not inside a git repository: ${paths}. Use --force to watch non-git paths anyway.`);
    }
    console.error(`uatu: warning: watching non-git ${nonGitEntries.length === 1 ? "path" : "paths"} with --force; indexing may be slow: ${paths}`);
  }

  const clearIndexingStatus = printIndexingStatus(rootEntries, process.stdout);
  let watchSession: ReturnType<typeof createWatchSession> | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;

  try {
    watchSession = createWatchSession(rootEntries, options.follow, {
      respectGitignore: options.respectGitignore,
      startupMode: options.startupMode,
    });
    await watchSession.start();

    server = Bun.serve({
      hostname: "127.0.0.1",
      port: options.port,
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
          GET: () => Response.json(watchSession!.getStatePayload()),
        },
        "/api/document": {
          GET: async request => {
            const documentId = new URL(request.url).searchParams.get("id");
            if (!documentId) {
              return Response.json({ error: "missing document id" }, { status: 400 });
            }

            try {
              const document = await renderDocument(watchSession!.getRoots(), documentId);
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
          GET: () => watchSession!.eventsResponse(),
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
              return Response.json({ scope: watchSession!.setScope({ kind: "folder" }) });
            }

            if (kind === "file") {
              const documentId = (scope as { documentId?: unknown }).documentId;
              if (typeof documentId !== "string" || documentId.length === 0) {
                return Response.json({ error: "missing documentId" }, { status: 400 });
              }
              if (!canSetFileScope(watchSession!.getRoots(), documentId)) {
                return Response.json({ error: "document not found" }, { status: 404 });
              }
              return Response.json({ scope: watchSession!.setScope({ kind: "file", documentId }) });
            }

            return Response.json({ error: "unsupported scope kind" }, { status: 400 });
          },
        },
      },
      fetch: createNavigationFetchHandler({
        getUnscopedRoots: () => watchSession!.getUnscopedRoots(),
        getEntries: () => rootEntries,
        getRespectGitignore: () => options.respectGitignore,
        getServer: () => server!,
      }),
    });
  } catch (error) {
    clearIndexingStatus();
    if (watchSession) {
      void Promise.resolve()
        .then(() => watchSession!.stop())
        .catch(() => undefined);
    }
    if (server) {
      void Promise.resolve()
        .then(() => server!.stop(true))
        .catch(() => undefined);
    }
    throw error;
  }

  clearIndexingStatus();
  // TypeScript narrowing: both are set if the try block above completed.
  if (!server || !watchSession) {
    throw new Error("failed to start watch session");
  }

  const url = `http://127.0.0.1:${server.port}`;
  printStartupBanner(process.stdout);
  console.log(url);

  if (options.openBrowser) {
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
      .then(() => watchSession!.stop())
      .catch(() => undefined);
    void Promise.resolve()
      .then(() => server!.stop(true))
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

function formatWatchEntryPaths(entries: WatchEntry[]): string {
  return entries.map(entry => entry.absolutePath).join(", ");
}

void main();
