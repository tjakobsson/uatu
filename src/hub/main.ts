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
import { CloneJobManager } from "./clone-jobs";
import { CloneProcessAdapter } from "./clone-process";
import { FolderManager } from "./folder-manager";
import { hashPassword, HubSessionStore } from "./auth";
import { loadHubConfig } from "./config";
import { WorkspaceRegistry } from "./registry";
import { PersonalWorkspaceStateStore } from "./personal-state";
import { PathReservationCoordinator } from "./path-reservations";
import {
  ensureCredentialStateDirs,
  ensureCanonicalStateDir,
  acquireHubStateLease,
  credentialGnuPgPath,
  credentialRuntimePath,
  credentialSecretsPath,
  credentialsPath,
  credentialTokenStorePath,
  credentialToolsPath,
  folderMutationJournalPath,
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

export type HubRuntimeShutdownResult = {
  ok: boolean;
  stateLeaseSafeToRelease: boolean;
};

export type HubShutdownResult = {
  exitCode: number;
  stateLeaseHeld: boolean;
};

export async function stopHubRuntime(parts: {
  cloneJobs: { close(): Promise<void> };
  credentialTools?: { shutdown(): Promise<void> } | null;
  sessions: { stopAll(): Promise<void> };
  sshAgent?: { shutdown(): Promise<void> } | null;
  openPgp?: { shutdown(): Promise<unknown> } | null;
  reportError?: (message: string) => void;
}): Promise<HubRuntimeShutdownResult> {
  const report = parts.reportError ?? (message => console.error(message));
  const failures = new Set<string>();
  const settle = async (label: string, operation: () => Promise<unknown>) => {
    const [result] = await Promise.allSettled([Promise.resolve().then(operation)]);
    if (result?.status === "rejected") {
      failures.add(label);
      report(`uatu hub: ${label} shutdown failed`);
    }
    return result;
  };
  await settle("clone job", () => parts.cloneJobs.close());
  await settle("credential tool", () => parts.credentialTools?.shutdown() ?? Promise.resolve());
  await settle("workspace session", () => parts.sessions.stopAll());
  const agents = await Promise.allSettled([
    Promise.resolve().then(() => parts.sshAgent?.shutdown()),
    Promise.resolve().then(() => parts.openPgp?.shutdown()),
  ]);
  if (agents[0]?.status === "rejected") {
    failures.add("SSH agent");
    report("uatu hub: SSH agent shutdown failed");
  }
  if (agents[1]?.status === "rejected") {
    failures.add("OpenPGP agent");
    report("uatu hub: OpenPGP agent shutdown failed");
  }
  return {
    ok: failures.size === 0,
    stateLeaseSafeToRelease: !failures.has("clone job") && !failures.has("workspace session"),
  };
}

export async function shutdownHub(parts: {
  stopServer(): void;
  stateLease: { release(): Promise<void> };
  cloneJobs: { close(): Promise<void> };
  credentialTools?: { shutdown(): Promise<void> } | null;
  sessions: { stopAll(): Promise<void> };
  sshAgent?: { shutdown(): Promise<void> } | null;
  openPgp?: { shutdown(): Promise<unknown> } | null;
  reportError?: (message: string) => void;
}): Promise<HubShutdownResult> {
  const report = parts.reportError ?? (message => console.error(message));
  let serverStopped = true;
  try {
    parts.stopServer();
  } catch {
    serverStopped = false;
    report("uatu hub: server shutdown failed");
  }
  const runtime = await stopHubRuntime({ ...parts, reportError: report });
  let leaseReleased = false;
  if (serverStopped && runtime.stateLeaseSafeToRelease) {
    try {
      await parts.stateLease.release();
      leaseReleased = true;
    } catch (error) {
      report(`uatu hub: state-root lease release failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    report("uatu hub: retaining state-root lease after incomplete shutdown");
  }
  return {
    exitCode: serverStopped && runtime.ok && leaseReleased ? 0 : 1,
    stateLeaseHeld: !leaseReleased,
  };
}

export function createHubSignalShutdown(options: {
  shutdown(): Promise<HubShutdownResult>;
  forceExit?: (code: number) => void;
  reportRetained?: () => void;
}): () => void {
  const forceExit = options.forceExit ?? (code => process.exit(code));
  let state: "running" | "shutting-down" | "lease-retained" = "running";
  return () => {
    if (state !== "running") {
      forceExit(1);
      return;
    }
    state = "shutting-down";
    void Promise.resolve().then(() => options.shutdown()).then(result => {
      if (result.stateLeaseHeld) {
        state = "lease-retained";
        options.reportRetained?.();
        return;
      }
      forceExit(result.exitCode);
    }, () => {
      state = "lease-retained";
      options.reportRetained?.();
    });
  };
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

export async function applyCredentialRuntimeAtomically<State>(
  previous: State,
  next: State,
  apply: (state: State, force: boolean) => Promise<void>,
): Promise<void> {
  try {
    await apply(next, false);
  } catch (error) {
    try {
      await apply(previous, true);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], "credential runtime application and restoration failed");
    }
    throw error;
  }
}

export async function reconcileManagedSshAgent<Agent extends { shutdown(): Promise<void> }>(options: {
  agent: Agent | null;
  agentPath: string | null;
  nextAgentPath: string | null;
  create(path: string): Agent;
}): Promise<{ agent: Agent | null; agentPath: string | null }> {
  if (options.agentPath === options.nextAgentPath) {
    return { agent: options.agent, agentPath: options.agentPath };
  }
  await options.agent?.shutdown();
  return {
    agent: options.nextAgentPath ? options.create(options.nextAgentPath) : null,
    agentPath: options.nextAgentPath,
  };
}

export async function recoverPersistedSshGuardian(
  options: { runtimeDirectory: string; uatuArgv: string[] },
  create: (options: { runtimeDirectory: string; uatuArgv: string[] }) => { recover(): Promise<void> }
    = recoveryOptions => new ManagedSshAgent(recoveryOptions),
): Promise<void> {
  await create(options).recover();
}

export async function runHub(options: RunHubOptions): Promise<void> {
  const config = await loadHubConfig(options.configPath);
  if (options.port !== undefined) {
    config.port = options.port;
  }

  const configuredStateRoot = config.stateDir ?? resolveHubStateRoot();
  const uatuArgv = resolveUatuArgv();
  const stateRoot = await ensureCanonicalStateDir(configuredStateRoot);
  const stateLease = await acquireHubStateLease(stateRoot);
  try {
    await ensureCredentialStateDirs(stateRoot);
  await recoverPersistedSshGuardian({
    runtimeDirectory: credentialRuntimePath(stateRoot),
    uatuArgv,
  });
  const sessionStore = new HubSessionStore(sessionsPath(stateRoot));
  await sessionStore.load();

  const registry = new WorkspaceRegistry(registryPath(stateRoot));
  await registry.load();
  const personalState = new PersonalWorkspaceStateStore(personalWorkspaceStatePath(stateRoot));
  const credentialMetadata = new CredentialMetadataStore(credentialsPath(stateRoot));
  await Promise.all([personalState.load(), credentialMetadata.load()]);
  const credentialTokens = new CredentialTokenStore(credentialTokenStorePath(stateRoot));
  const credentialToolStore = new CredentialToolOverrideStore(credentialToolsPath(stateRoot));
  const credentialTools = new CredentialToolManager(
    credentialToolStore,
    undefined,
    undefined,
    () => applyCredentialRuntime(),
  );
  await Promise.all([credentialTokens.load(), credentialTools.load()]);
  let sshAgent: ManagedSshAgent | null = null;
  let sshAgentExecutable: string | null = null;
  let sshCredentials: SshCredentialService | null = null;
  const sshExplicitLocks = new Set<string>();
  const sshRuntime = createCredentialRuntimeGate(() => sshCredentials);
  let openPgpCredentials!: OpenPgpCredentialManager;
  const openPgpRuntime = createCredentialRuntimeGate(() => openPgpCredentials);
  // A Hub killed without graceful shutdown can leave its dedicated
  // gpg-agent running with cached passphrases; protected keys must be
  // locked after a restart. Recovery (a scoped agent kill) runs on the
  // first runtime build and retries on every re-probe until it succeeds —
  // failing closed with an unavailable manager in between. Ordinary tool
  // refreshes after a successful recovery never kill the agent.
  let openPgpRecoveryPending = true;
  let activePaths = new Map<string, string | null>();
  const contextTools = { ssh: null, git: null, gpg: null, sshKeygen: null, gh: null, glab: null } as {
    ssh: string | null; git: string | null; gpg: string | null; sshKeygen: string | null; gh: string | null; glab: string | null;
  };
  const refreshCredentialRuntime = async (paths: Map<string, string | null>, force: boolean) => {
    const sshChanged = force || (["ssh-agent", "ssh-keygen", "ssh-add"] as const).some(tool => paths.get(tool) !== activePaths.get(tool));
    if (sshChanged) {
      await sshRuntime.replace(async () => {
        const agentPath = paths.get("ssh-agent") ?? null;
        const keygenPath = paths.get("ssh-keygen");
        const addPath = paths.get("ssh-add");
        // Only an ssh-agent change restarts the agent. A key-tool override
        // rebuilds the service around the running agent: restarting would
        // drop every loaded identity, and encrypted keys cannot be restored
        // without their discarded passphrases.
        const reconciled = await reconcileManagedSshAgent({
          agent: sshAgent,
          agentPath: sshAgentExecutable,
          nextAgentPath: agentPath,
          create: sshAgentPath => new ManagedSshAgent({
            runtimeDirectory: credentialRuntimePath(stateRoot),
            sshAgentPath,
            uatuArgv,
          }),
        });
        sshAgent = reconciled.agent;
        sshAgentExecutable = reconciled.agentPath;
        sshCredentials = sshAgent && keygenPath && addPath ? new SshCredentialService({
          secretsDirectory: credentialSecretsPath(stateRoot),
          runtimeDirectory: credentialRuntimePath(stateRoot),
          metadataStore: credentialMetadata,
          agent: sshAgent,
          sshKeygenPath: keygenPath,
          sshAddPath: addPath,
          explicitLocks: sshExplicitLocks,
        }) : null;
      });
    }
    if (force || !openPgpCredentials || paths.get("gpg") !== activePaths.get("gpg") || paths.get("gpgconf") !== activePaths.get("gpgconf") || openPgpRecoveryPending) {
      // Replacement drains the old manager's in-flight operations first: a
      // detached operation could otherwise restart the shared GnuPG agent
      // after a later shutdown killed it through the replacement manager.
      await openPgpRuntime.replace(async () => {
        const replacement = new OpenPgpCredentialManager({
          gnupgHome: credentialGnuPgPath(stateRoot),
          metadataStore: credentialMetadata,
          gpgPath: paths.get("gpg") ?? null,
          gpgconfPath: paths.get("gpgconf") ?? null,
        });
        if (openPgpRecoveryPending) {
          const recovery = await replacement.shutdown();
          // Pending until a scoped agent kill has actually SUCCEEDED — a
          // start without GnuPG tooling must not clear it, or configuring
          // the tools later would skip recovery and reconnect gpg to the
          // survivor's cached passphrases.
          openPgpRecoveryPending = recovery.some(result => result.status === "unavailable");
          if (openPgpRecoveryPending && (paths.get("gpg") ?? paths.get("gpgconf") ?? null) !== null) {
            // Fail closed: gpg could reconnect to the surviving agent and
            // sign with its cached passphrase, so OpenPGP stays unavailable
            // until a re-probe clears the agent. (Without any configured
            // tooling the replacement already reports unavailable.)
            console.error("uatu hub: could not clear a possibly surviving OpenPGP agent; OpenPGP credentials stay unavailable until a tool re-probe succeeds");
            openPgpCredentials = new OpenPgpCredentialManager({
              gnupgHome: credentialGnuPgPath(stateRoot),
              metadataStore: credentialMetadata,
              gpgPath: null,
              gpgconfPath: null,
            });
            return;
          }
        }
        openPgpCredentials = replacement;
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
  const applyCredentialRuntime = () => applyCredentialRuntimeAtomically(
    activePaths,
    new Map(credentialTools.list().map(tool => [tool.tool, readyToolPath(tool)])),
    refreshCredentialRuntime,
  );
  await refreshCredentialRuntime(
    new Map(credentialTools.list().map(tool => [tool.tool, readyToolPath(tool)])),
    false,
  );
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
  const sessions = new SessionManager(
    registry,
    { local: new LocalProcessBackend() },
    credentialContexts,
    // The pending-mutation fence every start is checked against, evaluated
    // inside the queued lifecycle operation. Reached through the closure
    // because the folder manager below takes `sessions` as a dependency; the
    // first start can only come from the server assembled after it.
    () => folderManager.assertNoPendingMutation(),
  );
  const cloneCredentials = createStoredCloneCredentialResolver({
    metadata: credentialMetadata,
    tokens: credentialTokens,
    stateRoot,
    sshAgentSocket: () => sshAgent?.currentSocket(),
    sshPath: () => activePaths.get("ssh") ?? undefined,
    sshPublicKeyPath: credentialId => path.join(credentialSecretsPath(stateRoot), `${credentialId}.key.pub`),
    sshCredentialUsable: sshUsable,
    uatuArgv,
    runExclusive: operation => sshRuntime.run(() => operation()),
  });
  const reservations = new PathReservationCoordinator();
  const folderManager = new FolderManager({
    journalPath: folderMutationJournalPath(stateRoot),
    registry,
    sessions,
    personalState,
    credentials: credentialMetadata,
    reservations,
  });
  await folderManager.recover();
  await personalState.recoverPendingForgets(
    workspaceId => registry.byId(workspaceId) !== undefined,
    async workspaceId => { await credentialMetadata.removeWorkspaceAssignments(workspaceId); },
  );
  const cloneJobs = new CloneJobManager({
    processFactory: new CloneProcessAdapter({ gitCommand: () => activePaths.get("git") ?? path.join(stateRoot, ".unavailable-git") }),
    registry,
    sessions,
    credentials: cloneCredentials,
    reservations,
  });
  const server = startHubServer({
    config,
    registry,
    sessions,
    sessionStore,
    personalState,
    gitCommand: () => activePaths.get("git") ?? path.join(stateRoot, ".unavailable-git"),
    cloneCredentials,
    cloneJobs,
    folderManager,
    reservations,
    credentialApi: {
      metadata: credentialMetadata,
      tools: credentialTools,
      get ssh() { return sshCredentials ? sshOperations : null; },
      openpgp: openPgpOperations,
      tokens: tokenCredentials,
      workspaceExists: workspaceId => registry.byId(workspaceId) !== undefined,
    },
  });

  const scheme = config.tls ? "https" : "http";
  console.log(`${scheme}://${config.host}:${server.port}/`);
  console.error(
    `uatu hub: state in ${stateRoot}; ${registry.list().length} registered workspace(s)`,
  );

  const shutdown = createHubSignalShutdown({
    shutdown: async () => {
      console.error("uatu hub: shutting down");
      // Stop accepting requests before teardown: an already-accepted
      // credential operation could otherwise restart the SSH agent after
      // shutdown observed it stopped, orphaning its socket past exit.
      return await shutdownHub({
        stopServer: () => server.stop(true),
        stateLease,
        cloneJobs: server.cloneJobs,
        credentialTools,
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
            const results = await previous.shutdown();
            // shutdown() reports failure as readiness, not rejection: a
            // failed kill with tooling configured means the Hub-owned
            // agent may survive exit with cached passphrases — surface it
            // through stopHubRuntime instead of exiting silently.
            const gpgConfigured = (activePaths.get("gpg") ?? activePaths.get("gpgconf") ?? null) !== null;
            if (gpgConfigured && results.some(result => result.status === "unavailable")) {
              throw new Error("the Hub OpenPGP agent could not be stopped");
            }
          }),
        },
      });
    },
    reportRetained: () => {
      console.error("uatu hub: shutdown incomplete; state-root lease remains held (send another signal to force exit)");
    },
  });

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
  } catch (error) {
    try {
      await stateLease.release();
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], "Hub startup and state-root lease release failed");
    }
    throw error;
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
