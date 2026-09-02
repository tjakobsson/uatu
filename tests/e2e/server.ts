#!/usr/bin/env bun

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MultiAgentChatService } from "../../src/chat/agents";
import { CLAUDE_PERMISSION_SCOPE_NOTE } from "../../src/chat/claude/provider";
import { OPENCODE_PERMISSION_SCOPE_NOTE } from "../../src/chat/opencode/sdk-v2-provider";
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
import { FakeE2EChatService, type ReversibleFileFixture } from "./chat-service";
import type { ChatCapability, ChatModel, ConversationConfiguration, ConversationItem, ConversationStatus } from "../../src/chat/types";

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
const fakeChatAgent = new FakeE2EChatService({
  agentName: process.env.UATU_E2E_PRIMARY_AGENT_NAME ?? undefined,
  // The OpenCode-shaped primary fixture carries OpenCode's own verified
  // persistent-approval sentence, imported so the e2e assertions prove the
  // real descriptor text.
  permissionScopeNote: OPENCODE_PERMISSION_SCOPE_NOTE,
  restoreFile: async (relativePath, contents) => {
    const target = path.resolve(activeWorkspaceRoot, relativePath);
    const relative = path.relative(activeWorkspaceRoot, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("invalid reversible file path");
    if (contents === null) {
      await fs.rm(target, { force: true });
      return;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, "utf8");
  },
});
const E2E_AGENT_NAMES: Record<string, string> = { opencode: "OpenCode", claude: "Claude Code" };
function qualifyControlValue<T>(value: T, agentId = "opencode"): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      const next: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(record)) {
        if ((key === "conversationId" || key === "childConversationId") && typeof entry === "string" && !entry.includes(":")) {
          next[key] = `${agentId}:${entry}`;
          continue;
        }
        next[key] = walk(entry);
      }
      // A conversation summary is recognizable by its shape; stamp the wire form.
      if (typeof next.id === "string" && "title" in next && "updatedAt" in next && "status" in next && !(next.id as string).includes(":")) {
        next.id = `${agentId}:${next.id as string}`;
        next.agent = { id: agentId, name: E2E_AGENT_NAMES[agentId] ?? agentId };
      }
      return next;
    }
    return node;
  };
  return walk(value) as T;
}
const controlJson = (value: unknown, agentId = "opencode") => Response.json(qualifyControlValue(value, agentId));

// A second stub agent, offered only when a spec opts in: most chat specs
// exercise single-agent behavior (creation without a choice), and the agent
// set is fixed per router — so the harness swaps routers behind a delegating
// proxy instead of mutating one.
const fakeSecondAgent = new FakeE2EChatService({
  restoreFile: async () => undefined,
  agentName: "Claude Code",
  agentId: "claude-fixture",
  // Claude Code's own persistent-approval sentence and its typed-id
  // capability, as the real descriptor declares them (chat/claude/provider).
  permissionScopeNote: CLAUDE_PERMISSION_SCOPE_NOTE,
  extraCapabilities: ["custom-model-id"],
});
// The fake owns attachment persistence (its prompt path validates ids
// against its own store), so the routers delegate rather than keeping a
// second store the fake would never see.
const fakeAttachmentStore = {
  directory: E2E_WORKSPACE_ROOT,
  async save(bytes: Uint8Array) {
    const saved = await fakeChatAgent.saveAttachment(bytes);
    const stored = await fakeChatAgent.resolveAttachment(saved.id);
    if (!stored) throw new Error("e2e attachment store lost a just-saved attachment");
    return stored;
  },
  resolve: (id: string) => fakeChatAgent.resolveAttachment(id),
};

