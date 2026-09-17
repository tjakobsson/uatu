import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { hashPassword, hubCookieName, HubSessionStore } from "./auth";
import type { RunningSession, SessionBackend } from "./backend";
import type { HubConfig } from "./config";
import { EMPTY_CREDENTIAL_CONTEXT_RESOLVER } from "./credential-context";
import { CredentialMetadataStore } from "./credential-store";
import { WorkspaceOnboardingCoordinator, type OnboardingGit } from "./onboarding";
import { PathReservationCoordinator } from "./path-reservations";
import { PersonalWorkspaceStateStore } from "./personal-state";
import { WorkspaceRegistry } from "./registry";
import { startHubServer } from "./server";
import { SessionManager } from "./sessions";
import { WorktreeJournal, WorktreeProvenanceStore } from "./worktree-journal";
import { createOnboardingWorktreeRegistrar } from "./worktree-registrar";
import { WorktreeService } from "./worktree-service";
import { parseWorktreeInventory, type WorktreeInventory } from "../shared/worktree-contract";
import { parseLiveEnvelope, type LiveEnvelope } from "../shared/live-protocol";
import { parseHubState } from "../shell/hub-nav";

// Tasks 5.1–5.6 against the REAL Hub pieces: Bun.serve, the registry,
// onboarding, personal state, the live broker/endpoint, the worktree service
// and its reconciler, over real temporary Git repositories. No workspace
// child is spawned: the session backend is a controllable stub, so
// "running", a failing stop and an in-flight start are Hub-side facts. The
// Git environment is explicit, never inherited from a Hub-managed
// development workspace.

const temporaryDirectories: string[] = [];
let root = "";
let home = "";
let origin = "";
let cookie = "";
let server: ReturnType<typeof startHubServer>;
let registry: WorkspaceRegistry;
let sessions: SessionManager;
let service: WorktreeService;
let provenance: WorktreeProvenanceStore;
let journal: WorktreeJournal;
let personalState: PersonalWorkspaceStateStore;
let atlas = "";
let atlasId = "";
let beacon = "";
let beaconId = "";

const backendControl = {
  starts: [] as string[],
  stopFailures: new Set<string>(),
  gate: null as Promise<void> | null,
  startedInMissingFolder: false,
};
let unregisterFailures = 0;

