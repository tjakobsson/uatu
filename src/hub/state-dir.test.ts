import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  ensureCanonicalStateDir,
  ensureStateDir,
  personalWorkspaceStatePath,
  registryPath,
  resolveHubStateRoot,
  sessionsPath,
} from "./state-dir";

const tempDirectories: string[] = [];
const leaseProcesses = new Set<ChildProcessWithoutNullStreams>();
const leaseHelper = path.resolve(import.meta.dir, "../../tests/fixtures/hub-lease-helper.ts");

afterEach(async () => {
  for (const child of leaseProcesses) child.kill("SIGKILL");
  await Promise.all([...leaseProcesses].map(child => new Promise<void>(resolve => child.once("exit", () => resolve()))));
  leaseProcesses.clear();
  await Promise.all(tempDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempStateRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-state-"));
  tempDirectories.push(dir);
  return path.join(dir, "uatu-hub");
}

function spawnLeaseProcess(
  stateRoot: string,
  options: { executable?: string; pressure?: boolean } = {},
): ChildProcessWithoutNullStreams {
  const executable = options.executable ?? process.execPath;
  const args = executable === process.execPath
    ? [leaseHelper, stateRoot, ...(options.pressure ? ["pressure"] : [])]
    : [stateRoot, ...(options.pressure ? ["pressure"] : [])];
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
  leaseProcesses.add(child);
  child.once("exit", () => leaseProcesses.delete(child));
  return child;
}

type LeaseProcessOutcome =
  | { status: "locked" }
  | { status: "contended"; stderr: string };

async function firstLeaseProcessOutcome(child: ChildProcessWithoutNullStreams): Promise<LeaseProcessOutcome> {
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`lease helper timed out: ${stderr}`)), 5_000);
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
      if (stdout.includes("locked\n")) {
        clearTimeout(timer);
        resolve({ status: "locked" });
      }
    });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("exit", code => {
      clearTimeout(timer);
      if (stdout.includes("locked\n")) resolve({ status: "locked" });
      else if (code !== 0 && stderr.includes("Hub state root is already in use")) {
        resolve({ status: "contended", stderr });
      }
      else if (code !== 0) reject(new Error(`lease helper failed unexpectedly: ${stderr}`));
      else reject(new Error(`lease helper exited without acquiring: ${stderr}`));
    });
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return await new Promise(resolve => child.once("exit", code => resolve(code)));
}

