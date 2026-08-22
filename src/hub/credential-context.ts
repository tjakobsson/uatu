import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WorkspaceEntry } from "./registry";
import { CredentialMetadataStore, CredentialTokenStore } from "./credential-store";
import type {
  CredentialAssignment,
  CredentialRecord,
  OpenPgpCredentialRecord,
  SshCredentialRecord,
  TokenCredentialRecord,
} from "./credential-types";
import { normalizeProviderHost } from "./credential-types";
import { createProviderRuntime } from "./provider-runtime";

export const LOCAL_CREDENTIAL_ASSIGNMENT_WARNING =
  "Local workspace credential assignments configure normal tools only. All workspaces run as the Hub OS user, so same-UID processes can inspect runtime files, reach shared agents, unset the configuration, and use credentials assigned elsewhere.";

export type ResolvedAuthenticationCredential =
  | { host: string; credential: SshCredentialRecord }
  | { host: string; credential: TokenCredentialRecord; token: string };

export type ResolvedSigningCredential = SshCredentialRecord | OpenPgpCredentialRecord;

export type ResolvedCredentialContext = {
  revision: string;
  runtimeRoot: string;
  stateRoot: string;
  sshAgentSocket: string | null;
  gnupgHome: string;
  tools: {
    ssh: string | null;
    git: string | null;
    gpg: string | null;
    sshKeygen: string | null;
    gh: string | null;
    glab: string | null;
  };
  authentication: ResolvedAuthenticationCredential[];
  signing: ResolvedSigningCredential | null;
};

export interface CredentialContextResolver {
  resolve(workspace: WorkspaceEntry): Promise<ResolvedCredentialContext>;
  revision(workspaceId: string): string;
  // Holds the credential runtime steady for the duration of the operation —
  // the session manager wraps resolve-plus-spawn in one section so an
  // ssh-agent override cannot retire the socket and identities between the
  // usability check and the child capturing them.
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

export type CloneCredentialProcessContext =
  | { type: "ssh"; host: string; sshPath: string; agentSocket: string; publicKeyPath: string }
  | { type: "https"; host: string; credentialId: string; stateRoot: string; uatuArgv: string[] };

export type ResolvedCloneCredential = {
  credentialId: string;
  host: string;
  process: CloneCredentialProcessContext;
};

export interface CloneCredentialResolver {
  resolve(remote: string, credentialId?: string): Promise<ResolvedCloneCredential | undefined>;
  assign(workspaceId: string, credential: ResolvedCloneCredential): Promise<void>;
  unassign(workspaceId: string, credential: ResolvedCloneCredential): Promise<void>;
  // Holds the credential runtime steady for the duration of the operation —
  // a selected SSH clone depends on the managed agent's socket and loaded
  // identity for its whole process lifetime, so an ssh-agent override
  // defers until active selected clones exit.
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

export const EMPTY_CLONE_CREDENTIAL_RESOLVER: CloneCredentialResolver = {
  async resolve(_remote, credentialId) {
    if (credentialId) throw new Error(`unknown credential: ${credentialId}`);
    return undefined;
  },
  async assign() {},
  async unassign() {},
  runExclusive: operation => operation(),
};

type CloneRemote = { transport: "ssh" | "https" | "other"; host?: string };

export function parseCloneRemote(remote: string): CloneRemote {
  const scp = /^(?:[^@/:\s]+@)?(\[[^\]]+\]|[^/:\s]+):(.+)$/.exec(remote);
  const windowsDrivePath = /^[A-Za-z]:(?:[\\/]|.*[\\/])/.test(remote);
  if (scp && !windowsDrivePath && !/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    // An IPv6 literal keeps its brackets — that is the normalized host form
    // assignments store and validate; only decorative brackets around a
    // plain host are stripped. The result goes through the same host
    // canonicalizer assignments use (trailing dots, case), falling back to
    // the raw literal for hosts that cannot back an assignment anyway.
    const literal = scp[1]!.toLowerCase();
    const bare = literal.startsWith("[") && !literal.includes(":") ? literal.replace(/^\[|\]$/g, "") : literal;
    let host = bare;
    try {
      host = normalizeProviderHost(bare);
    } catch {
      // Clone-only host: SSH can reach it, but no stored assignment can
      // reference it.
    }
    return { transport: "ssh", host };
  }
  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch {
    return { transport: "other" };
  }
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && (parsed.username || parsed.password)) {
    throw new Error("clone URL must not contain embedded credentials");
  }
  if (parsed.protocol === "https:") {
    // URL.port intentionally erases an explicit default port. Retain the
    // authority spelling so an assignment to :443 remains port-specific.
    const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(remote)?.[1] ?? parsed.host;
    return { transport: "https", host: normalizeProviderHost(authority) };
  }
  if (parsed.protocol === "ssh:" || parsed.protocol === "git+ssh:") {
    return { transport: "ssh", host: normalizeProviderHost(parsed.host) };
  }
  return { transport: "other" };
}

