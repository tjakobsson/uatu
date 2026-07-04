#!/usr/bin/env bun

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import mermaidAsset from "mermaid/dist/mermaid.min.js" with { type: "file" };
import logoAsset from "../../src/assets/uatu-logo.svg" with { type: "file" };
import icon192Asset from "../../src/assets/icon-192.png" with { type: "file" };
import icon512Asset from "../../src/assets/icon-512.png" with { type: "file" };
import manifestAsset from "../../src/assets/manifest.webmanifest" with { type: "file" };
import swAsset from "../../src/assets/sw.js" with { type: "file" };
import hackMonoFontAsset from "../../src/assets/fonts/HackNerdFontMono-Regular.woff2" with { type: "file" };
import hackLicenseAsset from "../../src/assets/fonts/LICENSE-hack.md" with { type: "file" };
import nerdFontsLicenseAsset from "../../src/assets/fonts/LICENSE-nerdfonts.txt" with { type: "file" };
import fontNoticesAsset from "../../src/assets/fonts/NOTICES.md" with { type: "file" };

import index from "../../src/index.html";
import { e2ePort, resetE2EWorkspace, workspaceRoot } from "./config";

// Per-process workspace root. Captured once at startup from the lazy
// workspaceRoot() helper (which reads process.env.UATU_E2E_WORKSPACE if
// set, falling back to the default). Per-worker test harnesses inject a
// distinct value via env so each worker's server lives in its own dir.
const E2E_WORKSPACE_ROOT = workspaceRoot();
const E2E_PORT = e2ePort();
import { safeGit } from "../../src/review/load";
import { createNavigationFetchHandler } from "../../src/server/navigation";
import { resolveWatchRoots, type WatchEntry } from "../../src/server/roots";
import { createWatchSession } from "../../src/server/watch-session";
import { loadTerminalConfig } from "../../src/terminal/config";
import { loadMonoConfig } from "../../src/mono/config";
import {
  buildFetchFallback,
  buildRoutes,
  SERVE_IDLE_TIMEOUT_SECONDS,
} from "../../src/server/routes";
import { terminalBackendAvailable } from "../../src/terminal/backend";
import { createTerminalServer } from "../../src/terminal/server";

let activeFilePath: string | null = null;
let activeRespectGitignore = true;
let activeFollow = true;
let activeWorkspaceRoot = E2E_WORKSPACE_ROOT;
let activeEntries: WatchEntry[] = [];
const terminalEnabled = await terminalBackendAvailable();
let watchSession = await createSession({ resetWorkspace: true });
const terminalServer = terminalEnabled
  ? createTerminalServer({ cwd: activeWorkspaceRoot })
  : null;

async function handleE2EReset(request: Request): Promise<Response> {
  let body: {
    file?: string;
    extras?: Record<string, string>;
    dirty?: Record<string, string>;
    git?: boolean;
    nonGit?: boolean;
    uatuConfig?: unknown;
    respectGitignore?: boolean;
    follow?: boolean;
  } = {};
  try {
    const text = await request.text();
    if (text.length > 0) {
      body = JSON.parse(text) as typeof body;
    }
  } catch {
    body = {};
  }

  // Kill every PTY session so tests are hermetic: with persistent sessions
  // and the session picker, a shell leaked from a previous test would
  // otherwise surface in the next test's pane-spawn flow.
  if (terminalServer) {
    try {
      terminalServer.disposeAll();
    } catch {
      // Best-effort — a dead backend must not fail the reset.
    }
  }

  await watchSession.stop();
  activeFilePath = typeof body.file === "string" ? body.file : null;
  activeRespectGitignore =
    typeof body.respectGitignore === "boolean" ? body.respectGitignore : true;
  activeFollow = typeof body.follow === "boolean" ? body.follow : true;

  const previousWorkspaceRoot = activeWorkspaceRoot;
  activeWorkspaceRoot = E2E_WORKSPACE_ROOT;
  await resetE2EWorkspace();
  if (body.nonGit) {
    activeWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-e2e-non-git-"));
    await fs.cp(E2E_WORKSPACE_ROOT, activeWorkspaceRoot, { recursive: true });
  }
  if (previousWorkspaceRoot !== E2E_WORKSPACE_ROOT) {
    await fs.rm(previousWorkspaceRoot, { recursive: true, force: true });
  }
  if (body.extras) {
    for (const [relativePath, contents] of Object.entries(body.extras)) {
      const target = path.join(activeWorkspaceRoot, relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents, "utf8");
    }
  }
  if (body.uatuConfig) {
    await fs.writeFile(
      path.join(activeWorkspaceRoot, ".uatu.json"),
      JSON.stringify(body.uatuConfig),
      "utf8",
    );
  }
  if (body.git) {
    await initE2EGitRepository();
  }
  if (body.dirty) {
    for (const [relativePath, contents] of Object.entries(body.dirty)) {
      const target = path.join(activeWorkspaceRoot, relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents, "utf8");
    }
  }

  watchSession = await createSession({ resetWorkspace: false });
  return Response.json(watchSession.getStatePayload());
}

