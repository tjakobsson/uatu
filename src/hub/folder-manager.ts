import { promises as nodeFs } from "node:fs";
import path from "node:path";

import type { CredentialMetadataStore } from "./credential-store";
import type { PersonalWorkspaceStateStore } from "./personal-state";
import { normalizeAbsolutePath, PathReservationCoordinator } from "./path-reservations";
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

type RenameJournal = {
  version: typeof JOURNAL_VERSION;
  operation: "rename";
  source: string;
  destination: string;
  before: WorkspaceEntry[];
  after: WorkspaceEntry[];
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

function journalAbsolutePath(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0") || !path.isAbsolute(value)) throw new Error("journal path must be absolute");
  return normalizeAbsolutePath(value);
}

function parseJournal(value: unknown): PendingFolderMutation {
  const base = closedJournalObject(
    value,
    (value as { operation?: unknown })?.operation === "rename"
      ? ["version", "operation", "source", "destination", "before", "after"]
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

export class FolderManager {
  private readonly fs: FileSystem;
  private readonly journal: FolderMutationJournal;
  private operationChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: FolderManagerOptions) {
    this.fs = options.fs ?? nodeFs;
    this.journal = new FolderMutationJournal(options.journalPath, this.fs);
  }

  create(input: unknown): Promise<CreateFolderResult> {
    return this.enqueue(async () => {
      const parsed = parseCreate(input);
      await this.assertNoPendingMutation();
      const parent = await this.canonicalDirectory(parsed.parent);
      const destination = path.join(parent, parsed.name);
      const reservation = this.reserve([destination]);
      try {
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
            if (affected.length === 0) {
              try {
                await this.renameWithoutReplacement(source, destination);
              } catch (error) {
                throw safeFsError(error, "folder rename failed");
              }
              return { path: destination, workspaceIds: [] };
            }
            return await this.renameRegistered(source, destination, affected);
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
            if (!entry) {
              try {
                await this.fs.rmdir(source);
              } catch (error) {
                throw safeFsError(error, "folder removal failed");
              }
              return { path: source };
            }
            return await this.removeRegistered(source, entry);
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
        if (sourceExists === destinationExists) {
          throw new Error("ambiguous pending folder rename: expected exactly one of source or destination to exist");
        }
        await this.options.registry.restoreEntries(sourceExists ? pending.before : pending.after);
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

  // Registries persisted before path canonicalization can hold alias paths
  // (a registration reached through a symlinked ancestor). Canonical-source
  // lookups would treat those entries as unrelated and mutate the directory
  // without stopping their sessions or updating their registered paths, so
  // mutations first rewrite any stored alias to its canonical form. A path
  // that cannot exist anymore is left alone — the entry stays registered at
  // its recorded path, exactly as a vanished folder does.
  private async reconcileRegisteredAliases(): Promise<void> {
    for (const entry of this.options.registry.list()) {
      const persisted = normalizeAbsolutePath(entry.path);
      let canonical: string;
      try {
        canonical = normalizeAbsolutePath(await this.fs.realpath(persisted));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        // Only a missing path is the vanished-folder case. Anything else
        // (EACCES on an alias ancestor) fails the mutation closed:
        // skipping would silently exempt this entry from session stops
        // and path updates while its directory may still be affected.
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        throw safeFsError(error, "registered workspace path reconciliation failed");
      }
      if (canonical === persisted) continue;
      try {
        await this.options.registry.replacePathPrefix(persisted, canonical);
      } catch (error) {
        throw safeFsError(error, "registered workspace path reconciliation failed");
      }
    }
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
    let claimed = false;
    try {
      // mkdir atomically claims the absent name. POSIX rename may then replace
      // only our empty claim; a competing entry makes either step fail.
      await this.fs.mkdir(destination);
      claimed = true;
      await this.fs.rename(source, destination);
      claimed = false;
    } catch (error) {
      if (claimed) await this.fs.rmdir(destination).catch(() => undefined);
      throw error;
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
    const pending: RenameJournal = { version: JOURNAL_VERSION, operation: "rename", source, destination, before, after };
    try {
      await this.journal.write(pending);
      await this.renameWithoutReplacement(source, destination);
    } catch (error) {
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