function cleanEnvironment(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Uatu Test",
    GIT_AUTHOR_EMAIL: "uatu@example.test",
    GIT_COMMITTER_NAME: "Uatu Test",
    GIT_COMMITTER_EMAIL: "uatu@example.test",
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd, env: cleanEnvironment(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout;
}

async function repository(name: string): Promise<string> {
  const folder = path.join(root, name);
  await mkdir(folder);
  await git(folder, ["init", "--initial-branch=main"]);
  await writeFile(path.join(folder, "README.md"), `# ${name}\n`);
  await writeFile(path.join(folder, ".gitignore"), "*.local\n");
  await git(folder, ["add", "."]);
  await git(folder, ["commit", "-m", "initial"]);
  await git(folder, ["branch", "release"]);
  return folder;
}

const onboardingGit: OnboardingGit = {
  async probe(folder) {
    const isRepository = await Bun.file(path.join(folder, ".git", "HEAD")).exists();
    return isRepository ? { kind: "repository", toplevel: folder } : { kind: "not-a-repository" };
  },
  async init() {
    throw new Error("these tests never initialize a repository");
  },
};

const backend: SessionBackend = {
  async start(workspace, basePath): Promise<RunningSession> {
    backendControl.starts.push(workspace.id);
    if (backendControl.gate) await backendControl.gate;
    if (!existsSync(workspace.path)) backendControl.startedInMissingFolder = true;
    return {
      workspaceId: workspace.id,
      basePath,
      endpoint: { hostname: "127.0.0.1", port: 1 },
      token: null,
      exited: new Promise<number | null>(() => {}),
      async stop() {
        if (backendControl.stopFailures.has(workspace.id)) throw new Error("simulated stop failure");
      },
    };
  },
};

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "uatu-worktree-lifecycle-")));
  temporaryDirectories.push(root);
  home = path.join(root, "home");
  await mkdir(home);
  const state = path.join(root, "state");
  await mkdir(state);
  atlas = await repository("atlas");
  beacon = await repository("beacon");

  const config: HubConfig = {
    port: 0,
    host: "127.0.0.1",
    tls: null,
    users: [{ name: "reviewer", passwordHash: await hashPassword("open sesame") }],
    stateDir: state,
  };
  registry = new WorkspaceRegistry(path.join(state, "registry.json"));
  personalState = new PersonalWorkspaceStateStore(path.join(state, "personal-state.json"));
  const credentials = new CredentialMetadataStore(path.join(state, "credentials.json"));
  const sessionStore = new HubSessionStore(path.join(state, "sessions.json"));
  await Promise.all([registry.load(), personalState.load(), credentials.load(), sessionStore.load()]);
  sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER, workspaceId => service.assertStartable(workspaceId));
  const onboarding = new WorkspaceOnboardingCoordinator({
    journalPath: path.join(state, "pending-onboarding.json"),
    registry,
    credentials,
    sessions,
    reservations: new PathReservationCoordinator(),
    git: onboardingGit,
  });
  atlasId = (await onboarding.configureExisting({ path: atlas, displayName: "Atlas", authentication: [], signing: null, init: false, start: false })).entry.id;
  beaconId = (await onboarding.configureExisting({ path: beacon, displayName: "Beacon", authentication: [], signing: null, init: false, start: false })).entry.id;
  journal = new WorktreeJournal(path.join(state, "pending-worktree-operation.json"));
  provenance = new WorktreeProvenanceStore(path.join(state, "worktree-provenance.json"));
  service = new WorktreeService({
    registry,
    sessions,
    journal,
    provenance,
    registrar: createOnboardingWorktreeRegistrar({ onboarding, registry }),
    git: { env: cleanEnvironment() },
    // The same Hub cleanup main.ts wires, with an injectable persistence failure.
    unregister: async workspaceId => {
      if (unregisterFailures > 0) {
        unregisterFailures -= 1;
        throw new Error("simulated registry write failure");
      }
      await personalState.forgetWorkspace(workspaceId, () => registry.remove(workspaceId), async () => {
        await credentials.removeWorkspaceAssignments(workspaceId);
      });
    },
  });
  server = startHubServer({
    config, registry, sessions, sessionStore, personalState, onboarding,
    worktrees: service,
    // Fast, bounded cadence so reconciliation is observable within a test.
    worktreeReconcilerOptions: { minIntervalMs: 50, periodMs: 150 },
    credentialApi: {
      metadata: credentials,
      tools: { list: () => [], async set() { throw new Error("unused"); } } as never,
      ssh: null,
      openpgp: null as never,
      tokens: null as never,
      workspaceExists: workspaceId => registry.byId(workspaceId) !== undefined,
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  cookie = `${hubCookieName(new URL(origin))}=${(await sessionStore.issue("reviewer", "test")).id}`;
});

afterAll(async () => {
  server?.worktreeReconciler?.dispose();
  server?.live.endAll();
  server?.stop(true);
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const auth = (init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...(init.headers as Record<string, string>), cookie, origin } });

type ActionAnswer = { redirect: string; completion?: { message: string; id?: string; deleted?: string; source: string } };

async function act(action: string, fields: Record<string, string>): Promise<ActionAnswer> {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const response = await fetch(`${origin}/worktrees/${action}`, auth({ method: "POST", body }));
  expect(response.status).toBe(200);
  return await response.json() as ActionAnswer;
}

const messageOf = (answer: ActionAnswer) => new URL(answer.redirect, origin).searchParams.get("message") ?? "";
const failed = (answer: ActionAnswer) => new URL(answer.redirect, origin).searchParams.get("error") === "1";

async function create(branch: string, source = atlasId, base = "main"): Promise<string> {
  const answer = await act("create", { source, mode: "new", branch, selection: `local:${base}` });
  expect(answer.completion?.id).toBeDefined();
  return answer.completion!.id!;
}

async function view(query: string): Promise<string> {
  const response = await fetch(`${origin}/worktrees?${query}&fragment=1`, auth());
  expect(response.status).toBe(200);
  return response.text();
}

async function inventory(source = atlasId): Promise<WorktreeInventory> {
  return parseWorktreeInventory(JSON.parse(JSON.stringify(await service.inventory(source))));
}

async function hubState() {
  const response = await fetch(`${origin}/api/hub/state`, auth());
  expect(response.status).toBe(200);
  return await response.json() as { worktreeNavigation?: string; worktreeConfigureNavigation?: string; workspaces: Array<Record<string, unknown>> };
}

const branchExists = async (folder: string, branch: string) => (await git(folder, ["branch", "--list", branch])).trim() !== "";

// A live stream as a page holds it: one connection, frames parsed by the
// same protocol parser the client uses.
async function openLive(ws: string, options: { activity?: boolean } = {}) {
  const controller = new AbortController();
  const params = new URLSearchParams({ ws, subs: JSON.stringify([{ topic: "worktrees" }]) });
  if (options.activity) params.set("activity", "1");
  const response = await fetch(`${origin}/api/hub/live?${params}`, auth({ signal: controller.signal }));
  expect(response.status).toBe(200);
  const envelopes: LiveEnvelope[] = [];
  const raw: string[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          raw.push(frame);
          if (!frame.startsWith("event: live")) continue;
          const envelope = parseLiveEnvelope(frame.split("\n").find(line => line.startsWith("data: "))!.slice(6));
          if (envelope) envelopes.push(envelope);
        }
      }
    } catch {
      // Aborted.
    }
  })();
  const worktrees = () => envelopes.filter(envelope => envelope.topic === "worktrees" && envelope.event.kind === "data");
  return {
    envelopes,
    raw,
    worktrees,
    async waitFor(predicate: () => boolean, what: string, timeoutMs = 4_000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(10);
      }
    },
    close: () => controller.abort(),
  };
}

