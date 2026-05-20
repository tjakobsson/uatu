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

import index from "../../src/index.html";
import { e2ePort, resetE2EWorkspace, workspaceRoot } from "./config";

// Per-process workspace root. Captured once at startup from the lazy
// workspaceRoot() helper (which reads process.env.UATU_E2E_WORKSPACE if
// set, falling back to the default). Per-worker test harnesses inject a
// distinct value via env so each worker's server lives in its own dir.
const E2E_WORKSPACE_ROOT = workspaceRoot();
const E2E_PORT = e2ePort();
import { safeGit } from "../../src/review/load";
import {
  createNavigationFetchHandler,
  createWatchSession,
  resolveWatchRoots,
  SERVE_IDLE_TIMEOUT_SECONDS,
  type WatchEntry,
} from "../../src/server/session";
import { buildRoutes } from "../../src/server/routes";
import {
  TERMINAL_COOKIE_NAME,
  constantTimeEqual,
  formatTerminalCookie,
  isAllowedOrigin,
  readCookie,
} from "../../src/terminal/auth";
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
      },
      getSession: () => watchSession,
      handleE2EReset,
    }),
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
          void terminalServer.open(socket as never);
        },
        message: (socket, msg) => {
          terminalServer.message(socket as never, msg as never);
        },
        close: socket => {
          terminalServer.close(socket as never);
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

// Mirror cli.ts's auth handler. Tests POST a known token here to seed the
// `uatu_term` cookie before navigating; subsequent WS upgrades authenticate
// via the cookie alone.
async function handleAuth(request: Request): Promise<Response> {
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
  if (!constantTimeEqual(provided, watchSession.getTerminalToken())) {
    return Response.json({ error: "invalid token" }, { status: 401 });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": formatTerminalCookie(provided),
    },
  });
}

function handleTerminalUpgrade(
  request: Request,
  requestUrl: URL,
  srv: typeof Bun extends { serve: (...args: never) => infer S } ? S : never,
): Response | undefined {
  if (!terminalServer) return new Response("terminal disabled", { status: 503 });
  const expected = watchSession.getTerminalToken();
  const queryToken = requestUrl.searchParams.get("t") ?? "";
  const cookieToken = readCookie(request.headers.get("Cookie"), TERMINAL_COOKIE_NAME);
  if (!constantTimeEqual(queryToken, expected) && !constantTimeEqual(cookieToken, expected)) {
    return new Response("unauthorized", { status: 401 });
  }
  if (!isAllowedOrigin(request.headers.get("Origin"), srv)) {
    return new Response("forbidden origin", { status: 403 });
  }
  const sessionId = requestUrl.searchParams.get("sessionId") ?? "";
  const result = terminalServer.prepareSession(sessionId);
  if (result.kind === "invalid") {
    return new Response("invalid or missing sessionId", { status: 400 });
  }
  if (result.kind === "collision") {
    return new Response("sessionId in use", { status: 409 });
  }
  const ok = (srv.upgrade as (req: Request, opts: { data: unknown }) => boolean)(request, {
    data: { sessionId },
  });
  if (!ok) return new Response("upgrade failed", { status: 500 });
  return undefined;
}

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
  const session = createWatchSession(entries, activeFollow, {
    usePolling: true,
    respectGitignore: activeRespectGitignore,
    terminalEnabled,
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
