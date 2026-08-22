// Hub state-directory resolution. The hub persists three things across
// restarts: the workspace registry (JSON, not secret), per-user personal
// workspace state, and the session store (secret — its ids are live
// credentials). Everything lives under an XDG-resolved state root, mirroring
// how debug/cache.ts resolves the cache root, and secret files are created
// owner-only.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { constants as sqlite, Database } from "bun:sqlite";

const LEASE_FILE = ".hub-lease";
const LEASE_OPEN_FLAGS = sqlite.SQLITE_OPEN_READWRITE
  | sqlite.SQLITE_OPEN_CREATE
  | sqlite.SQLITE_OPEN_PRIVATECACHE
  | sqlite.SQLITE_OPEN_NOFOLLOW
  | sqlite.SQLITE_OPEN_EXRESCODE;

export type HubStateLease = {
  release(): Promise<void>;
};

export function resolveHubStateRoot(env: Record<string, string | undefined> = process.env): string {
  const stateHome =
    env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim() !== ""
      ? env.XDG_STATE_HOME
      : path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "uatu-hub");
}

export function registryPath(stateRoot: string): string {
  return path.join(stateRoot, "registry.json");
}

export function personalWorkspaceStatePath(stateRoot: string): string {
  return path.join(stateRoot, "personal-workspace-state.json");
}

// The server-side session store: opaque session ids mapped to user, issue
// time, and revocation state. Deleting the file invalidates every session.
export function sessionsPath(stateRoot: string): string {
  return path.join(stateRoot, "sessions.json");
}

export function credentialsPath(stateRoot: string): string {
  return path.join(stateRoot, "credentials.json");
}

export function credentialToolsPath(stateRoot: string): string {
  return path.join(stateRoot, "credential-tools.json");
}

export function credentialSecretsPath(stateRoot: string): string {
  return path.join(stateRoot, "credential-secrets");
}

export function credentialTokenStorePath(stateRoot: string): string {
  return path.join(credentialSecretsPath(stateRoot), "tokens.json");
}

export function credentialGnuPgPath(stateRoot: string): string {
  return path.join(stateRoot, "credential-gnupg");
}

export function credentialRuntimePath(stateRoot: string): string {
  return path.join(stateRoot, "credential-runtime");
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const stats = await fs.lstat(directory);
  if (stats.isSymbolicLink()) throw new Error(`refusing symlink for Hub private directory: ${directory}`);
  if (!stats.isDirectory()) throw new Error(`Hub private path is not a directory: ${directory}`);
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`unsafe permissions on Hub private directory (must be mode 0700, accessible only by its owner): ${directory}`);
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`Hub private directory is not owned by the current user: ${directory}`);
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  await assertPrivateDirectory(directory);
}

export async function ensureStateDir(stateRoot: string): Promise<void> {
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(stateRoot);
}

export async function ensureCanonicalStateDir(stateRoot: string): Promise<string> {
  await ensureStateDir(stateRoot);
  return await fs.realpath(stateRoot);
}

type LeaseFileIdentity = { dev: bigint; ino: bigint };

async function inspectLeaseFile(leasePath: string): Promise<LeaseFileIdentity> {
  const stats = await fs.lstat(leasePath, { bigint: true });
  if (stats.isDirectory()) {
    throw new Error(`legacy Hub state-root lease directory found at ${leasePath}; stop every old Hub using this state root, then remove that directory manually`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Hub state-root lease must be a non-symlink regular file: ${leasePath}`);
  }
  if (stats.nlink !== 1n) throw new Error(`Hub state-root lease must have exactly one hard link: ${leasePath}`);
  if (typeof process.getuid !== "function" || stats.uid !== BigInt(process.getuid())) {
    throw new Error(`Hub state-root lease is not owned by the current user: ${leasePath}`);
  }
  if ((stats.mode & 0o7777n) !== 0o600n) {
    throw new Error(`unsafe Hub state-root lease permissions (must be exactly mode 0600): ${leasePath}`);
  }
  return { dev: stats.dev, ino: stats.ino };
}

function sqliteValue(row: unknown, key: string): unknown {
  return row && typeof row === "object" ? (row as Record<string, unknown>)[key] : undefined;
}

function isSqliteBusy(error: unknown): boolean {
  const errno = error && typeof error === "object" && "errno" in error
    ? (error as { errno?: unknown }).errno
    : undefined;
  return typeof errno === "number" && (errno & 0xff) === 5;
}

export async function acquireHubStateLease(stateRoot: string): Promise<HubStateLease> {
  await assertPrivateDirectory(stateRoot);
  const canonicalStateRoot = await fs.realpath(stateRoot);
  const leasePath = path.join(canonicalStateRoot, LEASE_FILE);

  try {
    const created = await fs.open(leasePath, "wx", 0o600);
    try {
      await created.chmod(0o600);
      await created.sync();
    } finally {
      await created.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new Error(`cannot create Hub state-root lease at ${leasePath}`, { cause: error });
    }
  }

  const identity = await inspectLeaseFile(leasePath);
  let database: Database | undefined;
  try {
    database = new Database(leasePath, LEASE_OPEN_FLAGS);
    database.exec("PRAGMA busy_timeout=0");
    if (sqliteValue(database.query("PRAGMA busy_timeout").get(), "timeout") !== 0) {
      throw new Error("SQLite did not apply busy_timeout=0 to the Hub state-root lease");
    }
    if (sqliteValue(database.query("PRAGMA journal_mode").get(), "journal_mode") !== "delete") {
      throw new Error("Hub state-root lease requires journal_mode=DELETE");
    }
    database.exec("CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK (id = 1)) WITHOUT ROWID");
    if (sqliteValue(database.query("PRAGMA locking_mode=EXCLUSIVE").get(), "locking_mode") !== "exclusive") {
      throw new Error("SQLite does not support locking_mode=EXCLUSIVE for the Hub state-root lease");
    }
    database.exec("BEGIN EXCLUSIVE");

    const lockedIdentity = await inspectLeaseFile(leasePath);
    if (lockedIdentity.dev !== identity.dev || lockedIdentity.ino !== identity.ino) {
      throw new Error(`Hub state-root lease was replaced while being acquired: ${leasePath}`);
    }
  } catch (error) {
    try {
      database?.close(true);
    } catch {
      // Preserve the acquisition error.
    }
    if (isSqliteBusy(error)) throw new Error(`Hub state root is already in use: ${stateRoot}`, { cause: error });
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`cannot safely acquire Hub state-root lease at ${leasePath}${detail}`, { cause: error });
  }

  const retainedDatabase = database;
  let releasePromise: Promise<void> | undefined;
  return {
    release() {
      return releasePromise ??= Promise.resolve().then(() => {
        try {
          retainedDatabase.exec("ROLLBACK");
        } finally {
          retainedDatabase.close(true);
        }
      });
    },
  };
}

export async function ensureCredentialStateDirs(stateRoot: string): Promise<void> {
  await assertPrivateDirectory(stateRoot);
  await ensurePrivateDirectory(credentialSecretsPath(stateRoot));
  await ensurePrivateDirectory(credentialGnuPgPath(stateRoot));
  await ensurePrivateDirectory(credentialRuntimePath(stateRoot));
}