describe("the worktrees live topic (5.2)", () => {
  test("a subscription gets a fresh invalidation; a committed creation invalidates only that repository, immediately", async () => {
    const atlasPage = await openLive(atlasId, { activity: true });
    const beaconPage = await openLive(beaconId);
    await atlasPage.waitFor(() => atlasPage.worktrees().length === 1, "fresh invalidation on subscribe");
    await beaconPage.waitFor(() => beaconPage.worktrees().length === 1, "fresh invalidation on subscribe");
    expect(atlasPage.envelopes.find(envelope => envelope.topic === "worktrees" && envelope.event.kind === "ready")).toBeDefined();

    const child = await create("feature/live");
    // Published when the operation committed, not at the next poll.
    await atlasPage.waitFor(() => atlasPage.worktrees().length >= 2, "invalidation after creation", 1_000);
    await Bun.sleep(100);
    expect(beaconPage.worktrees()).toHaveLength(1);

    // A child's own page is in the family too.
    const childPage = await openLive(child);
    await childPage.waitFor(() => childPage.worktrees().length === 1, "child subscription");
    await act("start", { source: atlasId, id: child });
    await childPage.waitFor(() => childPage.worktrees().length >= 2, "child invalidated by a family operation");

    // Content-free: no path, branch, identity or credential in any frame.
    for (const envelope of [...atlasPage.worktrees(), ...childPage.worktrees()]) {
      expect(envelope).toEqual({ ws: envelope.ws, topic: "worktrees", cursor: "", event: { kind: "data", data: { type: "worktree.inventory" } } });
    }
    expect(atlasPage.raw.join("\n")).not.toContain(root);
    // The activity payload keeps its three booleans.
    for (const envelope of atlasPage.envelopes.filter(candidate => candidate.topic === "activity" && candidate.event.kind === "data")) {
      expect(Object.keys((envelope.event as { data: object }).data).sort()).toEqual(["awaiting", "running", "working"]);
    }
    for (const page of [atlasPage, beaconPage, childPage]) page.close();
    await sessions.stop(child);
  });

  test("a reconnect gets a fresh invalidation without presenting any cursor", async () => {
    const first = await openLive(atlasId);
    await first.waitFor(() => first.worktrees().length === 1, "first stream");
    first.close();
    const second = await openLive(atlasId);
    await second.waitFor(() => second.worktrees().length === 1, "replacement stream");
    second.close();
  });

  test("the stream requires an authenticated same-origin session", async () => {
    const params = new URLSearchParams({ ws: atlasId, subs: JSON.stringify([{ topic: "worktrees" }]) });
    const anonymous = await fetch(`${origin}/api/hub/live?${params}`, { redirect: "manual" });
    expect(anonymous.status).toBeGreaterThanOrEqual(300);
    expect(anonymous.status).not.toBe(200);
    const crossOrigin = await fetch(`${origin}/api/hub/live?${params}`, { headers: { cookie, origin: "https://evil.example" } });
    expect(crossOrigin.status).toBe(403);
    const keyed = new URLSearchParams({ ws: atlasId, subs: JSON.stringify([{ topic: "worktrees", key: "x" }]) });
    expect((await fetch(`${origin}/api/hub/live?${keyed}`, auth())).status).toBe(400);
  });
});

