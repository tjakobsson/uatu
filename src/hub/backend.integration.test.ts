// Integration test: the local-process backend spawns a REAL `uatu serve`
// child (from source) and the contract holds end to end — URL on stdout,
// prefixed loopback endpoint, SIGTERM stop.

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LocalProcessBackend, type RunningSession } from "./backend";
import { EMPTY_RESOLVED_CREDENTIAL_CONTEXT } from "./credential-context";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.ts");

const tempDirectories: string[] = [];
let running: RunningSession | null = null;

afterEach(async () => {
  if (running) {
    await running.stop();
    running = null;
  }
  await Promise.all(tempDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-backend-"));
  tempDirectories.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  await writeFile(path.join(dir, "README.md"), "# Backend Test\n");
  return dir;
}

describe("LocalProcessBackend", () => {
  test(
    "starts a real child, serves under the base path, and stops on SIGTERM",
    async () => {
      const workspace = await makeWorkspace();
      const backend = new LocalProcessBackend({ uatuArgv: ["bun", "run", CLI_PATH] });

      running = await backend.start({ id: "backend-test", path: workspace, backend: "local" }, "/s/backend-test/", EMPTY_RESOLVED_CREDENTIAL_CONTEXT);

      expect(running.endpoint.hostname).toBe("127.0.0.1");
      expect(running.endpoint.port).toBeGreaterThan(0);

      const base = `http://${running.endpoint.hostname}:${running.endpoint.port}`;
      const state = await fetch(`${base}/s/backend-test/api/state`);
      expect(state.status).toBe(200);
      const payload = (await state.json()) as { roots: unknown[] };
      expect(Array.isArray(payload.roots)).toBe(true);

      // Outside the prefix the child answers 404 — its internal surface
      // never leaks past the base path.
      const outside = await fetch(`${base}/api/state`);
      expect(outside.status).toBe(404);

      const session = running;
      running = null;
      await session.stop();
      const exitCode = await session.exited;
      // SIGTERM produces a clean shutdown (exit 0) via the CLI's handler.
      expect(exitCode === 0 || exitCode === null).toBe(true);

      // The endpoint is really gone.
      await expect(fetch(`${base}/s/backend-test/api/state`)).rejects.toThrow();
    },
    60_000,
  );

  test(
    "reports a failed start with the child's stderr",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-nongit-"));
      tempDirectories.push(dir);
      // Non-git folder without --force → the CLI's git preflight fails fast.
      const backend = new LocalProcessBackend({ uatuArgv: ["bun", "run", CLI_PATH] });
      await expect(
        backend.start({ id: "nope", path: dir, backend: "local" }, "/s/nope/", EMPTY_RESOLVED_CREDENTIAL_CONTEXT),
      ).rejects.toThrow(/failed to start/);
    },
    60_000,
  );
});

describe("LocalProcessBackend stdout parsing", () => {
  test(
    "a URL split across stream chunks is parsed only once the line completes",
    async () => {
      // A fake child that writes the URL in two chunks with a pause — a
      // premature regex match would yield host "0.0.0.127" and a NaN port.
      // The backend appends its serve args; `bash -c` routes them into
      // $0/$@ where the script ignores them.
      const script = 'printf "http://127"; sleep 0.3; printf ".0.0.1:43210/s/split/?t=abc\n"; sleep 30';
      const backend = new LocalProcessBackend({ uatuArgv: ["bash", "-c", script] });

      running = await backend.start({ id: "split", path: "/tmp", backend: "local" }, "/s/split/", EMPTY_RESOLVED_CREDENTIAL_CONTEXT);
      expect(running.endpoint.hostname).toBe("127.0.0.1");
      expect(running.endpoint.port).toBe(43210);
      expect(running.token).toBe("abc");

      const session = running;
      running = null;
      await session.stop();
    },
    30_000,
  );

  test(
    "a session child inherits the hub's environment, so UATU_OPENCODE_STARTUP_TIMEOUT_MS reaches Chat",
    async () => {
      // The hub builds its children's argv itself, so no `uatu serve` flag can
      // carry an operator's Chat startup budget into a hub-hosted workspace.
      // Environment inheritance is the only channel — assert it end to end
      // rather than trusting that the spawn stays env-free.
      const previous = process.env.UATU_OPENCODE_STARTUP_TIMEOUT_MS;
      process.env.UATU_OPENCODE_STARTUP_TIMEOUT_MS = "45123";
      try {
        const script = 'printf "http://127.0.0.1:43211/s/envcheck/?t=$UATU_OPENCODE_STARTUP_TIMEOUT_MS\n"; sleep 30';
        const backend = new LocalProcessBackend({ uatuArgv: ["bash", "-c", script] });

        running = await backend.start({ id: "envcheck", path: "/tmp", backend: "local" }, "/s/envcheck/", EMPTY_RESOLVED_CREDENTIAL_CONTEXT);
        expect(running.token).toBe("45123");

        const session = running;
        running = null;
        await session.stop();
      } finally {
        if (previous === undefined) delete process.env.UATU_OPENCODE_STARTUP_TIMEOUT_MS;
        else process.env.UATU_OPENCODE_STARTUP_TIMEOUT_MS = previous;
      }
    },
    30_000,
  );
});
