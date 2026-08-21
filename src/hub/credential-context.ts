import { createHash, randomUUID } from "node:crypto";
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
}

export type CloneCredentialProcessContext =
  | { type: "ssh"; host: string; agentSocket: string; publicKeyPath: string }
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
}

export const EMPTY_CLONE_CREDENTIAL_RESOLVER: CloneCredentialResolver = {
  async resolve(_remote, credentialId) {
    if (credentialId) throw new Error(`unknown credential: ${credentialId}`);
    return undefined;
  },
  async assign() {},
  async unassign() {},
};

type CloneRemote = { transport: "ssh" | "https" | "other"; host?: string };

export function parseCloneRemote(remote: string): CloneRemote {
  const scp = /^(?:[^@/:\s]+@)?(\[[^\]]+\]|[^/:\s]+):[^/].*$/.exec(remote);
  if (scp && !/^[A-Za-z]:[\\/]/.test(remote)) {
    const host = scp[1]!.replace(/^\[|\]$/g, "").toLowerCase();
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
    return { transport: "https", host: normalizeProviderHost(parsed.host) };
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
  sshPublicKeyPath: (credentialId: string) => string;
  sshCredentialUsable: (credentialId: string) => Promise<boolean>;
  uatuArgv: string[];
}): CloneCredentialResolver {
  const credential = (credentialId: string): CredentialRecord => {
    const found = options.metadata.snapshot().credentials.find(item => item.id === credentialId);
    if (!found) throw new Error(`unknown credential: ${credentialId}`);
    if (!found.enabled) throw new Error(`credential is disabled: ${credentialId}`);
    return found;
  };
  return {
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
        const agentSocket = options.sshAgentSocket();
        if (!agentSocket || !(await options.sshCredentialUsable(selected.id))) {
          throw new Error(`selected SSH credential is locked; unlock it before cloning: ${selected.id}`);
        }
        return {
          credentialId: selected.id,
          host: parsed.host,
          process: {
            type: "ssh",
            host: parsed.host,
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
      await options.metadata.assign({
        workspaceId,
        credentialId: selected.credentialId,
        role: "authentication",
        host: selected.host,
      });
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
  tools: { git: null, gpg: null, sshKeygen: null, gh: null, glab: null },
  authentication: [],
  signing: null,
};

export const EMPTY_CREDENTIAL_CONTEXT_RESOLVER: CredentialContextResolver = {
  resolve: async () => structuredClone(EMPTY_RESOLVED_CREDENTIAL_CONTEXT),
  revision: () => "none",
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
      const sshAgentSocket = options.sshAgentSocket() ?? null;
      if (sshCredentialIds.size > 0 && (!sshAgentSocket || !(await Promise.all(
        [...sshCredentialIds].map(credentialId => options.sshCredentialUsable(credentialId)),
      )).every(Boolean))) {
        throw new Error("an assigned SSH credential is locked; unlock it before starting the workspace");
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
  "GIT_CONFIG_PARAMETERS",
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

function assertUnambiguousProviderCliAssignments(authentication: ResolvedAuthenticationCredential[]): void {
  for (const [capability, label] of [["github-cli", "GitHub"], ["gitlab-cli", "GitLab"]] as const) {
    const assigned = authentication.filter(item =>
      item.credential.type === "token" && item.credential.capabilities.includes(capability));
    if (assigned.length > 1) {
      throw new Error(`a workspace can use the ${label} CLI credential for only one provider host`);
    }
  }
}

function sshAssignmentMatch(host: string): string {
  const parsed = new URL(`https://${host}`);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  return parsed.port
    ? `Match host ${hostname} exec "test %p = ${parsed.port}"`
    : `Host ${hostname}`;
}

function sshConfigQuote(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
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
  await fs.rm(workspaceRuntimeDirectory, { recursive: true, force: true });
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
  const sshLines: string[] = [];
  const gitEntries: Array<[string, string]> = [
    ["credential.helper", ""],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
  ];
  let usesSshAgent = false;
  let toolBinCreated = false;
  const exposedTools = new Set<"git" | "gh" | "glab">();

  const exposeTool = async (name: "git" | "gh" | "glab", executable: string): Promise<void> => {
    if (exposedTools.has(name)) return;
    const providerBin = path.join(runtimeDirectory, "tool-bin");
    if (!toolBinCreated) {
      await fs.mkdir(providerBin, { mode: 0o700 });
      toolBinCreated = true;
      env.PATH = env.PATH ? `${providerBin}${path.delimiter}${env.PATH}` : providerBin;
    }
    await fs.symlink(executable, path.join(providerBin, name));
    exposedTools.add(name);
  };

  if (context.tools.git) await exposeTool("git", context.tools.git);

  for (const assignment of context.authentication) {
    const hostUrl = `https://${assignment.host}`;
    if (assignment.credential.type === "ssh") {
      const publicKeyPath = path.join(runtimeDirectory, `${assignment.credential.id}.pub`);
      await fs.writeFile(publicKeyPath, `${assignment.credential.metadata.publicKey}\n`, { mode: 0o600 });
      sshLines.push(
        sshAssignmentMatch(assignment.host),
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
        gitEntries.push([`credential.${hostUrl}.helper`, helper]);
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

  sshLines.push("Host *", "  IdentityAgent none", "  IdentityFile none", "  IdentitiesOnly yes", "");
  await fs.writeFile(sshConfigPath, sshLines.join("\n"), { mode: 0o600 });
  await fs.chmod(sshConfigPath, 0o600);
  env.GIT_SSH_COMMAND = `ssh -F ${shellQuote(sshConfigPath)}`;
  if (usesSshAgent) env.SSH_AUTH_SOCK = context.sshAgentSocket!;

  const emptyGithub = path.join(runtimeDirectory, "github-empty");
  const emptyGitlab = path.join(runtimeDirectory, "gitlab-empty");
  await Promise.all([emptyGithub, emptyGitlab].map(directory => fs.mkdir(directory, { mode: 0o700 })));
  env.GH_CONFIG_DIR ??= emptyGithub;
  env.GLAB_CONFIG_DIR ??= emptyGitlab;
  Object.assign(env, gitConfigEnvironment(gitEntries));
  return { env, runtimeDirectory };
}
