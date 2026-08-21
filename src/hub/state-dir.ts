// Hub state-directory resolution. The hub persists three things across
// restarts: the workspace registry (JSON, not secret), per-user personal
// workspace state, and the session store (secret — its ids are live
// credentials). Everything lives under an XDG-resolved state root, mirroring
// how debug/cache.ts resolves the cache root, and secret files are created
// owner-only.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const LEASE_DIRECTORY = ".hub-lease";
const LEASE_OWNER = "owner.json";
const LEASE_RECLAIM = ".reclaim";
const RELEASE_TIMEOUT_MS = 2_000;

type LeaseOwner = { version: 1; pid: number; nonce: string };

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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLeaseOwner(leasePath: string): Promise<LeaseOwner> {
  const leaseStats = await fs.lstat(leasePath);
  if (leaseStats.isSymbolicLink() || !leaseStats.isDirectory() || (leaseStats.mode & 0o077) !== 0) {
    throw new Error("Hub state-root lease directory is unsafe");
  }
  const ownerPath = path.join(leasePath, LEASE_OWNER);
  const ownerStats = await fs.lstat(ownerPath);
  if (ownerStats.isSymbolicLink() || !ownerStats.isFile() || (ownerStats.mode & 0o077) !== 0) {
    throw new Error("Hub state-root lease owner record is unsafe");
  }
  if (typeof process.getuid === "function" && (leaseStats.uid !== process.getuid() || ownerStats.uid !== process.getuid())) {
    throw new Error("Hub state-root lease is not owned by the current user");
  }
  const value = JSON.parse(await fs.readFile(ownerPath, "utf8")) as Partial<LeaseOwner>;
  if (value.version !== 1 || !Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0 || typeof value.nonce !== "string") {
    throw new Error("Hub state-root lease owner record is corrupt");
  }
  return value as LeaseOwner;
}

export async function acquireHubStateLease(
  stateRoot: string,
  testHooks: { staleOwnerObserved?: () => Promise<void> } = {},
): Promise<HubStateLease> {
  await assertPrivateDirectory(stateRoot);
  const leasePath = path.join(stateRoot, LEASE_DIRECTORY);
  const nonce = randomUUID();
  const owner: LeaseOwner = { version: 1, pid: process.pid, nonce };

  for (;;) {
    const candidate = path.join(stateRoot, `.hub-lease-candidate-${nonce}`);
    await fs.mkdir(candidate, { mode: 0o700 });
    await fs.writeFile(path.join(candidate, LEASE_OWNER), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    try {
      await fs.rename(candidate, leasePath);
      break;
    } catch (error) {
      await fs.rm(candidate, { recursive: true, force: true });
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
    }

    let existing: LeaseOwner;
    try {
      existing = await readLeaseOwner(leasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`cannot verify the existing Hub state-root lease at ${leasePath}`, { cause: error });
    }
    if (processIsAlive(existing.pid)) {
      throw new Error(`Hub state root is already in use by process ${existing.pid}: ${stateRoot}`);
    }
    await testHooks.staleOwnerObserved?.();

    const reclaimPath = path.join(leasePath, LEASE_RECLAIM);
    try {
      await fs.mkdir(reclaimPath, { mode: 0o700 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EEXIST") {
        await new Promise(resolve => setTimeout(resolve, 5));
        continue;
      }
      throw error;
    }

    try {
      const claimed = await readLeaseOwner(leasePath);
      if (claimed.pid !== existing.pid || claimed.nonce !== existing.nonce) continue;
      if (processIsAlive(claimed.pid)) continue;
      await fs.rm(leasePath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      await fs.rm(reclaimPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      const current = await readLeaseOwner(leasePath).catch(() => undefined);
      if (!current || current.nonce !== nonce || current.pid !== process.pid) {
        throw new Error("refusing to release a Hub state-root lease owned by another process");
      }
      const releasedPath = path.join(stateRoot, `.hub-lease-released-${nonce}`);
      await fs.rename(leasePath, releasedPath);
      const cleanup = fs.rm(releasedPath, { recursive: true, force: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          cleanup,
          new Promise<void>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Hub state-root lease cleanup timed out")), RELEASE_TIMEOUT_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export async function ensureCredentialStateDirs(stateRoot: string): Promise<void> {
  await assertPrivateDirectory(stateRoot);
  await ensurePrivateDirectory(credentialSecretsPath(stateRoot));
  await ensurePrivateDirectory(credentialGnuPgPath(stateRoot));
  await ensurePrivateDirectory(credentialRuntimePath(stateRoot));
}