export function createStoredCloneCredentialResolver(options: {
  metadata: CredentialMetadataStore;
  tokens: CredentialTokenStore;
  stateRoot: string;
  sshAgentSocket: () => string | undefined;
  sshPath: () => string | undefined;
  sshPublicKeyPath: (credentialId: string) => string;
  sshCredentialUsable: (credentialId: string) => Promise<boolean>;
  uatuArgv: string[];
  runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
}): CloneCredentialResolver {
  const credential = (credentialId: string): CredentialRecord => {
    const found = options.metadata.snapshot().credentials.find(item => item.id === credentialId);
    if (!found) throw new Error(`unknown credential: ${credentialId}`);
    if (!found.enabled) throw new Error(`credential is disabled: ${credentialId}`);
    return found;
  };
  return {
    runExclusive: options.runExclusive ?? (operation => operation()),
    async resolve(remote, credentialId) {
      const parsed = parseCloneRemote(remote);
      if (!credentialId) return undefined;
      const selected = credential(credentialId);
      if (!parsed.host || parsed.transport === "other") {
        throw new Error("selected credentials require an SSH or HTTPS clone URL");
      }
      if (parsed.transport === "ssh") {
        if (selected.type !== "ssh" || !selected.capabilities.includes("ssh-authentication")) {
          throw new Error("selected credential is not compatible with SSH clone transport");
        }
        const sshPath = options.sshPath();
        if (!sshPath) throw new Error("selected SSH credential requires a configured SSH client");
        // Usability first: after a Hub restart the lazily managed agent has
        // no socket yet, and this check is what starts it and auto-loads an
        // unencrypted key. Reading the socket first would report the key
        // locked after every restart.
        if (!(await options.sshCredentialUsable(selected.id))) {
          throw new Error(`selected SSH credential is locked; unlock it before cloning: ${selected.id}`);
        }
        const agentSocket = options.sshAgentSocket();
        if (!agentSocket) {
          throw new Error(`selected SSH credential is locked; unlock it before cloning: ${selected.id}`);
        }
        return {
          credentialId: selected.id,
          host: parsed.host,
          process: {
            type: "ssh",
            host: parsed.host,
            sshPath,
            agentSocket,
            publicKeyPath: options.sshPublicKeyPath(selected.id),
          },
        };
      }
      if (selected.type !== "token" || !selected.capabilities.includes("https-git")) {
        throw new Error("selected credential is not compatible with HTTPS clone transport");
      }
      if (selected.metadata.host !== parsed.host) {
        throw new Error(`selected credential host does not match clone host: ${selected.metadata.host}`);
      }
      if (options.tokens.get(selected.id) === undefined) {
        throw new Error(`selected token secret is unavailable: ${selected.id}`);
      }
      return {
        credentialId: selected.id,
        host: parsed.host,
        process: {
          type: "https",
          host: parsed.host,
          credentialId: selected.id,
          stateRoot: options.stateRoot,
          uatuArgv: [...options.uatuArgv],
        },
      };
    },
    async assign(workspaceId, selected) {
      // Called inside the workspace's lifecycle queue; the credential lock
      // is the innermost, matching the API assignment route, so credential
      // revocations can trust their assignment snapshot.
      await options.metadata.runExclusiveCredential(selected.credentialId, () => options.metadata.assign({
        workspaceId,
        credentialId: selected.credentialId,
        role: "authentication",
        host: selected.host,
      }));
    },
    async unassign(workspaceId, selected) {
      await options.metadata.unassign(workspaceId, selected.credentialId, "authentication", selected.host);
    },
  };
}

export const EMPTY_RESOLVED_CREDENTIAL_CONTEXT: ResolvedCredentialContext = {
  revision: "none",
  runtimeRoot: "",
  stateRoot: "",
  sshAgentSocket: null,
  gnupgHome: "",
  tools: { ssh: null, git: null, gpg: null, sshKeygen: null, gh: null, glab: null },
  authentication: [],
  signing: null,
};

export const EMPTY_CREDENTIAL_CONTEXT_RESOLVER: CredentialContextResolver = {
  resolve: async () => structuredClone(EMPTY_RESOLVED_CREDENTIAL_CONTEXT),
  revision: () => "none",
  runExclusive: operation => operation(),
};

export type StoredCredentialContextResolverOptions = {
  metadata: CredentialMetadataStore;
  tokens: CredentialTokenStore;
  stateRoot: string;
  runtimeRoot: string;
  gnupgHome: string;
  sshAgentSocket: () => string | undefined;
  sshCredentialUsable: (credentialId: string) => Promise<boolean>;
  openPgpCredentialUsable: (credentialId: string) => Promise<boolean>;
  tools: ResolvedCredentialContext["tools"];
  runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
};

function workspaceState(options: StoredCredentialContextResolverOptions, workspaceId: string): {
  assignments: CredentialAssignment[];
  credentials: Array<SshCredentialRecord | OpenPgpCredentialRecord | TokenCredentialRecord>;
} {
  const state = options.metadata.snapshot();
  const assignments = state.assignments.filter(item => item.workspaceId === workspaceId);
  const ids = new Set(assignments.map(item => item.credentialId));
  return {
    assignments,
    credentials: state.credentials.filter(item => ids.has(item.id)),
  };
}

function contextRevision(options: StoredCredentialContextResolverOptions, workspaceId: string): string {
  const state = workspaceState(options, workspaceId);
  const tokens = state.credentials
    .filter((credential): credential is TokenCredentialRecord => credential.type === "token")
    .map(credential => [credential.id, createHash("sha256").update(options.tokens.get(credential.id) ?? "").digest("hex")]);
  return createHash("sha256").update(JSON.stringify({ ...state, tokens, tools: options.tools })).digest("hex");
}