let server: ReturnType<typeof Bun.serve>;
server = Bun.serve({
  hostname: "127.0.0.1",
  port: E2E_PORT,
  idleTimeout: SERVE_IDLE_TIMEOUT_SECONDS,
  routes: {
    // `"/": index` MUST be a literal at this call site (see the matching
    // comment in src/cli.ts) so Bun's bundler can wire up the HTMLBundle's
    // chunk URLs. The remaining routes come from `buildRoutes`.
    "/": index,
    ...buildRoutes({
      mode: "e2e",
      assets: {
        mermaid: mermaidAsset,
        logo: logoAsset,
        icon192: icon192Asset,
        icon512: icon512Asset,
        manifest: manifestAsset,
        sw: swAsset,
        fonts: {
          hackMono: hackMonoFontAsset,
          hackLicense: hackLicenseAsset,
          nerdFontsLicense: nerdFontsLicenseAsset,
          notices: fontNoticesAsset,
        },
      },
      getSession: () => watchSession,
      handleE2EReset,
    }),
  },
  fetch: (request, srv) => fetchFallback(request, srv),
  websocket: terminalServer
    ? {
        open: socket => {
          void terminalServer.open(socket as never);
        },
        message: (socket, msg) => {
          terminalServer.message(socket as never, msg as never);
        },
        close: (socket, code) => {
          terminalServer.close(socket as never, code);
        },
      }
    : undefined,
});

const navigationFetch = createNavigationFetchHandler({
  getUnscopedRoots: () => watchSession.getUnscopedRoots(),
  getEntries: () => activeEntries,
  getRespectGitignore: () => activeRespectGitignore,
  getServer: () => server,
});

const fetchFallback = buildFetchFallback({
  getTerminalServer: () => terminalServer,
  getTerminalToken: () => watchSession.getTerminalToken(),
  navigationFetch,
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

async function createSession(options: { resetWorkspace: boolean }) {
  if (options.resetWorkspace) {
    activeWorkspaceRoot = E2E_WORKSPACE_ROOT;
    await resetE2EWorkspace();
  }
  const entryPaths = activeFilePath
    ? [`${activeWorkspaceRoot}/${activeFilePath}`]
    : [activeWorkspaceRoot];
  const entries = await resolveWatchRoots(entryPaths, process.cwd());
  activeEntries = entries;
  // Mirror cli.ts: `.uatu.json terminal.fontFamily` and `.uatu.json
  // mono.fontFamily` overrides at the watch root flow through
  // /api/state.terminalConfig and .monoConfig into the client. The reset
  // handler may have just written one (see body.uatuConfig), so reload
  // them every time the session is rebuilt.
  const terminalConfigResult = terminalEnabled
    ? await loadTerminalConfig(activeWorkspaceRoot)
    : { config: {}, warnings: [] };
  const monoConfigResult = await loadMonoConfig(activeWorkspaceRoot);
  const session = createWatchSession(entries, activeFollow, {
    usePolling: true,
    respectGitignore: activeRespectGitignore,
    terminalEnabled,
    terminalConfig: terminalConfigResult.config,
    monoConfig: monoConfigResult.config,
  });
  await session.start();
  return session;
}

async function initE2EGitRepository() {
  await fs.rm(path.join(activeWorkspaceRoot, ".git"), { recursive: true, force: true });
  await safeGit(activeWorkspaceRoot, ["init", "--initial-branch=main"]);
  await safeGit(activeWorkspaceRoot, ["config", "user.email", "uatu@example.test"]);
  await safeGit(activeWorkspaceRoot, ["config", "user.name", "Uatu Test"]);
  await safeGit(activeWorkspaceRoot, ["add", "."]);
  await safeGit(activeWorkspaceRoot, ["-c", "commit.gpgsign=false", "commit", "-m", "initial fixture"]);
  await safeGit(activeWorkspaceRoot, ["checkout", "-b", "feature/review-load"]);
  await fs.writeFile(path.join(activeWorkspaceRoot, "feature.md"), "# Feature\n\nCommitted branch change.\n", "utf8");
  await safeGit(activeWorkspaceRoot, ["add", "feature.md"]);
  await safeGit(activeWorkspaceRoot, [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "add feature doc",
    "-m",
    "Full commit message body for review-load hover.",
  ]);
  for (let index = 1; index <= 12; index += 1) {
    await fs.writeFile(path.join(activeWorkspaceRoot, `history-${index}.md`), `# History ${index}\n`, "utf8");
    await safeGit(activeWorkspaceRoot, ["add", `history-${index}.md`]);
    await safeGit(activeWorkspaceRoot, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      `history commit ${index}`,
    ]);
  }
}
