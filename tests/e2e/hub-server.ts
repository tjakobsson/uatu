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
//   UATU_E2E_HUB_WORKTREES       "1" makes every workspace a committed Git
//                                repository and serves the worktree API
//   UATU_E2E_HUB_PUSH            "1" observes the children's notification
//                                feeds as the real hub does and records every
//                                push it would send, one JSON line each, in
//                                the file named by the readiness line's
//                                `pushLog`; presence holds pushes while a
//                                session page is visible, with the grace
//                                period shortened to
//                                UATU_E2E_HUB_PRESENCE_GRACE_MS (default 1500)
//   UATU_E2E_HUB_CREDENTIALS     "1" serves the credential API (token
//                                credentials only — no ssh/gpg tooling) with
//                                a resolver that reads a linked worktree's
//                                policy from its parent, exactly as the real
//                                Hub's stored resolver does, so the state
//                                API's credentialRestartRequired flag is real
//
// Readiness is one stdout line, `uatu-e2e-hub <json>`, describing the hub
// origin, the user, and every workspace with its id, folder, session URL,
// and the child's direct origin (for the fake chat controls, which need no
// hub credential). After that, stdin takes one command, `reset <serial>`,
// which puts the hub back to its booted state between tests (see
// resetForTest below).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { hashPassword, HubSessionStore } from "../../src/hub/auth";
import type { RunningSession, SessionBackend } from "../../src/hub/backend";
import type { HubConfig } from "../../src/hub/config";
import {
  EMPTY_CREDENTIAL_CONTEXT_RESOLVER,
  EMPTY_RESOLVED_CREDENTIAL_CONTEXT,
  type CredentialContextResolver,
} from "../../src/hub/credential-context";
import { PersonalWorkspaceStateStore } from "../../src/hub/personal-state";
import { WorkspaceRegistry, type WorkspaceEntry } from "../../src/hub/registry";
import { startHubServer } from "../../src/hub/server";
import { SessionManager } from "../../src/hub/sessions";
import { NotificationStore } from "../../src/hub/notification-store";
import { HubNotifications } from "../../src/hub/notifications";
import { createHubUpstreamSource } from "../../src/hub/live-source";
import { CredentialMetadataStore, CredentialTokenStore, CredentialToolOverrideStore } from "../../src/hub/credential-store";
import { CredentialToolManager } from "../../src/hub/credential-tools";
import { OpenPgpCredentialManager } from "../../src/hub/openpgp-credentials";
import { TokenCredentialManager } from "../../src/hub/token-credentials";
import { WorkspaceOnboardingCoordinator } from "../../src/hub/onboarding";
import { PathReservationCoordinator } from "../../src/hub/path-reservations";
import { WorktreeOperationCoordinator } from "../../src/hub/worktree-coordinator";
import { WorktreeJournal, WorktreeProvenanceStore } from "../../src/hub/worktree-journal";
import { createOnboardingWorktreeRegistrar } from "../../src/hub/worktree-registrar";
import { WorktreeService } from "../../src/hub/worktree-service";

export const HUB_E2E_USER = { name: "e2e", password: "e2e-hub-password" };
export const HUB_E2E_READY_PREFIX = "uatu-e2e-hub ";
export const HUB_E2E_RESET_PREFIX = "uatu-e2e-hub-reset ";

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
  // With UATU_E2E_HUB_PUSH: the file each recorded push is appended to.
  pushLog?: string;
};

const HUB_PORT = Number.parseInt(process.env.UATU_E2E_HUB_PORT ?? "4300", 10);
const CHILD_BASE_PORT = Number.parseInt(process.env.UATU_E2E_HUB_CHILD_BASE_PORT ?? String(HUB_PORT + 1), 10);
const WORKSPACE_NAMES = (process.env.UATU_E2E_HUB_WORKSPACES ?? "alpha")
  .split(",")
  .map(name => name.trim())
  .filter(name => name.length > 0);
const HARNESS_PATH = path.resolve(import.meta.dir, "server.ts");
const CHILD_START_TIMEOUT_MS = 30_000;
const WORKTREES = process.env.UATU_E2E_HUB_WORKTREES === "1";
const CREDENTIALS = process.env.UATU_E2E_HUB_CREDENTIALS === "1";
const PUSH = process.env.UATU_E2E_HUB_PUSH === "1";
const PRESENCE_GRACE_MS = Number.parseInt(process.env.UATU_E2E_HUB_PRESENCE_GRACE_MS ?? "1500", 10);

const tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "uatu-hub-e2e-")));