describe("reconciliation (5.1)", () => {
  test("an external checkout is discovered and pushed, stays external and unregistered, and is never opened", async () => {
    const page = await openLive(atlasId);
    await page.waitFor(() => page.worktrees().length === 1, "subscription");
    const before = registry.list().length;
    const external = path.join(root, "agent-trees", "discovered");
    await git(atlas, ["worktree", "add", "-b", "agent/discovered", external]);
    // No Uatu operation ran: the bounded periodic cadence noticed.
    await page.waitFor(() => page.worktrees().length >= 2, "reconciliation invalidation", 3_000);
    page.close();
    const found = (await inventory()).checkouts.find(checkout => checkout.path === external)!;
    expect(found).toMatchObject({ ownership: "external", registered: false, branch: "agent/discovered", availability: "present" });
    expect(found.sourceRef).toBeUndefined();
    expect(registry.list()).toHaveLength(before);
    expect(backendControl.starts.filter(id => !registry.byId(id))).toEqual([]);
    const listing = await view(`view=inventory&source=${atlasId}`);
    expect(listing).toContain("External · no cleanup ownership");
    expect(listing).toContain("Register workspace");
  });

  test("explicit registration keeps the external path and ownership, and names the child by its branch", async () => {
    const external = path.join(root, "agent-trees", "discovered");
    const found = (await inventory()).checkouts.find(checkout => checkout.path === external)!;
    const answer = await act("register", { source: atlasId, id: found.checkoutId });
    expect(answer.completion?.message).toBe("Registered agent/discovered");
    const entry = registry.byId(answer.completion!.id!)!;
    expect(entry.path).toBe(external);
    expect(entry.displayName).toBe("agent/discovered");
    expect(entry.worktree?.parentWorkspaceId).toBe(atlasId);
    const registered = (await inventory()).checkouts.find(checkout => checkout.path === external)!;
    expect(registered).toMatchObject({ ownership: "external", registered: true, workspaceId: entry.id });
    // External ownership is never deletable.
    const refused = await act("delete", { source: atlasId, id: entry.id, confirm: "1" });
    expect(failed(refused)).toBe(true);
    expect(messageOf(refused)).toContain("Only a worktree Uatu created can be deleted");
    expect(existsSync(external)).toBe(true);
  });

  test("a missing registered checkout is reported, cannot start, and is never recreated or forgotten", async () => {
    const child = await create("feature/missing");
    const folder = registry.byId(child)!.path;
    await rm(folder, { recursive: true, force: true });
    const row = (await inventory()).checkouts.find(checkout => checkout.workspaceId === child)!;
    expect(row).toMatchObject({ availability: "missing", registered: true, running: false });
    // Pruned by Git too: still reported, from the registration.
    await git(atlas, ["worktree", "prune"]);
    const pruned = (await inventory()).checkouts.find(checkout => checkout.workspaceId === child)!;
    expect(pruned).toMatchObject({ availability: "missing", registered: true, branch: "feature/missing", sourceRef: "main" });
    const start = await fetch(`${origin}/api/hub/sessions/${child}/start`, auth({ method: "POST" }));
    expect(start.status).toBe(409);
    expect(backendControl.startedInMissingFolder).toBe(false);
    expect(existsSync(folder)).toBe(false);
    expect(registry.byId(child)).toBeDefined();
    const state = await hubState();
    expect(state.workspaces.find(workspace => workspace.id === child)).toMatchObject({ availability: "missing", parentId: atlasId });
    const deletion = await view(`view=delete&source=${atlasId}&id=${child}`);
    expect(deletion).not.toContain(">Delete<");
  });

  test("a path replaced by another tree is an identity conflict, even though Git reuses the old name", async () => {
    const child = await create("feature/replaced");
    const folder = registry.byId(child)!.path;
    // Outside Uatu: the tree is removed and a different one added at the
    // same path. Git gives it the same administrative name.
    await git(atlas, ["worktree", "remove", folder]);
    await git(atlas, ["worktree", "add", "-b", "intruder/tree", folder]);
    const row = (await inventory()).checkouts.find(checkout => checkout.path === folder)!;
    expect(row).toMatchObject({ ownership: "uncertain", availability: "replaced", workspaceId: child });
    const start = await fetch(`${origin}/api/hub/sessions/${child}/start`, auth({ method: "POST" }));
    expect(start.status).toBe(409);
    const refused = await act("delete", { source: atlasId, id: child, confirm: "1" });
    expect(failed(refused)).toBe(true);
    expect(existsSync(path.join(folder, "README.md"))).toBe(true);
    expect(await branchExists(atlas, "intruder/tree")).toBe(true);
  });
});

