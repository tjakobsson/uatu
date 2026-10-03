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
// A lock that stays busy for this long is a live owner's; anything shorter is
// another contender mid-setup. It bounds how long a refused start waits.
const LEASE_CONTENTION_WINDOW_MS = 500;
// Per attempt, SQLite's own busy handler lets a writer holding PENDING drain
// the other contenders' momentary SHARED reads instead of failing at once.
const LEASE_ATTEMPT_BUSY_TIMEOUT_MS = 20;
const LEASE_RETRY_MIN_DELAY_MS = 5;
const LEASE_RETRY_JITTER_MS = 20;

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

// What finished where, and who has seen it: the live broker's finished and
// viewed marks, kept so a restart does not forget them (src/hub/activity-marks.ts).
export function activityMarksPath(stateRoot: string): string {
  return path.join(stateRoot, "activity-marks.json");
}

export function folderMutationJournalPath(stateRoot: string): string {
  return path.join(stateRoot, "pending-folder-mutation.json");
}

export function hubPreferencesPath(stateRoot: string): string {
  return path.join(stateRoot, "hub-preferences.json");
}

export function onboardingJournalPath(stateRoot: string): string {
  return path.join(stateRoot, "pending-onboarding.json");
}

// The pending worktree operation: one at a time, written before any Git
// mutation so restart recovery can reconcile it against actual Git state.
export function worktreeJournalPath(stateRoot: string): string {
  return path.join(stateRoot, "pending-worktree-operation.json");
}

// Durable creation provenance, deliberately OUTLIVING registration: forget
// keeps it, re-registering the same verified checkout recovers it, and a
// reused path never inherits it.
export function worktreeProvenancePath(stateRoot: string): string {
  return path.join(stateRoot, "worktree-provenance.json");
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

// The working directory of the Hub's own short-lived agent runtimes, which
// exist only to read and change the machine's agent logins. Nothing secret is
// written here: logins live in each agent's own store.
export function agentAccountsPath(stateRoot: string): string {
  return path.join(stateRoot, "agent-accounts");
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

// One acquisition attempt on a fresh connection: schema setup, then the
// lifelong EXCLUSIVE transaction. Throws SQLITE_BUSY if any step meets a lock.
function openLeaseAttempt(database: Database): void {
  database.exec(`PRAGMA busy_timeout=${LEASE_ATTEMPT_BUSY_TIMEOUT_MS}`);
  if (sqliteValue(database.query("PRAGMA busy_timeout").get(), "timeout") !== LEASE_ATTEMPT_BUSY_TIMEOUT_MS) {
    throw new Error(`SQLite did not apply busy_timeout=${LEASE_ATTEMPT_BUSY_TIMEOUT_MS} to the Hub state-root lease`);
  }
  if (sqliteValue(database.query("PRAGMA journal_mode").get(), "journal_mode") !== "delete") {
    throw new Error("Hub state-root lease requires journal_mode=DELETE");
  }
  database.exec("CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK (id = 1)) WITHOUT ROWID");
  if (sqliteValue(database.query("PRAGMA locking_mode=EXCLUSIVE").get(), "locking_mode") !== "exclusive") {
    throw new Error("SQLite does not support locking_mode=EXCLUSIVE for the Hub state-root lease");
  }
  database.exec("BEGIN EXCLUSIVE");
}

export async function acquireHubStateLease(
  stateRoot: string,
  options: { contentionWindowMs?: number } = {},
): Promise<HubStateLease> {
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
  const contentionWindowMs = options.contentionWindowMs ?? LEASE_CONTENTION_WINDOW_MS;
  const deadline = Date.now() + contentionWindowMs;
  let retainedDatabase: Database | undefined;
  while (retainedDatabase === undefined) {
    let database: Database | undefined;
    try {
      database = new Database(leasePath, LEASE_OPEN_FLAGS);
      openLeaseAttempt(database);
      const lockedIdentity = await inspectLeaseFile(leasePath);
      if (lockedIdentity.dev !== identity.dev || lockedIdentity.ino !== identity.ino) {
        throw new Error(`Hub state-root lease was replaced while being acquired: ${leasePath}`);
      }
      retainedDatabase = database;
    } catch (error) {
      try {
        database?.close(true);
      } catch {
        // Preserve the acquisition error.
      }
      if (isSqliteBusy(error)) {
        // Busy is ambiguous: a live owner holds its EXCLUSIVE lock for life,
        // but another contender's schema setup or lock upgrade holds a lock
        // for only a moment — and with no retry, first-time contenders can
        // each see the others' transient locks and all give up. Only a lock
        // that stays held for the whole window is an owner.
        if (Date.now() < deadline) {
          await Bun.sleep(LEASE_RETRY_MIN_DELAY_MS + Math.random() * LEASE_RETRY_JITTER_MS);
          continue;
        }
        throw new Error(`Hub state root is already in use: ${stateRoot}`, { cause: error });
      }
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new Error(`cannot safely acquire Hub state-root lease at ${leasePath}${detail}`, { cause: error });
    }
  }

  const heldDatabase = retainedDatabase;
  let releasePromise: Promise<void> | undefined;
  return {
    release() {
      return releasePromise ??= Promise.resolve().then(() => {
        try {
          heldDatabase.exec("ROLLBACK");
        } finally {
          heldDatabase.close(true);
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
  await ensurePrivateDirectory(agentAccountsPath(stateRoot));
}