export function createStoredCredentialContextResolver(
  options: StoredCredentialContextResolverOptions,
): CredentialContextResolver {
  return {
    revision: workspaceId => contextRevision(options, workspaceId),
    runExclusive: options.runExclusive ?? (operation => operation()),
    async resolve(workspace) {
      const { assignments, credentials } = workspaceState(options, workspace.id);
      const byId = new Map(credentials.map(credential => [credential.id, credential]));
      const authentication: ResolvedAuthenticationCredential[] = [];
      let signing: ResolvedSigningCredential | null = null;

      for (const assignment of assignments) {
        const credential = byId.get(assignment.credentialId);
        if (!credential || !credential.enabled) {
          throw new Error(`assigned credential is disabled or unavailable: ${assignment.credentialId}`);
        }
        if (assignment.role === "signing") {
          if (credential.type === "token") throw new Error(`assigned credential cannot sign: ${credential.id}`);
          signing = credential;
          continue;
        }
        if (credential.type === "openpgp") throw new Error(`assigned credential cannot authenticate: ${credential.id}`);
        if (credential.type === "token") {
          const token = options.tokens.get(credential.id);
          if (token === undefined) throw new Error(`assigned token secret is unavailable: ${credential.id}`);
          authentication.push({ host: assignment.host, credential, token });
        } else {
          authentication.push({ host: assignment.host, credential });
        }
      }

      const sshCredentialIds = new Set(authentication
        .filter((item): item is Extract<ResolvedAuthenticationCredential, { credential: SshCredentialRecord }> => item.credential.type === "ssh")
        .map(item => item.credential.id));
      if (signing?.type === "ssh") sshCredentialIds.add(signing.id);
      if (sshCredentialIds.size > 0 && !options.tools.ssh) {
        throw new Error("an assigned SSH credential requires a configured SSH client");
      }
      // Usability before the socket read: after a Hub restart the lazily
      // managed agent has no socket yet, and the usability check is what
      // starts it and auto-loads unencrypted keys. Reading the socket first
      // would block every assigned workspace start until something else
      // touched the agent.
      if (sshCredentialIds.size > 0 && !(await Promise.all(
        [...sshCredentialIds].map(credentialId => options.sshCredentialUsable(credentialId)),
      )).every(Boolean)) {
        throw new Error("an assigned SSH credential is locked; unlock it before starting the workspace");
      }
      const sshAgentSocket = options.sshAgentSocket() ?? null;
      if (sshCredentialIds.size > 0 && !sshAgentSocket) {
        throw new Error("an assigned SSH credential is locked; unlock it before starting the workspace");
      }
      for (const item of authentication) {
        if (item.credential.type !== "token") continue;
        if (item.credential.capabilities.includes("github-cli") && !options.tools.gh) {
          throw new Error("an assigned GitHub CLI credential requires a configured GitHub CLI");
        }
        if (item.credential.capabilities.includes("gitlab-cli") && !options.tools.glab) {
          throw new Error("an assigned GitLab CLI credential requires a configured GitLab CLI");
        }
      }
      if (signing?.type === "openpgp" && !options.tools.gpg) {
        throw new Error("an assigned OpenPGP credential requires configured GnuPG tooling");
      }
      if (signing?.type === "openpgp" && !(await options.openPgpCredentialUsable(signing.id))) {
        throw new Error("the assigned OpenPGP credential is locked; unlock it before starting the workspace");
      }

      return {
        revision: contextRevision(options, workspace.id),
        runtimeRoot: options.runtimeRoot,
        stateRoot: options.stateRoot,
        sshAgentSocket,
        gnupgHome: options.gnupgHome,
        tools: { ...options.tools },
        authentication,
        signing,
      };
    },
  };
}

const AMBIENT_CREDENTIAL_VARIABLES = [
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "SSH_ASKPASS",
  "SSH_ASKPASS_REQUIRE",
  "GIT_ASKPASS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_SYSTEM",
  "GIT_PROXY_COMMAND",
  "GIT_SSL_CERT",
  "GIT_SSL_CERT_PASSWORD_PROTECTED",
  "GIT_SSL_KEY",
  "NETRC",
  "GNUPGHOME",
  "GPG_AGENT_INFO",
  "GH_CONFIG_DIR",
  "GH_HOST",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GLAB_CONFIG_DIR",
  "GITLAB_HOST",
  "GITLAB_TOKEN",
  "GITLAB_ACCESS_TOKEN",
] as const;

export function stripAmbientCredentialEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of AMBIENT_CREDENTIAL_VARIABLES) delete env[key];
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  return env;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function safeWorkspaceId(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(value)) throw new Error("invalid workspace id for credential runtime");
  return value;
}

function gitConfigEnvironment(entries: Array<[string, string]>): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

function isCredentialBearingGitConfig(key: string): boolean {
  const normalized = key.toLowerCase();
  if (normalized.startsWith("include.") || normalized.startsWith("includeif.")) return true;
  if (/^(?:credential|http|imap|remote|sendemail|submodule|svn-remote|url)\./.test(normalized)) return true;
  if (/(?:^|\.)(?:askpass|cookiefile|extraheader|password|passwd|proxy|pushurl|secret|sslcert|sslkey|token|url)$/.test(normalized)) return true;
  if (["core.askpass", "core.gitproxy", "core.sshcommand"].includes(normalized)) return true;
  return false;
}

type GitConfigEntry = { scope: string; origin: string; key: string; value: string };

