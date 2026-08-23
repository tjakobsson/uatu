import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RunningSession, SessionBackend } from "./backend";
import { EMPTY_CREDENTIAL_CONTEXT_RESOLVER } from "./credential-context";
import { CredentialMetadataStore } from "./credential-store";
import { FolderManager, FolderManagerError, type PendingFolderMutation } from "./folder-manager";
import { PathReservationCoordinator } from "./path-reservations";
import { PersonalWorkspaceStateStore } from "./personal-state";
import { WorkspaceRegistry, type WorkspaceEntry } from "./registry";
import { SessionManager } from "./sessions";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(options: { fs?: typeof fs; reservations?: PathReservationCoordinator; renameNoReplace?: (from: string, to: string) => number } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "uatu-folders-")));
  tempDirectories.push(root);
  const state = path.join(root, "state");
  const folders = path.join(root, "folders");
  await Promise.all([fs.mkdir(state), fs.mkdir(folders)]);
  const registry = new WorkspaceRegistry(path.join(state, "registry.json"));
  const personalState = new PersonalWorkspaceStateStore(path.join(state, "personal.json"));
  const credentials = new CredentialMetadataStore(path.join(state, "credentials.json"));
  await Promise.all([registry.load(), personalState.load(), credentials.load()]);
  const stopped: string[] = [];
  const backend: SessionBackend = {
    start: async workspace => ({
      workspaceId: workspace.id,
      basePath: `/s/${workspace.id}/`,
      endpoint: { hostname: "127.0.0.1", port: 1 },
      token: null,
      exited: new Promise<number | null>(() => undefined),
      stop: async () => { stopped.push(workspace.id); },
    }),
  };
  const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
  const reservations = options.reservations ?? new PathReservationCoordinator();
  const journalPath = path.join(state, "pending-folder-mutation.json");
  const manager = new FolderManager({
    journalPath,
    registry,
    sessions,
    personalState,
    credentials,
    reservations,
    fs: options.fs,
    ...(options.renameNoReplace === undefined ? {} : { renameNoReplace: options.renameNoReplace }),
  });
  return { root, state, folders, registry, personalState, credentials, sessions, reservations, journalPath, manager, stopped };
}

function completed<T>(result: { status: "completed"; value: T } | { status: "needs-stop" }): T {
  expect(result.status).toBe("completed");
  if (result.status !== "completed") throw new Error("expected completed result");
  return result.value;
}

async function exists(candidate: string): Promise<boolean> {
  return fs.lstat(candidate).then(() => true, () => false);
}

