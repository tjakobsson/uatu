import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  credentialGnuPgPath,
  credentialRuntimePath,
  credentialSecretsPath,
  credentialsPath,
  credentialTokenStorePath,
  credentialToolsPath,
  acquireHubStateLease,
  ensureCredentialStateDirs,
  ensureStateDir,
  personalWorkspaceStatePath,
  registryPath,
  resolveHubStateRoot,
  sessionsPath,
} from "./state-dir";

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

  test("persistent state and credential paths live under the state root", () => {
    expect(registryPath("/s")).toBe("/s/registry.json");
    expect(personalWorkspaceStatePath("/s")).toBe("/s/personal-workspace-state.json");
    expect(sessionsPath("/s")).toBe("/s/sessions.json");
    expect(credentialsPath("/s")).toBe("/s/credentials.json");
    expect(credentialToolsPath("/s")).toBe("/s/credential-tools.json");
    expect(credentialSecretsPath("/s")).toBe("/s/credential-secrets");
    expect(credentialTokenStorePath("/s")).toBe("/s/credential-secrets/tokens.json");
    expect(credentialGnuPgPath("/s")).toBe("/s/credential-gnupg");
    expect(credentialRuntimePath("/s")).toBe("/s/credential-runtime");
  });
});

describe("ensureStateDir", () => {
  test("the state dir itself is owner-only", async () => {
    const stateRoot = await tempStateRoot();
    await ensureStateDir(stateRoot);
    const mode = (await stat(stateRoot)).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test("rejects an existing symlink or unsafe state root", async () => {
    const stateRoot = await tempStateRoot();
    const target = `${stateRoot}-target`;
    await mkdir(target, { mode: 0o700 });
    await symlink(target, stateRoot);
    await expect(ensureStateDir(stateRoot)).rejects.toThrow(/symlink/);

    await rm(stateRoot);
    await mkdir(stateRoot, { mode: 0o700 });
    await chmod(stateRoot, 0o755);
    await expect(ensureStateDir(stateRoot)).rejects.toThrow(/must be mode 0700, accessible only by its owner/);
  });
});

describe("Hub state-root lease", () => {
  test("rejects a second live owner and releases for the next Hub", async () => {
    const stateRoot = await tempStateRoot();
    await ensureStateDir(stateRoot);
    const first = await acquireHubStateLease(stateRoot);
    await expect(acquireHubStateLease(stateRoot)).rejects.toThrow(`already in use by process ${process.pid}`);
    await first.release();
    const second = await acquireHubStateLease(stateRoot);
    await second.release();
  });

  test("recovers a lease whose owner no longer exists", async () => {
    const stateRoot = await tempStateRoot();
    await ensureStateDir(stateRoot);
    const leasePath = path.join(stateRoot, ".hub-lease");
    await mkdir(leasePath, { mode: 0o700 });
    await writeFile(path.join(leasePath, "owner.json"), JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      nonce: "stale",
    }), { mode: 0o600 });

    const lease = await acquireHubStateLease(stateRoot);
    await lease.release();
    expect(await Bun.file(path.join(leasePath, "owner.json")).exists()).toBe(false);
  });

  test("a delayed stale contender cannot move or delete a newly acquired lease", async () => {
    const stateRoot = await tempStateRoot();
    await ensureStateDir(stateRoot);
    const leasePath = path.join(stateRoot, ".hub-lease");
    await mkdir(leasePath, { mode: 0o700 });
    await writeFile(path.join(leasePath, "owner.json"), JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      nonce: "stale",
    }), { mode: 0o600 });
    let releaseContender!: () => void;
    let staleObserved!: () => void;
    const contenderGate = new Promise<void>(resolve => { releaseContender = resolve; });
    const observed = new Promise<void>(resolve => { staleObserved = resolve; });
    const delayed = acquireHubStateLease(stateRoot, {
      staleOwnerObserved: async () => {
        staleObserved();
        await contenderGate;
      },
    });
    await observed;

    const winner = await acquireHubStateLease(stateRoot);
    const winnerOwner = await Bun.file(path.join(leasePath, "owner.json")).text();
    releaseContender();
    await expect(delayed).rejects.toThrow(`already in use by process ${process.pid}`);

    expect(await Bun.file(path.join(leasePath, "owner.json")).text()).toBe(winnerOwner);
    await winner.release();
  });
});

describe("ensureCredentialStateDirs", () => {
  test("creates owner-only directories without destroying existing runtime state", async () => {
    const stateRoot = await tempStateRoot();
    await ensureStateDir(stateRoot);
    await ensureCredentialStateDirs(stateRoot);
    for (const directory of [credentialSecretsPath(stateRoot), credentialGnuPgPath(stateRoot), credentialRuntimePath(stateRoot)]) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }

    const marker = path.join(credentialRuntimePath(stateRoot), "stale-agent-state");
    await writeFile(marker, "stale");
    await ensureCredentialStateDirs(stateRoot);
    expect(await lstat(credentialRuntimePath(stateRoot))).toBeTruthy();
    expect(await Bun.file(marker).text()).toBe("stale");
  });

  test.each(["credential-secrets", "credential-gnupg", "credential-runtime"])(
    "rejects a symlink at %s",
    async directoryName => {
      const stateRoot = await tempStateRoot();
      await ensureStateDir(stateRoot);
      const target = path.join(path.dirname(stateRoot), `${directoryName}-target`);
      await mkdir(target, { mode: 0o700 });
      await symlink(target, path.join(stateRoot, directoryName));
      await expect(ensureCredentialStateDirs(stateRoot)).rejects.toThrow(/symlink/);
    },
  );

  test.each(["credential-secrets", "credential-gnupg", "credential-runtime"])(
    "rejects unsafe permissions at %s",
    async directoryName => {
      const stateRoot = await tempStateRoot();
      await ensureStateDir(stateRoot);
      await mkdir(path.join(stateRoot, directoryName), { mode: 0o700 });
      await chmod(path.join(stateRoot, directoryName), 0o750);
      await expect(ensureCredentialStateDirs(stateRoot)).rejects.toThrow(/unsafe permissions/);
    },
  );
});
