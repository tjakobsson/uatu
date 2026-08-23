import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CredentialMetadataStore } from "./credential-store";
import {
  OnboardingError,
  resolveOnboardingAssignments,
  WorkspaceOnboardingCoordinator,
  type OnboardingGit,
} from "./onboarding";
import { PathReservationCoordinator } from "./path-reservations";
import { WorkspaceRegistry } from "./registry";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

type GitBehavior = { initError?: string; probeNotRepository?: boolean; onInit?: (folder: string) => Promise<void> };

function fakeGit(behavior: GitBehavior = {}): OnboardingGit & { initialized: string[] } {
  const initialized: string[] = [];
  return {
    initialized,
    async probe(folder) {
      if (behavior.probeNotRepository) return { kind: "not-a-repository" };
      const isRepo = await fs.lstat(path.join(folder, ".git")).then(() => true, () => false);
      return isRepo ? { kind: "repository", toplevel: folder } : { kind: "not-a-repository" };
    },
    async init(folder) {
      if (behavior.initError) return { ok: false, error: behavior.initError };
      await fs.mkdir(path.join(folder, ".git"), { recursive: true });
      initialized.push(folder);
      await behavior.onInit?.(folder);
      return { ok: true };
    },
  };
}

async function fixture(git: GitBehavior = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "uatu-onboarding-")));
  tempDirectories.push(root);
  const state = path.join(root, "state");
  const folders = path.join(root, "folders");
  await Promise.all([fs.mkdir(state), fs.mkdir(folders)]);
  const registry = new WorkspaceRegistry(path.join(state, "registry.json"));
  const credentials = new CredentialMetadataStore(path.join(state, "credentials.json"));
  await Promise.all([registry.load(), credentials.load()]);
  const started: string[] = [];
  let startError: Error | undefined;
  // Mirrors SessionManager's per-workspace lifecycle queue: start and
  // runExclusive sections for one workspace serialize in call order.
  const lifecycle = new Map<string, Promise<unknown>>();
  const runExclusive = <T,>(id: string, operation: () => Promise<T>): Promise<T> => {
    const previous = lifecycle.get(id) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    lifecycle.set(id, next.then(() => undefined, () => undefined));
    return next;
  };
  const sessions = {
    start(id: string) {
      return runExclusive(id, async () => {
        if (startError) throw startError;
        started.push(id);
        return {} as never;
      });
    },
    runExclusive,
  };
  const reservations = new PathReservationCoordinator();
  const journalPath = path.join(state, "pending-onboarding.json");
  const gitAdapter = fakeGit(git);
  const coordinator = new WorkspaceOnboardingCoordinator({
    journalPath,
    registry,
    credentials,
    sessions,
    reservations,
    git: gitAdapter,
  });
  return {
    root,
    state,
    folders,
    registry,
    credentials,
    sessions,
    reservations,
    journalPath,
    coordinator,
    git: gitAdapter,
    started,
    failNextStart(error: Error) {
      startError = error;
    },
  };
}

async function gitRepository(parent: string, name: string): Promise<string> {
  const folder = path.join(parent, name);
  await fs.mkdir(path.join(folder, ".git"), { recursive: true });
  return folder;
}

async function addSshCredential(store: CredentialMetadataStore, id: string, options: { enabled?: boolean; signingOnly?: boolean } = {}) {
  await store.transaction(state => state.credentials.push({
    id,
    name: id,
    type: "ssh",
    enabled: options.enabled ?? true,
    capabilities: options.signingOnly ? ["ssh-signing"] : ["ssh-authentication", "ssh-signing"],
    metadata: { publicKey: `ssh-ed25519 AAAA-${id}`, fingerprint: `SHA256:${id}` },
    createdAt: "2026-08-23T00:00:00.000Z",
  }));
}

async function addTokenCredential(store: CredentialMetadataStore, id: string, host: string) {
  await store.transaction(state => state.credentials.push({
    id,
    name: id,
    type: "token",
    enabled: true,
    capabilities: ["https-git"],
    metadata: { host },
    createdAt: "2026-08-23T00:00:00.000Z",
  }));
}

async function journalExists(journalPath: string): Promise<boolean> {
  return fs.lstat(journalPath).then(() => true, () => false);
}

