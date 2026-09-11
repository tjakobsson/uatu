#!/usr/bin/env bun

// The hub-served e2e server: a REAL hub (src/hub/server.ts — auth gate,
// proxy, brokered live stream, dashboard API) whose session backend spawns
// the e2e harness (tests/e2e/server.ts) as each workspace's child instead
// of `uatu serve`. Real children need real chat agents, so conversations,
// permissions, and statuses could never be staged there; the harness
// carries the fake chat service and its `/__e2e/chat` controls, and under a
// hub prefix it serves exactly what a child serves.
//
// Spawned by tests/e2e/hub-fixtures.ts (Playwright workers run under Node;
// a hub is Bun.serve, so it lives in its own Bun process). Configuration is
// env:
//
//   UATU_E2E_HUB_PORT            the hub's port (default 4300)
//   UATU_E2E_HUB_CHILD_BASE_PORT first child port; children take
//                                consecutive ports (default hub port + 1)
//   UATU_E2E_HUB_WORKSPACES      comma-separated workspace folder names;
//                                each becomes a registered, started
//                                workspace with that id (default "alpha")
//
// Readiness is one stdout line, `uatu-e2e-hub <json>`, describing the hub
// origin, the user, and every workspace with its id, folder, session URL,
// and the child's direct origin (for the fake chat controls, which need no
// hub credential).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { hashPassword, HubSessionStore } from "../../src/hub/auth";
import type { RunningSession, SessionBackend } from "../../src/hub/backend";
import type { HubConfig } from "../../src/hub/config";
import { EMPTY_CREDENTIAL_CONTEXT_RESOLVER } from "../../src/hub/credential-context";
import { PersonalWorkspaceStateStore } from "../../src/hub/personal-state";
import { WorkspaceRegistry, type WorkspaceEntry } from "../../src/hub/registry";
import { startHubServer } from "../../src/hub/server";
import { SessionManager } from "../../src/hub/sessions";

export const HUB_E2E_USER = { name: "e2e", password: "e2e-hub-password" };
export const HUB_E2E_READY_PREFIX = "uatu-e2e-hub ";

export type HubE2EWorkspace = {
  id: string;
  // The watched folder — tests write here to trigger live reload.
  path: string;
  // `${hub origin}/s/<id>/`
  sessionUrl: string;
  // The child's own origin; `${childOrigin}/s/<id>/__e2e/chat` drives its fake chat.
  childOrigin: string;
};

export type HubE2EInfo = {
  origin: string;
  user: { name: string; password: string };
  workspaces: HubE2EWorkspace[];
};

const HUB_PORT = Number.parseInt(process.env.UATU_E2E_HUB_PORT ?? "4300", 10);
const CHILD_BASE_PORT = Number.parseInt(process.env.UATU_E2E_HUB_CHILD_BASE_PORT ?? String(HUB_PORT + 1), 10);
const WORKSPACE_NAMES = (process.env.UATU_E2E_HUB_WORKSPACES ?? "alpha")
  .split(",")
  .map(name => name.trim())
  .filter(name => name.length > 0);
const HARNESS_PATH = path.resolve(import.meta.dir, "server.ts");
const CHILD_START_TIMEOUT_MS = 30_000;

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-hub-e2e-"));

// One harness process per workspace. The hub's own LocalProcessBackend
// contract is kept where it matters — a RunningSession with a loopback
// endpoint, the child's workspace credential as `token` (so brokered child
// requests authenticate), and `exited`/`stop` — but the child is the e2e
// harness, told its port, folder, and hub-shaped base path through env.
class HarnessBackend implements SessionBackend {
  private nextPort = CHILD_BASE_PORT;
  readonly children = new Map<string, ChildProcess>();

  async start(workspace: WorkspaceEntry, basePath: string): Promise<RunningSession> {
    const port = this.nextPort;
    this.nextPort += 1;
    const child = spawn("bun", ["run", HARNESS_PATH], {
      cwd: path.resolve(import.meta.dir, "..", ".."),
      env: {
        ...process.env,
        UATU_E2E_PORT: String(port),
        UATU_E2E_WORKSPACE: workspace.path,
        UATU_E2E_BASE_PATH: basePath,
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    this.children.set(workspace.id, child);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`harness child for '${workspace.id}' did not announce within ${CHILD_START_TIMEOUT_MS / 1000}s`)),
        CHILD_START_TIMEOUT_MS,
      );
      child.stdout!.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes(`127.0.0.1:${port}`)) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.on("error", reject);
      child.on("exit", code => {
        clearTimeout(timeout);
        reject(new Error(`harness child for '${workspace.id}' exited (code ${code}) before announcing`));
      });
    });

    // The harness does not print its credential the way cli.ts does; its
    // e2e-only route exposes it.
    const tokenResponse = await fetch(`http://127.0.0.1:${port}${basePath}__e2e/terminal-token`);
    if (!tokenResponse.ok) {
      throw new Error(`harness child for '${workspace.id}' refused its token probe (${tokenResponse.status})`);
    }
    const { token } = (await tokenResponse.json()) as { token: string };

    const exited = new Promise<number | null>(resolve => {
      child.on("exit", code => resolve(code));
    });
    return {
      workspaceId: workspace.id,
      basePath,
      endpoint: { hostname: "127.0.0.1", port },
      token,
      exited,
      stop: async () => {
        this.children.delete(workspace.id);
        await terminate(child);
      },
    };
  }
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>(resolve => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.on("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

const config: HubConfig = {
  port: HUB_PORT,
  host: "127.0.0.1",
  tls: null,
  users: [{ name: HUB_E2E_USER.name, passwordHash: await hashPassword(HUB_E2E_USER.password) }],
  stateDir: path.join(tempRoot, "state"),
};
const registry = new WorkspaceRegistry(path.join(tempRoot, "registry.json"));
await registry.load();
const personalState = new PersonalWorkspaceStateStore(path.join(tempRoot, "personal-state.json"));
await personalState.load();
const sessionStore = new HubSessionStore(path.join(tempRoot, "sessions.json"));
await sessionStore.load();
const backend = new HarnessBackend();
const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);

// Workspace ids are the registry's slugs of the folder basenames, so the
// requested names are the ids — as long as they are slug-shaped.
const workspaces: HubE2EWorkspace[] = [];
for (const name of WORKSPACE_NAMES) {
  const folder = path.join(tempRoot, "workspaces", name);
  await fs.mkdir(folder, { recursive: true });
  const entry = await registry.register(folder);
  if (entry.id !== name) {
    throw new Error(`workspace '${name}' registered as '${entry.id}'; use slug-shaped names`);
  }
  workspaces.push({ id: entry.id, path: folder, sessionUrl: "", childOrigin: "" });
}
for (const workspace of workspaces) {
  const running = await sessions.start(workspace.id);
  workspace.childOrigin = `http://${running.endpoint.hostname}:${running.endpoint.port}`;
}

const server = startHubServer({ config, registry, sessions, sessionStore, personalState });
const origin = `http://127.0.0.1:${server.port}`;
for (const workspace of workspaces) {
  workspace.sessionUrl = `${origin}/s/${encodeURIComponent(workspace.id)}/`;
}

const info: HubE2EInfo = { origin, user: HUB_E2E_USER, workspaces };
console.log(`${HUB_E2E_READY_PREFIX}${JSON.stringify(info)}`);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.live.endAll();
  server.liveBroker.dispose();
  await sessions.stopAll().catch(() => undefined);
  // Children stopped outside the manager (a test's /stop) are gone already;
  // anything still tracked is reaped here.
  await Promise.all([...backend.children.values()].map(child => terminate(child)));
  server.stop(true);
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