async function releaseLeaseProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.stdin.end("release\n");
  expect(await waitForExit(child)).toBe(0);
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
  test("a second process cannot acquire while the owner is live", async () => {
    const stateRoot = await tempStateRoot();
    await ensureStateDir(stateRoot);
    const owner = spawnLeaseProcess(stateRoot);
    expect((await firstLeaseProcessOutcome(owner)).status).toBe("locked");

    await expect(acquireHubStateLease(stateRoot)).rejects.toThrow(/already in use/);
    await releaseLeaseProcess(owner);
  });

  test("first-time concurrent schema initialization has exactly one winner", async () => {
    const stateRoot = await tempStateRoot();
    await ensureStateDir(stateRoot);
    const contenders = Array.from({ length: 6 }, () => spawnLeaseProcess(stateRoot));
    const outcomes = await Promise.all(contenders.map(firstLeaseProcessOutcome));
    expect(outcomes.filter(outcome => outcome.status === "locked")).toHaveLength(1);
    const losers = outcomes.filter((outcome): outcome is Extract<LeaseProcessOutcome, { status: "contended" }> => outcome.status === "contended");
    expect(losers).toHaveLength(5);
    expect(losers.every(outcome => outcome.stderr.includes("Hub state root is already in use"))).toBe(true);

    await releaseLeaseProcess(contenders[outcomes.findIndex(outcome => outcome.status === "locked")]!);
  });

  test("graceful release permits reacquisition without changing the inode", async () => {
    const stateRoot = await tempStateRoot();
    await ensureStateDir(stateRoot);
    const leasePath = path.join(stateRoot, ".hub-lease");
    const first = spawnLeaseProcess(stateRoot);
    expect((await firstLeaseProcessOutcome(first)).status).toBe("locked");
    const before = await lstat(leasePath, { bigint: true });
    await releaseLeaseProcess(first);

    const second = spawnLeaseProcess(stateRoot);
    expect((await firstLeaseProcessOutcome(second)).status).toBe("locked");
    const after = await lstat(leasePath, { bigint: true });
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
    await releaseLeaseProcess(second);
  });

  test("SIGKILL releases the kernel lock for immediate reacquisition", async () => {
    const stateRoot = await tempStateRoot();
    await ensureStateDir(stateRoot);
    const owner = spawnLeaseProcess(stateRoot);
    expect((await firstLeaseProcessOutcome(owner)).status).toBe("locked");
    owner.kill("SIGKILL");
    await waitForExit(owner);

    const successor = await acquireHubStateLease(stateRoot);
    await successor.release();
  });

  test("an idle owner retains the lock under allocation and GC pressure without sidecars", async () => {
    const stateRoot = await tempStateRoot();
    await ensureStateDir(stateRoot);
    const owner = spawnLeaseProcess(stateRoot, { pressure: true });
    expect((await firstLeaseProcessOutcome(owner)).status).toBe("locked");
    await Bun.sleep(200);

    await expect(acquireHubStateLease(stateRoot)).rejects.toThrow(/already in use/);
    expect((await readdir(stateRoot)).filter(name => name.startsWith(".hub-lease"))).toEqual([".hub-lease"]);
    await releaseLeaseProcess(owner);
    expect((await readdir(stateRoot)).filter(name => name.startsWith(".hub-lease"))).toEqual([".hub-lease"]);
  });

  test("canonical root keeps all state paths on locked root A after an ancestor symlink retargets to B", async () => {
    const unusedStateRoot = await tempStateRoot();
    const parent = path.dirname(unusedStateRoot);
    const rootAParent = path.join(parent, "root-a");
    const rootBParent = path.join(parent, "root-b");
    const lexicalParent = path.join(parent, "current-root");
    await mkdir(path.join(rootAParent, "uatu-hub"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(rootBParent, "uatu-hub"), { recursive: true, mode: 0o700 });
    await symlink(rootAParent, lexicalParent);
    const lexicalRoot = path.join(lexicalParent, "uatu-hub");
    const canonicalRoot = await ensureCanonicalStateDir(lexicalRoot);
    const lease = await acquireHubStateLease(canonicalRoot);
    await ensureCredentialStateDirs(canonicalRoot);

    await rm(lexicalParent);
    await symlink(rootBParent, lexicalParent);
    await writeFile(registryPath(canonicalRoot), "root-a");
    await writeFile(credentialsPath(canonicalRoot), "root-a");
    await writeFile(path.join(credentialRuntimePath(canonicalRoot), "root-a"), "root-a");

    expect(canonicalRoot).toBe(await realpath(path.join(rootAParent, "uatu-hub")));
    expect(await Bun.file(path.join(rootAParent, "uatu-hub", "registry.json")).text()).toBe("root-a");
    expect(await Bun.file(path.join(rootAParent, "uatu-hub", "credentials.json")).text()).toBe("root-a");
    expect(await Bun.file(path.join(rootAParent, "uatu-hub", "credential-runtime", "root-a")).text()).toBe("root-a");
    expect(await Bun.file(path.join(rootBParent, "uatu-hub", "registry.json")).exists()).toBe(false);
    expect(await Bun.file(path.join(rootBParent, "uatu-hub", "credentials.json")).exists()).toBe(false);
    expect(await Bun.file(path.join(rootBParent, "uatu-hub", "credential-runtime", "root-a")).exists()).toBe(false);
    await lease.release();
  });

  test("first creation enforces mode 0600 under a restrictive umask", async () => {
    const stateRoot = await tempStateRoot();
    await ensureStateDir(stateRoot);
    const previousUmask = process.umask(0o777);
    let lease: Awaited<ReturnType<typeof acquireHubStateLease>> | undefined;
    try {
      lease = await acquireHubStateLease(stateRoot);
    } finally {
      process.umask(previousUmask);
    }

    expect((await lstat(path.join(stateRoot, ".hub-lease"))).mode & 0o777).toBe(0o600);
    await lease?.release();
  });

  test("rejects an existing WAL lease without converting or replacing it", async () => {
    const stateRoot = await tempStateRoot();
    await ensureStateDir(stateRoot);
    const leasePath = path.join(stateRoot, ".hub-lease");
    const seeded = new Database(leasePath, { create: true });
    expect(seeded.query("PRAGMA journal_mode=WAL").get()).toEqual({ journal_mode: "wal" });
    seeded.exec("CREATE TABLE seeded (id INTEGER PRIMARY KEY)");
    seeded.close(true);
    await chmod(leasePath, 0o600);
    const before = await lstat(leasePath, { bigint: true });
    const sidecarsBefore = (await readdir(stateRoot)).filter(name => name.startsWith(".hub-lease-")).sort();

    await expect(acquireHubStateLease(stateRoot)).rejects.toThrow(/requires journal_mode=DELETE/);
    const after = await lstat(leasePath, { bigint: true });
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
    expect((await readdir(stateRoot)).filter(name => name.startsWith(".hub-lease-")).sort()).toEqual(sidecarsBefore);

    const verified = new Database(leasePath);
    expect(verified.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    verified.close(true);
  });

  test("rejects unsafe, legacy, and corrupt lease paths without repairing them", async () => {
    const cases: Array<{ name: string; setup(leasePath: string): Promise<void>; message: RegExp }> = [
      {
        name: "unsafe mode",
        setup: async leasePath => { await writeFile(leasePath, "", { mode: 0o644 }); },
        message: /exactly mode 0600/,
      },
      {
        name: "symlink",
        setup: async leasePath => {
          const target = `${leasePath}-target`;
          await writeFile(target, "", { mode: 0o600 });
          await symlink(target, leasePath);
        },
        message: /non-symlink regular file/,
      },
      {
        name: "legacy directory",
        setup: async leasePath => { await mkdir(leasePath, { mode: 0o700 }); },
        message: /stop every old Hub.*remove that directory manually/,
      },
      {
        name: "hard link",
        setup: async leasePath => {
          await writeFile(leasePath, "", { mode: 0o600 });
          await link(leasePath, `${leasePath}-link`);
        },
        message: /exactly one hard link/,
      },
      {
        name: "corrupt database",
        setup: async leasePath => { await writeFile(leasePath, "not sqlite", { mode: 0o600 }); },
        message: /cannot safely acquire/,
      },
    ];

    for (const fixture of cases) {
      const stateRoot = await tempStateRoot();
      await ensureStateDir(stateRoot);
      const leasePath = path.join(stateRoot, ".hub-lease");
      await fixture.setup(leasePath);
      await expect(acquireHubStateLease(stateRoot), fixture.name).rejects.toThrow(fixture.message);
      if (fixture.name === "unsafe mode") expect((await lstat(leasePath)).mode & 0o777).toBe(0o644);
    }
  });

  test("repeated release cannot affect a successor", async () => {
    const stateRoot = await tempStateRoot();
    await ensureStateDir(stateRoot);
    const first = await acquireHubStateLease(stateRoot);
    const firstRelease = first.release();
    expect(first.release()).toBe(firstRelease);
    await firstRelease;

    const successor = await acquireHubStateLease(stateRoot);
    await first.release();
    await expect(acquireHubStateLease(stateRoot)).rejects.toThrow(/already in use/);
    await successor.release();
  });

  test("compiled and interpreted helpers contend on the same lock", async () => {
    const stateRoot = await tempStateRoot();
    await ensureStateDir(stateRoot);
    const compiledHelper = path.join(path.dirname(stateRoot), "hub-lease-helper");
    const build = Bun.spawnSync([
      process.execPath,
      "build",
      "--compile",
      leaseHelper,
      "--outfile",
      compiledHelper,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(build.exitCode, build.stderr.toString()).toBe(0);

    const interpreted = spawnLeaseProcess(stateRoot);
    expect((await firstLeaseProcessOutcome(interpreted)).status).toBe("locked");
    const compiledContender = spawnLeaseProcess(stateRoot, { executable: compiledHelper });
    const compiledOutcome = await firstLeaseProcessOutcome(compiledContender);
    expect(compiledOutcome.status).toBe("contended");
    if (compiledOutcome.status === "contended") {
      expect(compiledOutcome.stderr).toContain("Hub state root is already in use");
    }
    await releaseLeaseProcess(interpreted);

    const compiled = spawnLeaseProcess(stateRoot, { executable: compiledHelper });
    expect((await firstLeaseProcessOutcome(compiled)).status).toBe("locked");
    await expect(acquireHubStateLease(stateRoot)).rejects.toThrow(/already in use/);
    await releaseLeaseProcess(compiled);
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