function parseGitConfigList(output: string): GitConfigEntry[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 3 !== 0) throw new Error("malformed git config output");
  const entries: GitConfigEntry[] = [];
  for (let index = 0; index < fields.length; index += 3) {
    const keyValue = fields[index + 2]!;
    const separator = keyValue.indexOf("\n");
    if (separator < 0) throw new Error("malformed git config entry");
    entries.push({
      scope: fields[index]!,
      origin: fields[index + 1]!,
      key: keyValue.slice(0, separator),
      value: keyValue.slice(separator + 1),
    });
  }
  return entries;
}

const GIT_CONFIG_QUERY_TIMEOUT_MS = 2_000;
const GIT_CONFIG_OUTPUT_LIMIT = 256 * 1024;

async function collectBoundedGitOutput(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  stop: () => void,
): Promise<{ text: string; exceeded: boolean }> {
  const reader = stream.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  let exceeded = false;
  try {
    for (;;) {
      if (signal.aborted) break;
      const next = await reader.read();
      if (next.done) break;
      const remaining = GIT_CONFIG_OUTPUT_LIMIT - size;
      if (remaining > 0) {
        chunks.push(next.value.slice(0, remaining));
        size += Math.min(remaining, next.value.length);
      }
      if (next.value.length > remaining) {
        exceeded = true;
        stop();
        break;
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (signal.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder().decode(bytes), exceeded };
}

async function gitOutput(
  executable: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<string> {
  const child = Bun.spawn([executable, ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  const streams = new AbortController();
  const stop = () => {
    streams.abort();
    if (process.platform === "win32" && child.pid > 0) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 1_000,
        windowsHide: true,
      });
    } else if (child.pid > 0) {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {
        // The process group may already have exited.
      }
    }
    try { child.kill("SIGKILL"); } catch { /* The child already exited. */ }
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, GIT_CONFIG_QUERY_TIMEOUT_MS);
  try {
    const stdoutPromise = collectBoundedGitOutput(child.stdout, streams.signal, stop);
    const stderrPromise = collectBoundedGitOutput(child.stderr, streams.signal, stop);
    const exitCode = await child.exited;
    const drains = Promise.all([stdoutPromise, stderrPromise]);
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const drainTimeout = new Promise<[Awaited<typeof stdoutPromise>, Awaited<typeof stderrPromise>]>(resolve => {
      drainTimer = setTimeout(() => {
        stop();
        void drains.then(resolve);
      }, 100);
    });
    const [stdout, stderr] = await Promise.race([drains, drainTimeout]).finally(() => clearTimeout(drainTimer));
    if (timedOut) throw new Error("git config query timed out");
    if (stdout.exceeded || stderr.exceeded) throw new Error("git config query output exceeded limit");
    if (exitCode !== 0) throw new Error(stderr.text.trim() || `git exited with status ${exitCode}`);
    return stdout.text;
  } finally {
    clearTimeout(timer);
    streams.abort();
  }
}

const ORIGIN_RELATIVE_GIT_PATHS = new Set([
  "commit.template",
  "core.attributesfile",
  "core.excludesfile",
  "diff.orderfile",
  "format.signaturefile",
  "gpg.ssh.allowedsignersfile",
  "gpg.ssh.revocationfile",
  "mailmap.file",
]);

function projectGitConfigValue(entry: GitConfigEntry, home: string | undefined, cwd: string): string {
  if (!ORIGIN_RELATIVE_GIT_PATHS.has(entry.key.toLowerCase())) return entry.value;
  if (entry.value.startsWith("~/") && home) return path.join(home, entry.value.slice(2));
  if (path.isAbsolute(entry.value) || entry.value.startsWith("~") || entry.value.startsWith("%(prefix)")) {
    return entry.value;
  }
  if (!entry.origin.startsWith("file:")) return entry.value;
  const originPath = entry.origin.slice("file:".length);
  return path.resolve(path.dirname(path.resolve(cwd, originPath)), entry.value);
}

function quoteGitConfig(value: string): string {
  if (value.includes("\0") || value.includes("\r")) throw new Error("unsupported control character in git config");
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t")
    .replaceAll("\b", "\\b")}"`;
}

function serializeGitConfig(entries: GitConfigEntry[]): string {
  return entries.map(entry => {
    const firstDot = entry.key.indexOf(".");
    const lastDot = entry.key.lastIndexOf(".");
    const section = entry.key.slice(0, firstDot);
    const name = entry.key.slice(lastDot + 1);
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(section) || !/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) {
      throw new Error("unsupported git config key");
    }
    const subsection = firstDot === lastDot ? "" : ` ${quoteGitConfig(entry.key.slice(firstDot + 1, lastDot))}`;
    return `[${section}${subsection}]\n\t${name} = ${quoteGitConfig(entry.value)}\n`;
  }).join("");
}

async function writeSanitizedGitConfig(options: {
  executable: string;
  cwd: string;
  path: string;
  sourceEnv?: NodeJS.ProcessEnv;
}): Promise<void> {
  const queryEnv = stripAmbientCredentialEnvironment(options.sourceEnv);
  const source = options.sourceEnv ?? process.env;
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM"] as const) {
    if (source[key] !== undefined) queryEnv[key] = source[key]!;
  }
  try {
    const entries = parseGitConfigList(await gitOutput(
      options.executable,
      ["config", "--includes", "--show-scope", "--show-origin", "--null", "--list"],
      options.cwd,
      queryEnv,
    )).filter(entry =>
      !["local", "worktree", "command"].includes(entry.scope) && !isCredentialBearingGitConfig(entry.key));
    const projected = entries.map(entry => ({
      ...entry,
      value: projectGitConfigValue(entry, source.HOME, options.cwd),
    }));
    await fs.writeFile(options.path, serializeGitConfig(projected), { mode: 0o600 });
  } catch {
    // Any query, parse, or serialization failure leaves a valid empty config.
    await fs.writeFile(options.path, "", { mode: 0o600 });
  }
  await fs.chmod(options.path, 0o600);
}

