import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CredentialToolManager,
  discoverCredentialTools,
  discoverExecutable,
  probeCredentialTool,
  toolInstallationGuidance,
  validateExecutablePath,
} from "./credential-tools";
import { CredentialToolOverrideStore } from "./credential-store";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function executable(name: string): Promise<{ directory: string; filePath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "uatu-tools-"));
  tempDirectories.push(directory);
  const filePath = path.join(directory, name);
  await writeFile(filePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return { directory, filePath };
}

describe("credential executable discovery", () => {
  test("discovers fixed executable names from PATH without invoking them", async () => {
    const { directory, filePath } = await executable("git");
    expect(await discoverExecutable("git", { path: directory })).toEqual({
      tool: "git",
      path: filePath,
      source: "path",
    });
    expect(await discoverExecutable("gpg", { path: directory })).toEqual({
      tool: "gpg",
      path: null,
      source: "missing",
    });
  });

  test("uses a validated override before PATH", async () => {
    const override = await executable("custom-gpg");
    const pathTool = await executable("gpg");
    expect(await discoverExecutable("gpg", { override: override.filePath, path: pathTool.directory })).toEqual({
      tool: "gpg",
      path: override.filePath,
      source: "override",
    });
  });

  test("accepts executable symlink chains and preserves the configured path", async () => {
    const { directory, filePath } = await executable("gh-real");
    const first = path.join(directory, "gh-first");
    const configured = path.join(directory, "gh");
    await symlink(filePath, first);
    await symlink(first, configured);
    expect(await validateExecutablePath(configured)).toBe(configured);
    expect(await discoverExecutable("gh", { path: directory })).toEqual({
      tool: "gh",
      path: configured,
      source: "path",
    });
  });

  test("rejects relative, missing, dangling, directory-target, and non-executable paths", async () => {
    await expect(validateExecutablePath("bin/gpg")).rejects.toThrow(/absolute/);
    await expect(validateExecutablePath("/definitely/missing/uatu-gpg")).rejects.toThrow(/does not exist/);
    const { directory, filePath } = await executable("gpg");
    await chmod(filePath, 0o600);
    await expect(validateExecutablePath(filePath)).rejects.toThrow(/not executable/);
    await expect(validateExecutablePath(directory)).rejects.toThrow(/regular file/);
    const nonExecutableLink = path.join(directory, "gpg-link");
    await symlink(filePath, nonExecutableLink);
    await expect(validateExecutablePath(nonExecutableLink)).rejects.toThrow(/not executable/);
    const directoryLink = path.join(directory, "directory-link");
    await symlink(directory, directoryLink);
    await expect(validateExecutablePath(directoryLink)).rejects.toThrow(/regular file/);
    const dangling = path.join(directory, "dangling");
    await symlink(path.join(directory, "missing"), dangling);
    await expect(validateExecutablePath(dangling)).rejects.toThrow(/does not exist/);
  });

  test.skipIf(process.platform !== "darwin" || !existsSync("/opt/homebrew/bin/gh"))(
    "discovers an installed Homebrew gh symlink",
    async () => {
      expect(await discoverExecutable("gh", { path: "/opt/homebrew/bin" })).toEqual({
        tool: "gh",
        path: "/opt/homebrew/bin/gh",
        source: "path",
      });
    },
  );

  test("bounds PATH traversal", async () => {
    const { directory } = await executable("git");
    const emptyRoot = await mkdtemp(path.join(os.tmpdir(), "uatu-tools-empty-"));
    tempDirectories.push(emptyRoot);
    const entries: string[] = [];
    for (let index = 0; index < 128; index += 1) {
      const entry = path.join(emptyRoot, String(index));
      await mkdir(entry);
      entries.push(entry);
    }
    entries.push(directory);
    expect((await discoverExecutable("git", { path: entries.join(path.delimiter) })).path).toBeNull();
  });

  test("discovers OpenSSH, GnuPG, Git, and provider CLI components independently", async () => {
    const { directory } = await executable("ssh-agent");
    const discoveries = await discoverCredentialTools({}, directory);
    expect(discoveries.find(item => item.tool === "ssh-agent")?.source).toBe("path");
    expect(discoveries.find(item => item.tool === "ssh-keygen")?.source).toBe("missing");
    expect(discoveries.find(item => item.tool === "gpg")?.source).toBe("missing");
    expect(discoveries.find(item => item.tool === "git")?.source).toBe("missing");
    expect(discoveries.find(item => item.tool === "gh")?.source).toBe("missing");
    expect(discoveries.find(item => item.tool === "glab")?.source).toBe("missing");
  });
});

