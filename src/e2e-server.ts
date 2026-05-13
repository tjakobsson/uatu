#!/usr/bin/env bun

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import mermaidAsset from "mermaid/dist/mermaid.min.js" with { type: "file" };
import logoAsset from "./assets/uatu-logo.svg" with { type: "file" };
import icon192Asset from "./assets/icon-192.png" with { type: "file" };
import icon512Asset from "./assets/icon-512.png" with { type: "file" };
import manifestAsset from "./assets/manifest.webmanifest" with { type: "file" };
import swAsset from "./assets/sw.js" with { type: "file" };

import index from "./index.html";
import { E2E_PORT, E2E_WORKSPACE_ROOT, resetE2EWorkspace } from "./e2e";
import { safeGit } from "./review-load";
import { isMode, isViewMode, type Mode } from "./shared";
import {
  createNavigationFetchHandler,
  createWatchSession,
  canSetFileScope,
  renderDocument,
  resolveWatchRoots,
  SERVE_IDLE_TIMEOUT_SECONDS,
  type WatchEntry,
} from "./server";
import {
  TERMINAL_COOKIE_NAME,
  constantTimeEqual,
  formatTerminalCookie,
  isAllowedOrigin,
  readCookie,
} from "./terminal-auth";
import { terminalBackendAvailable } from "./terminal-backend";
import { createTerminalServer } from "./terminal-server";
import { getPierreDiffsCoreCSS, preloadCodeHighlighter } from "./highlighter";

let activeFilePath: string | null = null;
let activeRespectGitignore = true;
let activeStartupMode: Mode | undefined;
let activeFollow = true;
let activeWorkspaceRoot = E2E_WORKSPACE_ROOT;
let activeEntries: WatchEntry[] = [];
const terminalEnabled = await terminalBackendAvailable();
// Pre-warm Shiki before the first request lands; the e2e server is short-lived
// and tests assume highlighting is synchronous from the browser's perspective.
await preloadCodeHighlighter();
let watchSession = await createSession({ resetWorkspace: true });
const terminalServer = terminalEnabled
  ? createTerminalServer({ cwd: activeWorkspaceRoot })
  : null;

let server: ReturnType<typeof Bun.serve>;
server = Bun.serve({
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
    "/_pierre/diffs-core.css": new Response(getPierreDiffsCoreCSS(), {
      headers: {
        "content-type": "text/css; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    }),
    "/sw.js": new Response(Bun.file(swAsset), {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-cache",
        "service-worker-allowed": "/",
      },
    }),
    "/api/state": {
      GET: () => Response.json(watchSession.getStatePayload()),
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
          const document = await renderDocument(watchSession.getRoots(), documentId, { view });
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
    "/__e2e/terminal-token": {
      // Tests don't see the URL token (the e2e server doesn't print it to
      // stdout the way cli.ts does), so this exposes it directly. Localhost-
      // only by Bun.serve's hostname binding; not a real auth bypass — only
      // present in the e2e build.
      GET: () => Response.json({ token: watchSession.getTerminalToken(), enabled: terminalEnabled }),
    },
    "/__e2e/reset": {
      POST: async request => {
        let body: {
          file?: string;
          extras?: Record<string, string>;
          dirty?: Record<string, string>;
          git?: boolean;
          nonGit?: boolean;
          uatuConfig?: unknown;
          respectGitignore?: boolean;
          startupMode?: string;
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
        activeStartupMode = isMode(body.startupMode) ? body.startupMode : undefined;
        // Mirror the CLI behavior: --mode=review forces follow off.
        activeFollow = activeStartupMode === "review"
          ? false
          : typeof body.follow === "boolean"
            ? body.follow
            : true;

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
    startupMode: activeStartupMode,
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
