// Integration test: the local-process backend spawns a REAL `uatu serve`
// child (from source) and the contract holds end to end — URL on stdout,
// prefixed loopback endpoint, SIGTERM stop.

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LocalProcessBackend, type RunningSession } from "./backend";

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

      running = await backend.start({ id: "backend-test", path: workspace, backend: "local" }, "/s/backend-test/");

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
        backend.start({ id: "nope", path: dir, backend: "local" }, "/s/nope/"),
      ).rejects.toThrow(/failed to start/);
    },
    60_000,
  );
});
