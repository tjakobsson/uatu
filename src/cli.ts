#!/usr/bin/env bun

import { promises as fs } from "node:fs";
import readline from "node:readline";

import type { WebSocketHandler } from "bun";

import mermaidAsset from "mermaid/dist/mermaid.min.js" with { type: "file" };
import logoAsset from "./assets/uatu-logo.svg" with { type: "file" };
import icon192Asset from "./assets/icon-192.png" with { type: "file" };
import icon512Asset from "./assets/icon-512.png" with { type: "file" };
import manifestAsset from "./assets/manifest.webmanifest" with { type: "file" };
import hackMonoFontAsset from "./assets/fonts/HackNerdFontMono-Regular.woff2" with { type: "file" };
import hackLicenseAsset from "./assets/fonts/LICENSE-hack.md" with { type: "file" };
import nerdFontsLicenseAsset from "./assets/fonts/LICENSE-nerdfonts.txt" with { type: "file" };
import fontNoticesAsset from "./assets/fonts/NOTICES.md" with { type: "file" };
import index from "./index.html";
import { parseCommand, usageText, versionText, type WatchOptions } from "./cli/parse";
import { LazyChatService } from "./chat/service";
import { MultiAgentChatService } from "./chat/agents";
import { selectCanonicalChatRoot } from "./chat/workspace";
import { runHashPassword, runHub } from "./hub/main";
import { runStoredGitCredentialHelper } from "./hub/git-credential-helper";
import { runSshAgentSupervisor } from "./hub/credential-ssh-supervisor";
import {
  formatSessionUrl,
  printIndexingStatus,
  printStartupBanner,
  SERVE_DEPRECATION_WARNING,
  shouldWarnServeDeprecation,
  startSupervisedStartupHeartbeat,
} from "./cli/output";
import { createNavigationFetchHandler, INTERNAL_SHELL_PATH, openBrowser, spaShellResponse } from "./server/navigation";
import { findNonGitWatchEntries, resolveWatchRoots, type WatchEntry } from "./server/roots";
import { createWatchSession } from "./server/watch-session";
import { buildFetchFallback, buildRoutes, SERVE_IDLE_TIMEOUT_SECONDS } from "./server/routes";
import { DEFAULT_PORT_SCAN_LIMIT, findFreePort } from "./server/port-probe";
import { terminalBackendAvailable } from "./terminal/backend";
import { createTerminalServer } from "./terminal/server";
import { SHELL_UNSET_STARTUP_WARNING, shellIsUnset } from "./terminal/shell-warning";
import {
  createCachePaths,
  ensureCacheDir,
  pruneOldDumps,
  resolveCacheRoot,
} from "./debug/cache";
import {
  MetricsRegistry,
  NdjsonAppender,
  start1HzSnapshotTick,
  start5sSamplingTick,
  writeSnapshotAtomic,
} from "./debug/metrics";
import { setGitMetricsSink } from "./document/git-base-ref";
import { parseWatchdogArgs, runWatchdog } from "./watchdog/main";