describe("credential tool probes", () => {
  test("reports bounded structured version readiness", async () => {
    const { filePath } = await executable("git");
    await writeFile(filePath, "#!/bin/sh\nprintf 'git version 2.51.0\\n'\n", { mode: 0o700 });
    expect(await probeCredentialTool({ tool: "git", path: filePath, source: "override" })).toEqual({
      tool: "git",
      path: filePath,
      version: "git version 2.51.0",
      results: [
        { layer: "binary", status: "ready", message: "Executable is available." },
        { layer: "version", status: "ready", message: "Compatible version was reported." },
        { layer: "runtime", status: "not-applicable", message: "Runtime readiness is tested when the capability is used." },
      ],
      guidance: null,
    });
  });

  test("accepts OpenSSH usage probes that produce a usage banner but no version text", async () => {
    const { filePath } = await executable("ssh-add");
    await writeFile(filePath, "#!/bin/sh\nprintf 'usage: ssh-add [-cDdKkLlqvXx]\\n' >&2\nexit 2\n", { mode: 0o700 });
    expect(await probeCredentialTool({ tool: "ssh-add", path: filePath, source: "override" })).toEqual({
      tool: "ssh-add",
      path: filePath,
      version: null,
      results: [
        { layer: "binary", status: "ready", message: "Executable is available." },
        { layer: "version", status: "ready", message: "Executable responded to the probe." },
        { layer: "runtime", status: "not-applicable", message: "Runtime readiness is tested when the capability is used." },
      ],
      guidance: null,
    });
  });


  test("accepts agentless ssh-add, which reports the missing agent instead of usage", async () => {
    // Real ssh-add connects to the agent before parsing argv, so under the
    // scrubbed probe env (no SSH_AUTH_SOCK) it can never print usage text.
    // This is the only output the probe will ever see in practice; the old
    // banner rejected it and disabled SSH credentials on every install.
    const { filePath } = await executable("ssh-add");
    await writeFile(filePath, "#!/bin/sh\nprintf 'Could not open a connection to your authentication agent.\\n' >&2\nexit 2\n", { mode: 0o700 });
    const probe = await probeCredentialTool({ tool: "ssh-add", path: filePath, source: "override" });
    expect(probe.results.map(result => result.status)).toEqual(["ready", "ready", "not-applicable"]);
  });

  test("rejects an override whose output merely mentions the authentication agent", async () => {
    // The agentless banner must be the complete OpenSSH diagnostic, not a
    // phrase match: a broken override printing similar words is not ssh-add
    // and must not be persisted in place of a usable path.
    const { filePath } = await executable("ssh-add");
    await writeFile(filePath, "#!/bin/sh\nprintf 'authentication agent unavailable\\n' >&2\nexit 2\n", { mode: 0o700 });
    const probe = await probeCredentialTool({ tool: "ssh-add", path: filePath, source: "override" });
    expect(probe.results.map(result => result.status)).toEqual(["ready", "unavailable", "not-applicable"]);
  });

  test("probes the real ssh-add as identified when it is installed", async () => {
    const discovery = await discoverExecutable("ssh-add");
    if (!discovery.path) return; // no OpenSSH client on this machine
    const probe = await probeCredentialTool(discovery);
    expect(probe.results.map(result => result.status)).toEqual(["ready", "ready", "not-applicable"]);
  });

  test("rejects executables that do not identify as the configured tool", async () => {
    // /bin/false-alike: tolerated exit status, no banner.
    const silent = await executable("ssh-agent");
    await writeFile(silent.filePath, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    expect((await probeCredentialTool({ tool: "ssh-agent", path: silent.filePath, source: "override" })).results).toContainEqual({
      layer: "version",
      status: "unavailable",
      message: "Executable did not identify as the configured tool.",
    });
    // Unrelated exit-zero executable with unrelated output.
    const unrelated = await executable("git");
    await writeFile(unrelated.filePath, "#!/bin/sh\nprintf 'something else 1.0\\n'\n", { mode: 0o700 });
    expect((await probeCredentialTool({ tool: "git", path: unrelated.filePath, source: "override" })).results).toContainEqual({
      layer: "version",
      status: "unavailable",
      message: "Executable did not identify as the configured tool.",
    });
  });

  test("probes the OpenSSH client version", async () => {
    const { filePath } = await executable("ssh");
    await writeFile(filePath, "#!/bin/sh\nprintf 'OpenSSH_9.6p1, LibreSSL 3.3.6\\n' >&2\n", { mode: 0o700 });
    const result = await probeCredentialTool({ tool: "ssh", path: filePath, source: "override" });
    expect(result.version).toBe("OpenSSH_9.6p1, LibreSSL 3.3.6");
    expect(result.results).toContainEqual({ layer: "version", status: "ready", message: "Compatible version was reported." });
    expect(toolInstallationGuidance("ssh", "darwin")).toContain("OpenSSH");
  });

  test("enforces provider CLI minimum versions", async () => {
    const gh = await executable("gh");
    await writeFile(gh.filePath, "#!/bin/sh\nprintf 'gh version 1.99.0\\n'\n", { mode: 0o700 });
    expect((await probeCredentialTool({ tool: "gh", path: gh.filePath, source: "override" })).results).toContainEqual({
      layer: "version",
      status: "unavailable",
      message: "GitHub CLI 2.0 or newer is required.",
    });
    await writeFile(gh.filePath, "#!/bin/sh\nprintf 'gh version 2.0.0\\n'\n", { mode: 0o700 });
    expect((await probeCredentialTool({ tool: "gh", path: gh.filePath, source: "override" })).version).toBe("gh version 2.0.0");

    const glab = await executable("glab");
    await writeFile(glab.filePath, "#!/bin/sh\nprintf 'glab 1.21.0\\n'\n", { mode: 0o700 });
    expect((await probeCredentialTool({ tool: "glab", path: glab.filePath, source: "override" })).version).toBeNull();
    await writeFile(glab.filePath, "#!/bin/sh\nprintf 'glab 1.22.0\\n'\n", { mode: 0o700 });
    expect((await probeCredentialTool({ tool: "glab", path: glab.filePath, source: "override" })).version).toBe("glab 1.22.0");
  });

  test("sanitizes failures without retaining stderr, environment, or unbounded output", async () => {
    const { filePath } = await executable("git");
    await writeFile(filePath, "#!/bin/sh\nprintf '%*s' 9000 '' | tr ' ' x >&2\nprintf 'sentinel-secret' >&2\nexit 2\n", { mode: 0o700 });
    const result = await probeCredentialTool({ tool: "git", path: filePath, source: "override" });
    expect(result.version).toBeNull();
    expect(result.results).toContainEqual({
      layer: "version",
      status: "unavailable",
      message: "Version probe exceeded the output limit.",
    });
    expect(JSON.stringify(result)).not.toContain("sentinel-secret");
    expect(JSON.stringify(result)).not.toContain(process.env.HOME ?? "impossible-home");
    expect(JSON.stringify(result).length).toBeLessThan(1000);
  });

  test("times out a hung probe and gives platform-specific guidance", async () => {
    const { filePath } = await executable("gpg");
    await writeFile(filePath, "#!/bin/sh\nsleep 2\n", { mode: 0o700 });
    const result = await probeCredentialTool({ tool: "gpg", path: filePath, source: "override" }, 20);
    expect(result.results).toContainEqual({ layer: "version", status: "unavailable", message: "Version probe timed out." });
    expect(toolInstallationGuidance("gpg", "darwin")).toContain("macOS");
    expect(toolInstallationGuidance("gpg", "linux")).toContain("system package manager");
  });

  test("timeout does not wait for a descendant holding the output pipes", async () => {
    const { filePath } = await executable("gpg");
    await writeFile(filePath, "#!/bin/sh\n(sleep 30) &\nsleep 30\n", { mode: 0o700 });
    const started = Date.now();
    const result = await probeCredentialTool({ tool: "gpg", path: filePath, source: "override" }, 20);
    expect(result.results).toContainEqual({ layer: "version", status: "unavailable", message: "Version probe timed out." });
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("CredentialToolManager", () => {
  test("reports a stale persisted override without failing startup", async () => {
    const storePath = await tempPathForStore();
    const configured = await executable("configured-git");
    const ambient = await executable("git");
    const store = new CredentialToolOverrideStore(storePath);
    await store.load();
    await store.set({ tool: "git", path: configured.filePath });
    await rm(configured.filePath);

    const restartedStore = new CredentialToolOverrideStore(storePath);
    const manager = new CredentialToolManager(restartedStore, ambient.directory);
    await manager.load();

    expect(restartedStore.get("git")?.path).toBe(configured.filePath);
    expect(manager.list().find(item => item.tool === "git")).toMatchObject({
      path: configured.filePath,
      version: null,
      results: [{ layer: "binary", status: "unavailable" }],
    });
  });

  test("re-probes startup and mutation while preserving the last override after failure", async () => {
    const storePath = await tempPathForStore();
    const good = await executable("good-git");
    const bad = await executable("bad-git");
    const store = new CredentialToolOverrideStore(storePath);
    const probe = async (discovery: Awaited<ReturnType<typeof discoverExecutable>>) => ({
      tool: discovery.tool,
      path: discovery.path,
      version: discovery.path === bad.filePath ? null : "test 1.0",
      results: [{
        layer: "version" as const,
        status: discovery.path === bad.filePath ? "unavailable" as const : "ready" as const,
        message: "test result",
      }],
      guidance: null,
    });
    const manager = new CredentialToolManager(store, "", probe);
    await manager.load();
    await manager.setOverride("git", good.filePath);
    await expect(manager.setOverride("git", bad.filePath)).rejects.toThrow(/failed validation/);
    expect(store.get("git")?.path).toBe(good.filePath);

    const restartedStore = new CredentialToolOverrideStore(storePath);
    const restarted = new CredentialToolManager(restartedStore, "", probe);
    await restarted.load();
    expect(restartedStore.get("git")?.path).toBe(good.filePath);
    expect(restarted.list().find(item => item.tool === "git")?.version).toBe("test 1.0");
  });

  test("rolls back a new override that becomes invalid before the final probe", async () => {
    const storePath = await tempPathForStore();
    const good = await executable("good-git");
    const vanishing = await executable("vanishing-git");
    await writeFile(good.filePath, "#!/bin/sh\nprintf 'git version 2.51.0\\n'\n", { mode: 0o700 });
    await writeFile(vanishing.filePath, "#!/bin/sh\nrm \"$0\"\nprintf 'git version 2.51.0\\n'\n", { mode: 0o700 });
    const store = new CredentialToolOverrideStore(storePath);
    const manager = new CredentialToolManager(store, "");
    await manager.load();
    await manager.setOverride("git", good.filePath);

    await expect(manager.setOverride("git", vanishing.filePath)).rejects.toThrow("failed validation");
    expect(store.get("git")?.path).toBe(good.filePath);
    expect(manager.list().find(item => item.tool === "git")?.path).toBe(good.filePath);
  });

  test("serializes overlapping override mutations through their reprobes", async () => {
    const storePath = await tempPathForStore();
    const first = await executable("first-git");
    const second = await executable("second-git");
    const store = new CredentialToolOverrideStore(storePath);
    let firstPathProbes = 0;
    let releaseFirstReprobe!: () => void;
    let markFirstReprobe!: () => void;
    const firstReprobe = new Promise<void>(resolve => { markFirstReprobe = resolve; });
    const firstReprobeGate = new Promise<void>(resolve => { releaseFirstReprobe = resolve; });
    const probe = async (discovery: Awaited<ReturnType<typeof discoverExecutable>>) => {
      if (discovery.path === first.filePath && ++firstPathProbes === 2) {
        markFirstReprobe();
        await firstReprobeGate;
      }
      return {
        tool: discovery.tool,
        path: discovery.path,
        version: discovery.path ?? "missing",
        results: [{ layer: "version" as const, status: "ready" as const, message: "test result" }],
        guidance: null,
      };
    };
    const manager = new CredentialToolManager(store, "", probe);
    await manager.load();
    const firstMutation = manager.setOverride("git", first.filePath);
    await firstReprobe;
    const secondMutation = manager.setOverride("git", second.filePath);
    await Bun.sleep(1);
    releaseFirstReprobe();
    await Promise.all([firstMutation, secondMutation]);

    expect(store.get("git")?.path).toBe(second.filePath);
    expect(manager.list().find(item => item.tool === "git")?.path).toBe(second.filePath);
  });

  test("restores persistence, readiness, and runtime when runtime application fails", async () => {
    const storePath = await tempPathForStore();
    const first = await executable("first-git");
    const second = await executable("second-git");
    const store = new CredentialToolOverrideStore(storePath);
    const probe = async (discovery: Awaited<ReturnType<typeof discoverExecutable>>) => ({
      tool: discovery.tool,
      path: discovery.path,
      version: discovery.path,
      results: [{ layer: "version" as const, status: "ready" as const, message: "ready" }],
      guidance: null,
    });
    let manager!: CredentialToolManager;
    let runtimePath: string | null = null;
    let rejectSecond = true;
    manager = new CredentialToolManager(store, "", probe, async () => {
      const next = manager.list().find(value => value.tool === "git")?.path ?? null;
      if (next === second.filePath && rejectSecond) {
        rejectSecond = false;
        throw new Error("runtime replacement failed");
      }
      runtimePath = next;
    });
    await manager.load();
    await manager.setOverride("git", first.filePath);

    await expect(manager.setOverride("git", second.filePath)).rejects.toThrow("runtime replacement failed");
    expect(store.get("git")?.path).toBe(first.filePath);
    expect(manager.list().find(value => value.tool === "git")?.path).toBe(first.filePath);
    expect(runtimePath as string | null).toBe(first.filePath);
  });

  test("aggregates runtime application and restoration failures", async () => {
    const storePath = await tempPathForStore();
    const first = await executable("first-git");
    const second = await executable("second-git");
    const store = new CredentialToolOverrideStore(storePath);
    const probe = async (discovery: Awaited<ReturnType<typeof discoverExecutable>>) => ({
      tool: discovery.tool,
      path: discovery.path,
      version: discovery.path,
      results: [{ layer: "version" as const, status: "ready" as const, message: "ready" }],
      guidance: null,
    });
    let failRuntime = false;
    const manager = new CredentialToolManager(store, "", probe, async () => {
      if (failRuntime) throw new Error("runtime apply failed");
    });
    await manager.load();
    await manager.setOverride("git", first.filePath);
    failRuntime = true;

    let failure: unknown;
    try {
      await manager.setOverride("git", second.filePath);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map(error => (error as Error).message)).toEqual([
      "runtime apply failed",
      "runtime apply failed",
    ]);
    expect(store.get("git")?.path).toBe(first.filePath);
    expect(manager.list().find(value => value.tool === "git")?.path).toBe(first.filePath);
  });

  test("restores readiness and runtime when re-probe runtime application fails", async () => {
    const storePath = await tempPathForStore();
    const git = await executable("git");
    const store = new CredentialToolOverrideStore(storePath);
    let probedVersion = "first";
    const probe = async (discovery: Awaited<ReturnType<typeof discoverExecutable>>) => ({
      tool: discovery.tool,
      path: discovery.path,
      version: probedVersion,
      results: [{ layer: "version" as const, status: "ready" as const, message: "ready" }],
      guidance: null,
    });
    let manager!: CredentialToolManager;
    let runtimeVersion: string | null = null;
    let rejectSecond = true;
    manager = new CredentialToolManager(store, git.directory, probe, async () => {
      const next = manager.list().find(value => value.tool === "git")?.version ?? null;
      if (next === "second" && rejectSecond) {
        rejectSecond = false;
        throw new Error("runtime replacement failed");
      }
      runtimeVersion = next;
    });
    await manager.load();
    await manager.reprobeAll();
    expect(runtimeVersion as string | null).toBe("first");
    probedVersion = "second";

    await expect(manager.reprobeAll()).rejects.toThrow("runtime replacement failed");
    expect(manager.list().find(value => value.tool === "git")?.version).toBe("first");
    expect(runtimeVersion as string | null).toBe("first");
  });

  test("aggregates re-probe application and restoration failures", async () => {
    const storePath = await tempPathForStore();
    const git = await executable("git");
    const store = new CredentialToolOverrideStore(storePath);
    let probedVersion = "first";
    const probe = async (discovery: Awaited<ReturnType<typeof discoverExecutable>>) => ({
      tool: discovery.tool,
      path: discovery.path,
      version: probedVersion,
      results: [{ layer: "version" as const, status: "ready" as const, message: "ready" }],
      guidance: null,
    });
    let failRuntime = false;
    const manager = new CredentialToolManager(store, git.directory, probe, async () => {
      if (failRuntime) throw new Error("runtime apply failed");
    });
    await manager.load();
    failRuntime = true;
    probedVersion = "second";

    let failure: unknown;
    try {
      await manager.reprobeAll();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe("tool re-probe failed and restoration failed");
    expect((failure as AggregateError).errors.map(error => (error as Error).message)).toEqual([
      "runtime apply failed",
      "runtime apply failed",
    ]);
    expect(manager.list().find(value => value.tool === "git")?.version).toBe("first");
  });

  test("shutdown cancels and drains active probes", async () => {
    const storePath = await tempPathForStore();
    const hung = await executable("git");
    const marker = path.join(path.dirname(hung.filePath), "started");
    await writeFile(hung.filePath, `#!/bin/sh\ntouch '${marker}'\n(sleep 30) &\nsleep 30\n`, { mode: 0o700 });
    const store = new CredentialToolOverrideStore(storePath);
    await store.load();
    await store.set({ tool: "git", path: hung.filePath });
    const manager = new CredentialToolManager(store, "");
    const loading = manager.load();
    for (let attempt = 0; attempt < 100 && !await Bun.file(marker).exists(); attempt += 1) await Bun.sleep(10);

    const started = Date.now();
    await manager.shutdown();
    await loading;
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

async function tempPathForStore(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "uatu-tool-store-"));
  tempDirectories.push(directory);
  return path.join(directory, "tools.json");
}
