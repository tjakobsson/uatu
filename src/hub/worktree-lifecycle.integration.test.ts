import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, promises as fs } from "node:fs";
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
import { WorktreeOperationCoordinator } from "./worktree-coordinator";
import { WorktreeJournal, WorktreeProvenanceStore, removalMarkerPresent } from "./worktree-journal";
import { createOnboardingWorktreeRegistrar } from "./worktree-registrar";
import { WORKTREE_API_PATH } from "./worktree-api";
import { WorktreeService } from "./worktree-service";
import { CHECKOUT_IDENTITY_FILE } from "./worktree-git";
import { parseWorktreeDeletionPreflight, parseWorktreeInventory, parseWorktreeOperationResult, type WorktreeInventory } from "../shared/worktree-contract";
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
  // One PathReservationCoordinator shared by onboarding and the worktree
  // coordinator below, exactly like main.ts composes them (a rename, a
  // clone and a worktree creation must not race for one hierarchy). Two
  // separate coordinators hid Bug 3: a worktree create's own path fence and
  // the registration step it triggers never actually contended for
  // anything, so the self-conflict onboarding.configureWorktree() hits in
  // production (reserving the destination a second time inside the SAME
  // reservation coordinator that already reserved it) never reproduced here.
  const reservations = new PathReservationCoordinator();
  const onboarding = new WorkspaceOnboardingCoordinator({
    journalPath: path.join(state, "pending-onboarding.json"),
    registry,
    credentials,
    sessions,
    reservations,
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
    coordinator: new WorktreeOperationCoordinator(reservations),
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
      policyWorkspaceId: workspaceId => registry.byId(workspaceId)?.worktree?.parentWorkspaceId ?? workspaceId,
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

test("stamp write failure retains an unverified checkout without ownership or registration", async () => {
  const originalWrite = fs.writeFile.bind(fs);
  let failedWrites = 0;
  const write = spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    if (String(args[0]).endsWith(`/${CHECKOUT_IDENTITY_FILE}`)) {
      failedWrites++;
      throw Object.assign(new Error("simulated stamp write failure"), { code: "EACCES" });
    }
    return originalWrite(...args);
  });
  try {
    const created = await service.create("reviewer", { sourceWorkspaceId: atlasId, mode: "new-branch", branch: "stamp-failure", base: { kind: "local", ref: "main" }, start: true });
    expect(failedWrites).toBe(1);
    expect(created.ok).toBe(false);
    if (created.ok) throw new Error("must not register an unstamped checkout");
    expect(created.error.code).toBe("identity-uncertain");
    expect(created.phase).toBe("creating");
    const pending = await journal.read();
    if (pending?.kind !== "create") throw new Error("expected retained creation intent");
    expect(pending.phase).toBe("creating");
    expect(pending.checkoutId).toBeUndefined();
    expect(existsSync(path.join(pending.destination, "README.md"))).toBe(true);
    expect(registry.byPath(pending.destination)).toBeUndefined();
    expect((await provenance.load()).some(record => record.path === pending.destination)).toBe(false);
    expect((await service.retryRegistration("reviewer", created.operationId)).ok).toBe(false);
    expect((await service.recover())?.kind).toBe("uncertain");
    expect((await journal.read())?.operationId).toBe(created.operationId);
    expect((await git(atlas, ["rev-parse", "--verify", "stamp-failure"])).trim()).not.toBe("");
  } finally {
    write.mockRestore();
    // This fixture shares one journal; manual reconciliation is intentionally
    // required for the retained, unverified checkout.
    const pending = await journal.read();
    if (pending) await journal.clear(pending.operationId);
    await git(atlas, ["worktree", "remove", "--", `${atlas}.worktrees/stamp-failure`]);
  }
});