function assertUnambiguousProviderCliAssignments(authentication: ResolvedAuthenticationCredential[]): void {
  for (const [capability, label] of [["github-cli", "GitHub"], ["gitlab-cli", "GitLab"]] as const) {
    const assigned = authentication.filter(item =>
      item.credential.type === "token" && item.credential.capabilities.includes(capability));
    if (assigned.length > 1) {
      throw new Error(`a workspace can use the ${label} CLI credential for only one provider host`);
    }
  }
}

// Parsed directly rather than through the URL parser, which erases an
// explicit :443 as the HTTPS default — an SSH assignment for that port must
// generate a port-restricted match, not a broad host match. Assignment
// hosts are already normalized (`name`, `name:port`, `[v6]`, `[v6]:port`).
function sshAssignmentHost(host: string): { hostname: string; port: string } {
  const parsed = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host);
  return {
    hostname: (parsed?.[1] ?? host).replace(/^\[|\]$/g, ""),
    port: parsed?.[2] ?? "",
  };
}

function canonicalIpv6(hostname: string): string | null {
  if (!hostname.includes(":")) return null;
  const halves = hostname.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right];
  if (words.length !== 8 || words.some(word => !/^[0-9a-f]{1,4}$/i.test(word))) return null;
  return words.map(word => word.replace(/^0+(?=.)/, "").toLowerCase()).join(":");
}

function sshAssignmentHostnames(hostname: string): string[] {
  if (canonicalIpv6(hostname)) return [hostname];
  return [hostname, `${hostname}.`];
}

const SSH_CANONICAL_HOST_FUNCTION = `canonical_ssh_host() {
  value=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  value=\${value#[}
  value=\${value%]}
  value=\${value%.}
  case $value in
    *:*) ;;
    *) printf '%s\\n' "$value"; return ;;
  esac
  case $value in
    *[!0-9a-f:.]*) printf '%s\\n' "$value"; return ;;
  esac
  case $value in
    *.*)
      ipv4=\${value##*:}
      prefix=\${value%:*}
      old_ifs=$IFS
      IFS=.
      set -- $ipv4
      IFS=$old_ifs
      [ "$#" -eq 4 ] || { printf '%s\\n' "$value"; return; }
      for octet in "$@"; do
        case $octet in ''|*[!0-9]*) printf '%s\\n' "$value"; return ;; esac
      done
      first=\${1#0}; first=\${first#0}; first=\${first#0}; first=\${first:-0}
      second=\${2#0}; second=\${second#0}; second=\${second#0}; second=\${second:-0}
      third=\${3#0}; third=\${third#0}; third=\${third#0}; third=\${third:-0}
      fourth=\${4#0}; fourth=\${fourth#0}; fourth=\${fourth#0}; fourth=\${fourth:-0}
      [ "$first" -le 255 ] 2>/dev/null && [ "$second" -le 255 ] 2>/dev/null &&
        [ "$third" -le 255 ] 2>/dev/null && [ "$fourth" -le 255 ] 2>/dev/null || {
          printf '%s\\n' "$value"; return;
        }
      value="$prefix:$(printf '%x:%x' "$((first * 256 + second))" "$((third * 256 + fourth))")"
      ;;
  esac
  case $value in
    *::*) left=\${value%%::*}; right=\${value#*::}; compressed=1 ;;
    *) left=$value; right=; compressed=0 ;;
  esac
  left_words=
  left_count=0
  old_ifs=$IFS
  IFS=:
  for word in $left; do
    word=\${word#0}; word=\${word#0}; word=\${word#0}; word=\${word:-0}
    left_words=\${left_words:+$left_words:}$word
    left_count=$((left_count + 1))
  done
  right_words=
  right_count=0
  for word in $right; do
    word=\${word#0}; word=\${word#0}; word=\${word#0}; word=\${word:-0}
    right_words=\${right_words:+$right_words:}$word
    right_count=$((right_count + 1))
  done
  IFS=$old_ifs
  missing=$((8 - left_count - right_count))
  if [ "$missing" -lt 0 ] || { [ "$compressed" -eq 0 ] && [ "$missing" -ne 0 ]; } ||
    { [ "$compressed" -eq 1 ] && [ "$missing" -eq 0 ]; }; then
    printf '%s\\n' "$value"
    return
  fi
  result=$left_words
  while [ "$missing" -gt 0 ]; do
    result=\${result:+$result:}0
    missing=$((missing - 1))
  done
  [ -n "$right_words" ] && result=\${result:+$result:}$right_words
  printf '%s\\n' "$result"
}`;