describe("deletion preflight (5.3)", () => {
  const blockers: Array<[string, (folder: string) => Promise<void>, string]> = [
    ["tracked changes", folder => writeFile(path.join(folder, "README.md"), "changed\n"), "uncommitted changes"],
    ["untracked files", folder => writeFile(path.join(folder, "notes.txt"), "draft\n"), "untracked files"],
    ["ignored files", folder => writeFile(path.join(folder, "secrets.local"), "token\n"), "ignored files"],
    ["a Git lock", folder => git(folder, ["worktree", "lock", "--reason", "keep", folder]).then(() => undefined), "locked in Git"],
    ["a Git operation in progress", async folder => {
      const lock = (await git(folder, ["rev-parse", "--path-format=absolute", "--git-path", "index.lock"])).trim();
      await writeFile(lock, "");
    }, "Git operation appears to be running"],
    ["a nested worktree", folder => git(atlas, ["worktree", "add", "-b", `nested/${path.basename(folder)}`, path.join(folder, "inner")]).then(() => undefined), "Another worktree is inside"],
  ];

  for (const [label, arrange, reason] of blockers) {
    test(`${label} blocks deletion and retains checkout and registration`, async () => {
      const child = await create(`block/${label.replaceAll(" ", "-")}`);
      const folder = registry.byId(child)!.path;
      await arrange(folder);
      const dialog = await view(`view=delete&source=${atlasId}&id=${child}`);
      expect(dialog).toContain("Delete worktree?");
      expect(dialog).toContain(reason);
      expect(dialog).not.toContain(">Delete<");
      expect(dialog).not.toContain(folder);
      const answer = await act("delete", { source: atlasId, id: child, confirm: "1" });
      expect(failed(answer)).toBe(true);
      expect(answer.completion).toBeUndefined();
      expect(messageOf(answer)).toContain(reason);
      expect(existsSync(folder)).toBe(true);
      expect(registry.byId(child)).toBeDefined();
      expect(await journal.read()).toBeUndefined();
    });
  }

  test("the main checkout, an unregistered external tree and an unconfirmed request cannot delete anything", async () => {
    const main = await act("delete", { source: atlasId, id: atlasId, confirm: "1" });
    expect(messageOf(main)).toContain("main checkout cannot be deleted");
    const external = (await inventory()).checkouts.find(checkout => checkout.ownership === "external" && !checkout.registered);
    if (external) {
      const refused = await act("delete", { source: atlasId, id: external.checkoutId, confirm: "1" });
      expect(failed(refused)).toBe(true);
      expect(existsSync(external.path)).toBe(true);
    }
    const child = await create("feature/unconfirmed");
    const unconfirmed = await act("delete", { source: atlasId, id: child });
    expect(failed(unconfirmed)).toBe(true);
    expect(registry.byId(child)).toBeDefined();
    expect(existsSync(atlas)).toBe(true);
  });
});

