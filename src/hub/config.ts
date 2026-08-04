// Hub configuration: file format, defaults, and validation. Side-effect-free
// on import; the loader reads exactly one JSON file and never writes.
//
// {
//   "port": 4700,
//   "host": "127.0.0.1",
//   "tls": { "cert": "/path/fullchain.pem", "key": "/path/key.pem" },
//   "users": [{ "name": "tobias", "passwordHash": "$argon2id$..." }],
//   "workspacesDir": "~/workspaces",        // default: the hub's cwd
//   "stateDir": "~/.local/state/uatu-hub"   // optional override
// }

import os from "node:os";
import path from "node:path";

export const DEFAULT_HUB_PORT = 4700;

export type HubUser = {
  name: string;
  passwordHash: string;
};

export type HubTlsConfig = {
  cert: string;
  key: string;
};

export type HubConfig = {
  port: number;
  host: string;
  tls: HubTlsConfig | null;
  users: HubUser[];
  // The workspaces root: the directory whose subfolders are this hub's
  // workspaces and where `git clone` creates new ones. Defaults to the
  // working directory the hub was started in. Must NOT itself be inside a
  // git worktree (enforced at startup, not here — parsing stays pure).
  workspacesDir: string;
  // Optional override for the XDG state dir (registry + signing key).
  stateDir?: string;
};

export function defaultHubConfigPath(env: Record<string, string | undefined> = process.env): string {
  const configHome =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== ""
      ? env.XDG_CONFIG_HOME
      : path.join(os.homedir(), ".config");
  return path.join(configHome, "uatu", "hub.json");
}

export function expandHomePath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

// Parses and validates a hub config object (already JSON-parsed). Throws
// descriptive errors — hub startup surfaces them verbatim, so each message
// names the offending field.
export function parseHubConfig(raw: unknown, defaultWorkspacesDir: string = process.cwd()): HubConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("hub config must be a JSON object");
  }
  const record = raw as Record<string, unknown>;

  let port = DEFAULT_HUB_PORT;
  if (record.port !== undefined) {
    if (typeof record.port !== "number" || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) {
      throw new Error(`hub config: invalid port: ${JSON.stringify(record.port)}`);
    }
    port = record.port;
  }

  let host = "127.0.0.1";
  if (record.host !== undefined) {
    if (typeof record.host !== "string" || record.host.trim() === "") {
      throw new Error("hub config: host must be a non-empty string");
    }
    host = record.host;
  }

  let tls: HubTlsConfig | null = null;
  if (record.tls !== undefined && record.tls !== null) {
    const tlsRecord = record.tls as Record<string, unknown>;
    if (typeof tlsRecord !== "object" || Array.isArray(tlsRecord)) {
      throw new Error("hub config: tls must be an object with cert and key");
    }
    if (typeof tlsRecord.cert !== "string" || typeof tlsRecord.key !== "string") {
      throw new Error("hub config: tls requires both cert and key file paths");
    }
    tls = { cert: expandHomePath(tlsRecord.cert), key: expandHomePath(tlsRecord.key) };
  }

  // The security floor: a hub reachable beyond loopback must terminate TLS
  // itself. Plain HTTP stays available on loopback for operators fronting
  // the hub with their own reverse proxy.
  if (!isLoopbackHost(host) && tls === null) {
    throw new Error(
      `hub config: refusing to listen on non-loopback host '${host}' without TLS — configure tls.cert/tls.key, or bind loopback behind your own HTTPS proxy`,
    );
  }

  if (!Array.isArray(record.users) || record.users.length === 0) {
    throw new Error("hub config: users must be a non-empty array — run 'uatu hub hash-password' to create an entry");
  }
  const users: HubUser[] = [];
  const seenNames = new Set<string>();
  for (const entry of record.users) {
    const user = entry as Record<string, unknown>;
    if (typeof user !== "object" || user === null || typeof user.name !== "string" || user.name.trim() === "") {
      throw new Error("hub config: every user needs a non-empty name");
    }
    if (typeof user.passwordHash !== "string" || user.passwordHash.trim() === "") {
      throw new Error(`hub config: user '${user.name}' needs a passwordHash — run 'uatu hub hash-password'`);
    }
    if (seenNames.has(user.name)) {
      throw new Error(`hub config: duplicate user name '${user.name}'`);
    }
    seenNames.add(user.name);
    users.push({ name: user.name, passwordHash: user.passwordHash });
  }

  let workspacesDir = defaultWorkspacesDir;
  if (record.workspacesDir !== undefined) {
    if (typeof record.workspacesDir !== "string" || record.workspacesDir.trim() === "") {
      throw new Error("hub config: workspacesDir must be a non-empty string");
    }
    workspacesDir = expandHomePath(record.workspacesDir);
  }

  let stateDir: string | undefined;
  if (record.stateDir !== undefined) {
    if (typeof record.stateDir !== "string" || record.stateDir.trim() === "") {
      throw new Error("hub config: stateDir must be a non-empty string");
    }
    stateDir = expandHomePath(record.stateDir);
  }

  return { port, host, tls, users, workspacesDir, stateDir };
}

export async function loadHubConfig(configPath?: string): Promise<HubConfig> {
  const resolved = configPath ? expandHomePath(configPath) : defaultHubConfigPath();
  const file = Bun.file(resolved);
  if (!(await file.exists())) {
    throw new Error(`hub config not found: ${resolved}`);
  }
  let raw: unknown;
  try {
    raw = await file.json();
  } catch (error) {
    throw new Error(`hub config is not valid JSON (${resolved}): ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseHubConfig(raw);
}
