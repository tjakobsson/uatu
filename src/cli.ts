#!/usr/bin/env bun

import readline from "node:readline";

import mermaidAsset from "mermaid/dist/mermaid.min.js" with { type: "file" };
import logoAsset from "./assets/uatu-logo.svg" with { type: "file" };
import icon192Asset from "./assets/icon-192.png" with { type: "file" };
import icon512Asset from "./assets/icon-512.png" with { type: "file" };
import manifestAsset from "./assets/manifest.webmanifest" with { type: "file" };
import swAsset from "./assets/sw.js" with { type: "file" };
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
  PORT_SCAN_LIMIT,
  SERVE_IDLE_TIMEOUT_SECONDS,
  usageText,
  versionText,
  printStartupBanner,
  printIndexingStatus,
  type WatchEntry,
  type WatchOptions,
} from "./server";
import { isViewMode } from "./shared";
import { findFreePort } from "./port-probe";
import { terminalBackendAvailable } from "./terminal-backend";
import {
  TERMINAL_COOKIE_NAME,
  constantTimeEqual,
  formatTerminalCookie,
  isAllowedOrigin,
  readCookie,
} from "./terminal-auth";
import { loadTerminalConfig } from "./terminal-config";
import { createTerminalServer } from "./terminal-server";

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
  let terminalServer: ReturnType<typeof createTerminalServer> | null = null;

  // Resolve the actual port to bind. When the user passed `--port`, honor it
  // strictly (no roll). When they didn't, pre-flight probe for a free port
  // starting at the default so PWA install identity stays stable across
  // launches even when something else briefly takes 4711.
  let chosenPort = options.port;
  if (!options.portExplicit && options.port !== 0) {
    chosenPort = await findFreePort(options.port, PORT_SCAN_LIMIT);
    if (chosenPort !== options.port) {
      console.error(`uatu: port ${options.port} in use, using ${chosenPort}`);
    }
  }

  // Probe the PTY backend up front so /api/state and the printed URL can both
  // tell the truth about whether the terminal feature is available.
  const terminalEnabled = await terminalBackendAvailable();
  const terminalConfigResult = terminalEnabled
    ? await loadTerminalConfig(rootEntries[0]?.absolutePath ?? process.cwd())
    : { config: {}, warnings: [] };
  for (const warning of terminalConfigResult.warnings) {
    console.error(`uatu: ${warning}`);
  }

  try {
    watchSession = createWatchSession(rootEntries, options.follow, {
      respectGitignore: options.respectGitignore,
      startupMode: options.startupMode,
      terminalEnabled,
      terminalConfig: terminalConfigResult.config,
    });
    await watchSession.start();

    if (terminalEnabled) {
      terminalServer = createTerminalServer({
        cwd: rootEntries[0]?.absolutePath ?? process.cwd(),
      });
    }

    const navigationFetch = createNavigationFetchHandler({
      getUnscopedRoots: () => watchSession!.getUnscopedRoots(),
      getEntries: () => rootEntries,
      getRespectGitignore: () => options.respectGitignore,
      getServer: () => server!,
    });

    const handleTerminalUpgrade = (
      request: Request,
      requestUrl: URL,
      srv: typeof Bun extends { serve: (...args: never) => infer S } ? S : never,
    ): Response | undefined => {
      if (!terminalServer) {
        return new Response("terminal disabled", { status: 503 });
      }
      const expected = watchSession!.getTerminalToken();
      // Accept either the URL token (first-visit path) or the auth cookie
      // (PWA / subsequent visits). PWA installs share cookies with the
      // browser session that minted them, so a user who visited /?t=<token>
      // once before installing keeps working — no re-auth needed.
      const queryToken = requestUrl.searchParams.get("t") ?? "";
      const cookieToken = readCookie(request.headers.get("Cookie"), TERMINAL_COOKIE_NAME);
      const tokenOk =
        constantTimeEqual(queryToken, expected) || constantTimeEqual(cookieToken, expected);
      if (!tokenOk) {
        return new Response("unauthorized", { status: 401 });
      }
      const origin = request.headers.get("Origin");
      if (!isAllowedOrigin(origin, srv)) {
        return new Response("forbidden origin", { status: 403 });
      }
      const session = terminalServer.prepareSession();
      const upgraded = srv.upgrade(request, { data: session });
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
    const handleAuth = async (request: Request): Promise<Response> => {
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
      const expected = watchSession!.getTerminalToken();
      if (!constantTimeEqual(provided, expected)) {
        return Response.json({ error: "invalid token" }, { status: 401 });
      }
      const cookie = formatTerminalCookie(provided);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": cookie,
        },
      });
    };

    server = Bun.serve({
      hostname: "127.0.0.1",
      port: chosenPort,
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
        "/assets/icon-192.png": new Response(Bun.file(icon192Asset), {
          headers: {
            "content-type": "image/png",
            "cache-control": "public, max-age=86400",
          },
        }),
        "/assets/icon-512.png": new Response(Bun.file(icon512Asset), {
          headers: {
            "content-type": "image/png",
            "cache-control": "public, max-age=86400",
          },
        }),
        "/manifest.webmanifest": new Response(Bun.file(manifestAsset), {
          headers: {
            "content-type": "application/manifest+json",
            "cache-control": "public, max-age=3600",
          },
        }),
        "/sw.js": new Response(Bun.file(swAsset), {
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
        "/api/state": {
          GET: () => Response.json(watchSession!.getStatePayload()),
        },
        "/api/document": {
          GET: async request => {
            const url = new URL(request.url);
            const documentId = url.searchParams.get("id");
            if (!documentId) {
              return Response.json({ error: "missing document id" }, { status: 400 });
            }

            const rawView = url.searchParams.get("view");
            const view = rawView && isViewMode(rawView) ? rawView : undefined;

            try {
              const document = await renderDocument(watchSession!.getRoots(), documentId, { view });
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
      fetch: (request, srv) => {
        const requestUrl = new URL(request.url);
        if (requestUrl.pathname === "/api/terminal") {
          return handleTerminalUpgrade(request, requestUrl, srv);
        }
        if (requestUrl.pathname === "/api/auth" && request.method === "POST") {
          return handleAuth(request);
        }
        return navigationFetch(request);
      },
      websocket: terminalServer
        ? {
            open: socket => {
              void terminalServer!.open(socket as unknown as Parameters<NonNullable<typeof terminalServer>["open"]>[0]);
            },
            message: (socket, data) => {
              terminalServer!.message(
                socket as unknown as Parameters<NonNullable<typeof terminalServer>["message"]>[0],
                data,
              );
            },
            close: socket => {
              terminalServer!.close(socket as unknown as Parameters<NonNullable<typeof terminalServer>["close"]>[0]);
            },
          }
        : undefined,
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
    if (terminalServer) {
      try {
        terminalServer.disposeAll();
      } catch {
        // Already failing — best-effort.
      }
    }
    throw error;
  }

  clearIndexingStatus();
  // TypeScript narrowing: both are set if the try block above completed.
  if (!server || !watchSession) {
    throw new Error("failed to start watch session");
  }

  const baseUrl = `http://127.0.0.1:${server.port}`;
  // Token is appended only when the terminal feature is on so unrelated runs
  // don't surface a confusing `?t=` in the printed URL. The browser strips it
  // from `location` on first load and stores it for later WS upgrades.
  const url = terminalEnabled ? `${baseUrl}/?t=${encodeURIComponent(watchSession.getTerminalToken())}` : baseUrl;
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
    if (terminalServer) {
      try {
        terminalServer.disposeAll();
      } catch {
        // Ignore — we are already exiting.
      }
    }

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