describe("guarded removal (5.4) and branch preservation (5.5)", () => {
  test("a clean stopped worktree is removed, unregistered and forgotten; its branch and creation history stay", async () => {
    const child = await create("feature/clean", atlasId, "release");
    const folder = registry.byId(child)!.path;
    const dialog = await view(`view=delete&source=${atlasId}&id=${child}`);
    expect(dialog).toContain("The worktree’s files will be removed. The Git branch will be kept.");
    expect(dialog).toContain(`Atlas / feature/clean`);
    const page = await openLive(atlasId);
    await page.waitFor(() => page.worktrees().length === 1, "subscription");
    const answer = await act("delete", { source: atlasId, id: child, confirm: "1" });
    expect(answer.completion).toEqual({ message: "Worktree deleted. Branch kept.", deleted: child, source: atlasId });
    await page.waitFor(() => page.worktrees().length >= 2, "invalidation after deletion", 1_000);
    page.close();
    expect(existsSync(folder)).toBe(false);
    expect(registry.byId(child)).toBeUndefined();
    expect(await branchExists(atlas, "feature/clean")).toBe(true);
    expect(await journal.read()).toBeUndefined();
    expect((await provenance.load()).some(record => record.branch === "feature/clean")).toBe(false);
    // Checking the kept branch out again recovers its recorded origin only.
    const again = await act("create", { source: atlasId, mode: "existing", selection: "local:feature/clean" });
    const reopened = registry.byId(again.completion!.id!)!;
    const row = (await inventory()).checkouts.find(checkout => checkout.workspaceId === reopened.id)!;
    expect(row.sourceRef).toBe("release");
    expect(row.ownership).toBe("uatu");
  });

  test("a running worktree needs Stop and delete; the plain Delete refuses without touching it", async () => {
    const child = await create("feature/running");
    const folder = registry.byId(child)!.path;
    await sessions.start(child);
    const dialog = await view(`view=delete&source=${atlasId}&id=${child}`);
    expect(dialog).toContain("Stop and delete");
    expect(dialog).toContain("Its Uatu terminal and agent sessions will stop");
    const plain = await act("delete", { source: atlasId, id: child, confirm: "1" });
    expect(messageOf(plain)).toContain("Stop and delete");
    expect(sessions.isRunning(child)).toBe(true);
    expect(existsSync(folder)).toBe(true);
    const stopped = await act("delete", { source: atlasId, id: child, confirm: "1", stop: "1" });
    expect(stopped.completion?.deleted).toBe(child);
    expect(sessions.isRunning(child)).toBe(false);
    expect(existsSync(folder)).toBe(false);
    expect(await branchExists(atlas, "feature/running")).toBe(true);
  });

  test("a failed stop removes nothing and keeps the registration", async () => {
    const child = await create("feature/stop-fails");
    const folder = registry.byId(child)!.path;
    await sessions.start(child);
    backendControl.stopFailures.add(child);
    try {
      const answer = await act("delete", { source: atlasId, id: child, confirm: "1", stop: "1" });
      expect(failed(answer)).toBe(true);
      expect(messageOf(answer)).toContain("could not be stopped");
      expect(existsSync(folder)).toBe(true);
      expect(registry.byId(child)).toBeDefined();
      expect(sessions.isRunning(child)).toBe(true);
      expect(await journal.read()).toBeUndefined();
    } finally {
      backendControl.stopFailures.delete(child);
      await sessions.stop(child);
    }
  });

  test("an in-flight start is awaited and stopped; a start requested during removal cannot use the removed checkout", async () => {
    const child = await create("feature/racing");
    const folder = registry.byId(child)!.path;
    let release!: () => void;
    backendControl.gate = new Promise<void>(resolve => { release = resolve; });
    const startsBefore = backendControl.starts.length;
    const inFlight = sessions.start(child);
    await Bun.sleep(20);
    // Preflight sees the start: the dialog asks for Stop and delete.
    expect(await view(`view=delete&source=${atlasId}&id=${child}`)).toContain("Stop and delete");
    const deletion = act("delete", { source: atlasId, id: child, confirm: "1", stop: "1" });
    await Bun.sleep(50);
    // Requested while the removal holds the workspace's lifecycle queue.
    const late = sessions.start(child).then(() => "started", (error: Error) => error.message);
    backendControl.gate = null;
    release();
    await inFlight;
    const answer = await deletion;
    expect(answer.completion?.deleted).toBe(child);
    expect(await late).toContain("unknown workspace");
    expect(backendControl.starts.length - startsBefore).toBe(1);
    expect(existsSync(folder)).toBe(false);
    expect(sessions.isRunning(child)).toBe(false);
  });

  test("a cleanup persistence failure after verified removal is recorded and finished by a retry", async () => {
    const child = await create("feature/cleanup");
    const folder = registry.byId(child)!.path;
    unregisterFailures = 1;
    const answer = await act("delete", { source: atlasId, id: child, confirm: "1" });
    expect(failed(answer)).toBe(true);
    expect(messageOf(answer)).toContain("files were removed");
    expect(existsSync(folder)).toBe(false);
    expect(registry.byId(child)).toBeDefined();
    expect((await journal.read())?.phase).toBe("unregistering");
    // Meanwhile another worktree operation is fenced by the pending record.
    const fenced = await act("create", { source: atlasId, mode: "new", branch: "feature/fenced", selection: "local:main" });
    expect(failed(fenced)).toBe(true);
    const retry = await act("delete", { source: atlasId, id: child, confirm: "1" });
    expect(retry.completion?.deleted).toBe(child);
    expect(registry.byId(child)).toBeUndefined();
    expect(await journal.read()).toBeUndefined();
    expect(await branchExists(atlas, "feature/cleanup")).toBe(true);
  });

  test("a tree added at a removed worktree's path is a new, external occupant that Uatu will not delete", async () => {
    const child = await create("feature/reused");
    const folder = registry.byId(child)!.path;
    await act("delete", { source: atlasId, id: child, confirm: "1" });
    await git(atlas, ["worktree", "add", "-b", "other/occupant", folder]);
    const occupant = (await inventory()).checkouts.find(checkout => checkout.path === folder)!;
    expect(occupant).toMatchObject({ ownership: "external", registered: false, branch: "other/occupant" });
    const refused = await act("delete", { source: atlasId, id: occupant.checkoutId, confirm: "1" });
    expect(failed(refused)).toBe(true);
    expect(existsSync(path.join(folder, "README.md"))).toBe(true);
  });

  test("restart recovery of an interrupted removal cleans up without touching a new occupant", async () => {
    const child = await create("feature/interrupted");
    const folder = registry.byId(child)!.path;
    const checkoutId = registry.byId(child)!.worktree!.checkoutId;
    const administrativeDirectory = (await git(folder, ["rev-parse", "--path-format=absolute", "--absolute-git-dir"])).trim();
    await journal.begin({
      operationId: "crashed-removal", kind: "delete", phase: "preflight", user: "reviewer",
      repositoryId: registry.byId(child)!.worktree!.repositoryId, sourceWorkspaceId: atlasId, sourcePath: atlas,
      destination: folder, checkoutId, administrativeDirectory: await realpath(administrativeDirectory), branch: "feature/interrupted", workspaceId: child,
    });
    await journal.advance("crashed-removal", "removing");
    // The crash happened after Git removed the tree; somebody re-added one.
    await git(atlas, ["worktree", "remove", folder]);
    await git(atlas, ["worktree", "add", "-b", "other/after-crash", folder]);
    await writeFile(path.join(folder, "their-work.txt"), "keep me\n");
    const outcome = await service.recover();
    expect(outcome?.kind).toBe("removed");
    expect(registry.byId(child)).toBeUndefined();
    expect(existsSync(path.join(folder, "their-work.txt"))).toBe(true);
    expect((await inventory()).checkouts.find(checkout => checkout.path === folder)).toMatchObject({ ownership: "external", registered: false });
  });
});