function sshMatchExecQuote(command: string): string {
  return `"${command.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function sshIpv6MatchCommand(
  matcherPath: string,
  hostname: string,
  port: string,
  excludedPorts: string[],
): string {
  const mode = port ? "equal" : excludedPorts.length > 0 ? "exclude" : "any";
  const ports = port ? [port] : excludedPorts;
  return [matcherPath.replaceAll("%", "%%"), canonicalIpv6(hostname)!, "%h", mode, "%p", ...ports]
    .map(shellQuote)
    .join(" ");
}

// IdentityFile is additive across matching blocks, so a broad host block must
// exclude every port that another assignment claims for the same hostname —
// otherwise a connection to that port would offer both credentials' keys.
function sshAssignmentMatch(host: string, portsByHostname: Map<string, Set<string>>, matcherPath: string): string {
  const { hostname, port } = sshAssignmentHost(host);
  const excluded = [...(portsByHostname.get(hostname) ?? [])].sort();
  if (canonicalIpv6(hostname)) {
    return `Match exec ${sshMatchExecQuote(sshIpv6MatchCommand(matcherPath, hostname, port, excluded))}`;
  }
  const hosts = sshAssignmentHostnames(hostname).join(",");
  if (port) return `Match host ${hosts} exec "test %p = ${port}"`;
  if (excluded.length === 0) return `Host ${sshAssignmentHostnames(hostname).join(" ")}`;
  return `Match host ${hosts} exec "test ${excluded.map(value => `%p != ${value}`).join(" -a ")}"`;
}

function sshConfigQuote(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function sshHostMatcherScript(): string {
  return [
    "#!/bin/sh",
    SSH_CANONICAL_HOST_FUNCTION,
    "expected=$1",
    "actual=$2",
    "mode=$3",
    "actual_port=$4",
    "shift 4",
    "[ \"$(canonical_ssh_host \"$actual\")\" = \"$expected\" ] || exit 1",
    "case $mode in",
    "  equal) [ \"$actual_port\" = \"$1\" ] || exit 1 ;;",
    "  exclude) for excluded_port in \"$@\"; do [ \"$actual_port\" != \"$excluded_port\" ] || exit 1; done ;;",
    "esac",
    "",
  ].join("\n");
}

function sshShimScript(
  executable: string,
  configPath: string,
  authentication: ResolvedAuthenticationCredential[],
  publicKeys: Map<string, string>,
  agentSocket: string | null,
): string {
  const assignments = authentication.filter(
    (item): item is Extract<ResolvedAuthenticationCredential, { credential: SshCredentialRecord }> => item.credential.type === "ssh",
  );
  const portsByHostname = new Map<string, Set<string>>();
  for (const assignment of assignments) {
    const { hostname, port } = sshAssignmentHost(assignment.host);
    if (!port) continue;
    const ports = portsByHostname.get(hostname) ?? new Set<string>();
    ports.add(port);
    portsByHostname.set(hostname, ports);
  }
  const rules = assignments
    .sort((a, b) => Number(Boolean(sshAssignmentHost(b.host).port)) - Number(Boolean(sshAssignmentHost(a.host).port)))
    .map(assignment => {
      const { hostname, port } = sshAssignmentHost(assignment.host);
      const canonicalHostname = canonicalIpv6(hostname);
      const hostCondition = (canonicalHostname ? [canonicalHostname] : sshAssignmentHostnames(hostname))
        .map(value => `[ "$host" = ${shellQuote(value)} ]`)
        .join(" || ");
      const excluded = [...(portsByHostname.get(hostname) ?? [])]
        .map(value => `[ "$port" != ${shellQuote(value)} ]`)
        .join(" && ");
      const condition = port
        ? `( ${hostCondition} ) && [ "$port" = ${shellQuote(port)} ]`
        : `( ${hostCondition} )${excluded ? ` && ${excluded}` : ""}`;
      return [
        `if ${condition}; then`,
        `  exec ${shellQuote(executable)} -F ${shellQuote(configPath)} -o ${shellQuote(`IdentityAgent=${sshConfigQuote(agentSocket!)}`)} -o ${shellQuote(`IdentityFile=${sshConfigQuote(publicKeys.get(assignment.credential.id)!)}`)} -o IdentitiesOnly=yes "$@"`,
        "fi",
      ].join("\n");
    });
  return [
    "#!/bin/sh",
    SSH_CANONICAL_HOST_FUNCTION,
    "destination=",
    "port=22",
    "takes_value=",
    "for argument in \"$@\"; do",
    "  if [ -n \"$takes_value\" ]; then",
    "    [ \"$takes_value\" = port ] && port=$argument",
    "    if [ \"$takes_value\" = option ]; then",
    "      option=$(printf '%s' \"$argument\" | tr '[:upper:]' '[:lower:]')",
    "      case $option in",
    "        port=*) port=${argument#*=} ;;",
    "        'port '*) port=${argument#* } ;;",
    "        port) takes_value=option_port; continue ;;",
    "      esac",
    "    fi",
    "    [ \"$takes_value\" = option_port ] && port=$argument",
    "    takes_value=",
    "    continue",
    "  fi",
    "  case $argument in",
    "    -p) takes_value=port ;;",
    "    -o) takes_value=option ;;",
    "    -[BbcDEeFIiJLlmOQRSWw]) takes_value=other ;;",
    "    -p*) port=${argument#-p} ;;",
    "    -o*)",
    "      option=${argument#-o}",
    "      option_lower=$(printf '%s' \"$option\" | tr '[:upper:]' '[:lower:]')",
    "      case $option_lower in",
    "        port=*) port=${option#*=} ;;",
    "        'port '*) port=${option#* } ;;",
    "        port) takes_value=option_port ;;",
    "      esac",
    "      ;;",
    "    -*) ;;",
    "    *) destination=$argument; break ;;",
    "  esac",
    "done",
    "host=${destination##*@}",
    "host=${host#[}",
    "host=${host%]}",
    "host=$(canonical_ssh_host \"$host\")",
    ...rules,
    `exec ${shellQuote(executable)} -F ${shellQuote(configPath)} "$@"`,
    "",
  ].join("\n");
}

async function writeCredentialHelper(
  directory: string,
  credentialId: string,
  stateRoot: string,
  uatuArgv: string[],
): Promise<string> {
  const helperPath = path.join(directory, `git-credential-${credentialId}`);
  const command = uatuArgv.map(shellQuote).join(" ");
  const script = [
    "#!/bin/sh",
    `export UATU_HUB_STATE_ROOT=${shellQuote(stateRoot)}`,
    `export UATU_CREDENTIAL_ID=${shellQuote(credentialId)}`,
    `exec ${command} --git-credential-helper "$1"`,
    "",
  ].join("\n");
  await fs.writeFile(helperPath, script, { mode: 0o700 });
  await fs.chmod(helperPath, 0o700);
  return helperPath;
}

export async function buildLocalCredentialEnvironment(options: {
  workspace: WorkspaceEntry;
  context: ResolvedCredentialContext;
  uatuArgv: string[];
  sourceEnv?: NodeJS.ProcessEnv;
}): Promise<{ env: Record<string, string>; runtimeDirectory: string }> {
  const { workspace, context } = options;
  assertUnambiguousProviderCliAssignments(context.authentication);
  const runtimeRoot = context.runtimeRoot || path.join(os.tmpdir(), `uatu-empty-credential-runtime-${process.pid}`);
  const workspaceRuntimeDirectory = path.join(runtimeRoot, "sessions", safeWorkspaceId(workspace.id));
  const runtimeDirectory = path.join(workspaceRuntimeDirectory, randomUUID());
  try {
    await fs.mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(runtimeDirectory, 0o700);
    return await projectLocalCredentialEnvironment(options, runtimeDirectory);
  } catch (error) {
    await fs.rm(runtimeDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function projectLocalCredentialEnvironment(
  options: {
    workspace: WorkspaceEntry;
    context: ResolvedCredentialContext;
    uatuArgv: string[];
    sourceEnv?: NodeJS.ProcessEnv;
  },
  runtimeDirectory: string,
): Promise<{ env: Record<string, string>; runtimeDirectory: string }> {
  const { workspace, context } = options;
  const env = stripAmbientCredentialEnvironment(options.sourceEnv);
  const sshConfigPath = path.join(runtimeDirectory, "ssh_config");
  const sshMatcherPath = path.join(runtimeDirectory, "ssh-host-match");
  const gitConfigPath = path.join(runtimeDirectory, "gitconfig");
  const gitHome = path.join(runtimeDirectory, "git-home");
  const emptyNetrc = path.join(gitHome, ".netrc");
  const sshLines: string[] = [];
  const sshPublicKeys = new Map<string, string>();
  const gitEntries: Array<[string, string]> = [
    ["credential.helper", ""],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
  ];
  let usesSshAgent = false;
  let toolBinCreated = false;
  const exposedTools = new Set<"ssh" | "git" | "gh" | "glab">();

  const toolBin = async (): Promise<string> => {
    const providerBin = path.join(runtimeDirectory, "tool-bin");
    if (!toolBinCreated) {
      await fs.mkdir(providerBin, { mode: 0o700 });
      toolBinCreated = true;
      env.PATH = env.PATH ? `${providerBin}${path.delimiter}${env.PATH}` : providerBin;
    }
    return providerBin;
  };

  const exposeTool = async (name: "git" | "gh" | "glab", executable: string): Promise<void> => {
    if (exposedTools.has(name)) return;
    await fs.symlink(executable, path.join(await toolBin(), name));
    exposedTools.add(name);
  };

  await Promise.all([
    fs.writeFile(gitConfigPath, "", { mode: 0o600 }),
    fs.mkdir(gitHome, { mode: 0o700 }),
  ]);
  await fs.writeFile(emptyNetrc, "", { mode: 0o600 });
  // The explicit empty context is used when credential services are absent
  // (including alternate/test backends), so it retains the historical PATH
  // discovery. A real Hub context has a state root; null there means a
  // configured/default Git probe is unavailable and must not fall back.
  const gitExecutable = context.tools.git ?? (context.stateRoot === ""
    ? Bun.which("git", { PATH: options.sourceEnv?.PATH, cwd: workspace.path })
    : null);
  if (gitExecutable) {
    await writeSanitizedGitConfig({
      executable: gitExecutable,
      cwd: workspace.path,
      path: gitConfigPath,
      sourceEnv: options.sourceEnv,
    });
    const gitShim = path.join(await toolBin(), "git");
    await fs.writeFile(gitShim, [
      "#!/bin/sh",
      `export HOME=${shellQuote(gitHome)}`,
      `export NETRC=${shellQuote(emptyNetrc)}`,
      `exec ${shellQuote(gitExecutable)} "$@"`,
      "",
    ].join("\n"), { mode: 0o700 });
    await fs.chmod(gitShim, 0o700);
    exposedTools.add("git");
  } else {
    const gitShim = path.join(await toolBin(), "git");
    await fs.writeFile(gitShim, [
      "#!/bin/sh",
      `export HOME=${shellQuote(gitHome)}`,
      "exit 127",
      "",
    ].join("\n"), { mode: 0o700 });
    await fs.chmod(gitShim, 0o700);
    exposedTools.add("git");
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = gitConfigPath;
  env.NETRC = emptyNetrc;

  const sshPortsByHostname = new Map<string, Set<string>>();
  for (const assignment of context.authentication) {
    if (assignment.credential.type !== "ssh") continue;
    const { hostname, port } = sshAssignmentHost(assignment.host);
    if (!port) continue;
    const ports = sshPortsByHostname.get(hostname) ?? new Set<string>();
    ports.add(port);
    sshPortsByHostname.set(hostname, ports);
  }

  for (const assignment of context.authentication) {
    const hostUrl = `https://${assignment.host}`;
    if (assignment.credential.type === "ssh") {
      const publicKeyPath = path.join(runtimeDirectory, `${assignment.credential.id}.pub`);
      await fs.writeFile(publicKeyPath, `${assignment.credential.metadata.publicKey}\n`, { mode: 0o600 });
      sshPublicKeys.set(assignment.credential.id, publicKeyPath);
      sshLines.push(
        sshAssignmentMatch(assignment.host, sshPortsByHostname, sshMatcherPath),
        `  IdentityAgent ${sshConfigQuote(context.sshAgentSocket!)}`,
        `  IdentityFile ${sshConfigQuote(publicKeyPath)}`,
        "  IdentitiesOnly yes",
      );
      usesSshAgent = true;
    } else {
      const tokenAssignment = assignment as Extract<ResolvedAuthenticationCredential, { credential: TokenCredentialRecord }>;
      if (assignment.credential.capabilities.includes("https-git")) {
        const helper = await writeCredentialHelper(
          runtimeDirectory,
          assignment.credential.id,
          context.stateRoot,
          options.uatuArgv,
        );
        gitEntries.push([`credential.${hostUrl}.helper`, `!${shellQuote(helper)} "$@"`]);
      }
      if (assignment.credential.capabilities.includes("github-cli") && context.tools.gh) {
        await exposeTool("gh", context.tools.gh);
        Object.assign(env, (await createProviderRuntime(
          "github", runtimeDirectory, workspace.path, tokenAssignment.credential, tokenAssignment.token,
        )).env);
      }
      if (assignment.credential.capabilities.includes("gitlab-cli") && context.tools.glab) {
        await exposeTool("glab", context.tools.glab);
        Object.assign(env, (await createProviderRuntime(
          "gitlab", runtimeDirectory, workspace.path, tokenAssignment.credential, tokenAssignment.token,
        )).env);
      }
    }
  }

  if (context.signing?.type === "ssh") {
    const signingKeyPath = path.join(runtimeDirectory, `${context.signing.id}-signing.pub`);
    await fs.writeFile(signingKeyPath, `${context.signing.metadata.publicKey}\n`, { mode: 0o600 });
    gitEntries.push(["gpg.format", "ssh"], ["user.signingkey", signingKeyPath], ["commit.gpgsign", "true"]);
    if (context.tools.sshKeygen) gitEntries.push(["gpg.ssh.program", context.tools.sshKeygen]);
    usesSshAgent = true;
  } else if (context.signing?.type === "openpgp") {
    gitEntries.push(
      ["gpg.format", "openpgp"],
      ["user.signingkey", context.signing.metadata.fingerprint],
      ["commit.gpgsign", "true"],
      ["gpg.program", context.tools.gpg!],
    );
    env.GNUPGHOME = context.gnupgHome;
  }

  await fs.writeFile(sshMatcherPath, sshHostMatcherScript(), { mode: 0o700 });
  await fs.chmod(sshMatcherPath, 0o700);
  sshLines.push("Host *", "  IdentityAgent none", "  IdentityFile none", "  IdentitiesOnly yes", "");
  await fs.writeFile(sshConfigPath, sshLines.join("\n"), { mode: 0o600 });
  await fs.chmod(sshConfigPath, 0o600);
  if (context.tools.ssh) {
    const sshShim = path.join(await toolBin(), "ssh");
    await fs.writeFile(sshShim, sshShimScript(
      context.tools.ssh,
      sshConfigPath,
      context.authentication,
      sshPublicKeys,
      context.sshAgentSocket,
    ), { mode: 0o700 });
    await fs.chmod(sshShim, 0o700);
    exposedTools.add("ssh");
  } else {
    const sshShim = path.join(await toolBin(), "ssh");
    await fs.writeFile(sshShim, "#!/bin/sh\nexit 127\n", { mode: 0o700 });
    await fs.chmod(sshShim, 0o700);
    exposedTools.add("ssh");
  }
  env.GIT_SSH_COMMAND = `${context.tools.ssh ? shellQuote(context.tools.ssh) : "ssh"} -F ${shellQuote(sshConfigPath)}`;
  if (usesSshAgent) env.SSH_AUTH_SOCK = context.sshAgentSocket!;

  const emptyGithub = path.join(runtimeDirectory, "github-empty");
  const emptyGitlab = path.join(runtimeDirectory, "gitlab-empty");
  const emptyGnupg = path.join(runtimeDirectory, "gnupg-empty");
  await Promise.all([emptyGithub, emptyGitlab, emptyGnupg].map(directory => fs.mkdir(directory, { mode: 0o700 })));
  env.GH_CONFIG_DIR ??= emptyGithub;
  env.GLAB_CONFIG_DIR ??= emptyGitlab;
  env.GNUPGHOME ??= emptyGnupg;
  Object.assign(env, gitConfigEnvironment(gitEntries));
  return { env, runtimeDirectory };
}
