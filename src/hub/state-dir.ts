// Hub state-directory resolution and secret-bearing file creation. The hub
// persists two things across restarts: the workspace registry (JSON, not
// secret) and the cookie-signing key (secret). Both live under an
// XDG-resolved state root, mirroring how debug/cache.ts resolves the cache
// root, and secret files are created owner-only.

import crypto from "node:crypto";
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

export function signingKeyPath(stateRoot: string): string {
  return path.join(stateRoot, "hub.key");
}

export async function ensureStateDir(stateRoot: string): Promise<void> {
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
}

// Loads the persisted HMAC signing key, creating it (32 random bytes, hex,
// file mode 0600) on first run. Restart keeps sessions valid because the key
// persists; deleting the file invalidates every issued cookie.
export async function loadOrCreateSigningKey(stateRoot: string): Promise<string> {
  const keyPath = signingKeyPath(stateRoot);
  try {
    const existing = (await fs.readFile(keyPath, "utf8")).trim();
    if (existing.length >= 32) {
      return existing;
    }
  } catch {
    // Missing or unreadable — create below.
  }
  const key = crypto.randomBytes(32).toString("hex");
  await fs.writeFile(keyPath, `${key}\n`, { mode: 0o600 });
  return key;
}