describe("onboarding input validation", () => {
  test("rejects unknown fields, relative paths, bad names, and non-boolean start", async () => {
    const f = await fixture();
    const invalid: unknown[] = [
      { path: "relative", displayName: "X" },
      { path: path.join(f.folders, "a"), displayName: "" },
      { path: path.join(f.folders, "a"), displayName: "X", extra: 1 },
      { path: path.join(f.folders, "a"), displayName: "X", start: "yes" },
      { path: path.join(f.folders, "a"), displayName: "X", authentication: "nope" },
      { path: path.join(f.folders, "a"), displayName: "X", signing: "" },
    ];
    for (const input of invalid) {
      await expect(f.coordinator.configureExisting(input)).rejects.toMatchObject({ code: "invalid-input" });
    }
    await expect(f.coordinator.createWorkspace({ parent: f.folders, folderName: ".hidden", displayName: "X" }))
      .rejects.toMatchObject({ code: "invalid-input" });
    await expect(f.coordinator.createWorkspace({ parent: f.folders, folderName: "a/b", displayName: "X" }))
      .rejects.toMatchObject({ code: "invalid-input" });
  });
});

describe("credential selection validation", () => {
  test("resolves compatible authentication and signing assignments", async () => {
    const f = await fixture();
    await addSshCredential(f.credentials, "auth-key");
    await addSshCredential(f.credentials, "sign-key", { signingOnly: true });
    const desired = resolveOnboardingAssignments(
      "ws",
      { authentication: [{ credentialId: "auth-key", host: "github.com" }], signing: "sign-key" },
      f.credentials.snapshot(),
    );
    expect(desired).toEqual([
      { workspaceId: "ws", credentialId: "auth-key", role: "authentication", host: "github.com" },
      { workspaceId: "ws", credentialId: "sign-key", role: "signing" },
    ]);
  });

  test("rejects missing, disabled, incapable, host-mismatched, and conflicting selections", async () => {
    const f = await fixture();
    await addSshCredential(f.credentials, "ok");
    await addSshCredential(f.credentials, "off", { enabled: false });
    await addSshCredential(f.credentials, "sign-only", { signingOnly: true });
    await addTokenCredential(f.credentials, "gh-token", "github.com");
    const state = f.credentials.snapshot();
    const cases: Array<{ authentication?: Array<{ credentialId: string; host: string }>; signing?: string | null }> = [
      { authentication: [{ credentialId: "missing", host: "github.com" }], signing: null },
      { authentication: [{ credentialId: "off", host: "github.com" }], signing: null },
      { authentication: [{ credentialId: "sign-only", host: "github.com" }], signing: null },
      { authentication: [{ credentialId: "gh-token", host: "gitlab.com" }], signing: null },
      {
        authentication: [
          { credentialId: "ok", host: "github.com" },
          { credentialId: "gh-token", host: "github.com" },
        ],
        signing: null,
      },
      { authentication: [], signing: "gh-token" },
      { authentication: [], signing: "missing" },
    ];
    for (const selection of cases) {
      expect(() => resolveOnboardingAssignments("ws", { authentication: selection.authentication ?? [], signing: selection.signing ?? null }, state))
        .toThrow(OnboardingError);
    }
  });
});

