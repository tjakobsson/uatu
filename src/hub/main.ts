// Hub process wiring: config load, state-dir bootstrap, registry load,
// session manager assembly, Bun.serve start, and signal-driven shutdown that
// terminates every child before the hub exits. cli.ts dispatches here for
// `uatu hub` and `uatu hub hash-password`.

import { LocalProcessBackend } from "./backend";
import { hashPassword, HubSessionStore } from "./auth";
import { loadHubConfig } from "./config";
import { WorkspaceRegistry } from "./registry";
import { PersonalWorkspaceStateStore } from "./personal-state";
import {
  ensureStateDir,
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

export async function runHub(options: RunHubOptions): Promise<void> {
  const config = await loadHubConfig(options.configPath);
  if (options.port !== undefined) {
    config.port = options.port;
  }

  const stateRoot = config.stateDir ?? resolveHubStateRoot();
  await ensureStateDir(stateRoot);
  const sessionStore = new HubSessionStore(sessionsPath(stateRoot));
  await sessionStore.load();

  const registry = new WorkspaceRegistry(registryPath(stateRoot));
  await registry.load();
  const personalState = new PersonalWorkspaceStateStore(personalWorkspaceStatePath(stateRoot));
  await personalState.load();
  await personalState.recoverPendingForgets(workspaceId => registry.byId(workspaceId) !== undefined);

  const sessions = new SessionManager(registry, { local: new LocalProcessBackend() });
  const server = startHubServer({ config, registry, sessions, sessionStore, personalState });

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
        await server.cloneJobs.close();
        await sessions.stopAll();
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
