// Hub process wiring: config load, state-dir bootstrap, registry load,
// session manager assembly, Bun.serve start, and signal-driven shutdown that
// terminates every child before the hub exits. cli.ts dispatches here for
// `uatu hub` and `uatu hub hash-password`.

import path from "node:path";

import { LocalProcessBackend, resolveUatuArgv } from "./backend";
import { ManagedSshAgent } from "./credential-ssh-agent";
import { SshCredentialService } from "./credential-ssh";
import { CredentialMetadataStore, CredentialTokenStore, CredentialToolOverrideStore } from "./credential-store";
import { CredentialToolManager, readyToolPath } from "./credential-tools";
import { OpenPgpCredentialManager } from "./openpgp-credentials";
import { TokenCredentialManager } from "./token-credentials";
import { createStoredCloneCredentialResolver, createStoredCredentialContextResolver } from "./credential-context";
import { hashPassword, HubSessionStore } from "./auth";
import { loadHubConfig } from "./config";
import { WorkspaceRegistry } from "./registry";
import { PersonalWorkspaceStateStore } from "./personal-state";
import {
  ensureCredentialStateDirs,
  ensureStateDir,
  credentialGnuPgPath,
  credentialRuntimePath,
  credentialSecretsPath,
  credentialsPath,
  credentialTokenStorePath,
  credentialToolsPath,
  personalWorkspaceStatePath,
  registryPath,
  resolveHubStateRoot,
  sessionsPath,
} from "./state-dir";
import { startHubServer } from "./server";
import { SessionManager } from "./sessions";

export type RunHubOptions = {
  configPath?: string;
  // Overrides the port (config or default); 0 requests an ephemeral port
  // reported by the printed URL.
  port?: number;
  // Orphan backstop for supervising wrappers, mirroring `uatu serve`.
  exitOnStdinClose?: boolean;
};

export async function stopHubRuntime(parts: {
  cloneJobs: { close(): Promise<void> };
  sessions: { stopAll(): Promise<void> };
  sshAgent?: { shutdown(): Promise<void> } | null;
  openPgp?: { shutdown(): Promise<unknown> } | null;
  reportError?: (message: string) => void;
}): Promise<void> {
  const report = parts.reportError ?? (message => console.error(message));
  const settle = async (label: string, operation: () => Promise<unknown>) => {
    const [result] = await Promise.allSettled([Promise.resolve().then(operation)]);
    if (result?.status === "rejected") report(`uatu hub: ${label} shutdown failed`);
    return result;
  };
  await settle("clone job", () => parts.cloneJobs.close());
  await settle("workspace session", () => parts.sessions.stopAll());
  const agents = await Promise.allSettled([
    Promise.resolve().then(() => parts.sshAgent?.shutdown()),
    Promise.resolve().then(() => parts.openPgp?.shutdown()),
  ]);
  if (agents[0]?.status === "rejected") report("uatu hub: SSH agent shutdown failed");
  if (agents[1]?.status === "rejected") report("uatu hub: OpenPGP agent shutdown failed");
}