describe("Remove from Uatu (5.5)", () => {
  test("forgetting keeps files, branch and provenance; re-registering the same tree recovers ownership", async () => {
    const child = await create("feature/forget", atlasId, "release");
    const folder = registry.byId(child)!.path;
    const checkoutId = registry.byId(child)!.worktree!.checkoutId;
    await sessions.start(child);
    const dialog = await view(`view=forget&source=${atlasId}&id=${child}`);
    expect(dialog).toContain("Checkout, branch, files and creation provenance remain.");
    const answer = await act("forget", { source: atlasId, id: child, confirm: "on" });
    expect(answer.completion).toEqual({ message: "Removed from Uatu. Checkout, branch and files were kept.", deleted: child, source: atlasId });
    // Stopped first, then unregistered; nothing else.
    expect(sessions.isRunning(child)).toBe(false);
    expect(registry.byId(child)).toBeUndefined();
    expect(existsSync(path.join(folder, "README.md"))).toBe(true);
    expect(await branchExists(atlas, "feature/forget")).toBe(true);
    expect(await provenance.byCheckoutId(checkoutId)).toBeDefined();
    const row = (await inventory()).checkouts.find(checkout => checkout.path === folder)!;
    expect(row).toMatchObject({ ownership: "uatu", registered: false, sourceRef: "release" });
    const again = await act("register", { source: atlasId, id: row.checkoutId });
    expect(again.completion?.message).toBe("Created feature/forget");
    expect(registry.byId(again.completion!.id!)!.worktree!.checkoutId).toBe(checkoutId);
  });

  test("an external checkout is forgotten without Git or file changes; forget needs confirmation and a failed stop keeps it", async () => {
    const external = path.join(root, "agent-trees", "forget-me");
    await git(atlas, ["worktree", "add", "-b", "agent/forget-me", external]);
    const found = (await inventory()).checkouts.find(checkout => checkout.path === external)!;
    const id = (await act("register", { source: atlasId, id: found.checkoutId })).completion!.id!;
    const unconfirmed = await act("forget", { source: atlasId, id });
    expect(failed(unconfirmed)).toBe(true);
    expect(registry.byId(id)).toBeDefined();
    await sessions.start(id);
    backendControl.stopFailures.add(id);
    const stuck = await act("forget", { source: atlasId, id, confirm: "on" });
    expect(failed(stuck)).toBe(true);
    expect(registry.byId(id)).toBeDefined();
    backendControl.stopFailures.delete(id);
    const list = await git(atlas, ["worktree", "list", "--porcelain"]);
    await act("forget", { source: atlasId, id, confirm: "on" });
    expect(registry.byId(id)).toBeUndefined();
    expect(await git(atlas, ["worktree", "list", "--porcelain"])).toBe(list);
    expect(await branchExists(atlas, "agent/forget-me")).toBe(true);
    expect(existsSync(external)).toBe(true);
  });

  test("a main workspace with registered worktrees is not removed from Uatu; no branch-deletion operation exists", async () => {
    const answer = await act("forget", { source: atlasId, id: atlasId, confirm: "on" });
    expect(messageOf(answer)).toContain("worktrees from Uatu first");
    expect(registry.byId(atlasId)).toBeDefined();
    for (const action of ["delete-branch", "branch"]) {
      const body = new FormData();
      body.set("source", atlasId);
      expect((await fetch(`${origin}/worktrees/${action}`, auth({ method: "POST", body }))).status).toBe(405);
    }
    const listing = await view(`view=inventory&source=${atlasId}`);
    expect(listing.toLowerCase()).not.toContain("delete branch");
  });
});

