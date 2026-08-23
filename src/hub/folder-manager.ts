import { promises as nodeFs } from "node:fs";
import path from "node:path";

import type { CredentialMetadataStore } from "./credential-store";
import type { PersonalWorkspaceStateStore } from "./personal-state";
import { normalizeAbsolutePath, PathReservationCoordinator } from "./path-reservations";
import { loadNoReplaceRename, type NoReplaceRename } from "./rename-no-replace";
import type { WorkspaceEntry, WorkspaceRegistry } from "./registry";
import type { SessionManager, SessionsStoppedResult } from "./sessions";

const JOURNAL_VERSION = 1 as const;

export type FolderManagerErrorCode =
  | "invalid-input"
  | "not-found"
  | "conflict"
  | "permission-denied"
  | "not-empty"
  | "internal";

export class FolderManagerError extends Error {
  constructor(
    readonly code: FolderManagerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FolderManagerError";
  }
}

export type CreateFolderInput = { parent: string; name: string };
export type RenameFolderInput = { path: string; name: string; stop?: boolean };
export type RemoveFolderInput = { path: string; stop?: boolean };

export type CreateFolderResult = { path: string };
export type RenameFolderResult = { path: string; workspaceIds: string[] };
export type RemoveFolderResult = { path: string; workspaceId?: string };
export type CoordinatedFolderResult<T> = SessionsStoppedResult<T>;

// dev+ino as strings (64-bit inode numbers exceed safe JSON integers).
// Recorded so recovery can tell the successfully renamed folder — and, on
// the claimed-placeholder fallback path, our own empty destination claim —
// from a foreign directory.
type DirectoryIdentity = { dev: string; ino: string };

type RenameJournal = {
  version: typeof JOURNAL_VERSION;
  operation: "rename";
  source: string;
  destination: string;
  before: WorkspaceEntry[];
  after: WorkspaceEntry[];
  // Absent in journals from builds that predate identities; recovery then
  // treats a both-exist state as ambiguous, exactly as before. claim is
  // recorded only by the fallback strategy — the no-replace rename path
  // never creates a placeholder.
  identities?: { source: DirectoryIdentity; claim?: DirectoryIdentity };
};

type RemoveJournal = {
  version: typeof JOURNAL_VERSION;
  operation: "remove";
  source: string;
  entry: WorkspaceEntry;
};

export type PendingFolderMutation = RenameJournal | RemoveJournal;

type FileSystem = Pick<typeof nodeFs, "lstat" | "realpath" | "mkdir" | "rename" | "rmdir" | "readFile" | "open" | "unlink" | "chmod" | "rm">;

type FolderRegistry = Pick<WorkspaceRegistry,
  "atOrBelow" | "byId" | "byPath" | "list" | "remove" | "replacePathPrefix" | "restoreEntries"
>;

type FolderSessions = Pick<SessionManager, "runWithSessionsStopped">;
type PersonalState = Pick<PersonalWorkspaceStateStore, "forgetWorkspace" | "recoverPendingForgets" | "removeWorkspace">;
type CredentialState = Pick<CredentialMetadataStore, "removeWorkspaceAssignments">;

export type FolderManagerOptions = {
  journalPath: string;
  registry: FolderRegistry;
  sessions: FolderSessions;
  personalState: PersonalState;
  credentials: CredentialState;
  reservations: PathReservationCoordinator;
  fs?: FileSystem;
  // Test seam for the kernel no-replace rename; defaults to the platform
  // primitive on the real filesystem and to none with an injected fs.
  renameNoReplace?: NoReplaceRename | null;
};

function closedObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FolderManagerError("invalid-input", "request must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(fields);
  if (Object.keys(record).some(key => !allowed.has(key))) {
    throw new FolderManagerError("invalid-input", "request contains an unknown field");
  }
  return record;
}

function absolutePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.includes("\0") || !path.isAbsolute(value)) {
    throw new FolderManagerError("invalid-input", `${field} must be an absolute path`);
  }
  return normalizeAbsolutePath(value);
}

function folderName(value: unknown): string {
  if (
    typeof value !== "string"
    || value.trim() === ""
    || value === "."
    || value === ".."
    || value.startsWith(".")
    || value.includes("/")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new FolderManagerError("invalid-input", "name must be one visible non-hidden path segment");
  }
  return value;
}