export async function runHub(options: RunHubOptions): Promise<void> {
  const config = await loadHubConfig(options.configPath);
  if (options.port !== undefined) {
    config.port = options.port;
  }

  const stateRoot = config.stateDir ?? resolveHubStateRoot();
  await ensureStateDir(stateRoot);
  await ensureCredentialStateDirs(stateRoot);
  const sessionStore = new HubSessionStore(sessionsPath(stateRoot));
  await sessionStore.load();

  const registry = new WorkspaceRegistry(registryPath(stateRoot));
  await registry.load();
  const personalState = new PersonalWorkspaceStateStore(personalWorkspaceStatePath(stateRoot));
  await personalState.load();
  await personalState.recoverPendingForgets(workspaceId => registry.byId(workspaceId) !== undefined);

  const credentialMetadata = new CredentialMetadataStore(credentialsPath(stateRoot));
  const credentialTokens = new CredentialTokenStore(credentialTokenStorePath(stateRoot));
  const credentialToolStore = new CredentialToolOverrideStore(credentialToolsPath(stateRoot));
  const credentialTools = new CredentialToolManager(credentialToolStore);
  await Promise.all([credentialMetadata.load(), credentialTokens.load(), credentialTools.load()]);
  let sshAgent: ManagedSshAgent | null = null;
  let sshCredentials: SshCredentialService | null = null;
  let openPgpCredentials: OpenPgpCredentialManager;
  let activePaths = new Map<string, string | null>();
  const contextTools = { gpg: null, sshKeygen: null, gh: null, glab: null } as {
    gpg: string | null; sshKeygen: string | null; gh: string | null; glab: string | null;
  };
  const refreshCredentialRuntime = async () => {
    const paths = new Map(credentialTools.list().map(tool => [tool.tool, readyToolPath(tool)]));
    const sshChanged = (["ssh-agent", "ssh-keygen", "ssh-add"] as const).some(tool => paths.get(tool) !== activePaths.get(tool));
    if (sshChanged) {
      await sshAgent?.shutdown();
      const agentPath = paths.get("ssh-agent");
      const keygenPath = paths.get("ssh-keygen");
      const addPath = paths.get("ssh-add");
      sshAgent = agentPath ? new ManagedSshAgent({ runtimeDirectory: credentialRuntimePath(stateRoot), sshAgentPath: agentPath }) : null;
      sshCredentials = sshAgent && keygenPath && addPath ? new SshCredentialService({
        secretsDirectory: credentialSecretsPath(stateRoot),
        metadataStore: credentialMetadata,
        agent: sshAgent,
        sshKeygenPath: keygenPath,
        sshAddPath: addPath,
      }) : null;
    }
    if (!openPgpCredentials || paths.get("gpg") !== activePaths.get("gpg") || paths.get("gpgconf") !== activePaths.get("gpgconf")) {
      openPgpCredentials = new OpenPgpCredentialManager({
        gnupgHome: credentialGnuPgPath(stateRoot),
        metadataStore: credentialMetadata,
        gpgPath: paths.get("gpg") ?? null,
        gpgconfPath: paths.get("gpgconf") ?? null,
      });
    }
    contextTools.gpg = paths.get("gpg") ?? null;
    contextTools.sshKeygen = paths.get("ssh-keygen") ?? null;
    contextTools.gh = paths.get("gh") ?? null;
    contextTools.glab = paths.get("glab") ?? null;
    activePaths = paths;
  };
  await refreshCredentialRuntime();
  const tokenCredentials = new TokenCredentialManager(credentialMetadata, credentialTokens);
  const credentialContexts = createStoredCredentialContextResolver({
    metadata: credentialMetadata,
    tokens: credentialTokens,
    stateRoot,
    runtimeRoot: credentialRuntimePath(stateRoot),
    gnupgHome: credentialGnuPgPath(stateRoot),
    sshAgentSocket: () => sshAgent?.currentSocket(),
    tools: contextTools,
  });
  const sessions = new SessionManager(registry, { local: new LocalProcessBackend() }, credentialContexts);
  const cloneCredentials = createStoredCloneCredentialResolver({
    metadata: credentialMetadata,
    tokens: credentialTokens,
    stateRoot,
    sshAgentSocket: () => sshAgent?.currentSocket(),
    sshPublicKeyPath: credentialId => path.join(credentialSecretsPath(stateRoot), `${credentialId}.key.pub`),
    sshCredentialUsable: credentialId => sshCredentials?.testUsability(credentialId) ?? Promise.resolve(false),
    uatuArgv: resolveUatuArgv(),
  });
  const server = startHubServer({
    config,
    registry,
    sessions,
    sessionStore,
    personalState,
    cloneCredentials,
    credentialApi: {
      metadata: credentialMetadata,
      tools: credentialTools,
      get ssh() { return sshCredentials; },
      get openpgp() { return openPgpCredentials; },
      tokens: tokenCredentials,
      workspaceExists: workspaceId => registry.byId(workspaceId) !== undefined,
      toolsChanged: refreshCredentialRuntime,
    },
  });

  const scheme = config.tls ? "https" : "http";
  console.log(`${scheme}://${config.host}:${server.port}/`);
  console.error(
    `uatu hub: state in ${stateRoot}; ${registry.list().length} registered workspace(s)`,
  );

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      process.exit(1);
    }
    shuttingDown = true;
    console.error("uatu hub: shutting down");
    void (async () => {
      try {
        await stopHubRuntime({
          cloneJobs: server.cloneJobs,
          sessions,
          sshAgent,
          openPgp: openPgpCredentials,
        });
      } finally {
        server.stop(true);
        process.exit(0);
      }
    })();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);

  // --exit-on-stdin-close: a supervising wrapper (the desktop app) holds our
  // stdin pipe for its whole lifetime. EOF means the supervisor is gone —
  // even by crash — so shut down exactly as SIGTERM would instead of running
  // orphaned with live session children. Same contract as `uatu serve`.
  if (options.exitOnStdinClose && !process.stdin.isTTY) {
    // EOF fires both "end" and "close"; shutdown treats a second call as a
    // force-quit (exit 1), so collapse the pair to one graceful shutdown.
    let stdinGone = false;
    const onStdinGone = () => {
      if (stdinGone) return;
      stdinGone = true;
      shutdown();
    };
    process.stdin.resume();
    process.stdin.on("end", onStdinGone);
    process.stdin.on("close", onStdinGone);
  }
}

// Strips exactly the trailing line terminator from piped password input —
// `printf '%s\n' 'pw' | uatu hub hash-password` must hash `pw`, while a
// password that deliberately begins or ends with spaces must survive
// untouched (login verification preserves whitespace, so hashing must too).
export function passwordFromPipedInput(raw: string): string {
  return raw.replace(/\r?\n$/, "");
}

// `uatu hub hash-password`: reads the password from stdin (so it never lands
// in shell history or the process table) and prints the hash for the
// config's users list. Interactively, one LINE is the password — Enter
// completes the read rather than waiting for EOF.
export async function runHashPassword(): Promise<void> {
  let input: string;
  if (process.stdin.isTTY) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    input = await rl.question("Password (input is not hidden; pipe stdin to avoid the prompt): ");
    rl.close();
  } else {
    input = passwordFromPipedInput(await new Response(process.stdin as unknown as ReadableStream).text());
  }
  if (input === "") {
    throw new Error("no password on stdin");
  }
  console.log(await hashPassword(input));
}
