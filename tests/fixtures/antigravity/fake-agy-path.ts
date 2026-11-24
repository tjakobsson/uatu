// Puts the fake `agy` (fake-agy.ts) on a PATH of its own for one test, with a
// fresh state directory. Nothing here runs a real agy or reaches the network.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type FakeAgy = {
  // A directory holding only the `agy` wrapper, for PATH.
  binDirectory: string;
  executable: string;
  stateDirectory: string;
  // The fake's view of the world, for the workspace's cwd.
  workspace: string;
  env: NodeJS.ProcessEnv;
  // Every request and notification the fake received, in order.
  log(): Promise<Array<{ method: string; params?: Record<string, unknown>; outcome?: Record<string, unknown> }>>;
  setFlag(name: "auth-missing" | "crash-on-prompt" | "no-image" | "refuse-steer" | "refuse-next-steer" | "hold-take-in" | "fail-thought-level" | "crash-on-steer" | "hang-initialize" | "hang-list" | "orphan-child" | "hold-config" | "fail-load" | "legacy-only" | "no-legacy-models" | "end-then-refuse-steer" | "no-usage" | "paged-list" | "hang-new" | "hang-load", on: boolean): Promise<void>;
  sessions(): Promise<Array<{ sessionId: string; cwd: string; title: string | null; model: string; thoughtLevel: string; mode: string; replay: Array<Record<string, unknown>> }>>;
  // `agy acp` processes started for this fake that are still running.
  running(): Promise<number>;
  // Workers the `orphan-child` flag started that are still running.
  orphans(): Promise<number>;
  remove(): Promise<void>;
};

export async function installFakeAgy(): Promise<FakeAgy> {
  const root = await mkdtemp(path.join(os.tmpdir(), "uatu-fake-agy-"));
  const binDirectory = path.join(root, "bin");
  const stateDirectory = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  await Promise.all([binDirectory, stateDirectory, workspace].map(directory => import("node:fs/promises").then(fs => fs.mkdir(directory, { recursive: true }))));
  const executable = path.join(binDirectory, "agy");
  const script = path.join(import.meta.dir, "fake-agy.ts");
  await writeFile(executable, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`, AGY_FAKE_STATE: stateDirectory };
  return {
    binDirectory,
    executable,
    stateDirectory,
    workspace,
    env,
    async log() {
      const text = await readFile(path.join(stateDirectory, "log.jsonl"), "utf8").catch(() => "");
      return text.split("\n").filter(Boolean).map(line => JSON.parse(line));
    },
    async setFlag(name, on) {
      const file = path.join(stateDirectory, name);
      if (on) await writeFile(file, "");
      else await rm(file, { force: true });
    },
    async sessions() {
      return JSON.parse(await readFile(path.join(stateDirectory, "sessions.json"), "utf8").catch(() => "[]"));
    },
    running: () => alive(path.join(stateDirectory, "pids")),
    orphans: () => alive(path.join(stateDirectory, "orphans")),
    remove: () => rm(root, { recursive: true, force: true }),
  };
}

async function alive(file: string): Promise<number> {
  const pids = (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number);
  return pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } }).length;
}
