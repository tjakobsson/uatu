import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureStateDir, loadOrCreateSigningKey, registryPath, resolveHubStateRoot, signingKeyPath } from "./state-dir";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempStateRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-state-"));
  tempDirectories.push(dir);
  return path.join(dir, "uatu-hub");
}

describe("resolveHubStateRoot", () => {
  test("honors XDG_STATE_HOME", () => {
    expect(resolveHubStateRoot({ XDG_STATE_HOME: "/custom/state" })).toBe("/custom/state/uatu-hub");
  });

  test("defaults to ~/.local/state/uatu-hub", () => {
    expect(resolveHubStateRoot({})).toBe(path.join(os.homedir(), ".local", "state", "uatu-hub"));
  });

  test("registry and key paths live under the state root", () => {
    expect(registryPath("/s")).toBe("/s/registry.json");
    expect(signingKeyPath("/s")).toBe("/s/hub.key");
  });
});

describe("loadOrCreateSigningKey", () => {
  test("creates an owner-only key on first run and returns the same key after", async () => {
    const stateRoot = await tempStateRoot();
    await ensureStateDir(stateRoot);

    const first = await loadOrCreateSigningKey(stateRoot);
    expect(first.length).toBeGreaterThanOrEqual(64);

    const mode = (await stat(signingKeyPath(stateRoot))).mode & 0o777;
    expect(mode).toBe(0o600);

    const second = await loadOrCreateSigningKey(stateRoot);
    expect(second).toBe(first);
  });

  test("a reused key with permissive mode is tightened to 0600", async () => {
    const stateRoot = await tempStateRoot();
    await ensureStateDir(stateRoot);
    const key = "k".repeat(64);
    const { writeFile, chmod } = await import("node:fs/promises");
    await writeFile(signingKeyPath(stateRoot), `${key}\n`, { mode: 0o644 });
    await chmod(signingKeyPath(stateRoot), 0o644);

    const loaded = await loadOrCreateSigningKey(stateRoot);
    expect(loaded).toBe(key);
    const mode = (await stat(signingKeyPath(stateRoot))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("the state dir itself is owner-only", async () => {
    const stateRoot = await tempStateRoot();
    await ensureStateDir(stateRoot);
    const mode = (await stat(stateRoot)).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});