const singleAgentRouter = new MultiAgentChatService({
  workspacePath: E2E_WORKSPACE_ROOT,
  agents: [{ descriptor: { id: "opencode", name: "OpenCode" }, service: fakeChatAgent }],
  attachmentStore: fakeAttachmentStore,
});
const dualAgentRouter = new MultiAgentChatService({
  workspacePath: E2E_WORKSPACE_ROOT,
  agents: [
    { descriptor: { id: "opencode", name: "OpenCode" }, service: fakeChatAgent },
    { descriptor: { id: "claude", name: "Claude Code" }, service: fakeSecondAgent },
  ],
  attachmentStore: fakeAttachmentStore,
});
let activeChatRouter: MultiAgentChatService = singleAgentRouter;
const chatService = new Proxy({} as MultiAgentChatService, {
  get(_target, property) {
    const value = (activeChatRouter as unknown as Record<string | symbol, unknown>)[property];
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(activeChatRouter) : value;
  },
});
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
  fakeChatAgent.reset();
  fakeSecondAgent.reset();
  activeChatRouter = singleAgentRouter;

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
    message?: string;
    capabilities?: ChatCapability[];
    models?: ChatModel[];
    child?: boolean;
    invalidate?: boolean;
    configuration?: ConversationConfiguration;
    reversibleFiles?: ReversibleFileFixture[];
    agent?: "opencode" | "claude";
    count?: number;
  };
  // The chat wire is agent-qualified ("opencode:<id>") while the fake works
  // in bare provider ids. The control boundary translates both directions so
  // specs keep using the ids they see in the UI.
  const stripQualifier = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripQualifier);
    if (value && typeof value === "object") {
      const record = { ...(value as Record<string, unknown>) };
      for (const key of ["conversationId", "childConversationId"]) {
        if (typeof record[key] === "string") record[key] = (record[key] as string).replace(/^(?:opencode|claude):/, "");
      }
      for (const [key, entry] of Object.entries(record)) {
        if (key !== "conversationId" && key !== "childConversationId") record[key] = stripQualifier(entry);
      }
      return record;
    }
    return value;
  };
  if (typeof body.conversationId === "string") {
    // The qualified id names the owning agent; remember it before stripping
    // so conversation-scoped controls reach the right fake without every
    // spec spelling `agent:` explicitly.
    if (body.agent === undefined && body.conversationId.startsWith("claude:")) body.agent = "claude";
    body.conversationId = body.conversationId.replace(/^(?:opencode|claude):/, "");
  }
  if (body.items) body.items = stripQualifier(body.items) as typeof body.items;
  if (body.older) body.older = stripQualifier(body.older) as typeof body.older;
  if (body.item) body.item = stripQualifier(body.item) as typeof body.item;
  const targetFake = body.agent === "claude" ? fakeSecondAgent : fakeChatAgent;
  switch (body.action) {
    case "agents":
      activeChatRouter = body.count === 2 ? dualAgentRouter : singleAgentRouter;
      return Response.json({ agents: body.count === 2 ? 2 : 1 });
    case "seed":
      return controlJson(targetFake.seed(body.title ?? "Fixture conversation", body.items ?? [], body.older ?? [], body.child ?? false, body.configuration), body.agent ?? "opencode");
    case "externalCreate":
      return controlJson(targetFake.externalCreate(body.title ?? "External conversation", { child: body.child, invalidate: body.invalidate }), body.agent ?? "opencode");
    case "externalRename":
      if (body.conversationId) return controlJson(targetFake.externalRename(body.conversationId, body.title ?? "Externally renamed", body.invalidate !== false));
      break;
    case "externalDelete":
      if (body.conversationId) return controlJson(targetFake.externalDelete(body.conversationId, body.invalidate !== false));
      break;
    case "externalSetChild":
      if (body.conversationId && typeof body.child === "boolean") {
        return controlJson(targetFake.externalSetChild(body.conversationId, body.child, body.invalidate !== false));
      }
      break;
    case "item":
      if (body.conversationId && body.item) return controlJson(targetFake.publishItem(body.conversationId, body.item));
      break;
    case "delta":
      if (body.conversationId && body.itemId && typeof body.delta === "string") {
        return controlJson(targetFake.publishDelta(body.conversationId, body.itemId, body.delta));
      }
      break;
    case "status":
      if (body.conversationId && body.status) {
        targetFake.publishStatus(body.conversationId, body.status, body.message);
        return Response.json({ ok: true });
      }
      break;
    case "configuration":
      if (body.conversationId && body.configuration) return controlJson(targetFake.publishConfiguration(body.conversationId, body.configuration));
      break;
    case "reversibleFiles":
      if (body.conversationId) {
        targetFake.configureReversibleFiles(body.conversationId, body.reversibleFiles ?? []);
        return Response.json({ ok: true });
      }
      break;
    case "nextConversationConfiguration":
      fakeChatAgent.configureNextConversation(body.configuration ?? {});
      return Response.json({ ok: true });
    case "disconnect":
      fakeChatAgent.disconnect();
      return Response.json({ ok: true });
    case "stats":
      return Response.json({ statusCalls: fakeChatAgent.statusCalls, promptAttempts: fakeChatAgent.promptAttempts, promptModes: fakeChatAgent.promptModes, promptVariants: fakeChatAgent.promptVariants, promptConfigurations: fakeChatAgent.promptConfigurations, reversibleAttempts: fakeChatAgent.reversibleAttempts, ...fakeChatAgent.inventoryStats() });
    case "inventoryInvalidate":
      fakeChatAgent.invalidateInventory();
      return Response.json({ ok: true });
    case "inventoryInterrupt":
      fakeChatAgent.interruptInventoryTransport();
      return Response.json({ ok: true });
    case "inventoryResume":
      fakeChatAgent.resumeInventoryTransport();
      return Response.json({ ok: true });
    case "providerPumpRestart":
      fakeChatAgent.restartProviderPump();
      return Response.json({ ok: true });
    case "delayNextInventoryList":
      fakeChatAgent.delayNextInventoryList();
      return Response.json({ ok: true });
    case "releaseInventoryList":
      fakeChatAgent.releaseInventoryList();
      return Response.json({ ok: true });
    case "failPrompt":
      targetFake.failPrompt();
      return Response.json({ ok: true });
    case "failUndo":
      targetFake.failReversible("undo");
      return Response.json({ ok: true });
    case "failRedo":
      targetFake.failReversible("redo");
      return Response.json({ ok: true });
    case "failHistory":
      targetFake.failHistory(false);
      return Response.json({ ok: true });
    case "failOlderHistory":
      targetFake.failHistory(true);
      return Response.json({ ok: true });
    case "failStartup":
      targetFake.failStartup();
      return Response.json({ ok: true });
    case "declareOnly":
      targetFake.declareOnly(body.capabilities ?? []);
      return Response.json({ ok: true });
    case "models":
      targetFake.setModels(body.models ?? []);
      return Response.json({ ok: true });
    case "resync":
      fakeChatAgent.rotateGeneration();
      return Response.json({ ok: true });
    case "restart":
      fakeChatAgent.restart();
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
  await singleAgentRouter.dispose();
  await dualAgentRouter.dispose().catch(() => undefined);
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
