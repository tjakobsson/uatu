import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CredentialMetadataStore, CredentialTokenStore } from "./credential-store";
import { createStoredCredentialContextResolver } from "./credential-context";
import { WorkspaceOnboardingCoordinator, type OnboardingGit } from "./onboarding";
import { PathReservationCoordinator } from "./path-reservations";
import { WorkspaceRegistry } from "./registry";
import { WorktreeService } from "./worktree-service";
import { createOnboardingWorktreeRegistrar } from "./worktree-registrar";
import { WorktreeJournal, WorktreeProvenanceStore, type WorktreeRegistrar } from "./worktree-journal";
import { listWorktrees } from "./worktree-git";

// Real Git, real registry/onboarding/credential stores, temporary
// directories only. The Git environment is explicit: developing Uatu inside
// a Hub-managed workspace projects Git/SSH wrappers that these tests must
// not discover.
const temporaryDirectories: string[] = [];
let sharedHome: string | undefined;

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `uatu-worktree-onboarding-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

async function cleanEnvironment(): Promise<Record<string, string>> {
  sharedHome ??= await temporaryDirectory("home");
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: sharedHome,
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
    cwd, env: await cleanEnvironment(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout;
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

async function fixture(label: string, options: { registrar?: (real: WorktreeRegistrar) => WorktreeRegistrar } = {}) {
  const root = await realpath(await temporaryDirectory(label));
  const state = path.join(root, "state");
  await mkdir(state);
  const repository = path.join(root, "atlas");
  await mkdir(repository);
  await git(repository, ["init", "--initial-branch=main"]);
  await writeFile(path.join(repository, "README.md"), "# Readme\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "initial"]);

  const registry = new WorkspaceRegistry(path.join(state, "registry.json"));
  const credentials = new CredentialMetadataStore(path.join(state, "credentials.json"));
  const tokens = new CredentialTokenStore(path.join(state, "tokens"));
  await Promise.all([registry.load(), credentials.load(), tokens.load()]);

  const running = new Set<string>();
  const started: string[] = [];
  let startError: Error | undefined;
  const lifecycle = new Map<string, Promise<unknown>>();
  const runExclusive = <T,>(id: string, operation: () => Promise<T>): Promise<T> => {
    const previous = lifecycle.get(id) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    lifecycle.set(id, next.then(() => undefined, () => undefined));
    return next;
  };
  const sessions = {
    runExclusive,
    async startWhileLifecycleQueueHeld(id: string) {
      if (startError) throw startError;
      if (!registry.byId(id)) throw new Error(`unknown workspace: ${id}`);
      started.push(id);
      running.add(id);
      return {} as never;
    },
    isRunning: (id: string) => running.has(id),
  };

  const onboarding = new WorkspaceOnboardingCoordinator({
    journalPath: path.join(state, "pending-onboarding.json"),
    registry,
    credentials,
    sessions,
    reservations: new PathReservationCoordinator(),
    git: onboardingGit,
  });
  const parent = await onboarding.configureExisting({
    path: repository,
    displayName: "Atlas",
    authentication: [],
    signing: null,
    init: false,
    start: false,
  });

  const realRegistrar = createOnboardingWorktreeRegistrar({ onboarding, registry });
  const service = new WorktreeService({
    registry,
    sessions,
    journal: new WorktreeJournal(path.join(state, "pending-worktree-operation.json")),
    provenance: new WorktreeProvenanceStore(path.join(state, "worktree-provenance.json")),
    registrar: options.registrar ? options.registrar(realRegistrar) : realRegistrar,
    git: { env: await cleanEnvironment() },
    newOperationId: (() => {
      let counter = 0;
      return () => `operation-${counter += 1}`;
    })(),
  });

  // The same resolver the Hub assembles, with the registry's link deciding
  // whose policy governs a workspace.
  const contexts = createStoredCredentialContextResolver({
    metadata: credentials,
    tokens,
    stateRoot: state,
    runtimeRoot: path.join(state, "runtime"),
    gnupgHome: path.join(state, "gnupg"),
    sshAgentSocket: () => path.join(state, "agent.sock"),
    sshCredentialUsable: async () => true,
    openPgpCredentialUsable: async () => true,
    tools: { ssh: "/usr/bin/ssh", git: "/usr/bin/git", gpg: null, sshKeygen: "/usr/bin/ssh-keygen", gh: null, glab: null },
    policyWorkspaceId: workspaceId => registry.byId(workspaceId)?.worktree?.parentWorkspaceId ?? workspaceId,
  });

  return {
    root, state, repository, registry, credentials, onboarding, service, contexts, sessions, started, running,
    parentId: parent.entry.id,
    failNextStart(error: Error) {
      startError = error;
    },
    allowStarts() {
      startError = undefined;
    },
  };
}

async function addSshCredential(store: CredentialMetadataStore, id: string) {
  await store.transaction(state => state.credentials.push({
    id,
    name: id,
    type: "ssh",
    enabled: true,
    capabilities: ["ssh-authentication", "ssh-signing"],
    metadata: { publicKey: `ssh-ed25519 AAAA-${id}`, fingerprint: `SHA256:${id}` },
    createdAt: "2026-09-17T00:00:00.000Z",
  }));
}

afterAll(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("verified checkouts become registered workspaces atomically", () => {
  test("creation registers the child stopped, named by its branch, under its parent", async () => {
    const context = await fixture("register");
    const result = await context.service.create("reviewer", {
      sourceWorkspaceId: context.parentId,
      mode: "new-branch",
      branch: "feature/login",
      base: { kind: "local", ref: "main" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registered).toBe(true);
    expect(result.started).toBe(false);
    expect(result.checkout?.running).toBe(false);
    expect(result.checkout?.ownership).toBe("uatu");
    expect(result.checkout?.sourceRef).toBe("main");

    const child = context.registry.byId(result.checkout!.workspaceId!)!;
    expect(child.displayName).toBe("feature/login");
    expect(child.path).toBe(`${context.repository}.worktrees/feature-login`);
    expect(child.worktree).toEqual({
      parentWorkspaceId: context.parentId,
      repositoryId: result.checkout!.repositoryId,
      checkoutId: result.checkout!.checkoutId,
    });
    // Stopped by default: nothing was started.
    expect(context.started).toEqual([]);
    expect(context.sessions.isRunning(child.id)).toBe(false);
  });

  test("an explicitly requested start runs after the commit", async () => {
    const context = await fixture("start");
    const result = await context.service.create("reviewer", {
      sourceWorkspaceId: context.parentId,
      mode: "new-branch",
      branch: "feature/start",
      base: { kind: "local", ref: "main" },
      start: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.started).toBe(true);
    expect(context.started).toEqual([result.checkout!.workspaceId!]);
    expect(result.startError).toBeUndefined();
  });

  test("a failed start preserves the stopped, configured child", async () => {
    const context = await fixture("start-failure");
    context.failNextStart(new Error("child process exited during startup"));
    const result = await context.service.create("reviewer", {
      sourceWorkspaceId: context.parentId,
      mode: "new-branch",
      branch: "feature/stopped",
      base: { kind: "local", ref: "main" },
      start: true,
    });
    // A failed start is post-commit intent, not a failed operation.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registered).toBe(true);
    expect(result.started).toBe(false);
    expect(result.startError?.code).toBe("start-failed");
    expect(result.startError?.retry).toBe("retry-start");
    const child = context.registry.byId(result.checkout!.workspaceId!);
    expect(child?.displayName).toBe("feature/stopped");
    expect(context.sessions.isRunning(child!.id)).toBe(false);
    // The checkout survives for the retry; nothing was recreated or removed.
    expect(await Bun.file(path.join(child!.path, "README.md")).exists()).toBe(true);
  });
});

describe("registration failure retains the checkout", () => {
  test("a retry registers the same checkout instead of creating a second one", async () => {
    let failures = 1;
    const context = await fixture("retry", {
      registrar: real => ({
        register: input => {
          if (failures-- > 0) throw new Error("registry persistence failed");
          return real.register(input);
        },
      }),
    });
    const attempt = await context.service.create("reviewer", {
      sourceWorkspaceId: context.parentId,
      mode: "new-branch",
      branch: "feature/retained",
      base: { kind: "local", ref: "main" },
    });
    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.error.code).toBe("registration-failed");
    expect(attempt.error.retry).toBe("retry-registration");
    expect(attempt.retainedCheckout?.path).toBe(`${context.repository}.worktrees/feature-retained`);
    expect(context.registry.list().map(entry => entry.id)).toEqual([context.parentId]);

    const retry = await context.service.retryRegistration("reviewer", attempt.operationId);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.checkout?.path).toBe(attempt.retainedCheckout?.path);
    expect(retry.checkout?.checkoutId).toBe(attempt.retainedCheckout?.checkoutId);
    // Exactly one new registration and exactly one new linked tree.
    expect(context.registry.list().length).toBe(2);
    const inventory = await listWorktrees(context.repository, { env: await cleanEnvironment() });
    expect(inventory.kind === "inventory" && inventory.records.length).toBe(2);
    expect((await readdir(`${context.repository}.worktrees`)).length).toBe(1);
    // The branch was never recreated either.
    expect((await git(context.repository, ["branch", "--list", "feature/retained"])).trim()).toContain("feature/retained");
  });

  test("another user cannot retry someone else's retained operation", async () => {
    const context = await fixture("retry-user", {
      registrar: () => ({ register: () => Promise.reject(new Error("registry persistence failed")) }),
    });
    const attempt = await context.service.create("reviewer", {
      sourceWorkspaceId: context.parentId,
      mode: "new-branch",
      branch: "feature/scoped",
      base: { kind: "local", ref: "main" },
    });
    expect(attempt.ok).toBe(false);
    const other = await context.service.retryRegistration("intruder", attempt.operationId);
    expect(other.ok).toBe(false);
    if (other.ok) return;
    expect(other.error.code).toBe("permission-denied");
    // And the operation is still the initiator's to finish.
    expect(await context.service.progress("intruder")).toBeUndefined();
    expect((await context.service.progress("reviewer"))?.operationId).toBe(attempt.operationId);
  });
});

describe("parent policy is inherited live, not copied", () => {
  test("a parent credential change reaches its children with no child assignment", async () => {
    const context = await fixture("inherit");
    await addSshCredential(context.credentials, "cred-a");
    await addSshCredential(context.credentials, "cred-b");
    const created = await context.service.create("reviewer", {
      sourceWorkspaceId: context.parentId,
      mode: "new-branch",
      branch: "feature/inherit",
      base: { kind: "local", ref: "main" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const child = context.registry.byId(created.checkout!.workspaceId!)!;

    // The parent owns the policy.
    await context.credentials.assign({ workspaceId: context.parentId, credentialId: "cred-a", role: "authentication", host: "example.test" });
    const first = await context.contexts.resolve(child);
    expect(first.authentication.map(item => item.credential.id)).toEqual(["cred-a"]);
    // Nothing was copied: the child holds no assignment of its own.
    expect(context.credentials.snapshot().assignments.filter(item => item.workspaceId === child.id)).toEqual([]);

    // A later parent change applies live, with no per-child update.
    const before = context.contexts.revision(child.id);
    await context.credentials.unassign(context.parentId, "cred-a", "authentication", "example.test");
    await context.credentials.assign({ workspaceId: context.parentId, credentialId: "cred-b", role: "authentication", host: "example.test" });
    const second = await context.contexts.resolve(child);
    expect(second.authentication.map(item => item.credential.id)).toEqual(["cred-b"]);
    expect(context.contexts.revision(child.id)).not.toBe(before);
    // The child's revision tracks the parent's exactly, which is what marks
    // a running child restart-required when the parent's policy changes.
    expect(context.contexts.revision(child.id)).toBe(context.contexts.revision(context.parentId));
    expect(context.credentials.snapshot().assignments.map(item => item.workspaceId)).toEqual([context.parentId]);
  });

  test("an unrelated workspace's policy is never inherited", async () => {
    const context = await fixture("unrelated");
    await addSshCredential(context.credentials, "cred-other");
    const other = await context.onboarding.configureExisting({
      path: await (async () => {
        const folder = path.join(context.root, "beacon");
        await mkdir(folder);
        await git(folder, ["init", "--initial-branch=main"]);
        await writeFile(path.join(folder, "README.md"), "# Beacon\n");
        await git(folder, ["add", "."]);
        await git(folder, ["commit", "-m", "initial"]);
        return folder;
      })(),
      displayName: "Beacon",
      authentication: [],
      signing: null,
      init: false,
      start: false,
    });
    await context.credentials.assign({ workspaceId: other.entry.id, credentialId: "cred-other", role: "authentication", host: "example.test" });

    const created = await context.service.create("reviewer", {
      sourceWorkspaceId: context.parentId,
      mode: "new-branch",
      branch: "feature/isolated",
      base: { kind: "local", ref: "main" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const child = context.registry.byId(created.checkout!.workspaceId!)!;
    expect((await context.contexts.resolve(child)).authentication).toEqual([]);
  });

  test("a child cannot own another child's configuration", async () => {
    const context = await fixture("no-chain");
    const created = await context.service.create("reviewer", {
      sourceWorkspaceId: context.parentId,
      mode: "new-branch",
      branch: "feature/chain",
      base: { kind: "local", ref: "main" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const child = context.registry.byId(created.checkout!.workspaceId!)!;
    await expect(context.onboarding.configureWorktree({
      path: context.repository,
      displayName: "nope",
      link: { parentWorkspaceId: child.id, repositoryId: "r", checkoutId: "c" },
    })).rejects.toThrow(/cannot own another worktree/);
  });

  test("runtime and personal state are not inherited: only the policy link is", async () => {
    const context = await fixture("runtime");
    const created = await context.service.create("reviewer", {
      sourceWorkspaceId: context.parentId,
      mode: "new-branch",
      branch: "feature/runtime",
      base: { kind: "local", ref: "main" },
      start: true,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const child = context.registry.byId(created.checkout!.workspaceId!)!;
    // The child runs; the parent is untouched by its child's lifecycle.
    expect(context.sessions.isRunning(child.id)).toBe(true);
    expect(context.sessions.isRunning(context.parentId)).toBe(false);
    // The registry entry carries the relationship and nothing else — no
    // copied display name, credential selection or personal state.
    expect(Object.keys(child).sort()).toEqual(["backend", "displayName", "id", "path", "worktree"]);
  });
});

describe("the Hub's own fences apply before Git runs", () => {
  test("a pending folder mutation freezes creation with nothing retained", async () => {
    const context = await fixture("fenced");
    const fenced = new WorktreeService({
      registry: context.registry,
      sessions: context.sessions,
      journal: new WorktreeJournal(path.join(context.state, "fenced-operation.json")),
      provenance: new WorktreeProvenanceStore(path.join(context.state, "fenced-provenance.json")),
      registrar: { register: () => Promise.reject(new Error("unreachable")) },
      assertOperationsAllowed: () => Promise.reject(new Error("a pending folder mutation requires Hub recovery")),
      git: { env: await cleanEnvironment() },
    });
    const result = await fenced.create("reviewer", {
      sourceWorkspaceId: context.parentId,
      mode: "new-branch",
      branch: "feature/fenced",
      base: { kind: "local", ref: "main" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("internal");
    // Nothing ran: no branch, no destination, no journal.
    expect((await git(context.repository, ["branch", "--list", "feature/fenced"])).trim()).toBe("");
    expect(await Bun.file(path.join(context.state, "fenced-operation.json")).exists()).toBe(false);
  });
});

describe("restart recovery", () => {
  test("a completed creation leaves no pending operation to reconcile", async () => {
    const context = await fixture("recover-clean");
    const created = await context.service.create("reviewer", {
      sourceWorkspaceId: context.parentId,
      mode: "new-branch",
      branch: "feature/clean",
      base: { kind: "local", ref: "main" },
    });
    expect(created.ok).toBe(true);
    expect(await context.service.recover()).toBeUndefined();
  });

  test("an interrupted registration recovers as a retained, unregistered checkout", async () => {
    const context = await fixture("recover-retained", {
      registrar: () => ({ register: () => Promise.reject(new Error("registry persistence failed")) }),
    });
    const attempt = await context.service.create("reviewer", {
      sourceWorkspaceId: context.parentId,
      mode: "new-branch",
      branch: "feature/recovered",
      base: { kind: "local", ref: "main" },
    });
    expect(attempt.ok).toBe(false);

    // A fresh service over the same state files is what a restarted Hub has.
    const restarted = new WorktreeService({
      registry: context.registry,
      sessions: context.sessions,
      journal: new WorktreeJournal(path.join(context.state, "pending-worktree-operation.json")),
      provenance: new WorktreeProvenanceStore(path.join(context.state, "worktree-provenance.json")),
      registrar: { register: () => Promise.reject(new Error("unused")) },
      git: { env: await cleanEnvironment() },
    });
    const outcome = await restarted.recover();
    expect(outcome?.kind).toBe("retained-unregistered");
    if (outcome?.kind !== "retained-unregistered") return;
    expect(outcome.checkoutPath).toBe(`${context.repository}.worktrees/feature-recovered`);
    // Nothing was deleted and nothing was registered on its own.
    expect(await Bun.file(path.join(outcome.checkoutPath, "README.md")).exists()).toBe(true);
    expect(context.registry.list().length).toBe(1);
  });
});
