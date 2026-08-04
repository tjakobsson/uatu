// Hub process wiring: config load, state-dir bootstrap, registry load,
// session manager assembly, Bun.serve start, and signal-driven shutdown that
// terminates every child before the hub exits. cli.ts dispatches here for
// `uatu hub` and `uatu hub hash-password`.

import { promises as fs } from "node:fs";

import { LocalProcessBackend } from "./backend";
import { hashPassword } from "./auth";
import { loadHubConfig } from "./config";
import { probeGitRepository } from "./git";
import { WorkspaceRegistry } from "./registry";
import {
  ensureStateDir,
  loadOrCreateSigningKey,
  registryPath,
  resolveHubStateRoot,
} from "./state-dir";
import { startHubServer } from "./server";
import { SessionManager } from "./sessions";

export async function runHub(options: { configPath?: string }): Promise<void> {
  const config = await loadHubConfig(options.configPath);

  // The workspaces root is where repositories LIVE — it must not itself be
  // one. A hub started inside a repo (a natural mistake: `cd myproject &&
  // uatu hub`) is surfaced immediately instead of serving a confusing root.
  await fs.mkdir(config.workspacesDir, { recursive: true });
  const rootProbe = await probeGitRepository(config.workspacesDir);
  if (rootProbe.kind === "repository") {
    throw new Error(
      `workspaces root ${config.workspacesDir} is inside a git repository (${rootProbe.toplevel}). ` +
        `The workspaces root is the folder that CONTAINS your repositories — start the hub from (or point workspacesDir at) their parent folder.`,
    );
  }

  const stateRoot = config.stateDir ?? resolveHubStateRoot();
  await ensureStateDir(stateRoot);
  const signingKey = await loadOrCreateSigningKey(stateRoot);

  const registry = new WorkspaceRegistry(registryPath(stateRoot));
  await registry.load();
  const pruned = await registry.pruneOutsideRoot(config.workspacesDir);
  if (pruned.length > 0) {
    console.error(
      `uatu hub: forgot ${pruned.length} workspace(s) outside the workspaces root (folders untouched): ${pruned
        .map(entry => `${entry.id} (${entry.path})`)
        .join(", ")}`,
    );
  }

  const sessions = new SessionManager(registry, { local: new LocalProcessBackend() });
  const server = startHubServer({ config, registry, sessions, signingKey });

  const scheme = config.tls ? "https" : "http";
  console.log(`${scheme}://${config.host}:${server.port}/`);
  console.error(
    `uatu hub: workspaces in ${config.workspacesDir}; state in ${stateRoot}; ${registry.list().length} registered workspace(s)`,
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
}

// `uatu hub hash-password`: reads the password from stdin (so it never lands
// in shell history or the process table) and prints the hash for the
// config's users list.
export async function runHashPassword(): Promise<void> {
  if (process.stdin.isTTY) {
    process.stderr.write("Password (input is not hidden; pipe stdin to avoid the prompt): ");
  }
  const input = (await new Response(process.stdin as unknown as ReadableStream).text()).trim();
  if (input === "") {
    throw new Error("no password on stdin");
  }
  console.log(await hashPassword(input));
}