function stopFlag(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new FolderManagerError("invalid-input", "stop must be a boolean");
  return value;
}

function parseCreate(value: unknown): CreateFolderInput {
  const input = closedObject(value, ["parent", "name"]);
  return { parent: absolutePath(input.parent, "parent"), name: folderName(input.name) };
}

function parseRename(value: unknown): RenameFolderInput {
  const input = closedObject(value, ["path", "name", "stop"]);
  return { path: absolutePath(input.path, "path"), name: folderName(input.name), stop: stopFlag(input.stop) };
}

function parseRemove(value: unknown): RemoveFolderInput {
  const input = closedObject(value, ["path", "stop"]);
  return { path: absolutePath(input.path, "path"), stop: stopFlag(input.stop) };
}

function safeFsError(error: unknown, fallback: string): FolderManagerError {
  if (error instanceof FolderManagerError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return new FolderManagerError("not-found", "folder was not found", { cause: error });
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new FolderManagerError("permission-denied", "filesystem permission denied", { cause: error });
  }
  if (code === "ENOTEMPTY") return new FolderManagerError("not-empty", "folder is not empty", { cause: error });
  if (code === "EEXIST" || code === "EBUSY") {
    return new FolderManagerError("conflict", "folder operation conflicts with an existing filesystem entry", { cause: error });
  }
  if (code === "ENOTDIR" || code === "EISDIR") {
    return new FolderManagerError("invalid-input", "folder path is not a directory", { cause: error });
  }
  if (error instanceof Error && /workspace path collision/.test(error.message)) {
    return new FolderManagerError("conflict", "folder operation conflicts with a registered workspace path", { cause: error });
  }
  return new FolderManagerError("internal", fallback, { cause: error });
}

function parseEntry(value: unknown): WorkspaceEntry {
  const entry = closedJournalObject(value, ["id", "path", "backend"], "workspace entry");
  if (typeof entry.id !== "string" || entry.id === "" || entry.backend !== "local") {
    throw new Error("invalid workspace entry");
  }
  return { id: entry.id, path: journalAbsolutePath(entry.path), backend: "local" };
}

function closedJournalObject(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const allowed = new Set(fields);
  if (Object.keys(record).some(key => !allowed.has(key))) throw new Error(`${label} contains an unknown field`);
  return record;
}

function parseIdentity(value: unknown): DirectoryIdentity {
  const record = closedJournalObject(value, ["dev", "ino"], "directory identity");
  if (typeof record.dev !== "string" || record.dev === "" || typeof record.ino !== "string" || record.ino === "") {
    throw new Error("invalid directory identity");
  }
  return { dev: record.dev, ino: record.ino };
}

function parseIdentities(value: unknown): { source: DirectoryIdentity; claim?: DirectoryIdentity } {
  const record = closedJournalObject(value, ["source", "claim"], "rename journal identities");
  return {
    source: parseIdentity(record.source),
    ...(record.claim === undefined ? {} : { claim: parseIdentity(record.claim) }),
  };
}

function directoryIdentity(stats: { dev: number | bigint; ino: number | bigint }): DirectoryIdentity {
  return { dev: String(stats.dev), ino: String(stats.ino) };
}

function journalAbsolutePath(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0") || !path.isAbsolute(value)) throw new Error("journal path must be absolute");
  return normalizeAbsolutePath(value);
}

function parseJournal(value: unknown): PendingFolderMutation {
  const base = closedJournalObject(
    value,
    (value as { operation?: unknown })?.operation === "rename"
      ? ["version", "operation", "source", "destination", "before", "after", "identities"]
      : ["version", "operation", "source", "entry"],
    "folder mutation journal",
  );
  if (base.version !== JOURNAL_VERSION) throw new Error("unsupported folder mutation journal version");
  if (base.operation === "rename") {
    if (!Array.isArray(base.before) || !Array.isArray(base.after) || base.before.length === 0 || base.before.length !== base.after.length) {
      throw new Error("invalid rename journal entries");
    }
    const before = base.before.map(parseEntry);
    const after = base.after.map(parseEntry);
    if (before.some((entry, index) => entry.id !== after[index]?.id || entry.backend !== after[index]?.backend)) {
      throw new Error("rename journal identity mismatch");
    }
    return {
      version: JOURNAL_VERSION,
      operation: "rename",
      source: journalAbsolutePath(base.source),
      destination: journalAbsolutePath(base.destination),
      before,
      after,
      ...(base.identities === undefined ? {} : { identities: parseIdentities(base.identities) }),
    };
  }
  if (base.operation === "remove") {
    return { version: JOURNAL_VERSION, operation: "remove", source: journalAbsolutePath(base.source), entry: parseEntry(base.entry) };
  }
  throw new Error("unsupported folder mutation journal operation");
}