test.each(["ignored file", "changed ignore rules"])("ignored data appearing after the recheck (%s) refuses deletion prepared for a clean tree", async scenario => {
  const branch = scenario === "ignored file" ? "late-ignored" : "late-ignore-rules";
  const created = await service.create("reviewer", { sourceWorkspaceId: atlasId, mode: "new-branch", branch, base: { kind: "local", ref: "main" } });
  if (!created.ok || !created.checkout?.workspaceId) throw new Error("expected created workspace");
  const checkout = created.checkout;
  const originalAdvance = journal.advance.bind(journal);
  let injected = false;
  let administrativeDirectory = "";
  const filename = scenario === "ignored file" ? "precious.local" : "precious.scratch";
  journal.advance = async (...args) => {
    const intent = await originalAdvance(...args);
    if (args[1] === "removing") {
      if (intent.kind !== "delete") throw new Error("expected deletion intent");
      administrativeDirectory = intent.administrativeDirectory;
      await writeFile(path.join(checkout.path, filename), "keep this data\n");
      if (scenario === "changed ignore rules") {
        // The untracked change becomes ignored before Git can protect it.
        await writeFile(path.join(atlas, ".git", "info", "exclude"), `${filename}\n`);
      }
      injected = true;
    }
    return intent;
  };
  try {
    const deleted = await service.delete("reviewer", { sourceWorkspaceId: atlasId, reference: checkout.workspaceId! });
    expect(injected).toBe(true);
    expect(deleted.ok).toBe(false);
    if (deleted.ok) throw new Error("must not delete newly ignored data");
    expect(deleted.error.message).toContain("changed while deletion was prepared");
    expect(deleted.error.message).toContain("ignored files");
    expect(deleted.error.message).toContain("Move or delete them");
    expect(deleted.phase).toBe("removing");
    expect(deleted.error.phase).toBe(deleted.phase);
    expect(await Bun.file(path.join(checkout.path, filename)).text()).toBe("keep this data\n");
    expect(registry.byId(checkout.workspaceId!)).toBeDefined();
    expect(await provenance.byCheckoutId(checkout.checkoutId)).toBeDefined();
    expect(await journal.read()).toBeUndefined();
    expect(await removalMarkerPresent(administrativeDirectory, deleted.operationId)).toBe(false);
  } finally {
    journal.advance = originalAdvance;
    await rm(path.join(checkout.path, filename), { force: true });
    await service.delete("reviewer", { sourceWorkspaceId: atlasId, reference: checkout.workspaceId! });
  }
});

test.each(["blocker", "probe exception", "probe exception with successful cleanup"])("final deletion check %s cleans up safely", async scenario => {
  const clearFails = scenario !== "probe exception with successful cleanup";
  const branch = scenario === "blocker" ? "final-check-clear-failure" : clearFails ? "final-probe-clear-failure" : "final-probe-cleanup";
  const created = await service.create("reviewer", { sourceWorkspaceId: atlasId, mode: "new-branch", branch, base: { kind: "local", ref: "main" } });
  if (!created.ok || !created.checkout?.workspaceId) throw new Error("expected created workspace");
  const checkout = created.checkout;
  const originalAdvance = journal.advance.bind(journal);
  const originalClear = journal.clear.bind(journal);
  const originalById = registry.byId.bind(registry);
  let throwProbe = false;
  let failedClears = 0;
  let administrativeDirectory = "";
  journal.advance = async (...args) => {
    const intent = await originalAdvance(...args);
    if (args[1] === "removing") {
      if (intent.kind !== "delete") throw new Error("expected deletion intent");
      administrativeDirectory = intent.administrativeDirectory;
      if (scenario === "blocker") await writeFile(path.join(checkout.path, "precious.local"), "keep this data\n");
      else throwProbe = true;
    }
    return intent;
  };
  registry.byId = (...args) => {
    if (throwProbe) {
      throwProbe = false;
      throw new Error("simulated final repository probe failure");
    }
    return originalById(...args);
  };
  journal.clear = async operationId => {
    if (!clearFails) return originalClear(operationId);
    failedClears++;
    throw new Error("simulated journal cleanup failure");
  };
  try {
    const deleted = await service.delete("reviewer", { sourceWorkspaceId: atlasId, reference: checkout.workspaceId! });
    expect(deleted.ok).toBe(false);
    expect(failedClears).toBe(clearFails ? 1 : 0);
    if (!clearFails) {
      expect(await journal.read()).toBeUndefined();
      expect(await removalMarkerPresent(administrativeDirectory, deleted.operationId)).toBe(false);
      expect(registry.byId(checkout.workspaceId!)).toBeDefined();
      expect(existsSync(path.join(checkout.path, "README.md"))).toBe(true);
      return;
    }
    const pending = await journal.read();
    if (pending?.kind !== "delete") throw new Error("expected retained deletion intent");
    expect(pending.phase).toBe("removing");
    expect(await removalMarkerPresent(pending.administrativeDirectory, pending.operationId)).toBe(true);
    expect(registry.byId(checkout.workspaceId!)).toBeDefined();
    expect(existsSync(path.join(checkout.path, "README.md"))).toBe(true);
    // A failed recovery cleanup must preserve the same proof for the next
    // recovery attempt, not strand a surviving tree as identity-uncertain.
    await expect(service.recover()).rejects.toThrow("simulated journal cleanup failure");
    expect(await removalMarkerPresent(pending.administrativeDirectory, pending.operationId)).toBe(true);
    journal.clear = originalClear;
    expect((await service.recover())?.kind).toBe("removal-not-performed");
    expect(await journal.read()).toBeUndefined();
    expect(await removalMarkerPresent(pending.administrativeDirectory, pending.operationId)).toBe(false);
    expect(registry.byId(checkout.workspaceId!)).toBeDefined();
    expect(await provenance.byCheckoutId(checkout.checkoutId)).toBeDefined();
    if (scenario === "blocker") expect(await Bun.file(path.join(checkout.path, "precious.local")).text()).toBe("keep this data\n");
  } finally {
    journal.advance = originalAdvance;
    journal.clear = originalClear;
    registry.byId = originalById;
    const pending = await journal.read();
    if (pending) await journal.clear(pending.operationId);
    await rm(path.join(checkout.path, "precious.local"), { force: true });
    await service.delete("reviewer", { sourceWorkspaceId: atlasId, reference: checkout.workspaceId! });
  }
});

