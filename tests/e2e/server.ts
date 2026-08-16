#!/usr/bin/env bun

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import mermaidAsset from "mermaid/dist/mermaid.min.js" with { type: "file" };
import logoAsset from "../../src/assets/uatu-logo.svg" with { type: "file" };
import icon192Asset from "../../src/assets/icon-192.png" with { type: "file" };
import icon512Asset from "../../src/assets/icon-512.png" with { type: "file" };
import manifestAsset from "../../src/assets/manifest.webmanifest" with { type: "file" };
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
import { safeGit } from "../../src/document/git-base-ref";
import { createNavigationFetchHandler, INTERNAL_SHELL_PATH, spaShellResponse } from "../../src/server/navigation";
import { resolveWatchRoots, type WatchEntry } from "../../src/server/roots";
import { createWatchSession } from "../../src/server/watch-session";
import {
  buildFetchFallback,
  buildRoutes,
  SERVE_IDLE_TIMEOUT_SECONDS,
} from "../../src/server/routes";
import { terminalBackendAvailable } from "../../src/terminal/backend";
import { createTerminalServer } from "../../src/terminal/server";
import { FakeE2EChatService } from "./chat-service";
import type { ConversationItem, ConversationStatus } from "../../src/chat/types";

// One-shot artificial latency for GET /api/terminal/sessions, armed by tests
// that need two inventory reads to complete out of order (the switcher's
// stale-render guard). It has to live server-side: uatu registers a
// pass-through service worker, and Playwright's page.route never sees fetches
// a service worker mediates. The handler computes its response BEFORE the
// delay so the held response reflects the state at request time — that
// staleness is the point. `pending` stays true until the held response is
// delivered, so a test can poll for delivery instead of sleeping.
let terminalSessionsDelay: { ms: number; armed: boolean; pending: boolean } | null = null;

let activeFilePath: string | null = null;
let activeRespectGitignore = true;
let activeFollow = true;
let activeWorkspaceRoot = E2E_WORKSPACE_ROOT;
let activeEntries: WatchEntry[] = [];
let personalState: Record<string, unknown> = { version: 1 };
const chatService = new FakeE2EChatService();
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

  terminalSessionsDelay = null;
  chatService.reset();

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
  personalState = { version: 1 };

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

async function handleE2EPersonalState(request: Request): Promise<Response> {
  if (request.method === "GET") return Response.json(personalState);
  const patch = await request.json() as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete personalState[key];
    else personalState[key] = value;
  }
  return Response.json(personalState);
}

async function handleE2EChat(request: Request): Promise<Response> {
  const body = await request.json() as {
    action?: string;
    conversationId?: string;
    title?: string;
    item?: ConversationItem;
    items?: ConversationItem[];
    older?: ConversationItem[];
    itemId?: string;
    delta?: string;
    status?: ConversationStatus;
  };
  switch (body.action) {
    case "seed":
      return Response.json(chatService.seed(body.title ?? "Fixture conversation", body.items ?? [], body.older ?? []));
    case "item":
      if (body.conversationId && body.item) return Response.json(chatService.publishItem(body.conversationId, body.item));
      break;
    case "delta":
      if (body.conversationId && body.itemId && typeof body.delta === "string") {
        return Response.json(chatService.publishDelta(body.conversationId, body.itemId, body.delta));
      }
      break;
    case "status":
      if (body.conversationId && body.status) {
        chatService.publishStatus(body.conversationId, body.status);
        return Response.json({ ok: true });
      }
      break;
    case "disconnect":
      chatService.disconnect();
      return Response.json({ ok: true });
    case "stats":
      return Response.json({ statusCalls: chatService.statusCalls, promptAttempts: chatService.promptAttempts });
    case "failPrompt":
      chatService.failPrompt();
      return Response.json({ ok: true });
    case "resync":
      chatService.rotateGeneration();
      return Response.json({ ok: true });
  }
  return Response.json({ error: "invalid chat control" }, { status: 400 });
}

let server: ReturnType<typeof Bun.serve>;
server = Bun.serve({
  hostname: "127.0.0.1",
  port: E2E_PORT,
  idleTimeout: SERVE_IDLE_TIMEOUT_SECONDS,
  routes: {
    // The HTMLBundle MUST be a literal at this call site (see the matching
    // comment in src/cli.ts) so Bun's bundler can wire up the chunk URLs.
    // INTERNAL_SHELL_PATH backs spaShellResponse's cache fetch; "/" serves
    // through spaShellResponse like production so the e2e suite exercises
    // the same no-cache HTML + prefixed bundle-asset flow browsers get.
    [INTERNAL_SHELL_PATH]: index,
    "/": { GET: () => spaShellResponse(server) },
    ...buildRoutes({
      mode: "e2e",
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
      getSession: () => watchSession,
      chatService,
      getWorkspaceCredential: () => watchSession.getTerminalToken(),
      handleE2EReset,
      handleE2EPersonalState,
      handleE2EChat,
    }),
  },
  fetch: async (request, srv) => {
    const url = new URL(request.url);
    if (url.pathname === "/__e2e/terminal-sessions-delay") {
      if (request.method === "POST") {
        const body = (await request.json()) as { ms?: number };
        terminalSessionsDelay = {
          ms: typeof body.ms === "number" ? body.ms : 0,
          armed: true,
          pending: false,
        };
        return Response.json({ ok: true });
      }
      return Response.json({ pending: terminalSessionsDelay?.pending ?? false });
    }
    if (
      terminalSessionsDelay?.armed
      && request.method === "GET"
      && url.pathname === "/api/terminal/sessions"
    ) {
      // Consume the arming immediately so only THIS read is held — a second
      // read arriving during the delay must pass through at full speed, or
      // the out-of-order scenario the test stages collapses back into FIFO.
      const delay = terminalSessionsDelay;
      delay.armed = false;
      delay.pending = true;
      const response = await fetchFallback(request, srv);
      await new Promise(resolve => setTimeout(resolve, delay.ms));
      delay.pending = false;
      return response;
    }
    return fetchFallback(request, srv);
  },
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
  await chatService.dispose();
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