describe("configure existing folder", () => {
  test("commits registration and assignments as one stopped result", async () => {
    const f = await fixture();
    await addSshCredential(f.credentials, "auth-key");
    await addSshCredential(f.credentials, "sign-key", { signingOnly: true });
    const folder = await gitRepository(f.folders, "payments-service");

    const result = await f.coordinator.configureExisting({
      path: folder,
      displayName: "Payments API",
      authentication: [{ credentialId: "auth-key", host: "github.com" }],
      signing: "sign-key",
    });

    expect(result.entry).toEqual({ id: "payments-service", path: folder, backend: "local", displayName: "Payments API" });
    expect(result.created).toBe(true);
    expect(result.started).toBe(false);
    expect(result.startError).toBeNull();
    expect(f.started).toEqual([]);
    expect(f.credentials.snapshot().assignments).toEqual([
      { workspaceId: "payments-service", credentialId: "auth-key", role: "authentication", host: "github.com" },
      { workspaceId: "payments-service", credentialId: "sign-key", role: "signing" },
    ]);
    expect(await journalExists(f.journalPath)).toBe(false);
  });

  test("configuring a canonical path recognizes a legacy alias registration", async () => {
    const f = await fixture();
    const folder = await gitRepository(f.folders, "repo");
    const alias = path.join(f.root, "legacy-alias");
    await fs.symlink(f.folders, alias);
    // A pre-canonicalization registry entry persisted through the symlinked
    // ancestor must short-circuit as already registered — not mint a second
    // stable id for the same repository.
    const legacy = await f.registry.register(path.join(alias, "repo"), "local", "Legacy");

    const result = await f.coordinator.configureExisting({ path: folder, displayName: "Repo" });
    expect(result.alreadyRegistered).toBe(true);
    expect(result.entry.id).toBe(legacy.id);
    expect(f.registry.byPath(folder)?.id).toBe(legacy.id);
    expect(f.registry.list().filter(entry => entry.id.startsWith("repo"))).toHaveLength(1);
  });

  test("an already-registered folder short-circuits without mutation", async () => {
    const f = await fixture();
    const folder = await gitRepository(f.folders, "repo");
    const existing = await f.registry.register(folder, "local", "Kept");

    const result = await f.coordinator.configureExisting({ path: folder, displayName: "Ignored" });
    expect(result.alreadyRegistered).toBe(true);
    expect(result.created).toBe(false);
    expect(result.entry).toEqual(existing);
    expect(f.registry.byId(existing.id)?.displayName).toBe("Kept");
  });

  test("a non-git folder needs explicit init and initializes when confirmed", async () => {
    const f = await fixture();
    const folder = path.join(f.folders, "plain");
    await fs.mkdir(folder);

    await expect(f.coordinator.configureExisting({ path: folder, displayName: "Plain" }))
      .rejects.toMatchObject({ code: "needs-init" });
    expect(f.registry.byPath(folder)).toBeUndefined();

    const result = await f.coordinator.configureExisting({ path: folder, displayName: "Plain", init: true });
    expect(result.entry.id).toBe("plain");
    expect(f.git.initialized).toEqual([folder]);
  });

  test("credential failure precedes git init so a declined folder is untouched", async () => {
    const f = await fixture();
    const folder = path.join(f.folders, "plain");
    await fs.mkdir(folder);

    await expect(f.coordinator.configureExisting({
      path: folder,
      displayName: "Plain",
      init: true,
      authentication: [{ credentialId: "missing", host: "github.com" }],
    })).rejects.toMatchObject({ code: "credential" });
    expect(f.git.initialized).toEqual([]);
    expect(f.registry.byPath(folder)).toBeUndefined();
  });

  test("a reserved path conflicts instead of racing the other operation", async () => {
    const f = await fixture();
    const folder = await gitRepository(f.folders, "busy");
    const held = f.reservations.acquire([folder])!;
    await expect(f.coordinator.configureExisting({ path: folder, displayName: "Busy" }))
      .rejects.toMatchObject({ code: "conflict" });
    held.release();
    expect((await f.coordinator.configureExisting({ path: folder, displayName: "Busy" })).created).toBe(true);
  });
});