// One harness process per workspace. The hub's own LocalProcessBackend
// contract is kept where it matters — a RunningSession with a loopback
// endpoint, the child's workspace credential as `token` (so brokered child
// requests authenticate), and `exited`/`stop` — but the child is the e2e
// harness, told its port, folder, and hub-shaped base path through env.
class HarnessBackend implements SessionBackend {
  private nextPort = CHILD_BASE_PORT;
  // A workspace keeps its port across restarts, so the `childOrigin` the
  // readiness line published stays true after a test (or the per-test
  // reset) stops and starts it, and restarts do not walk the port counter
  // out of this worker's block.
  private readonly ports = new Map<string, number>();
  readonly children = new Map<string, ChildProcess>();

  async start(workspace: WorkspaceEntry, basePath: string): Promise<RunningSession> {
    const port = this.ports.get(workspace.id) ?? this.nextPort++;
    this.ports.set(workspace.id, port);
    const child = spawn("bun", ["run", HARNESS_PATH], {
      cwd: path.resolve(import.meta.dir, "..", ".."),
      env: {
        ...process.env,
        UATU_E2E_PORT: String(port),
        UATU_E2E_WORKSPACE: workspace.path,
        UATU_E2E_BASE_PATH: basePath,
        ...(WORKTREES ? { UATU_E2E_PRESERVE_WORKSPACE: "1" } : {}),
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
let worktreesService: WorktreeService | undefined;
const credentials = new CredentialMetadataStore(path.join(tempRoot, "credentials.json"));
await credentials.load();
// The harness child never receives a credential projection (it has no Git
// to configure), so the resolver's only observable work is the REVISION:
// the session manager records it at start and flags credentialRestartRequired
// once it drifts. Like main.ts's stored resolver, a linked worktree's revision
// is its parent's assignments, read live through the registry link.
const policyAssignments = (workspaceId: string) =>
  JSON.stringify(credentials.snapshot().assignments.filter(item => item.workspaceId === registry.policyWorkspaceId(workspaceId)));
const credentialContexts: CredentialContextResolver = CREDENTIALS
  ? {
    revision: workspaceId => policyAssignments(workspaceId),
    resolve: async entry => ({ ...structuredClone(EMPTY_RESOLVED_CREDENTIAL_CONTEXT), revision: policyAssignments(entry.id) }),
    runExclusive: operation => operation(),
  }
  : EMPTY_CREDENTIAL_CONTEXT_RESOLVER;
const sessions = new SessionManager(registry, { local: backend }, credentialContexts,
  workspaceId => worktreesService?.assertStartable(workspaceId) ?? Promise.resolve());
let credentialTools: CredentialToolManager | undefined;
let credentialApi: NonNullable<Parameters<typeof startHubServer>[0]["credentialApi"]> | undefined;
if (CREDENTIALS) {
  const tokenStore = new CredentialTokenStore(path.join(tempRoot, "credential-tokens.json"));
  // An empty service PATH: the tool manager discovers nothing, so no ambient
  // git/ssh/gpg (or a Hub-managed workspace's projected wrappers) takes part.
  credentialTools = new CredentialToolManager(new CredentialToolOverrideStore(path.join(tempRoot, "credential-tools.json")), "");
  await Promise.all([tokenStore.load(), credentialTools.load()]);
  credentialApi = {
    metadata: credentials,
    tools: credentialTools,
    ssh: null,
    openpgp: new OpenPgpCredentialManager({
      gnupgHome: path.join(tempRoot, "gnupg"), metadataStore: credentials, gpgPath: null, gpgconfPath: null,
    }),
    tokens: new TokenCredentialManager(credentials, tokenStore),
    workspaceExists: workspaceId => registry.byId(workspaceId) !== undefined,
    policyWorkspaceId: workspaceId => registry.policyWorkspaceId(workspaceId),
  };
}
// One PathReservationCoordinator shared by onboarding and the worktree
// coordinator, exactly like src/hub/main.ts composes them — a rename, a
// clone and a worktree creation must not be able to race for one hierarchy.
// Handing each its own (the bug this harness used to hide, uatu-2 Bug 3)
// lets a worktree create's own path fence and its own registration step
// both "win" a path that was never actually contested, which the real Hub
// can never do.
const reservations = new PathReservationCoordinator();
const onboarding = new WorkspaceOnboardingCoordinator({
  journalPath: path.join(tempRoot, "onboarding.json"), registry, credentials, sessions,
  reservations,
});
if (WORKTREES) {
  worktreesService = new WorktreeService({
    registry, sessions,
    journal: new WorktreeJournal(path.join(tempRoot, "worktree-operation.json")),
    provenance: new WorktreeProvenanceStore(path.join(tempRoot, "worktree-provenance.json")),
    registrar: createOnboardingWorktreeRegistrar({ onboarding, registry }),
    coordinator: new WorktreeOperationCoordinator(reservations),
    // Worktree suites fetch from local fixture repositories without credentials.
    // A missing policy disables Fetch entirely, even for those local remotes.
    fetchPolicy: { async select() { return { kind: "none" }; } },
    fetchEnv: { ...process.env, GIT_ALLOW_PROTOCOL: "file" },
    unregister: async id => {
      await personalState.forgetWorkspace(id, () => registry.remove(id), async () => {
        await credentials.removeWorkspaceAssignments(id);
      });
    },
  });
}

async function git(folder: string, args: string[]) {
  const child = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd: folder, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`fixture Git failed: ${stderr}`);
}

// Workspace ids are the registry's slugs of the folder basenames, so the
// requested names are the ids — as long as they are slug-shaped.
const workspaces: HubE2EWorkspace[] = [];
for (const name of WORKSPACE_NAMES) {
  const folder = path.join(tempRoot, "workspaces", name);
  await fs.mkdir(folder, { recursive: true });
  if (WORKTREES) {
    await git(folder, ["init", "--initial-branch=main"]);
    await fs.writeFile(path.join(folder, "README.md"), `# ${name} main checkout\n`);
    await fs.writeFile(path.join(folder, "NOTES.md"), `${name} source notes\n`);
    await git(folder, ["add", "."]);
    await git(folder, ["-c", "user.name=Uatu Test", "-c", "user.email=uatu@example.test", "commit", "-m", "initial"]);
  }
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

const notificationStore = new NotificationStore(path.join(tempRoot, "notifications.json"));
await notificationStore.load();
const pushLog = path.join(tempRoot, "push-sends.jsonl");
const notifications = new HubNotifications({ store: notificationStore,
  sender: async (subscription, payload) => {
    if (PUSH) await fs.appendFile(pushLog, `${JSON.stringify({ endpoint: subscription.endpoint, payload: JSON.parse(payload) })}\n`);
    return { kind: "accepted" };
  },
  source: PUSH ? createHubUpstreamSource({ sessions, registry })
    : { isRunning: () => false, workspaceIds: () => registry.list().map(entry => entry.id), open: async () => { throw new Error("browser suite does not open push upstreams"); } },
  authorized: (principal, id) => sessionStore.resolve(principal.sessionId)?.user === principal.user && (id === undefined || Boolean(registry.byId(id))),
  workspaceName: id => registry.byId(id)?.displayName ?? id,
});
const server = startHubServer({ config, registry, sessions, sessionStore, personalState, notifications,
  ...(PUSH ? { presenceGraceMs: PRESENCE_GRACE_MS } : {}),
  ...(WORKTREES ? { onboarding, worktrees: worktreesService,
    worktreeReconcilerOptions: { minIntervalMs: 100, periodMs: 500 } } : {}),
  ...(credentialApi ? { credentialApi } : {}),
});
const origin = `http://127.0.0.1:${server.port}`;
for (const workspace of workspaces) {
  workspace.sessionUrl = `${origin}/s/${encodeURIComponent(workspace.id)}/`;
}

if (PUSH) notifications.start();
const info: HubE2EInfo = { origin, user: HUB_E2E_USER, workspaces, ...(PUSH ? { pushLog } : {}) };
console.log(`${HUB_E2E_READY_PREFIX}${JSON.stringify(info)}`);

// The per-test reset: hub-fixtures.ts writes `reset <serial>` to stdin and
// waits for `uatu-e2e-hub-reset <serial> ok`. The hub is worker-scoped, so
// without it a test inherits whatever the previous one left: a stopped
// session, a child's staged chat, live PTYs or armed terminal delays, the
// broker's finished/viewed marks, and the personal state. Every workspace
// the hub started with is restarted (a stop the hub observes is what
// forgets the marks, and a fresh child has no conversations and no shells),
// and the personal state of every registered workspace is dropped.
// Workspaces a test registered (linked worktrees) are left to the suites
// that create them.
// The first test of a worker gets the hub exactly as it booted.
let pristine = true;
async function resetForTest(): Promise<void> {
  if (pristine) {
    pristine = false;
    return;
  }
  await Promise.all(workspaces.map(async workspace => {
    await sessions.stop(workspace.id);
    await sessions.start(workspace.id);
  }));
  for (const entry of registry.list()) await personalState.removeWorkspace(entry.id);
}

let controlBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  controlBuffer += chunk;
  let newline = controlBuffer.indexOf("\n");
  while (newline >= 0) {
    const [command, serial] = controlBuffer.slice(0, newline).trim().split(" ");
    controlBuffer = controlBuffer.slice(newline + 1);
    newline = controlBuffer.indexOf("\n");
    if (command !== "reset") continue;
    void resetForTest().then(
      () => console.log(`${HUB_E2E_RESET_PREFIX}${serial} ok`),
      error => console.log(`${HUB_E2E_RESET_PREFIX}${serial} error ${JSON.stringify(String(error))}`),
    );
  }
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await notifications.dispose();
  server.worktreeReconciler?.dispose();
  server.live.endAll();
  server.liveBroker.dispose();
  await sessions.stopAll().catch(() => undefined);
  await credentialTools?.shutdown().catch(() => undefined);
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