async function writeJournal(filePath: string, journal: PendingFolderMutation, mode = 0o600): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(journal)}\n`, { mode });
  await fs.chmod(filePath, mode);
}

function renameJournal(
  source: string,
  destination: string,
  entries: WorkspaceEntry[],
  identities?: { source: { dev: string; ino: string }; claim: { dev: string; ino: string } },
): PendingFolderMutation {
  return {
    version: 1,
    operation: "rename",
    source,
    destination,
    before: entries,
    after: entries.map(entry => ({ ...entry, path: path.join(destination, path.relative(source, entry.path)) })),
    ...(identities === undefined ? {} : { identities }),
  };
}

async function identityOf(candidate: string): Promise<{ dev: string; ino: string }> {
  const stats = await fs.lstat(candidate);
  return { dev: String(stats.dev), ino: String(stats.ino) };
}

describe("FolderManager validation and unregistered operations", () => {
  test("accepts only closed absolute-path requests and visible single-segment names", async () => {
    const f = await fixture();
    const invalid: Array<() => Promise<unknown>> = [
      () => f.manager.create({ parent: "relative", name: "child" }),
      () => f.manager.create({ parent: f.folders, name: "" }),
      () => f.manager.create({ parent: f.folders, name: "   " }),
      () => f.manager.create({ parent: f.folders, name: ".hidden" }),
      () => f.manager.create({ parent: f.folders, name: "a/b" }),
      () => f.manager.create({ parent: f.folders, name: "a\\b" }),
      () => f.manager.create({ parent: f.folders, name: "child", extra: true }),
      () => f.manager.rename({ path: f.folders, name: "next", stop: "yes" }),
      () => f.manager.remove({ path: f.folders, extra: true }),
    ];
    for (const operation of invalid) {
      await expect(operation()).rejects.toMatchObject({ code: "invalid-input" });
    }
  });

  test("creates, sibling-renames, and non-recursively removes an empty folder", async () => {
    const f = await fixture();
    const created = await f.manager.create({ parent: `${f.folders}/.`, name: "one" });
    expect(created).toEqual({ path: path.join(f.folders, "one") });
    await fs.writeFile(path.join(created.path, "content.txt"), "kept");

    const renamed = completed(await f.manager.rename({ path: created.path, name: "two" }));
    expect(renamed).toEqual({ path: path.join(f.folders, "two"), workspaceIds: [] });
    expect(await fs.readFile(path.join(renamed.path, "content.txt"), "utf8")).toBe("kept");
    await fs.unlink(path.join(renamed.path, "content.txt"));
    expect(completed(await f.manager.remove({ path: renamed.path }))).toEqual({ path: renamed.path });
    expect(await exists(renamed.path)).toBe(false);
  });

  test("rejects symlink sources, colliding destinations, and hidden non-empty removal", async () => {
    const f = await fixture();
    const source = path.join(f.folders, "source");
    const destination = path.join(f.folders, "destination");
    const link = path.join(f.folders, "link");
    await Promise.all([fs.mkdir(source), fs.mkdir(destination)]);
    await fs.symlink(source, link);
    await expect(f.manager.rename({ path: link, name: "renamed" })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(f.manager.rename({ path: source, name: "destination" })).rejects.toMatchObject({ code: "conflict" });
    await fs.writeFile(path.join(source, ".hidden"), "content");
    await expect(f.manager.remove({ path: source })).rejects.toMatchObject({ code: "not-empty" });
    expect(await exists(path.join(source, ".hidden"))).toBe(true);
  });

  test("canonicalizes symlinked ancestors before reservations and registry lookup", async () => {
    const f = await fixture();
    const source = path.join(f.folders, "source");
    const alias = path.join(f.root, "folder-alias");
    await fs.mkdir(source);
    await fs.symlink(f.folders, alias);
    const entry = await f.registry.register(source);
    const clone = f.reservations.acquire([path.join(source, "clone")])!;

    await expect(f.manager.rename({ path: path.join(alias, "source"), name: "renamed" })).rejects.toMatchObject({ code: "conflict" });
    clone.release();

    const result = completed(await f.manager.rename({ path: path.join(alias, "source"), name: "renamed" }));
    const destination = path.join(f.folders, "renamed");
    expect(result).toEqual({ path: destination, workspaceIds: [entry.id] });
    expect(f.registry.byId(entry.id)?.path).toBe(destination);
  });

  test("does not replace a destination created after the preflight check", async () => {
    const destinationName = "destination";
    let raceEnabled = false;
    const injected = Object.assign({}, fs, {
      mkdir: async (candidate: string, options?: Parameters<typeof fs.mkdir>[1]) => {
        if (raceEnabled && path.basename(candidate) === destinationName) {
          raceEnabled = false;
          await fs.mkdir(candidate);
          await fs.writeFile(path.join(candidate, "competitor.txt"), "kept");
        }
        return fs.mkdir(candidate, options);
      },
    }) as typeof fs;
    const f = await fixture({ fs: injected });
    const source = path.join(f.folders, "source");
    const destination = path.join(f.folders, destinationName);
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "source.txt"), "source");
    raceEnabled = true;

    await expect(f.manager.rename({ path: source, name: destinationName })).rejects.toMatchObject({ code: "conflict" });
    expect(await fs.readFile(path.join(source, "source.txt"), "utf8")).toBe("source");
    expect(await fs.readFile(path.join(destination, "competitor.txt"), "utf8")).toBe("kept");
  });

  test("maps filesystem permission failures without exposing host error details", async () => {
    const injected = Object.assign({}, fs, {
      mkdir: async () => { throw Object.assign(new Error("secret host detail"), { code: "EACCES" }); },
    }) as typeof fs;
    const f = await fixture({ fs: injected });
    const rejection = f.manager.create({ parent: f.folders, name: "denied" }).catch(error => error);
    const error = await rejection as FolderManagerError;
    expect(error).toMatchObject({ code: "permission-denied", message: "filesystem permission denied" });
    expect(error.message).not.toContain("secret");
  });

  test("conflicts with clone hierarchy reservations and releases after failure", async () => {
    const reservations = new PathReservationCoordinator();
    const f = await fixture({ reservations });
    const cloneTarget = path.join(f.folders, "group", "clone");
    const clone = reservations.acquire([cloneTarget])!;
    await expect(f.manager.create({ parent: f.folders, name: "group" })).rejects.toMatchObject({ code: "conflict" });
    clone.release();
    expect(await f.manager.create({ parent: f.folders, name: "group" })).toEqual({ path: path.join(f.folders, "group") });
  });

  test("coordinates rename sources, rename destinations, and removals with clone hierarchies", async () => {
    const reservations = new PathReservationCoordinator();
    const f = await fixture({ reservations });
    const source = path.join(f.folders, "source");
    await fs.mkdir(source);
    const sourceClone = reservations.acquire([path.join(source, "clone")])!;
    await expect(f.manager.rename({ path: source, name: "destination" })).rejects.toMatchObject({ code: "conflict" });
    await expect(f.manager.remove({ path: source })).rejects.toMatchObject({ code: "conflict" });
    sourceClone.release();

    const destinationClone = reservations.acquire([path.join(f.folders, "destination", "clone")])!;
    await expect(f.manager.rename({ path: source, name: "destination" })).rejects.toMatchObject({ code: "conflict" });
    destinationClone.release();
    completed(await f.manager.rename({ path: source, name: "destination" }));
  });

  test("globally serializes disjoint operations despite a single-record journal", async () => {
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const entered = new Promise<void>(resolve => { firstEntered = resolve; });
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const calls: string[] = [];
    const injected = Object.assign({}, fs, {
      mkdir: async (candidate: string) => {
        calls.push(path.basename(candidate));
        if (path.basename(candidate) === "first") {
          firstEntered();
          await gate;
        }
        await fs.mkdir(candidate);
      },
    }) as typeof fs;
    const f = await fixture({ fs: injected });
    const first = f.manager.create({ parent: f.folders, name: "first" });
    await entered;
    const second = f.manager.create({ parent: f.folders, name: "second" });
    await Bun.sleep(10);
    expect(calls).toEqual(["first"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(calls).toEqual(["first", "second"]);
  });
});

describe("FolderManager registered mutations", () => {
  test("renames registered descendants while preserving identity and metadata", async () => {
    const f = await fixture();
    const source = path.join(f.folders, "group");
    const child = path.join(source, "nested", "repo");
    await fs.mkdir(child, { recursive: true });
    const parentEntry = await f.registry.register(source);
    const childEntry = await f.registry.register(child);
    await f.personalState.patch("alice", parentEntry.id, { documentPath: "README.md" });
    await f.credentials.transaction(state => state.credentials.push({
      id: "key", name: "Key", type: "ssh", enabled: true,
      capabilities: ["ssh-signing"], metadata: { publicKey: "ssh-ed25519 AAAA", fingerprint: "SHA256:test" },
      createdAt: "2026-08-23T00:00:00.000Z",
    }));
    await f.credentials.assign({ workspaceId: parentEntry.id, credentialId: "key", role: "signing" });
    const assignments = f.credentials.snapshot().assignments;

    const destination = path.join(f.folders, "team");
    const result = completed(await f.manager.rename({ path: source, name: "team" }));
    expect(result).toEqual({ path: destination, workspaceIds: [parentEntry.id, childEntry.id] });
    expect(f.registry.byId(parentEntry.id)).toEqual({ ...parentEntry, path: destination });
    expect(f.registry.byId(childEntry.id)).toEqual({ ...childEntry, path: path.join(destination, "nested", "repo") });
    expect(f.personalState.get("alice", parentEntry.id).documentPath).toBe("README.md");
    expect(f.credentials.snapshot().assignments).toEqual(assignments);
    expect(await exists(f.journalPath)).toBe(false);
  });

  test("reports all running workspaces, then stops them before authorized rename", async () => {
    const f = await fixture();
    const source = path.join(f.folders, "group");
    const child = path.join(source, "child");
    await fs.mkdir(child, { recursive: true });
    const entries = await Promise.all([f.registry.register(source), f.registry.register(child)]);
    await Promise.all(entries.map(entry => f.sessions.start(entry.id)));

    const conflict = await f.manager.rename({ path: source, name: "team" });
    expect(conflict).toEqual({ status: "needs-stop", workspaceIds: entries.map(entry => entry.id).sort() });
    expect(await exists(source)).toBe(true);
    completed(await f.manager.rename({ path: source, name: "team", stop: true }));
    expect(f.stopped.sort()).toEqual(entries.map(entry => entry.id).sort());
    expect(await exists(path.join(f.folders, "team"))).toBe(true);
  });

  test("rolls the filesystem back when registry persistence fails", async () => {
    const f = await fixture();
    const source = path.join(f.folders, "source");
    await fs.mkdir(source);
    const entry = await f.registry.register(source);
    const failingRegistry = Object.assign(Object.create(f.registry), f.registry, {
      replacePathPrefix: async () => { throw new Error("injected registry persistence failure"); },
    });
    const manager = new FolderManager({
      journalPath: f.journalPath,
      registry: failingRegistry,
      sessions: f.sessions,
      personalState: f.personalState,
      credentials: f.credentials,
      reservations: f.reservations,
    });
    await expect(manager.rename({ path: source, name: "destination" })).rejects.toMatchObject({ code: "internal" });
    expect(await exists(source)).toBe(true);
    expect(await exists(path.join(f.folders, "destination"))).toBe(false);
    expect(f.registry.byId(entry.id)?.path).toBe(source);
    expect(await exists(f.journalPath)).toBe(false);
  });

  test("writes the pending registered mutation journal owner-only before filesystem rename", async () => {
    const f = await fixture();
    const source = path.join(f.folders, "source");
    await fs.mkdir(source);
    await f.registry.register(source);
    let releaseRename!: () => void;
    let renameEntered!: () => void;
    const entered = new Promise<void>(resolve => { renameEntered = resolve; });
    const gate = new Promise<void>(resolve => { releaseRename = resolve; });
    const injected = Object.assign({}, fs, {
      rename: async (from: string, to: string) => {
        if (from === source) {
          renameEntered();
          await gate;
        }
        await fs.rename(from, to);
      },
    }) as typeof fs;
    const manager = new FolderManager({
      journalPath: f.journalPath,
      registry: f.registry,
      sessions: f.sessions,
      personalState: f.personalState,
      credentials: f.credentials,
      reservations: f.reservations,
      fs: injected,
    });
    const operation = manager.rename({ path: source, name: "destination" });
    await entered;
    const stats = await fs.lstat(f.journalPath);
    expect(stats.mode & 0o777).toBe(0o600);
    expect((JSON.parse(await fs.readFile(f.journalPath, "utf8")) as { version: number }).version).toBe(1);
    releaseRename();
    completed(await operation);
  });

  test("preserves an unresolved mutation journal by refusing all later mutations", async () => {
    const f = await fixture();
    const doomed = path.join(f.folders, "doomed");
    const other = path.join(f.folders, "other");
    await Promise.all([fs.mkdir(doomed), fs.mkdir(other)]);
    const doomedEntry = await f.registry.register(doomed);
    const otherEntry = await f.registry.register(other);
    const failingPersonalState = Object.assign(Object.create(f.personalState), f.personalState, {
      forgetWorkspace: async () => { throw new Error("injected personal-state failure"); },
    });
    const failing = new FolderManager({
      journalPath: f.journalPath,
      registry: f.registry,
      sessions: f.sessions,
      personalState: failingPersonalState,
      credentials: f.credentials,
      reservations: f.reservations,
    });
    // The removal deletes the directory, then fails past the point of no
    // return — the journal is the only remaining record of "doomed".
    await expect(failing.remove({ path: doomed })).rejects.toMatchObject({ code: "internal" });
    expect(await exists(doomed)).toBe(false);
    expect(await exists(f.journalPath)).toBe(true);

    // Every later mutation must refuse rather than disturb that record —
    // a registered one would replace the single-record journal, and even
    // an unregistered create could recreate the removed source and make
    // recovery restore the old registration onto an unrelated directory.
    await expect(f.manager.rename({ path: other, name: "renamed" })).rejects.toMatchObject({ code: "conflict" });
    await expect(f.manager.remove({ path: other })).rejects.toMatchObject({ code: "conflict" });
    await expect(f.manager.create({ parent: f.folders, name: "doomed" })).rejects.toMatchObject({ code: "conflict" });
    const journal = JSON.parse(await fs.readFile(f.journalPath, "utf8")) as { operation: string; source: string };
    expect(journal).toMatchObject({ operation: "remove", source: doomed });

    await f.manager.recover();
    expect(f.registry.byId(doomedEntry.id)).toBeUndefined();
    expect(await exists(f.journalPath)).toBe(false);
    await f.manager.create({ parent: f.folders, name: "fresh" });
    completed(await f.manager.rename({ path: other, name: "renamed" }));
    expect(f.registry.byId(otherEntry.id)?.path).toBe(path.join(f.folders, "renamed"));
  });

  test("reconciles persisted alias paths before canonical rename lookup", async () => {
    const f = await fixture();
    const project = path.join(f.folders, "project");
    await fs.mkdir(project);
    const alias = path.join(f.root, "legacy-alias");
    await fs.symlink(f.folders, alias);
    // A pre-canonicalization registry entry: persisted through the
    // symlinked ancestor, invisible to canonical byPath/atOrBelow.
    const entry = await f.registry.register(path.join(alias, "project"));
    expect(f.registry.atOrBelow(project)).toEqual([]);
    await f.sessions.start(entry.id);

    // The running session must be seen — a missed lookup would move the
    // folder out from under it without stopping anything.
    const conflict = await f.manager.rename({ path: project, name: "renamed" });
    expect(conflict).toEqual({ status: "needs-stop", workspaceIds: [entry.id] });

    const destination = path.join(f.folders, "renamed");
    const result = completed(await f.manager.rename({ path: project, name: "renamed", stop: true }));
    expect(result).toEqual({ path: destination, workspaceIds: [entry.id] });
    expect(f.stopped).toEqual([entry.id]);
    expect(f.registry.byId(entry.id)?.path).toBe(destination);
  });

  test("a removal raced by a concurrent forget degrades to an unregistered removal", async () => {
    const f = await fixture();
    const source = path.join(f.folders, "raced");
    await fs.mkdir(source);
    const entry = await f.registry.register(source);
    // The forget wins the lifecycle queue: by the time the removal's
    // exclusive section runs, the registration is gone. A stale-entry
    // removal would journal an entry it can no longer remove and strand
    // every later mutation behind that journal.
    const racedSessions = {
      runWithSessionsStopped: async <T,>(ids: string[], stop: boolean, operation: () => Promise<T>) => {
        await f.registry.remove(entry.id);
        return f.sessions.runWithSessionsStopped(ids, stop, operation);
      },
    };
    const manager = new FolderManager({
      journalPath: f.journalPath,
      registry: f.registry,
      sessions: racedSessions as never,
      personalState: f.personalState,
      credentials: f.credentials,
      reservations: f.reservations,
    });

    expect(completed(await manager.remove({ path: source }))).toEqual({ path: source });
    expect(await exists(source)).toBe(false);
    expect(await exists(f.journalPath)).toBe(false);
    await manager.create({ parent: f.folders, name: "not-blocked" });
  });

  test("fails closed when alias reconciliation cannot inspect a registered path", async () => {
    const f = await fixture();
    const project = path.join(f.folders, "project");
    await fs.mkdir(project);
    const alias = path.join(f.root, "legacy-alias");
    await fs.symlink(f.folders, alias);
    const aliasProject = path.join(alias, "project");
    const entry = await f.registry.register(aliasProject);
    const injected = Object.assign({}, fs, {
      realpath: (async (candidate: string) => {
        if (candidate === aliasProject) {
          throw Object.assign(new Error("injected inaccessible alias"), { code: "EACCES" });
        }
        return fs.realpath(candidate);
      }) as typeof fs.realpath,
    }) as typeof fs;
    const manager = new FolderManager({
      journalPath: f.journalPath,
      registry: f.registry,
      sessions: f.sessions,
      personalState: f.personalState,
      credentials: f.credentials,
      reservations: f.reservations,
      fs: injected,
    });

    // Skipping the unreadable alias would move the folder without seeing
    // its registration; the mutation must refuse instead.
    await expect(manager.rename({ path: project, name: "renamed" })).rejects.toMatchObject({ code: "permission-denied" });
    expect(await exists(project)).toBe(true);
    expect(f.registry.byId(entry.id)?.path).toBe(aliasProject);
  });

  test("rejects rename and create destinations claimed by a stale registration", async () => {
    const f = await fixture();
    const source = path.join(f.folders, "source");
    await fs.mkdir(source);
    // The workspace's folder is gone but its registration is deliberately
    // retained; its path must not be claimable by unrelated content —
    // neither by moving a folder onto it nor by creating an empty one.
    const stale = await f.registry.register(path.join(f.folders, "vanished"));

    await expect(f.manager.rename({ path: source, name: "vanished" })).rejects.toMatchObject({ code: "conflict" });
    await expect(f.manager.create({ parent: f.folders, name: "vanished" })).rejects.toMatchObject({ code: "conflict" });
    expect(await exists(source)).toBe(true);
    expect(await exists(path.join(f.folders, "vanished"))).toBe(false);
    expect(f.registry.byId(stale.id)?.path).toBe(path.join(f.folders, "vanished"));

    await f.registry.remove(stale.id);
    completed(await f.manager.rename({ path: source, name: "vanished" }));
  });

  test("reconciles chained aliases across rewritten descendants", async () => {
    const f = await fixture();
    const group = path.join(f.folders, "group");
    const other = path.join(f.root, "other");
    const otherRepo = path.join(other, "repo");
    await fs.mkdir(group);
    await fs.mkdir(otherRepo, { recursive: true });
    await fs.symlink(other, path.join(group, "link"));
    const alias = path.join(f.root, "legacy-alias");
    await fs.symlink(f.folders, alias);
    // The parent alias is listed first; its bulk rewrite moves the
    // descendant to a path that still traverses the `link` symlink, so a
    // single stale-snapshot pass would leave it unreconciled.
    const parentEntry = await f.registry.register(path.join(alias, "group"));
    const chained = await f.registry.register(path.join(alias, "group", "link", "repo"));

    await f.manager.create({ parent: f.folders, name: "trigger" });
    expect(f.registry.byId(parentEntry.id)?.path).toBe(group);
    expect(f.registry.byId(chained.id)?.path).toBe(otherRepo);
  });

  test("a failing no-replace primitive degrades to the claimed strategy, never a replacing rename", async () => {
    // renameat2 can be exported yet rejected by the running kernel or
    // filesystem; the degradation path must be the claimed placeholder,
    // whose mkdir precedes any rename — a plain rename would silently
    // replace a directory created after the last existence probe.
    const mkdirs: string[] = [];
    const injected = Object.assign({}, fs, {
      mkdir: async (candidate: string, options?: Parameters<typeof fs.mkdir>[1]) => {
        mkdirs.push(candidate);
        return fs.mkdir(candidate, options);
      },
    }) as typeof fs;
    const f = await fixture({ fs: injected, renameNoReplace: () => -1 });
    const source = path.join(f.folders, "source");
    const destination = path.join(f.folders, "destination");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "kept.txt"), "kept");

    completed(await f.manager.rename({ path: source, name: "destination" }));
    expect(await fs.readFile(path.join(destination, "kept.txt"), "utf8")).toBe("kept");
    expect(mkdirs).toContain(destination);
  });

  test("a rename raced by a concurrent forget degrades to an unregistered rename", async () => {
    const f = await fixture();
    const source = path.join(f.folders, "raced");
    await fs.mkdir(source);
    const entry = await f.registry.register(source);
    // The forget wins the lifecycle queue: journaling the stale entry
    // would let a crash after the move resurrect a workspace whose
    // personal state and assignments were already deleted.
    const racedSessions = {
      runWithSessionsStopped: async <T,>(ids: string[], stop: boolean, operation: () => Promise<T>) => {
        await f.registry.remove(entry.id);
        return f.sessions.runWithSessionsStopped(ids, stop, operation);
      },
    };
    const manager = new FolderManager({
      journalPath: f.journalPath,
      registry: f.registry,
      sessions: racedSessions as never,
      personalState: f.personalState,
      credentials: f.credentials,
      reservations: f.reservations,
    });

    expect(completed(await manager.rename({ path: source, name: "renamed" }))).toEqual({
      path: path.join(f.folders, "renamed"),
      workspaceIds: [],
    });
    expect(await exists(f.journalPath)).toBe(false);
    expect(f.registry.byId(entry.id)).toBeUndefined();
  });

  test("a degraded registered rename journals its fallback claim", async () => {
    // When the native no-replace rename is exported but rejected, the
    // claimed fallback must reach the journal BEFORE the replacing rename:
    // a crash in the claim window must read as a reclaimable state, never
    // as the ambiguous both-exist failure that blocks startup.
    let midFlight: { identities?: { source?: unknown; claim?: unknown } } | undefined;
    let journalPath = "";
    let source = "";
    const injected = Object.assign({}, fs, {
      rename: async (from: string, to: string) => {
        if (from === source) {
          midFlight = JSON.parse(await fs.readFile(journalPath, "utf8")) as typeof midFlight;
        }
        return fs.rename(from, to);
      },
    }) as typeof fs;
    const f = await fixture({ fs: injected, renameNoReplace: () => -1 });
    journalPath = f.journalPath;
    source = path.join(f.folders, "source");
    await fs.mkdir(source);
    await f.registry.register(source);

    completed(await f.manager.rename({ path: source, name: "renamed" }));
    expect(midFlight?.identities?.source).toBeDefined();
    expect(midFlight?.identities?.claim).toBeDefined();
    expect(await exists(f.journalPath)).toBe(false);
  });

  test("a claim swapped from under the rename conflicts instead of replacing", async () => {
    // A same-user process replaces the destination while the journal is
    // being written: the recorded claim identity no longer matches, so the
    // rename must refuse — and the cleanup must not delete the foreign
    // directory either. The replacement is created BEFORE the claim is
    // removed so its inode is guaranteed distinct on every filesystem
    // (the claim's inode is still allocated at creation time).
    let swapArmed = false;
    let swapTarget = "";
    const injected = Object.assign({}, fs, {
      rename: async (from: string, to: string) => {
        if (swapArmed && to.endsWith("pending-folder-mutation.json")) {
          swapArmed = false;
          const replacement = `${swapTarget}.foreign`;
          await fs.mkdir(replacement);
          await fs.rmdir(swapTarget);
          await fs.rename(replacement, swapTarget);
        }
        return fs.rename(from, to);
      },
    }) as typeof fs;
    const f = await fixture({ fs: injected });
    const source = path.join(f.folders, "source");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "kept.txt"), "kept");
    await f.registry.register(source);
    swapTarget = path.join(f.folders, "destination");
    swapArmed = true;

    await expect(f.manager.rename({ path: source, name: "destination" })).rejects.toMatchObject({ code: "conflict" });
    expect(await fs.readFile(path.join(source, "kept.txt"), "utf8")).toBe("kept");
    expect(await exists(swapTarget)).toBe(true);
    expect(await exists(f.journalPath)).toBe(false);
  });

  test("stale alias claims block their canonical create and rename destinations", async () => {
    const f = await fixture();
    const alias = path.join(f.root, "legacy-alias");
    await fs.symlink(f.folders, alias);
    // Registered through the alias and the folder later vanished: the full
    // path no longer resolves, but the claim still maps to the canonical
    // destination via its existing parent.
    const stale = await f.registry.register(path.join(alias, "vanished"));
    const source = path.join(f.folders, "source");
    await fs.mkdir(source);

    await expect(f.manager.create({ parent: f.folders, name: "vanished" })).rejects.toMatchObject({ code: "conflict" });
    await expect(f.manager.rename({ path: source, name: "vanished" })).rejects.toMatchObject({ code: "conflict" });
    expect(await exists(path.join(f.folders, "vanished"))).toBe(false);
    // The stale claim itself is now canonically spelled.
    expect(f.registry.byId(stale.id)?.path).toBe(path.join(f.folders, "vanished"));
  });

  test("removes an alias-registered workspace addressed by its canonical path", async () => {
    const f = await fixture();
    const project = path.join(f.folders, "empty");
    await fs.mkdir(project);
    const alias = path.join(f.root, "legacy-alias");
    await fs.symlink(f.folders, alias);
    const entry = await f.registry.register(path.join(alias, "empty"));

    expect(completed(await f.manager.remove({ path: project }))).toEqual({ path: project, workspaceId: entry.id });
    expect(f.registry.byId(entry.id)).toBeUndefined();
  });

  test("removes an exact registered empty folder and clears personal and credential metadata", async () => {
    const f = await fixture();
    const source = path.join(f.folders, "empty");
    await fs.mkdir(source);
    const entry = await f.registry.register(source);
    await f.personalState.patch("alice", entry.id, { follow: true });
    await f.credentials.transaction(state => state.credentials.push({
      id: "key", name: "Key", type: "ssh", enabled: true,
      capabilities: ["ssh-signing"], metadata: { publicKey: "ssh-ed25519 AAAA", fingerprint: "SHA256:test" },
      createdAt: "2026-08-23T00:00:00.000Z",
    }));
    await f.credentials.assign({ workspaceId: entry.id, credentialId: "key", role: "signing" });

    expect(completed(await f.manager.remove({ path: source }))).toEqual({ path: source, workspaceId: entry.id });
    expect(f.registry.byId(entry.id)).toBeUndefined();
    expect(f.personalState.get("alice", entry.id)).toEqual({ version: 1 });
    expect(f.credentials.snapshot().assignments).toEqual([]);
    expect(await exists(source)).toBe(false);
  });
});

describe("FolderManager journal recovery", () => {
  test.each([
    ["source-only", true],
    ["destination-only", false],
  ] as const)("reconciles a %s registered rename", async (_label, sourceOnly) => {
    const f = await fixture();
    const source = path.join(f.folders, "source");
    const destination = path.join(f.folders, "destination");
    const entry = await f.registry.register(source);
    const journal = renameJournal(source, destination, [entry]);
    if (sourceOnly) {
      await fs.mkdir(source);
      await f.registry.restoreEntries(journal.operation === "rename" ? journal.after : []);
    } else {
      await fs.mkdir(destination);
    }
    await writeJournal(f.journalPath, journal);
    await f.manager.recover();
    expect(f.registry.byId(entry.id)?.path).toBe(sourceOnly ? source : destination);
    expect(await exists(f.journalPath)).toBe(false);
  });

  test("recovers a crash between the destination claim and the rename", async () => {
    // The registered rename claims the destination, journals both
    // identities, then renames. A crash before the rename leaves source
    // plus our journaled empty placeholder — an ordinary crash state that
    // must not brick startup.
    const f = await fixture();
    const source = path.join(f.folders, "source");
    const destination = path.join(f.folders, "destination");
    await Promise.all([fs.mkdir(source), fs.mkdir(destination)]);
    const entry = await f.registry.register(source);
    await writeJournal(f.journalPath, renameJournal(source, destination, [entry], {
      source: await identityOf(source),
      claim: await identityOf(destination),
    }));

    await f.manager.recover();
    expect(f.registry.byId(entry.id)?.path).toBe(source);
    expect(await exists(destination)).toBe(false);
    expect(await exists(f.journalPath)).toBe(false);
  });

  test("recovers a completed rename whose source was recreated by a foreign process", async () => {
    // Crash after the rename but before the registry update, with a foreign
    // process recreating the source: the destination carries the recorded
    // SOURCE identity (the moved folder), so recovery completes to the
    // after-state and never deletes the renamed folder.
    const f = await fixture();
    const source = path.join(f.folders, "source");
    const destination = path.join(f.folders, "destination");
    await fs.mkdir(destination);
    const entry = await f.registry.register(source);
    const journal = renameJournal(source, destination, [entry], {
      // The destination IS the moved source directory.
      source: await identityOf(destination),
      claim: { dev: "0", ino: "0" },
    });
    await fs.mkdir(source);
    await writeJournal(f.journalPath, journal);

    await f.manager.recover();
    expect(f.registry.byId(entry.id)?.path).toBe(destination);
    expect(await exists(destination)).toBe(true);
    expect(await exists(source)).toBe(true);
    expect(await exists(f.journalPath)).toBe(false);
  });

  test("rejects a lone surviving directory that is not the journaled source", async () => {
    // The moved (or unmoved) folder was itself replaced by an unrelated
    // directory during the crash window: existence alone must not attach
    // the old stable ids and credentials to it.
    const f = await fixture();
    const source = path.join(f.folders, "source");
    const destination = path.join(f.folders, "destination");
    const entry = await f.registry.register(source);
    await fs.mkdir(destination);
    await writeJournal(f.journalPath, renameJournal(source, destination, [entry], {
      source: { dev: "0", ino: "1" },
      claim: { dev: "0", ino: "2" },
    }));
    await expect(f.manager.recover()).rejects.toThrow("unrecognized directory");
    expect(await exists(f.journalPath)).toBe(true);

    // Same for a lone source that is not the recorded one.
    await fs.rename(destination, source);
    await expect(f.manager.recover()).rejects.toThrow("unrecognized directory");
    expect(await exists(f.journalPath)).toBe(true);
  });

  test("fails loudly when both exist and neither identity matches", async () => {
    // An empty destination that is neither our claim nor the moved source
    // is a foreign directory; emptiness alone must never authorize rmdir.
    // The same applies to journals from builds without recorded identities.
    const f = await fixture();
    const source = path.join(f.folders, "source");
    const destination = path.join(f.folders, "destination");
    await Promise.all([fs.mkdir(source), fs.mkdir(destination)]);
    const entry = await f.registry.register(source);
    await writeJournal(f.journalPath, renameJournal(source, destination, [entry], {
      source: { dev: "0", ino: "1" },
      claim: { dev: "0", ino: "2" },
    }));
    await expect(f.manager.recover()).rejects.toThrow("ambiguous pending folder rename");
    expect(await exists(destination)).toBe(true);

    await writeJournal(f.journalPath, renameJournal(source, destination, [entry]));
    await expect(f.manager.recover()).rejects.toThrow("ambiguous pending folder rename");
    expect(await exists(destination)).toBe(true);
    expect(await exists(f.journalPath)).toBe(true);
  });

  test.each([
    ["both with a populated destination", true, true],
    ["neither", false, false],
  ] as const)("fails loudly for ambiguous rename state: %s", async (_label, sourceExists, destinationExists) => {
    const f = await fixture();
    const source = path.join(f.folders, "source");
    const destination = path.join(f.folders, "destination");
    if (sourceExists) await fs.mkdir(source);
    if (destinationExists) {
      // A populated destination was never our claim placeholder.
      await fs.mkdir(destination);
      await fs.writeFile(path.join(destination, "content.txt"), "kept");
    }
    const entry = await f.registry.register(source);
    await writeJournal(f.journalPath, renameJournal(source, destination, [entry]));
    await expect(f.manager.recover()).rejects.toThrow("ambiguous pending folder rename");
    expect(await exists(f.journalPath)).toBe(true);
    if (destinationExists) {
      expect(await fs.readFile(path.join(destination, "content.txt"), "utf8")).toBe("kept");
    }
  });

  test.each([true, false])("restores retained removal state with registry present=%s", async registryPresent => {
    const f = await fixture();
    const source = path.join(f.folders, "source");
    await fs.mkdir(source);
    const entry = await f.registry.register(source);
    await f.personalState.patch("alice", entry.id, { follow: true });
    if (!registryPresent) await f.registry.remove(entry.id);
    await writeJournal(f.journalPath, { version: 1, operation: "remove", source, entry });

    await f.manager.recover();
    expect(f.registry.byId(entry.id)).toEqual(entry);
    expect(f.personalState.get("alice", entry.id).follow).toBe(true);
    expect(await exists(f.journalPath)).toBe(false);
  });

  test.each([true, false])("finishes committed removal with registry present=%s", async registryPresent => {
    const f = await fixture();
    const source = path.join(f.folders, "source");
    const entry = await f.registry.register(source);
    await f.personalState.patch("alice", entry.id, { follow: true });
    await f.credentials.transaction(state => state.credentials.push({
      id: "key", name: "Key", type: "ssh", enabled: true,
      capabilities: ["ssh-signing"], metadata: { publicKey: "ssh-ed25519 AAAA", fingerprint: "SHA256:test" },
      createdAt: "2026-08-23T00:00:00.000Z",
    }));
    await f.credentials.assign({ workspaceId: entry.id, credentialId: "key", role: "signing" });
    if (!registryPresent) await f.registry.remove(entry.id);
    await writeJournal(f.journalPath, { version: 1, operation: "remove", source, entry });

    await f.manager.recover();
    expect(f.registry.byId(entry.id)).toBeUndefined();
    expect(f.personalState.get("alice", entry.id)).toEqual({ version: 1 });
    expect(f.credentials.snapshot().assignments).toEqual([]);
    expect(await exists(f.journalPath)).toBe(false);
  });

  test("removal recovery refuses a recreated directory at the source", async () => {
    const f = await fixture();
    const source = path.join(f.folders, "source");
    await fs.mkdir(source);
    const entry = await f.registry.register(source);
    const identity = await identityOf(source);
    // The rmdir committed and another process recreated the path (the
    // replacement is created before the removal so its inode is distinct
    // on every filesystem).
    await fs.mkdir(`${source}.next`);
    await fs.rmdir(source);
    await fs.rename(`${source}.next`, source);
    await writeJournal(f.journalPath, { version: 1, operation: "remove", source, entry, identity });
    await expect(f.manager.recover()).rejects.toThrow("unrecognized directory");
    expect(await exists(f.journalPath)).toBe(true);

    // The journaled directory itself restores normally.
    await writeJournal(f.journalPath, { version: 1, operation: "remove", source, entry, identity: await identityOf(source) });
    await f.manager.recover();
    expect(f.registry.byId(entry.id)).toEqual(entry);
    expect(await exists(f.journalPath)).toBe(false);
  });

  test("rejects a journal that is not owner-only", async () => {
    const f = await fixture();
    const source = path.join(f.folders, "source");
    const entry = await f.registry.register(source);
    await writeJournal(f.journalPath, { version: 1, operation: "remove", source, entry }, 0o644);
    await expect(f.manager.recover()).rejects.toThrow("journal is invalid");
  });
});
