#!/usr/bin/env bun

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import mermaidAsset from "mermaid/dist/mermaid.min.js" with { type: "file" };
import logoAsset from "./assets/uatu-logo.svg" with { type: "file" };

import index from "./index.html";
import { E2E_PORT, E2E_WORKSPACE_ROOT, resetE2EWorkspace } from "./e2e";
import { safeGit } from "./review-load";
import { isMode, type Mode } from "./shared";
import {
  createNavigationFetchHandler,
  createWatchSession,
  canSetFileScope,
  renderDocument,
  resolveWatchRoots,
  SERVE_IDLE_TIMEOUT_SECONDS,
  type WatchEntry,
} from "./server";

let activeFilePath: string | null = null;
let activeRespectGitignore = true;
let activeStartupMode: Mode | undefined;
let activeFollow = true;
let activeWorkspaceRoot = E2E_WORKSPACE_ROOT;
let activeEntries: WatchEntry[] = [];
let watchSession = await createSession({ resetWorkspace: true });

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
  fetch: createNavigationFetchHandler({
    getUnscopedRoots: () => watchSession.getUnscopedRoots(),
    getEntries: () => activeEntries,
    getRespectGitignore: () => activeRespectGitignore,
    getServer: () => server,
  }),
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
  const session = createWatchSession(entries, activeFollow, {
    usePolling: true,
    respectGitignore: activeRespectGitignore,
    startupMode: activeStartupMode,
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
