// Hub state-directory resolution. The hub persists three things across
// restarts: the workspace registry (JSON, not secret), per-user personal
// workspace state, and the session store (secret — its ids are live
// credentials). Everything lives under an XDG-resolved state root, mirroring
// how debug/cache.ts resolves the cache root, and secret files are created
// owner-only.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

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

export async function ensureCredentialStateDirs(stateRoot: string): Promise<void> {
  await assertPrivateDirectory(stateRoot);
  await ensurePrivateDirectory(credentialSecretsPath(stateRoot));
  await ensurePrivateDirectory(credentialGnuPgPath(stateRoot));
  await ensurePrivateDirectory(credentialRuntimePath(stateRoot));
}