describe("real Hub state for the picker and dashboard (5.6)", () => {
  test("the state list carries the capability, hierarchy, branches, provenance and fork entry points", async () => {
    const child = await create("feature/state", beaconId, "release");
    await git(beacon, ["checkout", "-q", "release"]);
    const state = await hubState();
    expect(state.worktreeNavigation).toBe("/worktrees");
    expect(state.worktreeConfigureNavigation).toBe("/settings");
    const parent = state.workspaces.find(workspace => workspace.id === beaconId)!;
    const childRow = state.workspaces.find(workspace => workspace.id === child)!;
    expect(parent).toMatchObject({ branch: "release", createWorktree: `/worktrees?view=create&source=${beaconId}` });
    expect(parent.parentId).toBeUndefined();
    expect(childRow).toMatchObject({ parentId: beaconId, branch: "feature/state", sourceRef: "release", ownership: "uatu", repositoryId: parent.repositoryId });
    expect(childRow.createWorktree).toBeUndefined();
    // The child's own assignment rows, not a copy of the parent's.
    expect(childRow.credentialAssignments).toEqual({ authentication: [], signing: [] });
    // The picker's own parser nests it under the right parent.
    const parsed = parseHubState(state)!;
    expect(parsed.worktreeNavigation).toBe("/worktrees");
    expect(parsed.workspaces.find(workspace => workspace.id === child)).toMatchObject({ parentId: beaconId, sourceRef: "release", branch: "feature/state" });
    // The parent's current checkout is not the child's origin.
    await git(beacon, ["checkout", "-q", "--detach"]);
    const detached = await hubState();
    expect(detached.workspaces.find(workspace => workspace.id === beaconId)).toMatchObject({ detached: true });
    expect(detached.workspaces.find(workspace => workspace.id === beaconId)!.branch).toBeUndefined();
    expect(detached.workspaces.find(workspace => workspace.id === child)!.sourceRef).toBe("release");
    await git(beacon, ["checkout", "-q", "main"]);
  });

  test("the fork, inventory and deletion fragments the picker mounts answer from the real Hub", async () => {
    const fork = await view(`view=create&mode=new&source=${beaconId}`);
    expect(fork).toContain("New branch / worktree · Beacon");
    const existing = await view(`view=create&mode=existing&source=${beaconId}`);
    expect(existing).toContain("Existing branch · Beacon");
    const listing = await view(`view=inventory&source=${beaconId}`);
    expect(listing).toContain("feature/state");
    // Dashboard-owned views are not linked from the real picker.
    expect(listing).not.toContain("view=settings");
    expect(listing).toContain("view=folder");
    const folder = await view(`view=folder&source=${beaconId}&id=${beaconId}`);
    expect(folder).toContain("Folder rename is blocked");
    expect(folder).not.toContain("view=rename");
  });
});