test("removal marker is durable before the removing phase can be persisted", async () => {
  const created = await service.create("reviewer", { sourceWorkspaceId: atlasId, mode: "new-branch", branch: "marker-order", base: { kind: "local", ref: "main" } });
  if (!created.ok || !created.checkout?.workspaceId) throw new Error("expected created workspace");
  const originalAdvance = journal.advance.bind(journal);
  let markerAtTransition: boolean | null | undefined;
  journal.advance = async (...args) => {
    if (args[1] === "removing") {
      const pending = await journal.read();
      if (pending?.kind !== "delete") throw new Error("expected deletion intent");
      markerAtTransition = await removalMarkerPresent(pending.administrativeDirectory, pending.operationId);
    }
    return originalAdvance(...args);
  };
  try {
    const deleted = await service.delete("reviewer", { sourceWorkspaceId: atlasId, reference: created.checkout.workspaceId });
    expect(deleted.ok).toBe(true);
    expect(markerAtTransition).toBe(true);
  } finally {
    journal.advance = originalAdvance;
  }
});

type ActionAnswer = { ok: boolean; message: string; completion?: { message: string; id?: string; deleted?: string } };

// The dialog's own vocabulary over the published JSON family: the picker
// used to submit these fields as a form to `/worktrees/<action>`, and now
// src/shell/worktree-dialog.ts sends exactly this JSON. The mapping lives
// here so every lifecycle assertion below is unchanged by the transport.
async function act(action: string, fields: Record<string, string>): Promise<ActionAnswer> {
  const reference = fields.id ?? "";
  let route = action;
  let body: Record<string, unknown> = { sourceWorkspaceId: fields.source };
  if (action === "create") {
    const selection = fields.selection ?? "";
    const separator = selection.indexOf(":");
    const base = { kind: selection.slice(0, separator), ref: selection.slice(separator + 1) };
    body = fields.mode === "new"
      ? { ...body, mode: "new-branch", branch: fields.branch, base }
      : { ...body, mode: base.kind === "remote" ? "remote-tracking" : "existing-local", base };
  } else if (action === "start") {
    route = "open";
    body = { ...body, reference, start: true };
  } else if (action === "delete") {
    body = { ...body, reference, confirm: fields.confirm === "1", ...(fields.stop === "1" ? { stop: true } : {}) };
  } else if (action === "register") {
    body = { ...body, reference, ...(fields.start === undefined ? {} : { start: true }) };
  } else {
    body = { ...body, reference };
  }
  const response = await fetch(`${origin}${WORKTREE_API_PATH}/${route}`, auth({
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  expect(response.status).toBe(200);
  const result = parseWorktreeOperationResult(await response.json());
  if (!result.ok) return { ok: false, message: result.error.message };
  // The confirmation the dialog shows for this outcome, assembled exactly as
  // src/shell/worktree-dialog.ts assembles it from the same answer.
  if (action === "delete") return { ok: true, message: "", completion: { message: "Worktree deleted. Branch kept.", deleted: reference } };
  if (action === "forget") return { ok: true, message: "", completion: { message: "Removed from Uatu. Checkout, branch and files were kept.", deleted: reference } };
  const checkout = result.checkout;
  const verb = action === "register" && checkout?.ownership !== "uatu" ? "Registered" : "Created";
  return {
    ok: true,
    message: "",
    ...(checkout?.workspaceId === undefined
      ? {}
      : { completion: { message: `${verb} ${checkout.branch}`, id: checkout.workspaceId } }),
  };
}

const messageOf = (answer: ActionAnswer) => answer.message;
const failed = (answer: ActionAnswer) => !answer.ok;

async function create(branch: string, source = atlasId, base = "main"): Promise<string> {
  const answer = await act("create", { source, mode: "new", branch, selection: `local:${base}` });
  expect(answer.completion?.id).toBeDefined();
  return answer.completion!.id!;
}

// The authoritative read the dialog opens with (and the reconciler
// baseline it settles).
async function listInventory(source = atlasId): Promise<WorktreeInventory> {
  const response = await fetch(`${origin}${WORKTREE_API_PATH}?source=${encodeURIComponent(source)}`, auth());
  expect(response.status).toBe(200);
  return parseWorktreeInventory((await response.json() as { inventory: unknown }).inventory);
}

// What the delete dialog reads before it shows its consequences.
async function preflight(reference: string, source = atlasId) {
  const response = await fetch(`${origin}${WORKTREE_API_PATH}/preflight-delete`, auth({
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceWorkspaceId: source, reference }),
  }));
  expect(response.status).toBe(200);
  return parseWorktreeDeletionPreflight(await response.json());
}

async function inventory(source = atlasId): Promise<WorktreeInventory> {
  return parseWorktreeInventory(JSON.parse(JSON.stringify(await service.inventory(source))));
}

async function hubState() {
  const response = await fetch(`${origin}/api/hub/state`, auth());
  expect(response.status).toBe(200);
  return await response.json() as { worktreeApi?: string; worktreeConfigureNavigation?: string; workspaces: Array<Record<string, unknown>> };
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
    await atlasPage.waitFor(() => atlasPage.worktrees().length >= 2, "invalidation after creation");
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
    // Subscribing only guarantees the invalidation FRAME; the reconciler's
    // baseline read behind it is fire-and-forget. Settle that baseline with
    // an awaited read (reason "open") first, or it can land after the
    // worktree below exists, absorb it, and never report it as a change.
    await listInventory(atlasId);
    const external = path.join(root, "agent-trees", "discovered");
    await git(atlas, ["worktree", "add", "-b", "agent/discovered", external]);
    // No Uatu operation ran: the bounded periodic cadence noticed.
    await page.waitFor(() => page.worktrees().length >= 2, "reconciliation invalidation", 10_000);
    page.close();
    const found = (await inventory()).checkouts.find(checkout => checkout.path === external)!;
    expect(found).toMatchObject({ ownership: "external", registered: false, branch: "agent/discovered", availability: "present" });
    expect(found.sourceRef).toBeUndefined();
    expect(registry.list()).toHaveLength(before);
    expect(backendControl.starts.filter(id => !registry.byId(id))).toEqual([]);
    // What the dialog renders its "External · no cleanup ownership" row and
    // its Register workspace action from (see worktree-dialog.test.ts).
    const listed = await listInventory(atlasId);
    expect(listed.checkouts.find(checkout => checkout.path === external))
      .toMatchObject({ ownership: "external", registered: false });
  }, 30000);

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
    expect((await preflight(child)).ok).toBe(false);
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
      // The blocker the dialog shows INSTEAD of its normal consequences; that
      // it replaces them, and shows no path, is worktree-dialog.test.ts's.
      const blocked = await preflight(child);
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.error.message).toContain(reason);
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
    const ready = await preflight(child);
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    expect(ready.requiresStop).toBe(false);
    expect(ready.checkout.branch).toBe("feature/clean");
    const page = await openLive(atlasId);
    await page.waitFor(() => page.worktrees().length === 1, "subscription");
    const answer = await act("delete", { source: atlasId, id: child, confirm: "1" });
    expect(answer.completion).toEqual({ message: "Worktree deleted. Branch kept.", deleted: child });
    await page.waitFor(() => page.worktrees().length >= 2, "invalidation after deletion");
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
    const running = await preflight(child);
    expect(running.ok && running.requiresStop).toBe(true);
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
    const inFlightPreflight = await preflight(child);
    expect(inFlightPreflight.ok && inFlightPreflight.requiresStop).toBe(true);
    const deletion = act("delete", { source: atlasId, id: child, confirm: "1", stop: "1" });
    await Bun.sleep(50);
    // Requested while the removal holds the workspace's lifecycle queue. A
    // start published in `starting` is JOINED rather than queued (see
    // SessionManager.start), so this call rides the in-flight start that
    // began before removal instead of being refused. That is safe and is
    // what the spawn count below pins: joining cannot spawn a second child,
    // and the session it joins is stopped by this deletion.
    const late = sessions.start(child).then(() => "started", (error: Error) => error.message);
    backendControl.gate = null;
    release();
    await inFlight;
    const answer = await deletion;
    expect(answer.completion?.deleted).toBe(child);
    expect(await late).toBe("started");
    // No start ever used the removed checkout: one spawn, before removal.
    expect(backendControl.starts.length - startsBefore).toBe(1);
    expect(existsSync(folder)).toBe(false);
    expect(sessions.isRunning(child)).toBe(false);
    // Nothing in flight now, so the lifecycle fence is the only thing left
    // to answer: a fresh start cannot resurrect the deleted workspace.
    await expect(sessions.start(child)).rejects.toThrow(/unknown workspace/);
    expect(backendControl.starts.length - startsBefore).toBe(1);
  }, 30000);

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
    const answer = await act("forget", { source: atlasId, id: child, confirm: "on" });
    expect(answer.ok).toBe(true);
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
    // The confirmation is the dialog's required checkbox now, not a server
    // field (worktree-dialog.test.ts covers it); the registration survives
    // every refused attempt below all the same.
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
    // There is no branch-deletion operation anywhere in the family.
    for (const action of ["delete-branch", "branch", "rename"]) {
      const response = await fetch(`${origin}${WORKTREE_API_PATH}/${action}`, auth({
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceWorkspaceId: atlasId }),
      }));
      expect(response.status).toBe(404);
    }
  });
});

