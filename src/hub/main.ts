// Hub process wiring: config load, state-dir bootstrap, registry load,
// session manager assembly, Bun.serve start, and signal-driven shutdown that
// terminates every child before the hub exits. cli.ts dispatches here for
// `uatu hub` and `uatu hub hash-password`.

import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

import { LocalProcessBackend, resolveUatuArgv } from "./backend";
import { ManagedSshAgent } from "./credential-ssh-agent";
import { SshCredentialService, type SshCredentialOperations } from "./credential-ssh";
import { CredentialMetadataStore, CredentialTokenStore, CredentialToolOverrideStore } from "./credential-store";
import { CredentialToolManager, readyToolPath } from "./credential-tools";
import { OpenPgpCredentialManager, type OpenPgpCredentialOperations } from "./openpgp-credentials";
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

// Coordinates credential operations with runtime replacement. An operation
// runs against the service captured when it starts; replace() waits for
// in-flight operations to drain and holds new ones until the swap
// completes, so no operation can restart an agent that shutdown() has
// already observed stopped (which would orphan the agent on the fixed
// socket and leave the replacement manager refusing it). Replacements
// queue behind each other: an overlapping call must not overwrite the
// active barrier, or a drained operation could be released against a
// service the later replacement is about to retire.
export function createCredentialRuntimeGate<Service>(current: () => Service): {
  run<T>(operation: (service: Service) => Promise<T>): Promise<T>;
  replace(swap: () => Promise<void>): Promise<void>;
} {
  // A pending count instead of a per-replacement barrier: it increments
  // synchronously in replace(), so a new operation can never slip into the
  // microtask gap between two queued replacements and capture a service the
  // next one is about to retire.
  let pendingReplacements = 0;
  let replacements: Promise<void> = Promise.resolve();
  const operations = new Set<Promise<unknown>>();
  // Reentrancy: an operation running inside the gate (a workspace start
  // section) may issue further gated calls (usability checks); those must
  // piggyback on the enclosing operation rather than wait on a pending
  // replacement that is itself draining the encloser — a deadlock.
  const withinGate = new AsyncLocalStorage<true>();
  const replaceNow = async (swap: () => Promise<void>): Promise<void> => {
    while (operations.size > 0) await Promise.all([...operations]);
    await swap();
  };
  return {
    run(operation) {
      if (withinGate.getStore()) return operation(current());
      return withinGate.run(true, async () => {
        while (pendingReplacements > 0) await replacements;
        // Registered before the operation's synchronous prefix runs, so a
        // replacement arriving at any point sees this section and drains it.
        let release!: () => void;
        const active = new Promise<void>(resolve => {
          release = resolve;
        });
        operations.add(active);
        try {
          return await operation(current());
        } finally {
          operations.delete(active);
          release();
        }
      });
    },
    replace(swap) {
      pendingReplacements += 1;
      const execute = pendingReplacements === 1 ? replaceNow(swap) : replacements.then(() => replaceNow(swap));
      const settled = execute.finally(() => {
        pendingReplacements -= 1;
      });
      replacements = settled.then(() => undefined, () => undefined);
      return settled;
    },
  };
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
  const credentialMetadata = new CredentialMetadataStore(credentialsPath(stateRoot));
  await Promise.all([personalState.load(), credentialMetadata.load()]);
  await personalState.recoverPendingForgets(
    workspaceId => registry.byId(workspaceId) !== undefined,
    async workspaceId => { await credentialMetadata.removeWorkspaceAssignments(workspaceId); },
  );

  const credentialTokens = new CredentialTokenStore(credentialTokenStorePath(stateRoot));
  const credentialToolStore = new CredentialToolOverrideStore(credentialToolsPath(stateRoot));
  const credentialTools = new CredentialToolManager(credentialToolStore);
  await Promise.all([credentialTokens.load(), credentialTools.load()]);
  let sshAgent: ManagedSshAgent | null = null;
  let sshCredentials: SshCredentialService | null = null;
  const sshExplicitLocks = new Set<string>();
  const sshRuntime = createCredentialRuntimeGate(() => sshCredentials);
  let openPgpCredentials!: OpenPgpCredentialManager;
  const openPgpRuntime = createCredentialRuntimeGate(() => openPgpCredentials);
  let activePaths = new Map<string, string | null>();
  const contextTools = { ssh: null, git: null, gpg: null, sshKeygen: null, gh: null, glab: null } as {
    ssh: string | null; git: string | null; gpg: string | null; sshKeygen: string | null; gh: string | null; glab: string | null;
  };
  const refreshCredentialRuntime = async () => {
    const paths = new Map(credentialTools.list().map(tool => [tool.tool, readyToolPath(tool)]));
    const sshChanged = (["ssh-agent", "ssh-keygen", "ssh-add"] as const).some(tool => paths.get(tool) !== activePaths.get(tool));
    if (sshChanged) {
      await sshRuntime.replace(async () => {
        const agentPath = paths.get("ssh-agent");
        const keygenPath = paths.get("ssh-keygen");
        const addPath = paths.get("ssh-add");
        // Only an ssh-agent change restarts the agent. A key-tool override
        // rebuilds the service around the running agent: restarting would
        // drop every loaded identity, and encrypted keys cannot be restored
        // without their discarded passphrases.
        if (agentPath !== activePaths.get("ssh-agent")) {
          await sshAgent?.shutdown();
          sshAgent = agentPath ? new ManagedSshAgent({ runtimeDirectory: credentialRuntimePath(stateRoot), sshAgentPath: agentPath }) : null;
        }
        sshCredentials = sshAgent && keygenPath && addPath ? new SshCredentialService({
          secretsDirectory: credentialSecretsPath(stateRoot),
          metadataStore: credentialMetadata,
          agent: sshAgent,
          sshKeygenPath: keygenPath,
          sshAddPath: addPath,
          explicitLocks: sshExplicitLocks,
        }) : null;
      });
    }
    if (!openPgpCredentials || paths.get("gpg") !== activePaths.get("gpg") || paths.get("gpgconf") !== activePaths.get("gpgconf")) {
      // Replacement drains the old manager's in-flight operations first: a
      // detached operation could otherwise restart the shared GnuPG agent
      // after a later shutdown killed it through the replacement manager.
      await openPgpRuntime.replace(async () => {
        openPgpCredentials = new OpenPgpCredentialManager({
          gnupgHome: credentialGnuPgPath(stateRoot),
          metadataStore: credentialMetadata,
          gpgPath: paths.get("gpg") ?? null,
          gpgconfPath: paths.get("gpgconf") ?? null,
        });
      });
    }
    contextTools.git = paths.get("git") ?? null;
    contextTools.ssh = paths.get("ssh") ?? null;
    contextTools.gpg = paths.get("gpg") ?? null;
    contextTools.sshKeygen = paths.get("ssh-keygen") ?? null;
    contextTools.gh = paths.get("gh") ?? null;
    contextTools.glab = paths.get("glab") ?? null;
    activePaths = paths;
  };
  await refreshCredentialRuntime();
  // A Hub killed without graceful shutdown can leave its dedicated
  // gpg-agent running with cached passphrases; protected keys must be
  // locked after a restart, so clear any surviving agent before readiness
  // is exposed. Startup-only — tool-override refreshes must not relock
  // credentials.
  await openPgpCredentials.shutdown();
  const requireSshService = (service: SshCredentialService | null): SshCredentialService => {
    if (!service) throw new Error("OpenSSH credential tooling is unavailable");
    return service;
  };
  // Every SSH credential operation goes through the gate so a tool-override
  // refresh cannot swap the agent/service pair out from under it.
  const sshOperations: SshCredentialOperations = {
    generate: (name, capabilities, passphrase) => sshRuntime.run(service => requireSshService(service).generate(name, capabilities, passphrase)),
    import: (name, capabilities, privateKey, passphrase) => sshRuntime.run(service => requireSshService(service).import(name, capabilities, privateKey, passphrase)),
    unlock: (credentialId, passphrase) => sshRuntime.run(service => requireSshService(service).unlock(credentialId, passphrase)),
    lock: credentialId => sshRuntime.run(service => requireSshService(service).lock(credentialId)),
    setEnabled: (credentialId, enabled) => sshRuntime.run(service => requireSshService(service).setEnabled(credentialId, enabled)),
    delete: (credentialId, unassign) => sshRuntime.run(service => requireSshService(service).delete(credentialId, unassign)),
    testUsability: credentialId => sshRuntime.run(service => service?.testUsability(credentialId) ?? Promise.resolve(false)),
  };
  const sshUsable = (credentialId: string) => sshOperations.testUsability(credentialId);
  // OpenPGP operations go through their gate for the same reason.
  const openPgpOperations: OpenPgpCredentialOperations = {
    generate: input => openPgpRuntime.run(manager => manager.generate(input)),
    import: input => openPgpRuntime.run(manager => manager.import(input)),
    unlock: (credentialId, passphrase) => openPgpRuntime.run(manager => manager.unlock(credentialId, passphrase)),
    enable: credentialId => openPgpRuntime.run(manager => manager.enable(credentialId)),
    disable: credentialId => openPgpRuntime.run(manager => manager.disable(credentialId)),
    delete: (credentialId, unassign) => openPgpRuntime.run(manager => manager.delete(credentialId, unassign)),
    test: credentialId => openPgpRuntime.run(manager => manager.test(credentialId)),
    readiness: credentialId => openPgpRuntime.run(manager => manager.readiness(credentialId)),
  };
  const tokenCredentials = new TokenCredentialManager(credentialMetadata, credentialTokens);
  const credentialContexts = createStoredCredentialContextResolver({
    metadata: credentialMetadata,
    tokens: credentialTokens,
    stateRoot,
    runtimeRoot: credentialRuntimePath(stateRoot),
    gnupgHome: credentialGnuPgPath(stateRoot),
    sshAgentSocket: () => sshAgent?.currentSocket(),
    sshCredentialUsable: sshUsable,
    openPgpCredentialUsable: async credentialId => {
      const readiness = await openPgpOperations.test(credentialId);
      return readiness.every(result => result.status !== "unavailable");
    },
    tools: contextTools,
    runExclusive: operation => sshRuntime.run(() => operation()),
  });
  const sessions = new SessionManager(registry, { local: new LocalProcessBackend() }, credentialContexts);
  const cloneCredentials = createStoredCloneCredentialResolver({
    metadata: credentialMetadata,
    tokens: credentialTokens,
    stateRoot,
    sshAgentSocket: () => sshAgent?.currentSocket(),
    sshPath: () => activePaths.get("ssh") ?? undefined,
    sshPublicKeyPath: credentialId => path.join(credentialSecretsPath(stateRoot), `${credentialId}.key.pub`),
    sshCredentialUsable: sshUsable,
    uatuArgv: resolveUatuArgv(),
    runExclusive: operation => sshRuntime.run(() => operation()),
  });
  const server = startHubServer({
    config,
    registry,
    sessions,
    sessionStore,
    personalState,
    gitCommand: () => activePaths.get("git") ?? "git",
    cloneCredentials,
    credentialApi: {
      metadata: credentialMetadata,
      tools: credentialTools,
      get ssh() { return sshCredentials ? sshOperations : null; },
      openpgp: openPgpOperations,
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
        // Stop accepting requests before teardown: an already-accepted
        // credential operation could otherwise restart the SSH agent after
        // shutdown observed it stopped, orphaning its socket past exit.
        server.stop(true);
        await stopHubRuntime({
          cloneJobs: server.cloneJobs,
          sessions,
          sshAgent: {
            // Final agent shutdown goes through the runtime gate: in-flight
            // gated operations drain first, and swapping the service to null
            // keeps any operation still waiting on the gate from starting a
            // replacement agent.
            shutdown: () => sshRuntime.replace(async () => {
              const agent = sshAgent;
              sshAgent = null;
              sshCredentials = null;
              await agent?.shutdown();
            }),
          },
          openPgp: {
            // Same shape for OpenPGP: drain gated operations, then swap in a
            // tooling-unavailable manager before killing the agent, so a
            // waiting operation cannot restart the shared GnuPG agent after
            // exit.
            shutdown: () => openPgpRuntime.replace(async () => {
              const previous = openPgpCredentials;
              openPgpCredentials = new OpenPgpCredentialManager({
                gnupgHome: credentialGnuPgPath(stateRoot),
                metadataStore: credentialMetadata,
                gpgPath: null,
                gpgconfPath: null,
              });
              await previous.shutdown();
            }),
          },
        });
      } finally {
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