describe("create new workspace", () => {
  test("creates, initializes, and registers a stopped workspace under the parent", async () => {
    const f = await fixture();
    await addSshCredential(f.credentials, "auth-key");
    const result = await f.coordinator.createWorkspace({
      parent: f.folders,
      folderName: "payments-service",
      displayName: "Payments API",
      authentication: [{ credentialId: "auth-key", host: "github.com" }],
    });

    const destination = path.join(f.folders, "payments-service");
    expect(result.entry).toEqual({ id: "payments-service", path: destination, backend: "local", displayName: "Payments API" });
    expect(result.createdFolder).toBe(true);
    expect(result.started).toBe(false);
    expect(f.git.initialized).toEqual([destination]);
    expect((await fs.lstat(path.join(destination, ".git"))).isDirectory()).toBe(true);
    expect(f.credentials.snapshot().assignments).toHaveLength(1);
    expect(await journalExists(f.journalPath)).toBe(false);
  });

  test("an existing destination fails without registering or modifying it", async () => {
    const f = await fixture();
    const occupied = path.join(f.folders, "taken");
    await fs.mkdir(occupied);
    await fs.writeFile(path.join(occupied, "kept.txt"), "kept");

    await expect(f.coordinator.createWorkspace({ parent: f.folders, folderName: "taken", displayName: "Taken" }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(f.registry.byPath(occupied)).toBeUndefined();
    expect(await fs.readFile(path.join(occupied, "kept.txt"), "utf8")).toBe("kept");
  });

  test("credential failure precedes folder creation", async () => {
    const f = await fixture();
    await expect(f.coordinator.createWorkspace({
      parent: f.folders,
      folderName: "never-created",
      displayName: "X",
      signing: "missing",
    })).rejects.toMatchObject({ code: "credential" });
    expect(await fs.readdir(f.folders)).toEqual([]);
  });

  test("git init failure removes the still-empty created folder", async () => {
    const f = await fixture({ initError: "boom" });
    await expect(f.coordinator.createWorkspace({ parent: f.folders, folderName: "doomed", displayName: "X" }))
      .rejects.toMatchObject({ code: "git-init" });
    expect(await fs.readdir(f.folders)).toEqual([]);
    expect(f.registry.byPath(path.join(f.folders, "doomed"))).toBeUndefined();
  });

  test("metadata failure after init retains the repository and reports retry", async () => {
    const f = await fixture();
    const failingCredentials = {
      snapshot: () => f.credentials.snapshot(),
      transaction: async () => { throw new Error("injected assignment failure"); },
    };
    await addSshCredential(f.credentials, "auth-key");
    const coordinator = new WorkspaceOnboardingCoordinator({
      journalPath: f.journalPath,
      registry: f.registry,
      credentials: failingCredentials as never,
      sessions: f.sessions,
      reservations: f.reservations,
      git: f.git,
    });

    const destination = path.join(f.folders, "retained");
    let caught: OnboardingError | undefined;
    await coordinator.createWorkspace({
      parent: f.folders,
      folderName: "retained",
      displayName: "Retained",
      authentication: [{ credentialId: "auth-key", host: "github.com" }],
    }).catch(error => { caught = error as OnboardingError; });

    expect(caught?.retainedPath).toBe(destination);
    expect(caught?.message).toContain("Existing folder");
    expect((await fs.lstat(path.join(destination, ".git"))).isDirectory()).toBe(true);
    expect(f.registry.byPath(destination)).toBeUndefined();
    expect(await journalExists(f.journalPath)).toBe(false);

    // Retry through Existing folder completes registration of the retained repo.
    const retried = await f.coordinator.configureExisting({ path: destination, displayName: "Retained" });
    expect(retried.created).toBe(true);
    expect(retried.entry.path).toBe(destination);
  });
});

describe("commit-boundary failure injection", () => {
  test("a journal write failure mutates nothing", async () => {
    const f = await fixture();
    const folder = await gitRepository(f.folders, "repo");
    const failingFs = Object.assign(Object.create(fs), fs, {
      open: async () => { throw new Error("injected journal failure"); },
    }) as typeof fs;
    const coordinator = new WorkspaceOnboardingCoordinator({
      journalPath: f.journalPath,
      registry: f.registry,
      credentials: f.credentials,
      sessions: f.sessions,
      reservations: f.reservations,
      git: f.git,
      fs: failingFs,
    });
    await expect(coordinator.configureExisting({ path: folder, displayName: "Repo" })).rejects.toThrow();
    expect(f.registry.byPath(folder)).toBeUndefined();
    expect(f.credentials.snapshot().assignments).toEqual([]);
  });

  test("a registry persistence failure clears the journal and leaves no assignments", async () => {
    const f = await fixture();
    const folder = await gitRepository(f.folders, "repo");
    const failingRegistry = {
      byId: (id: string) => f.registry.byId(id),
      byPath: (p: string) => f.registry.byPath(p),
      registerWithStatus: async () => { throw new Error("injected registry failure"); },
      remove: (id: string) => f.registry.remove(id),
      restoreEntries: (entries: never) => f.registry.restoreEntries(entries),
    };
    const coordinator = new WorkspaceOnboardingCoordinator({
      journalPath: f.journalPath,
      registry: failingRegistry as never,
      credentials: f.credentials,
      sessions: f.sessions,
      reservations: f.reservations,
      git: f.git,
    });
    await expect(coordinator.configureExisting({ path: folder, displayName: "Repo" })).rejects.toThrow();
    expect(f.credentials.snapshot().assignments).toEqual([]);
    expect(await journalExists(f.journalPath)).toBe(false);
  });

  test("an assignment commit failure rolls the registration back", async () => {
    const f = await fixture();
    await addSshCredential(f.credentials, "auth-key");
    const folder = await gitRepository(f.folders, "repo");
    const failingCredentials = {
      snapshot: () => f.credentials.snapshot(),
      transaction: async () => { throw new Error("injected assignment failure"); },
    };
    const coordinator = new WorkspaceOnboardingCoordinator({
      journalPath: f.journalPath,
      registry: f.registry,
      credentials: failingCredentials as never,
      sessions: f.sessions,
      reservations: f.reservations,
      git: f.git,
    });
    await expect(coordinator.configureExisting({
      path: folder,
      displayName: "Repo",
      authentication: [{ credentialId: "auth-key", host: "github.com" }],
    })).rejects.toMatchObject({ code: "credential" });
    expect(f.registry.byPath(folder)).toBeUndefined();
    expect(await journalExists(f.journalPath)).toBe(false);
  });

  test("a failed rollback retains the journal and recovery restores previous state", async () => {
    const f = await fixture();
    await addSshCredential(f.credentials, "auth-key");
    const folder = await gitRepository(f.folders, "repo");
    let failRemove = true;
    const brokenRegistry = {
      byId: (id: string) => f.registry.byId(id),
      byPath: (p: string) => f.registry.byPath(p),
      list: () => f.registry.list(),
      registerWithStatus: (p: string, backend: "local", name?: string) => f.registry.registerWithStatus(p, backend, name),
      remove: async (id: string) => {
        if (failRemove) throw new Error("injected rollback failure");
        return f.registry.remove(id);
      },
      replacePathPrefix: (source: string, destination: string) => f.registry.replacePathPrefix(source, destination),
      restoreEntries: (entries: never) => f.registry.restoreEntries(entries),
    };
    let failTransaction = true;
    const flakyCredentials = {
      snapshot: () => f.credentials.snapshot(),
      transaction: async (mutate: never) => {
        if (failTransaction) throw new Error("injected assignment failure");
        return f.credentials.transaction(mutate);
      },
    };
    const coordinator = new WorkspaceOnboardingCoordinator({
      journalPath: f.journalPath,
      registry: brokenRegistry as never,
      credentials: flakyCredentials as never,
      sessions: f.sessions,
      reservations: f.reservations,
      git: f.git,
    });
    await expect(coordinator.configureExisting({
      path: folder,
      displayName: "Repo",
      authentication: [{ credentialId: "auth-key", host: "github.com" }],
    })).rejects.toMatchObject({ code: "recovery-required" });
    // The half-committed registration and the journal both survive the crash.
    expect(f.registry.byPath(folder)).toBeDefined();
    expect(await journalExists(f.journalPath)).toBe(true);

    // Startup recovery restores the recorded previous state: the entry does
    // not match the desired displayName? It does — so recovery completes the
    // desired metadata instead, applying the journaled assignments.
    failRemove = false;
    failTransaction = false;
    await coordinator.recover();
    expect(await journalExists(f.journalPath)).toBe(false);
    expect(f.registry.byPath(folder)?.displayName).toBe("Repo");
    expect(f.credentials.snapshot().assignments).toEqual([
      { workspaceId: "repo", credentialId: "auth-key", role: "authentication", host: "github.com" },
    ]);
  });

  test("recovery restores previous state when the registration never committed", async () => {
    const f = await fixture();
    await addSshCredential(f.credentials, "auth-key");
    // Simulate a crash after the journal write but before the registry
    // commit: journal on disk, no registry entry, stray assignment.
    await f.credentials.transaction(state => state.assignments.push({
      workspaceId: "ghost", credentialId: "auth-key", role: "signing",
    }));
    const journal = {
      version: 1,
      operation: "configure-existing",
      createdFolder: false,
      entry: { id: "ghost", path: path.join(f.folders, "ghost"), backend: "local", displayName: "Ghost" },
      previousEntry: null,
      previousAssignments: [],
      desiredAssignments: [
        { workspaceId: "ghost", credentialId: "auth-key", role: "signing" },
      ],
    };
    await fs.writeFile(f.journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    await fs.chmod(f.journalPath, 0o600);

    await f.coordinator.recover();
    expect(f.registry.byId("ghost")).toBeUndefined();
    expect(f.credentials.snapshot().assignments).toEqual([]);
    expect(await journalExists(f.journalPath)).toBe(false);
  });

  test("recovery completes desired assignments when the registration committed", async () => {
    const f = await fixture();
    await addSshCredential(f.credentials, "auth-key");
    const folder = await gitRepository(f.folders, "committed");
    await f.registry.register(folder, "local", "Committed");
    const journal = {
      version: 1,
      operation: "configure-existing",
      createdFolder: false,
      entry: { id: "committed", path: folder, backend: "local", displayName: "Committed" },
      previousEntry: null,
      previousAssignments: [],
      desiredAssignments: [
        { workspaceId: "committed", credentialId: "auth-key", role: "authentication" as const, host: "github.com" },
      ],
    };
    await fs.writeFile(f.journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    await fs.chmod(f.journalPath, 0o600);

    await f.coordinator.recover();
    expect(f.registry.byId("committed")?.displayName).toBe("Committed");
    expect(f.credentials.snapshot().assignments).toEqual(journal.desiredAssignments);
    expect(await journalExists(f.journalPath)).toBe(false);
  });

  test("a credential disabled after resolution fails the commit inside the transaction", async () => {
    // The selection passes pre-validation, then a concurrent operator
    // disables it before the assignment transaction (interposed here on
    // git init, which runs between the two). The store itself would accept
    // the stale assignment — the id still exists — so the transaction's
    // own revalidation must fail the commit and roll the registration back.
    const f = await fixture({
      probeNotRepository: true,
      onInit: async () => {
        await f.credentials.transaction(draft => {
          const record = draft.credentials.find(credential => credential.id === "auth-key");
          if (record) record.enabled = false;
        });
      },
    });
    await addSshCredential(f.credentials, "auth-key");
    const folder = path.join(f.folders, "plain");
    await fs.mkdir(folder);
    await expect(f.coordinator.configureExisting({
      path: folder,
      displayName: "Plain",
      authentication: [{ credentialId: "auth-key", host: "github.com" }],
      init: true,
    })).rejects.toMatchObject({ code: "credential" });
    expect(f.registry.byPath(folder)).toBeUndefined();
    expect(f.credentials.snapshot().assignments).toEqual([]);
    expect(await journalExists(f.journalPath)).toBe(false);
  });

  test("recovery recognizes a committed entry renamed before the crash", async () => {
    // The registry save makes the entry visible (and renamable) before the
    // journal clears; recognition must rest on immutable id + path so a
    // user rename in that window cannot get the registration rolled back.
    const f = await fixture();
    await addSshCredential(f.credentials, "auth-key");
    const folder = await gitRepository(f.folders, "committed");
    await f.registry.register(folder, "local", "Renamed After Commit");
    const journal = {
      version: 1,
      operation: "configure-existing",
      createdFolder: false,
      entry: { id: "committed", path: folder, backend: "local", displayName: "Committed" },
      previousEntry: null,
      previousAssignments: [],
      desiredAssignments: [
        { workspaceId: "committed", credentialId: "auth-key", role: "authentication" as const, host: "github.com" },
      ],
    };
    await fs.writeFile(f.journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    await fs.chmod(f.journalPath, 0o600);

    await f.coordinator.recover();
    // The newer name survives; only the assignments are completed.
    expect(f.registry.byId("committed")?.displayName).toBe("Renamed After Commit");
    expect(f.credentials.snapshot().assignments).toEqual(journal.desiredAssignments);
    expect(await journalExists(f.journalPath)).toBe(false);
  });

  test("a pending onboarding journal refuses new onboarding operations", async () => {
    // The single-record journal is the only recovery record of an
    // onboarding that failed midway; another commit would replace and
    // then clear it, stranding the earlier partial registration.
    const f = await fixture();
    const stranded = {
      version: 1,
      operation: "configure-existing",
      createdFolder: false,
      entry: { id: "stranded", path: path.join(f.folders, "stranded"), backend: "local", displayName: "Stranded" },
      previousEntry: null,
      previousAssignments: [],
      desiredAssignments: [],
    };
    await fs.writeFile(f.journalPath, `${JSON.stringify(stranded)}\n`, { mode: 0o600 });
    await fs.chmod(f.journalPath, 0o600);
    const folder = await gitRepository(f.folders, "repo");

    await expect(f.coordinator.configureExisting({ path: folder, displayName: "Repo" }))
      .rejects.toMatchObject({ code: "recovery-required" });
    await expect(f.coordinator.createWorkspace({ parent: f.folders, folderName: "fresh", displayName: "Fresh" }))
      .rejects.toMatchObject({ code: "recovery-required" });
    expect(JSON.parse(await fs.readFile(f.journalPath, "utf8"))).toMatchObject({ entry: { id: "stranded" } });
    expect(f.registry.byPath(folder)).toBeUndefined();
    // The refusal lands before any filesystem mutation.
    expect(await fs.lstat(path.join(f.folders, "fresh")).then(() => true, () => false)).toBe(false);

    await f.coordinator.recover();
    expect(await journalExists(f.journalPath)).toBe(false);
    const result = await f.coordinator.configureExisting({ path: folder, displayName: "Repo" });
    expect(result.created).toBe(true);
  });

  test("recovery does not resurrect assignments revoked after the commit", async () => {
    // The journal's clear failed after both stores committed and the hub
    // kept serving: a credential deletion then legitimately revoked the
    // committed assignment. On restart the desired set no longer resolves,
    // so recovery must keep the newer (empty) assignment state instead of
    // replaying the journal — while still clearing it.
    const f = await fixture();
    await addSshCredential(f.credentials, "auth-key");
    const folder = await gitRepository(f.folders, "committed");
    await f.registry.register(folder, "local", "Committed");
    const journal = {
      version: 1,
      operation: "configure-existing",
      createdFolder: false,
      entry: { id: "committed", path: folder, backend: "local", displayName: "Committed" },
      previousEntry: null,
      previousAssignments: [],
      desiredAssignments: [
        { workspaceId: "committed", credentialId: "auth-key", role: "signing" as const },
      ],
    };
    await fs.writeFile(f.journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    await fs.chmod(f.journalPath, 0o600);
    await f.credentials.transaction(draft => {
      draft.credentials = draft.credentials.filter(credential => credential.id !== "auth-key");
      draft.assignments = draft.assignments.filter(assignment => assignment.credentialId !== "auth-key");
    });

    await f.coordinator.recover();
    expect(f.registry.byId("committed")?.displayName).toBe("Committed");
    expect(f.credentials.snapshot().assignments).toEqual([]);
    expect(await journalExists(f.journalPath)).toBe(false);
  });

  test("recovery preserves assignment choices made after the commit", async () => {
    // Both stores committed but the clear failed and the hub kept serving:
    // the user then replaced the committed assignment with a different,
    // still-valid credential. The current set no longer matches the
    // journaled pre-commit state, so recovery must keep the newer choice
    // instead of replaying the journal — while still clearing it.
    const f = await fixture();
    await addSshCredential(f.credentials, "original-key");
    await addSshCredential(f.credentials, "replacement-key");
    const folder = await gitRepository(f.folders, "committed");
    await f.registry.register(folder, "local", "Committed");
    const journal = {
      version: 1,
      operation: "configure-existing",
      createdFolder: false,
      entry: { id: "committed", path: folder, backend: "local", displayName: "Committed" },
      previousEntry: null,
      previousAssignments: [],
      desiredAssignments: [
        { workspaceId: "committed", credentialId: "original-key", role: "signing" as const },
      ],
    };
    await fs.writeFile(f.journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    await fs.chmod(f.journalPath, 0o600);
    const replacement = [{ workspaceId: "committed", credentialId: "replacement-key", role: "signing" as const }];
    await f.credentials.transaction(draft => {
      draft.assignments = structuredClone(replacement);
    });

    await f.coordinator.recover();
    expect(f.credentials.snapshot().assignments).toEqual(replacement);
    expect(await journalExists(f.journalPath)).toBe(false);
  });

  test("recovery rejects a journal that is not owner-only", async () => {
    const f = await fixture();
    await fs.writeFile(f.journalPath, `${JSON.stringify({ version: 1 })}\n`, { mode: 0o644 });
    await fs.chmod(f.journalPath, 0o644);
    await expect(f.coordinator.recover()).rejects.toThrow("journal is invalid");
  });
});

describe("start intent", () => {
  test("an explicitly requested start runs after commit and reports success", async () => {
    const f = await fixture();
    const folder = await gitRepository(f.folders, "runner");
    const result = await f.coordinator.configureExisting({ path: folder, displayName: "Runner", start: true });
    expect(result.started).toBe(true);
    expect(f.started).toEqual(["runner"]);
  });

  test("a failed requested start preserves the configured stopped workspace", async () => {
    const f = await fixture();
    await addSshCredential(f.credentials, "auth-key");
    f.failNextStart(new Error("assigned SSH credential is locked"));
    const folder = await gitRepository(f.folders, "locked");

    const result = await f.coordinator.configureExisting({
      path: folder,
      displayName: "Locked",
      authentication: [{ credentialId: "auth-key", host: "github.com" }],
      start: true,
    });

    expect(result.started).toBe(false);
    expect(result.startError).toContain("locked");
    expect(f.registry.byId("locked")?.displayName).toBe("Locked");
    expect(f.credentials.snapshot().assignments).toHaveLength(1);
    expect(await journalExists(f.journalPath)).toBe(false);
  });
});

describe("concurrency", () => {
  test("concurrent creates of colliding basenames mint distinct suffixed ids", async () => {
    const f = await fixture();
    const parentA = path.join(f.folders, "a");
    const parentB = path.join(f.folders, "b");
    await Promise.all([fs.mkdir(parentA), fs.mkdir(parentB)]);

    const [first, second] = await Promise.all([
      f.coordinator.createWorkspace({ parent: parentA, folderName: "docs", displayName: "Docs A" }),
      f.coordinator.createWorkspace({ parent: parentB, folderName: "docs", displayName: "Docs B" }),
    ]);
    expect([first.entry.id, second.entry.id].sort()).toEqual(["docs", "docs-2"]);
  });

  test("concurrent creates of the same destination let exactly one win", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      f.coordinator.createWorkspace({ parent: f.folders, folderName: "solo", displayName: "One" }),
      f.coordinator.createWorkspace({ parent: f.folders, folderName: "solo", displayName: "Two" }),
    ]);
    const fulfilled = results.filter(result => result.status === "fulfilled");
    const rejected = results.filter(result => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "conflict" });
  });

  test("a start racing the commit only runs after the assignments committed", async () => {
    const f = await fixture();
    await addSshCredential(f.credentials, "auth-key");
    const folder = await gitRepository(f.folders, "raced");

    // Delay the assignment commit so a start issued after the registry save
    // (when the id is already visible) has a real window to race into.
    let releaseTransaction!: () => void;
    const gate = new Promise<void>(resolve => { releaseTransaction = resolve; });
    const gatedCredentials = {
      snapshot: () => f.credentials.snapshot(),
      transaction: async (mutate: never) => {
        await gate;
        return f.credentials.transaction(mutate);
      },
    };
    const assignmentsSeenByStart: number[] = [];
    const sessions = {
      start: (id: string) => f.sessions.runExclusive(id, async () => {
        assignmentsSeenByStart.push(
          f.credentials.snapshot().assignments.filter(a => a.workspaceId === id).length,
        );
        return {} as never;
      }),
      runExclusive: f.sessions.runExclusive,
    };
    const coordinator = new WorkspaceOnboardingCoordinator({
      journalPath: f.journalPath,
      registry: f.registry,
      credentials: gatedCredentials as never,
      sessions,
      reservations: f.reservations,
      git: f.git,
    });

    const committing = coordinator.configureExisting({
      path: folder,
      displayName: "Raced",
      authentication: [{ credentialId: "auth-key", host: "github.com" }],
    });
    // Wait until the registration is visible mid-commit, then start it.
    while (!f.registry.byId("raced")) await new Promise(resolve => setTimeout(resolve, 1));
    const racingStart = sessions.start("raced");
    releaseTransaction();
    await Promise.all([committing, racingStart]);

    // The queued start observed the committed assignment set, never the
    // registered-but-unconfigured intermediate state.
    expect(assignmentsSeenByStart).toEqual([1]);
  });

  test("configureCloned commits while the clone job still holds the target reservation", async () => {
    const f = await fixture();
    await addSshCredential(f.credentials, "auth-key");
    const target = await gitRepository(f.folders, "cloned");
    const held = f.reservations.acquire([target])!;
    try {
      const result = await f.coordinator.configureCloned({
        path: target,
        displayName: "Cloned",
        authentication: [{ credentialId: "auth-key", host: "github.com" }],
        signing: null,
      });
      expect(result.entry.id).toBe("cloned");
      expect(f.credentials.snapshot().assignments).toHaveLength(1);
    } finally {
      held.release();
    }
  });
});