async function main() {
  // Watchdog mode short-circuits the rest of CLI parsing — when uatu is
  // re-execed as the sibling watchdog, none of the parent's startup work
  // (chokidar, server, terminal stack) should run. parseWatchdogArgs throws
  // on malformed input, which we surface to stderr.
  const argv = Bun.argv.slice(2);
  if (argv[0] === "--ssh-agent-supervisor") {
    if (argv.length !== 1) {
      process.exitCode = 2;
      return;
    }
    process.exit(await runSshAgentSupervisor());
  }
  if (argv[0] === "--git-credential-helper") {
    if (argv.length !== 2) {
      process.exitCode = 1;
      return;
    }
    try {
      process.stdout.write(await runStoredGitCredentialHelper(argv[1], process.stdin, process.env));
    } catch {
      process.exitCode = 1;
    }
    return;
  }
  if (argv[0] === "--watchdog") {
    try {
      const args = parseWatchdogArgs(argv.slice(1), process.env);
      const code = await runWatchdog(args);
      process.exit(code);
    } catch (error) {
      console.error(`uatu watchdog: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }
    return;
  }

  let parsed;

  try {
    parsed = parseCommand(argv);
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
    if (parsed.kind === "hub") {
      await runHub(parsed.options);
      return;
    }
    if (parsed.kind === "hub-hash-password") {
      await runHashPassword();
      return;
    }
    await runWatch(parsed.options);
  } catch (error) {
    console.error(`uatu: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function runWatch(options: WatchOptions) {
  // stderr only, so piped-stdout consumers capturing the URL line are
  // unaffected; behavior is otherwise identical to before.
  if (shouldWarnServeDeprecation(options)) {
    console.error(`uatu: ${SERVE_DEPRECATION_WARNING}`);
  }

  // Diagnostic plumbing comes before any heavy startup work — the cache dir
  // and the metrics registry are needed by createWatchSession and by the
  // watchdog spawn. Failures in this layer must never fail the watch session.
  const metrics = new MetricsRegistry();
  setGitMetricsSink(metrics);
  const cacheRoot = resolveCacheRoot();
  try {
    await ensureCacheDir(cacheRoot);
    void pruneOldDumps(cacheRoot).catch(() => undefined);
  } catch (error) {
    console.error(`uatu: cache directory unavailable, diagnostics disabled: ${error instanceof Error ? error.message : String(error)}`);
  }
  const cachePaths = createCachePaths(cacheRoot);
  const heartbeatPath = cachePaths.heartbeatPath(process.pid);
  const snapshotPath = cachePaths.snapshotPath(process.pid);
  const ndjsonPath = cachePaths.ndjsonPath(process.pid);

  const rootEntries = await resolveWatchRoots(options.rootPaths, process.cwd());
  const nonGitEntries = await findNonGitWatchEntries(rootEntries);
  if (nonGitEntries.length > 0) {
    const paths = formatWatchEntryPaths(nonGitEntries.map(result => result.entry));
    const plural = nonGitEntries.length === 1 ? "path is" : "paths are";
    if (!options.force) {
      throw new Error(`${plural} not inside a git repository: ${paths}. Use --force to serve non-git paths anyway.`);
    }
    console.error(`uatu: warning: serving non-git ${nonGitEntries.length === 1 ? "path" : "paths"} with --force; indexing may be slow: ${paths}`);
  }

  const clearIndexingStatus = printIndexingStatus(rootEntries, process.stdout);
  // Hub-supervised children (marked by --exit-on-stdin-close) get periodic
  // progress lines instead of the TTY status, so the hub's startup watchdog
  // can tell slow from hung.
  const stopStartupHeartbeat = startSupervisedStartupHeartbeat(rootEntries, options, process.stdout);
  let watchSession: ReturnType<typeof createWatchSession> | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let terminalServer: ReturnType<typeof createTerminalServer> | null = null;
  let chatService: MultiAgentChatService | null = null;

  // Resolve the actual port to bind. When the user passed `--port`, honor it
  // strictly (no roll). When they didn't, pre-flight probe for a free port
  // starting at the default so PWA install identity stays stable across
  // launches even when something else briefly takes 4711.
  let chosenPort = options.port;
  if (!options.portExplicit && options.port !== 0) {
    chosenPort = await findFreePort(options.port, DEFAULT_PORT_SCAN_LIMIT);
    if (chosenPort !== options.port) {
      console.error(`uatu: port ${options.port} in use, using ${chosenPort}`);
    }
  }

  // Probe the PTY backend up front so /api/state and the printed URL can both
  // tell the truth about whether the terminal feature is available.
  const terminalEnabled = await terminalBackendAvailable();
  const chatRoot = await selectCanonicalChatRoot(rootEntries);

  try {
    chatService = new MultiAgentChatService({
      workspacePath: chatRoot,
      agents: [{
        descriptor: { id: "opencode", name: "OpenCode" },
        service: new LazyChatService({ workspacePath: chatRoot, metrics }),
      }],
    });
    watchSession = createWatchSession(rootEntries, options.follow, {
      respectGitignore: options.respectGitignore,
      terminalEnabled,
      metrics,
    });
    await watchSession.start();

    if (terminalEnabled) {
      terminalServer = createTerminalServer({
        cwd: rootEntries[0]?.absolutePath ?? process.cwd(),
        metrics,
      });
    }

    const navigationFetch = createNavigationFetchHandler({
      getUnscopedRoots: () => watchSession!.getUnscopedRoots(),
      getEntries: () => rootEntries,
      getRespectGitignore: () => options.respectGitignore,
      getServer: () => server!,
      basePath: options.basePath,
    });

    const fetchFallback = buildFetchFallback({
      getTerminalServer: () => terminalServer,
      getTerminalToken: () => watchSession!.getTerminalToken(),
      navigationFetch,
      basePath: options.basePath,
    });

    server = Bun.serve({
      hostname: "127.0.0.1",
      port: chosenPort,
      idleTimeout: SERVE_IDLE_TIMEOUT_SECONDS,
      routes: {
        // The HTMLBundle MUST appear as a literal at this call site so
        // Bun's bundler can analyze the route table during `bun build
        // --compile` and wire up the chunk URLs — routing through
        // `buildRoutes` alone is opaque to that analysis and the compiled
        // binary fails to serve /chunk-*.js. It lives on an internal path
        // only: external traffic reaches the shell through spaShellResponse,
        // which pins `Cache-Control: no-cache` (the raw HTMLBundle route
        // serves no cache headers at all — a stale-HTML vector) and rewrites
        // bundle-asset refs so their responses carry immutable caching. The
        // remaining routes are deduplicated across cli.ts and
        // tests/e2e/server.ts via `buildRoutes`.
        [INTERNAL_SHELL_PATH]: index,
        // Cast: TS types the conditional spread's "/" as optional-undefined,
        // which Bun's Routes type rejects; at runtime the key is simply
        // absent in prefix mode.
        ...((options.basePath === "/"
          ? { "/": { GET: () => spaShellResponse(server!) } }
          : {}) as { "/": { GET: () => Promise<Response> } }),
        ...buildRoutes({
          mode: "prod",
          assets: {
            mermaid: mermaidAsset,
            logo: logoAsset,
            icon192: icon192Asset,
            icon512: icon512Asset,
            manifest: manifestAsset,
            fonts: {
              hackMono: hackMonoFontAsset,
              hackLicense: hackLicenseAsset,
              nerdFontsLicense: nerdFontsLicenseAsset,
              notices: fontNoticesAsset,
            },
          },
          getSession: () => watchSession!,
          chatService: chatService!,
          getWorkspaceCredential: () => watchSession!.getTerminalToken(),
          basePath: options.basePath,
          manifestScope: options.manifestScope,
          debug: options.debug,
          getMetricsSnapshot: () => metrics.snapshot(),
        }),
      },
      fetch: (request, srv) => fetchFallback(request, srv),
      // The serve options type is an XOR (websocket required, or absent) and
      // cannot express "present iff the terminal is enabled" — and this call
      // must stay a single object literal so Bun's bundler can analyze the
      // route table (see the routes comment above), which rules out separate
      // enabled/disabled Bun.serve calls. Runtime accepts undefined here (it
      // shipped that way), so assert the enabled arm's shape.
      websocket: (terminalServer
        ? {
            open: (socket: Parameters<NonNullable<typeof terminalServer>["open"]>[0]) => {
              void terminalServer!.open(socket);
            },
            message: (socket: Parameters<NonNullable<typeof terminalServer>["message"]>[0], data: string | Buffer) => {
              terminalServer!.message(socket, data);
            },
            close: (socket: Parameters<NonNullable<typeof terminalServer>["close"]>[0], code: number) => {
              terminalServer!.close(socket, code);
            },
          }
        : undefined) as WebSocketHandler<Parameters<NonNullable<typeof terminalServer>["open"]>[0]["data"]>,
    });
  } catch (error) {
    clearIndexingStatus();
    stopStartupHeartbeat();
    if (chatService) await chatService.dispose().catch(() => undefined);
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
  stopStartupHeartbeat();
  // TypeScript narrowing: both are set if the try block above completed.
  if (!server || !watchSession) {
    throw new Error("failed to start watch session");
  }

  // The child credential gates terminal and chat controls. The browser strips
  // it from location on first load and promotes it to the existing HttpOnly
  // cookie; the hub captures and brokers the same value without exposing it.
  const url = formatSessionUrl(
    server.port!,
    options.basePath,
    watchSession.getTerminalToken(),
  );
  printStartupBanner(process.stdout);
  console.log(url);

  // Printed after the URL, where the operator's eye lands. Tells them once that
  // an unset $SHELL means terminals will run /bin/sh instead of their login
  // shell — only when the terminal is available, else $SHELL is irrelevant.
  if (terminalEnabled && shellIsUnset(process.env)) {
    console.error(`uatu: ${SHELL_UNSET_STARTUP_WARNING}`);
  }

  if (options.openBrowser) {
    const opened = await openBrowser(url);
    if (!opened) {
      console.error(`uatu: unable to open browser automatically; open ${url}`);
    }
  }

  // -------- Diagnostics: heartbeat + snapshot + sampling + watchdog --------
  // The 1Hz heartbeat tick is what the watchdog watches for staleness. The
  // snapshot tick keeps a tiny on-disk JSON of current counters that the
  // watchdog can read into its dump bundle even when --debug is off. The
  // 5s sampling tick records non-counter signals (fd count, memory, SSE).
  // All ticks are unref()'d so they never keep the loop alive on their own.
  start5sSamplingTick(metrics, () => watchSession!.getSseSubscriberCount());
  const snapshotTick = start1HzSnapshotTick(
    () => metrics.snapshot(),
    async snapshot => {
      // Heartbeat is just an mtime advance — separate from the snapshot
      // contents — but we coalesce both into the same 1Hz tick so the
      // process only wakes once per second.
      await fs.utimes(heartbeatPath, new Date(), new Date()).catch(async () => {
        // Heartbeat file may not exist yet (first tick after watchdog spawn,
        // or cache dir was just created). Touch it.
        await fs.writeFile(heartbeatPath, "").catch(() => undefined);
      });
      await writeSnapshotAtomic(snapshotPath, snapshot).catch(() => undefined);
    },
  );
  void snapshotTick; // referenced for clarity, no need to stop explicitly

  let ndjsonAppender: NdjsonAppender | null = null;
  if (options.debug) {
    ndjsonAppender = new NdjsonAppender(ndjsonPath);
    const ndjsonHandle = setInterval(() => {
      void ndjsonAppender!.append(metrics.snapshot()).catch(() => undefined);
    }, 1000);
    if (typeof ndjsonHandle.unref === "function") ndjsonHandle.unref();
  }

  // Touch the heartbeat once before spawning the watchdog so it's already
  // present and recent when the child does its first stat.
  await fs.writeFile(heartbeatPath, "").catch(() => undefined);

  let watchdogChild: ReturnType<typeof Bun.spawn> | null = null;
  if (options.watchdogEnabled) {
    try {
      // Re-execute uatu with the watchdog argv. In dev (`bun run src/cli.ts`)
      // Bun.argv[1] is the script path and we must pass it. In a compiled
      // binary, Bun.argv[1] is the first user-supplied argument and the
      // process.execPath alone is the entry point.
      const scriptArg = typeof Bun.argv[1] === "string" && /\.(ts|js)$/.test(Bun.argv[1])
        ? [Bun.argv[1]]
        : [];
      const watchdogArgv = [
        process.execPath,
        ...scriptArg,
        "--watchdog",
        String(process.pid),
        heartbeatPath,
        cacheRoot,
      ];
      const watchdogEnv: Record<string, string> = { ...process.env } as Record<string, string>;
      if (typeof options.watchdogTimeoutMs === "number") {
        watchdogEnv.UATU_HEARTBEAT_TIMEOUT_MS = String(options.watchdogTimeoutMs);
      }
      // Keep the Subprocess reference alive — Bun reaps the child if the
      // handle gets GC'd. Stored at outer-function scope on `watchdogChild`.
      watchdogChild = Bun.spawn(watchdogArgv, {
        env: watchdogEnv,
        stdout: "inherit",
        stderr: "inherit",
        stdin: "ignore",
      });
      // Don't keep the parent's exit waiting on the watchdog — it tracks the
      // parent independently and exits when the parent is gone.
      const childWithUnref = watchdogChild as unknown as { unref?: () => void };
      if (typeof childWithUnref.unref === "function") {
        childWithUnref.unref();
      } else {
        // If Bun's Subprocess ever drops `unref`, `uatu watch` would block on
        // exit waiting for the watchdog — surface it instead of hiding the bug.
        console.warn("uatu: Bun.Subprocess.unref unavailable; watchdog may delay parent exit");
      }
      // Surface unexpected early exits so the user knows the watchdog isn't
      // protecting them. A clean exit (parent dies → watchdog observes ESRCH)
      // produces code 0 too, but during normal operation it should stay alive
      // for as long as the parent does.
      const exited = (watchdogChild as unknown as { exited?: Promise<number> }).exited;
      if (exited && typeof exited.then === "function") {
        void exited
          .then(code => {
            if (typeof code === "number" && code !== 0) {
              console.error(`uatu: watchdog exited unexpectedly (code ${code})`);
            }
          })
          .catch(() => undefined);
      }
    } catch (error) {
      console.error(`uatu: failed to spawn watchdog (continuing without): ${error instanceof Error ? error.message : String(error)}`);
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

  const shutdown = async () => {
    if (shuttingDown) {
      console.error("uatu: received second interrupt — force exiting");
      hardExit(1);
      return;
    }
    shuttingDown = true;
    console.error("uatu: shutting down");

    // The OpenCode child is detached as its own process group, so dispose it
    // before the hard exit rather than relying on OS cleanup of this process.
    await chatService!.dispose().catch(() => undefined);

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

  // These handlers cover the *healthy* shutdown path. When the JS event
  // loop is wedged none of them can run — recovery from a wedge is the
  // watchdog subprocess's job (see watchdog.ts).
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);

  // --exit-on-stdin-close: a supervising wrapper (e.g. the desktop app) holds
  // our stdin pipe for its whole lifetime. EOF means the supervisor is gone —
  // including by crash, where no signal is ever sent — so shut down instead of
  // running orphaned. Without the flag stdin's lifetime is deliberately
  // ignored (piped invocations like `uatu serve | tee` must not couple).
  if (options.exitOnStdinClose && !process.stdin.isTTY) {
    process.stdin.resume();
    // Bun emits BOTH `end` and `close` for a single EOF. Wired directly to
    // shutdown, the second event hit the second-interrupt guard and force-
    // exited while the first call was still disposing the detached OpenCode
    // child — orphaning it on every supervisor shutdown. One EOF is one
    // shutdown request, however many events report it.
    let stdinGone = false;
    const onStdinGone = () => {
      if (stdinGone) return;
      stdinGone = true;
      void shutdown();
    };
    process.stdin.on("end", onStdinGone);
    process.stdin.on("close", onStdinGone);
  }

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
            void shutdown();
            return;
          }
          if (byte === 0x71 || byte === 0x51) {
            // 'q' or 'Q'
            void shutdown();
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