class FolderMutationJournal {
  private counter = 0;

  constructor(private readonly filePath: string, private readonly fs: FileSystem) {}

  async read(): Promise<PendingFolderMutation | undefined> {
    try {
      const stats = await this.fs.lstat(this.filePath);
      if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) throw new Error("journal must be a single regular file");
      if ((stats.mode & 0o777) !== 0o600) throw new Error("journal permissions must be 0600");
      if (typeof process.getuid === "function" && stats.uid !== process.getuid()) throw new Error("journal is not owned by the current user");
      return parseJournal(JSON.parse(await this.fs.readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("pending folder mutation journal is invalid", { cause: error });
    }
  }

  async write(record: PendingFolderMutation): Promise<void> {
    const temp = `${this.filePath}.${process.pid}.${this.counter += 1}.tmp`;
    let created = false;
    try {
      const handle = await this.fs.open(temp, "wx", 0o600);
      created = true;
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.fs.rename(temp, this.filePath);
      created = false;
      await this.fs.chmod(this.filePath, 0o600);
    } catch (error) {
      if (created) await this.fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async clear(): Promise<void> {
    try {
      await this.fs.unlink(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

// Canonicalizes a possibly-missing path: the deepest existing ancestor is
// resolved with realpath and the missing remainder rejoined verbatim (its
// components do not exist, so they cannot traverse further symlinks).
// Returns undefined when no ancestor resolves; missing-path errors on an
// ancestor walk down, everything else (EACCES) propagates.
async function canonicalizeNearestAncestor(
  persisted: string,
  fileSystem: Pick<FileSystem, "realpath">,
): Promise<string | undefined> {
  let prefix = persisted;
  const suffix: string[] = [];
  for (;;) {
    const parent = path.dirname(prefix);
    if (parent === prefix) return undefined;
    suffix.unshift(path.basename(prefix));
    prefix = parent;
    try {
      return path.join(await fileSystem.realpath(prefix), ...suffix);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
  }
}

// Registries persisted before path canonicalization can hold alias paths
// (a registration reached through a symlinked ancestor). Canonical-path
// lookups would treat those entries as unrelated — a folder mutation would
// skip their session stops and path updates, workspace registration would
// mint a duplicate id for the same repository, and a stale claim would not
// block its canonical destination — so all of them reconcile stored
// aliases to their canonical form before any exact-path lookup. A vanished
// folder stays registered, but at its canonical spelling: the missing leaf
// is rejoined onto its deepest existing ancestor's resolution.
export async function reconcileRegisteredAliasPaths(
  registry: Pick<WorkspaceRegistry, "list" | "replacePathPrefix">,
  fileSystem: Pick<FileSystem, "realpath"> = nodeFs,
): Promise<void> {
  // Every rewrite invalidates the snapshot: a parent prefix replacement
  // also moves its descendants, and a rewritten descendant may still
  // traverse a further symlink. Each pass therefore restarts from a fresh
  // snapshot after the first rewrite and the loop runs to a fixpoint —
  // realpath is deterministic and every rewrite strictly resolves at least
  // one link, so a pass with no rewrite terminates the loop.
  for (;;) {
    let rewrote = false;
    for (const entry of registry.list()) {
      const persisted = normalizeAbsolutePath(entry.path);
      let canonical: string | undefined;
      try {
        canonical = normalizeAbsolutePath(await fileSystem.realpath(persisted));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        // Anything but a missing path (EACCES on an alias ancestor) fails
        // the caller closed: skipping would silently exempt this entry
        // from canonical-path matching while its directory may still be
        // affected.
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          throw safeFsError(error, "registered workspace path reconciliation failed");
        }
        try {
          const rejoined = await canonicalizeNearestAncestor(persisted, fileSystem);
          canonical = rejoined === undefined ? undefined : normalizeAbsolutePath(rejoined);
        } catch (ancestorError) {
          throw safeFsError(ancestorError, "registered workspace path reconciliation failed");
        }
      }
      if (canonical === undefined || canonical === persisted) continue;
      try {
        await registry.replacePathPrefix(persisted, canonical);
      } catch (error) {
        throw safeFsError(error, "registered workspace path reconciliation failed");
      }
      rewrote = true;
      break;
    }
    if (!rewrote) return;
  }
}

export class FolderManager {
  private readonly fs: FileSystem;
  private readonly journal: FolderMutationJournal;
  private readonly renameNoReplace: NoReplaceRename | null;
  private operationChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: FolderManagerOptions) {
    this.fs = options.fs ?? nodeFs;
    this.journal = new FolderMutationJournal(options.journalPath, this.fs);
    // The kernel-level no-replace rename applies only to the real
    // filesystem; an injected fs (failure-injection tests) exercises the
    // claimed-placeholder fallback its hooks can observe.
    this.renameNoReplace = options.renameNoReplace !== undefined
      ? options.renameNoReplace
      : options.fs
        ? null
        : loadNoReplaceRename();
  }

  create(input: unknown): Promise<CreateFolderResult> {
    return this.enqueue(async () => {
      const parsed = parseCreate(input);
      await this.assertNoPendingMutation();
      const parent = await this.canonicalDirectory(parsed.parent);
      const destination = path.join(parent, parsed.name);
      const reservation = this.reserve([destination]);
      try {
        // A missing directory's registration is deliberately retained;
        // creating an unrelated empty folder at that path would hand it
        // the old workspace's stable id, personal state, and credential
        // assignments. Reconciled first, so an alias-spelled stale claim
        // matches its canonical destination too.
        await this.reconcileRegisteredAliases();
        if (this.options.registry.atOrBelow(destination).length > 0) {
          throw new FolderManagerError("conflict", "destination is claimed by a registered workspace");
        }
        await this.assertMissing(destination);
        await this.fs.mkdir(destination);
        return { path: destination };
      } catch (error) {
        throw safeFsError(error, "folder creation failed");
      } finally {
        reservation.release();
      }
    });
  }

  rename(input: unknown): Promise<CoordinatedFolderResult<RenameFolderResult>> {
    return this.enqueue(async () => {
      const parsed = parseRename(input);
      await this.assertNoPendingMutation();
      const source = await this.canonicalDirectory(parsed.path);
      const destination = path.join(path.dirname(source), parsed.name);
      if (destination === source) throw new FolderManagerError("conflict", "source and destination are the same folder");
      const reservation = this.reserve([source, destination]);
      try {
        await this.assertMissing(destination);
        await this.reconcileRegisteredAliases();
        const affected = this.options.registry.atOrBelow(source);
        // A destination absent on disk can still be claimed by a registered
        // workspace — missing paths are deliberately retained. Renaming
        // onto it would point that stable workspace id (and its personal
        // state and credential assignments) at unrelated content.
        if (this.options.registry.atOrBelow(destination).length > 0) {
          throw new FolderManagerError("conflict", "destination is claimed by a registered workspace");
        }
        return await this.options.sessions.runWithSessionsStopped(
          affected.map(entry => entry.id),
          parsed.stop === true,
          async () => {
            await this.assertDirectory(source);
            await this.assertMissing(destination);
            // Predecessors in the lifecycle queue (a concurrent forget) may
            // have unregistered entries after the capture above; the
            // re-read keeps a forgotten entry out of the journal, which
            // recovery would otherwise resurrect with its personal state
            // and assignments already deleted.
            const current = this.options.registry.atOrBelow(source);
            if (current.length === 0) {
              try {
                await this.renameWithoutReplacement(source, destination);
              } catch (error) {
                throw safeFsError(error, "folder rename failed");
              }
              return { path: destination, workspaceIds: [] };
            }
            return await this.renameRegistered(source, destination, current);
          },
        );
      } finally {
        reservation.release();
      }
    });
  }

  remove(input: unknown): Promise<CoordinatedFolderResult<RemoveFolderResult>> {
    return this.enqueue(async () => {
      const parsed = parseRemove(input);
      await this.assertNoPendingMutation();
      const source = await this.canonicalDirectory(parsed.path);
      const reservation = this.reserve([source]);
      try {
        await this.reconcileRegisteredAliases();
        const entry = this.options.registry.byPath(source);
        return await this.options.sessions.runWithSessionsStopped(
          entry ? [entry.id] : [],
          parsed.stop === true,
          async () => {
            await this.assertDirectory(source);
            // Predecessors in the lifecycle queue (a concurrent forget of
            // this workspace) may have unregistered the folder after the
            // capture above; the re-read turns an already-forgotten entry
            // into a plain unregistered removal instead of a registered
            // removal that would journal an entry it can no longer remove.
            const current = this.options.registry.byPath(source);
            if (!current) {
              try {
                await this.fs.rmdir(source);
              } catch (error) {
                throw safeFsError(error, "folder removal failed");
              }
              return { path: source };
            }
            return await this.removeRegistered(source, current);
          },
        );
      } finally {
        reservation.release();
      }
    });
  }

  recover(): Promise<void> {
    return this.enqueue(async () => {
      const pending = await this.journal.read();
      if (!pending) return;
      if (pending.operation === "rename") {
        const [sourceExists, destinationExists] = await Promise.all([
          this.isDirectDirectory(pending.source),
          this.isDirectDirectory(pending.destination),
        ]);
        let renamed: boolean;
        if (sourceExists && destinationExists) {
          // Both existing is resolvable only through the journaled
          // identities: the destination carrying the recorded claim
          // identity is our crashed empty placeholder (reclaimed —
          // rmdir refuses anything non-empty), while the recorded
          // source identity means the rename completed and something
          // foreign recreated the source. Emptiness alone proves
          // nothing, and a journal predating identities stays a loud
          // failure.
          const destinationStats = await this.fs.lstat(pending.destination);
          const matches = (identity: DirectoryIdentity | undefined) =>
            identity !== undefined
            && String(destinationStats.dev) === identity.dev
            && String(destinationStats.ino) === identity.ino;
          if (matches(pending.identities?.claim)) {
            try {
              await this.fs.rmdir(pending.destination);
            } catch (error) {
              throw new Error("ambiguous pending folder rename: expected exactly one of source or destination to exist", { cause: error });
            }
            renamed = false;
          } else if (matches(pending.identities?.source)) {
            renamed = true;
          } else {
            throw new Error("ambiguous pending folder rename: expected exactly one of source or destination to exist");
          }
        } else if (!sourceExists && !destinationExists) {
          throw new Error("ambiguous pending folder rename: expected exactly one of source or destination to exist");
        } else {
          renamed = destinationExists;
        }
        // With recorded identities, the surviving directory must BE the
        // journaled source — moved or not. An unrelated directory created
        // at either pathname during the crash window must not inherit the
        // registrations, their personal state, or their assignments.
        if (pending.identities) {
          const survivor = renamed ? pending.destination : pending.source;
          const stats = await this.fs.lstat(survivor);
          if (String(stats.dev) !== pending.identities.source.dev || String(stats.ino) !== pending.identities.source.ino) {
            throw new Error("pending folder rename recovery found an unrecognized directory; manual reconciliation required");
          }
        }
        await this.options.registry.restoreEntries(renamed ? pending.after : pending.before);
        await this.journal.clear();
        return;
      }

      const sourceExists = await this.isDirectDirectory(pending.source);
      if (sourceExists) {
        await this.options.registry.restoreEntries([pending.entry]);
      } else if (this.options.registry.byId(pending.entry.id)) {
        await this.options.personalState.forgetWorkspace(
          pending.entry.id,
          () => this.options.registry.remove(pending.entry.id),
          async () => { await this.options.credentials.removeWorkspaceAssignments(pending.entry.id); },
        );
      } else {
        await this.options.personalState.removeWorkspace(pending.entry.id);
      }
      await this.options.personalState.recoverPendingForgets(
        workspaceId => this.options.registry.byId(workspaceId) !== undefined,
        async workspaceId => { await this.options.credentials.removeWorkspaceAssignments(workspaceId); },
      );
      if (!sourceExists) await this.options.credentials.removeWorkspaceAssignments(pending.entry.id);
      await this.journal.clear();
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationChain.then(operation, operation);
    this.operationChain = next.catch(() => undefined);
    return next;
  }

  private reserve(paths: readonly string[]) {
    const reservation = this.options.reservations.acquire(paths);
    if (!reservation) throw new FolderManagerError("conflict", "folder path is reserved by another operation");
    return reservation;
  }

  private async assertDirectory(folderPath: string): Promise<void> {
    let stats;
    try {
      stats = await this.fs.lstat(folderPath);
    } catch (error) {
      throw safeFsError(error, "folder inspection failed");
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new FolderManagerError("invalid-input", "folder path must name a direct non-symbolic-link directory");
    }
  }

  private reconcileRegisteredAliases(): Promise<void> {
    return reconcileRegisteredAliasPaths(this.options.registry, this.fs);
  }

  // A journal that outlives its mutation is the only recovery record for a
  // workspace whose directory and registered state no longer agree. Every
  // mutation refuses while it exists, not just registered ones: a later
  // registered mutation would replace the single-record journal (and, on
  // success, clear it), while even an unregistered create or rename can
  // flip the existence probes recovery relies on — recreating a removed
  // journal source would restore the old registration onto an unrelated
  // directory. Nothing proceeds until recover() has resolved the record.
  private async assertNoPendingMutation(): Promise<void> {
    try {
      await this.fs.lstat(this.options.journalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw safeFsError(error, "folder mutation journal inspection failed");
    }
    throw new FolderManagerError("conflict", "a pending folder mutation requires recovery before further registered changes");
  }

  private async canonicalDirectory(folderPath: string): Promise<string> {
    await this.assertDirectory(folderPath);
    try {
      return normalizeAbsolutePath(await this.fs.realpath(folderPath));
    } catch (error) {
      throw safeFsError(error, "folder inspection failed");
    }
  }

  private async renameWithoutReplacement(source: string, destination: string): Promise<void> {
    if (this.renameNoReplace) {
      // The kernel refuses an existing destination atomically — no claim,
      // no placeholder, no ownership question. errno does not cross the
      // FFI boundary: a failure with a visible destination is the
      // conflict; any other failure (an exported syscall the running
      // kernel or filesystem rejects, or a real error we cannot name)
      // falls through to the claimed strategy below, which surfaces
      // genuine errors faithfully and never replaces anything beyond its
      // own placeholder — a plain rename here would reopen the hole.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (this.renameNoReplace(source, destination) === 0) return;
        if (await this.fs.lstat(destination).then(() => true, () => false)) {
          throw new FolderManagerError("conflict", "destination already exists");
        }
      }
    }
    let claim: DirectoryIdentity | undefined;
    try {
      // Fallback: mkdir atomically claims the absent name and POSIX rename
      // replaces our empty claim. Best-effort only — a claim swapped by a
      // foreign process between these steps is caught by identity where
      // inode numbers cooperate.
      await this.fs.mkdir(destination);
      claim = directoryIdentity(await this.fs.lstat(destination));
      await this.fs.rename(source, destination);
      claim = undefined;
    } catch (error) {
      if (claim) await this.removeOwnedClaim(destination, claim);
      throw error;
    }
  }

  // Removes the destination only while it still IS our recorded claim —
  // never a directory some other process put there after ours. rmdir
  // additionally refuses anything non-empty.
  private async removeOwnedClaim(destination: string, claim: DirectoryIdentity): Promise<void> {
    try {
      const stats = await this.fs.lstat(destination);
      if (String(stats.dev) !== claim.dev || String(stats.ino) !== claim.ino) return;
      await this.fs.rmdir(destination);
    } catch {
      // Already gone, or not ours to judge — leave it.
    }
  }

  // Re-checks that the destination still carries our claim's identity right
  // before the rename that replaces it. POSIX offers no portable no-replace
  // directory rename (renameat2(RENAME_NOREPLACE) is Linux-only and not
  // exposed by the runtime), so a same-user process swapping the claim
  // between this check and the rename remains theoretically able to lose
  // its just-created EMPTY directory (anything non-empty survives via
  // ENOTEMPTY); the check reduces that window from the whole journal write
  // to one lstat-to-rename step.
  private async assertClaimOwned(destination: string, claim: DirectoryIdentity): Promise<void> {
    let stats;
    try {
      stats = await this.fs.lstat(destination);
    } catch (error) {
      throw safeFsError(error, "rename destination claim inspection failed");
    }
    if (String(stats.dev) !== claim.dev || String(stats.ino) !== claim.ino) {
      throw new FolderManagerError("conflict", "destination changed during the rename");
    }
  }

  private async assertMissing(candidate: string): Promise<void> {
    try {
      await this.fs.lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw safeFsError(error, "destination inspection failed");
    }
    throw new FolderManagerError("conflict", "destination already exists");
  }

  private async isDirectDirectory(candidate: string): Promise<boolean> {
    try {
      const stats = await this.fs.lstat(candidate);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error("pending folder mutation path is not a direct directory");
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async renameRegistered(source: string, destination: string, before: WorkspaceEntry[]): Promise<RenameFolderResult> {
    const after = before.map(entry => ({
      ...entry,
      path: path.join(destination, path.relative(source, entry.path)),
    }));
    let claim: DirectoryIdentity | undefined;
    try {
      if (this.renameNoReplace) {
        // The journaled source identity lets recovery recognize the moved
        // folder if a crash lands between the rename and the registry
        // update while something foreign recreates the source.
        const sourceStats = await this.fs.lstat(source);
        const pending: RenameJournal = {
          version: JOURNAL_VERSION,
          operation: "rename",
          source,
          destination,
          before,
          after,
          identities: { source: directoryIdentity(sourceStats) },
        };
        await this.journal.write(pending);
        await this.renameWithoutReplacement(source, destination);
      } else {
        // Fallback strategy: the destination is claimed BEFORE the journal
        // so the claim's identity can be recorded in it — recovery can then
        // tell our empty placeholder from a foreign directory or the
        // renamed folder itself. A crash before the journal write leaves
        // only an inert empty directory, never a recovery state.
        await this.fs.mkdir(destination);
        const [sourceStats, claimStats] = await Promise.all([this.fs.lstat(source), this.fs.lstat(destination)]);
        claim = directoryIdentity(claimStats);
        const pending: RenameJournal = {
          version: JOURNAL_VERSION,
          operation: "rename",
          source,
          destination,
          before,
          after,
          identities: { source: directoryIdentity(sourceStats), claim },
        };
        await this.journal.write(pending);
        // The journal write above is real I/O; re-verify the claim is
        // still ours before the rename that replaces it.
        await this.assertClaimOwned(destination, claim);
        await this.fs.rename(source, destination);
        claim = undefined;
      }
    } catch (error) {
      if (claim) await this.removeOwnedClaim(destination, claim);
      await this.journal.clear().catch(() => undefined);
      throw safeFsError(error, "registered folder rename failed");
    }

    let registryUpdated = false;
    try {
      await this.options.registry.replacePathPrefix(source, destination);
      registryUpdated = true;
      await this.journal.clear();
      return { path: destination, workspaceIds: before.map(entry => entry.id) };
    } catch (error) {
      try {
        await this.renameWithoutReplacement(destination, source);
        if (registryUpdated) await this.options.registry.restoreEntries(before);
        await this.journal.clear();
      } catch (rollbackError) {
        throw new FolderManagerError("internal", "registered folder rename failed and recovery is required", {
          cause: new AggregateError([error, rollbackError]),
        });
      }
      throw safeFsError(error, "registered folder rename failed");
    }
  }

  private async removeRegistered(source: string, entry: WorkspaceEntry): Promise<RemoveFolderResult> {
    const pending: RemoveJournal = { version: JOURNAL_VERSION, operation: "remove", source, entry };
    try {
      await this.journal.write(pending);
      await this.fs.rmdir(source);
    } catch (error) {
      await this.journal.clear().catch(() => undefined);
      throw safeFsError(error, "registered folder removal failed");
    }
    try {
      await this.options.personalState.forgetWorkspace(
        entry.id,
        () => this.options.registry.remove(entry.id),
        async () => { await this.options.credentials.removeWorkspaceAssignments(entry.id); },
      );
      await this.journal.clear();
      return { path: source, workspaceId: entry.id };
    } catch (error) {
      throw safeFsError(error, "registered folder removal requires recovery");
    }
  }
}
