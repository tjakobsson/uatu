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

export async function ensureStateDir(stateRoot: string): Promise<void> {
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
}