describe("real Hub state for the picker and dashboard (5.6)", () => {
  test("the state list carries the capability, hierarchy, branches, provenance and fork entry points", async () => {
    const child = await create("feature/state", beaconId, "release");
    await git(beacon, ["checkout", "-q", "release"]);
    const state = await hubState();
    expect(state.worktreeApi).toBe("/api/hub/worktrees");
    // F9: the capability is the API path alone. The Configure navigation
    // field went with the per-repository button that read it; parent
    // policy lives on the Hub's Settings page, reached from its own nav.
    expect(state.worktreeConfigureNavigation).toBeUndefined();
    const parent = state.workspaces.find(workspace => workspace.id === beaconId)!;
    const childRow = state.workspaces.find(workspace => workspace.id === child)!;
    expect(parent).toMatchObject({ branch: "release", createWorktree: true });
    expect(parent.parentId).toBeUndefined();
    expect(childRow).toMatchObject({ parentId: beaconId, branch: "feature/state", sourceRef: "release", ownership: "uatu", repositoryId: parent.repositoryId });
    expect(childRow.createWorktree).toBeUndefined();
    // The child's own assignment rows, not a copy of the parent's.
    expect(childRow.credentialAssignments).toEqual({ authentication: [], signing: [] });
    // The picker's own parser nests it under the right parent.
    const parsed = parseHubState(state)!;
    expect(parsed.worktreeApi).toBe("/api/hub/worktrees");
    expect(parsed.workspaces.find(workspace => workspace.id === child)).toMatchObject({ parentId: beaconId, sourceRef: "release", branch: "feature/state" });
    // The parent's current checkout is not the child's origin.
    await git(beacon, ["checkout", "-q", "--detach"]);
    const detached = await hubState();
    expect(detached.workspaces.find(workspace => workspace.id === beaconId)).toMatchObject({ detached: true });
    expect(detached.workspaces.find(workspace => workspace.id === beaconId)!.branch).toBeUndefined();
    expect(detached.workspaces.find(workspace => workspace.id === child)!.sourceRef).toBe("release");
    await git(beacon, ["checkout", "-q", "main"]);
  });

  test("the picker's dialog reads everything it renders from the JSON family, and the server-rendered flow is gone", async () => {
    // One authoritative answer feeds every view the dialog shows: the
    // inventory rows, and the local/remote refs both creation modes offer.
    const listing = await listInventory(beaconId);
    expect(listing.checkouts.some(checkout => checkout.branch === "feature/state")).toBe(true);
    expect(listing.checkouts.some(checkout => checkout.main)).toBe(true);
    expect(listing.refs.local).toContain("release");
    // The retired `/worktrees` presentation and its form actions are
    // unmounted; nothing navigates to a server-rendered worktree page.
    for (const retired of ["/worktrees", `/worktrees?view=create&source=${beaconId}`, "/worktrees/create", "/worktrees/operation"]) {
      expect((await fetch(`${origin}${retired}`, auth())).status).toBe(404);
    }
  });
});
