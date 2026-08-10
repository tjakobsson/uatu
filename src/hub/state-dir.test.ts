import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureStateDir, personalWorkspaceStatePath, registryPath, resolveHubStateRoot, sessionsPath } from "./state-dir";

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

  test("registry, personal-state, and session paths live under the state root", () => {
    expect(registryPath("/s")).toBe("/s/registry.json");
    expect(personalWorkspaceStatePath("/s")).toBe("/s/personal-workspace-state.json");
    expect(sessionsPath("/s")).toBe("/s/sessions.json");
  });
});

describe("ensureStateDir", () => {
  test("the state dir itself is owner-only", async () => {
    const stateRoot = await tempStateRoot();
    await ensureStateDir(stateRoot);
    const mode = (await stat(stateRoot)).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});
