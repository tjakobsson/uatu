import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { CredentialMetadataStore } from "./credential-store";
import { ManagedSshAgent } from "./credential-ssh-agent";
import { SshCredentialService } from "./credential-ssh";
import { discoverExecutable } from "./credential-tools";
import {
  credentialRuntimePath,
  credentialSecretsPath,
  credentialsPath,
  ensureCredentialStateDirs,
  ensureStateDir,
} from "./state-dir";

const roots: string[] = [];
const agents: ManagedSshAgent[] = [];
const CLI_ARGV = [process.execPath, path.resolve(import.meta.dir, "../cli.ts")];

afterEach(async () => {
  await Promise.all(agents.splice(0).map(agent => agent.shutdown().catch(() => undefined)));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function tools(): Promise<{ agent: string; add: string; keygen: string }> {
  const [agent, add, keygen] = await Promise.all([
    discoverExecutable("ssh-agent"),
    discoverExecutable("ssh-add"),
    discoverExecutable("ssh-keygen"),
  ]);
  if (!agent.path || !add.path || !keygen.path) throw new Error("OpenSSH tools are required for this test");
  return { agent: agent.path, add: add.path, keygen: keygen.path };
}

async function stateRoot(name: string): Promise<string> {
  const root = await mkdtemp(path.join("/tmp", name));
  roots.push(root);
  await ensureStateDir(root);
  await ensureCredentialStateDirs(root);
  return root;
}

async function run(executable: string, args: string[], env: Record<string, string>): Promise<{ code: number; output: string }> {
  const child = Bun.spawn([executable, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code: code ?? 1, output: `${stdout}${stderr}` };
}

describe("managed SSH credential lifecycle", () => {
  test("generates, imports, unlocks, locks, disables, enables, tests, and deletes without retaining its passphrase", async () => {
    const found = await tools();
    const root = await stateRoot("uatu-ssh-credential-");
    const audit = path.join(root, "tool-argv.log");
    const wrappedKeygen = await wrapper(root, "ssh-keygen", found.keygen, audit);
    const wrappedAdd = await wrapper(root, "ssh-add", found.add, audit);
    const metadata = new CredentialMetadataStore(credentialsPath(root));
    await metadata.load();
    const agent = new ManagedSshAgent({ runtimeDirectory: credentialRuntimePath(root), sshAgentPath: found.agent, uatuArgv: CLI_ARGV });
    agents.push(agent);
    let id = 0;
    const service = new SshCredentialService({
      secretsDirectory: credentialSecretsPath(root),
      runtimeDirectory: credentialRuntimePath(root),
      metadataStore: metadata,
      agent,
      sshKeygenPath: wrappedKeygen,
      sshAddPath: wrappedAdd,
      createId: () => `ssh-${++id}`,
    });
    const passphrase = "uatu-sentinel-passphrase-3.2";

    const generated = await service.generate("Generated", ["ssh-authentication", "ssh-signing"], passphrase);
    expect(generated.metadata.publicKey).toStartWith("ssh-ed25519 ");
    expect(generated.metadata.fingerprint).toStartWith("SHA256:");
    const generatedPath = path.join(credentialSecretsPath(root), `${generated.id}.key`);
    expect((await stat(generatedPath)).mode & 0o077).toBe(0);
    expect((await stat(`${generatedPath}.pub`)).mode & 0o077).toBe(0);
    expect(await readFile(generatedPath, "utf8")).not.toContain(passphrase);

    await service.unlock(generated.id, passphrase);
    expect(await service.testUsability(generated.id)).toBe(true);
    await service.lock(generated.id);
    expect(await service.testUsability(generated.id)).toBe(false);
    await service.unlock(generated.id, passphrase);
    await service.setEnabled(generated.id, false);
    expect(await service.testUsability(generated.id)).toBe(false);
    await service.setEnabled(generated.id, true);

    const importSource = path.join(root, "import-source");
    expect((await run(found.keygen, ["-q", "-t", "ed25519", "-N", passphrase, "-f", importSource], cleanEnv())).code).toBe(0);
    const imported = await service.import(
      "Imported",
      ["ssh-signing"],
      await readFile(importSource, "utf8"),
      passphrase,
    );
    expect(imported.metadata.fingerprint).not.toBe(generated.metadata.fingerprint);
    expect(await service.testUsability(imported.id)).toBe(true);
    expect(await service.delete(imported.id)).toBe(true);
    expect(await Bun.file(path.join(credentialSecretsPath(root), `${imported.id}.key`)).exists()).toBe(false);
    expect(await Bun.file(path.join(credentialSecretsPath(root), `${imported.id}.key.pub`)).exists()).toBe(false);

    const collisionPath = path.join(credentialSecretsPath(root), "ssh-3.key");
    await writeFile(collisionPath, "preserve-existing-backing", { mode: 0o600 });
    await expect(service.import(
      "Collision",
      ["ssh-authentication"],
      await readFile(generatedPath, "utf8"),
      passphrase,
    )).rejects.toThrow("backing path already exists");
    expect(await readFile(collisionPath, "utf8")).toBe("preserve-existing-backing");

    await metadata.assign({ workspaceId: "uatu", credentialId: generated.id, role: "signing" });
    const failingDelete = new SshCredentialService({
      secretsDirectory: credentialSecretsPath(root),
      runtimeDirectory: credentialRuntimePath(root),
      metadataStore: metadata,
      agent,
      sshKeygenPath: wrappedKeygen,
      sshAddPath: wrappedAdd,
      removeFile: async () => { throw new Error("backing cleanup failed"); },
    });
    await expect(failingDelete.delete(generated.id, true)).rejects.toThrow("backing cleanup failed");
    expect(metadata.snapshot().credentials.some(item => item.id === generated.id)).toBe(true);
    expect(metadata.snapshot().assignments).toContainEqual({ workspaceId: "uatu", credentialId: generated.id, role: "signing" });
    expect(await Bun.file(generatedPath).exists()).toBe(true);
    expect(await Bun.file(`${generatedPath}.pub`).exists()).toBe(true);
    expect(await service.delete(generated.id, true)).toBe(true);

    expect(await readFile(credentialsPath(root), "utf8")).not.toContain(passphrase);
    const toolAudit = await readFile(audit, "utf8");
    expect(toolAudit).not.toContain(passphrase);
    expect(toolAudit).toContain(`SSH_ASKPASS=${credentialRuntimePath(root)}/.`);
    expect(toolAudit).toContain(`UATU_SSH_ASKPASS_PIPE=${credentialRuntimePath(root)}/.`);
    expect(toolAudit).not.toContain(`SSH_ASKPASS=${credentialSecretsPath(root)}/`);
    expect((await readdir(credentialRuntimePath(root))).some(file => file.endsWith(".askpass") || file.endsWith(".pipe"))).toBe(false);
  }, 30_000);

  test("imports an unencrypted key without a passphrase and automatically reloads it", async () => {
    const found = await tools();
    const root = await stateRoot("uatu-ssh-unencrypted-");
    const source = path.join(root, "source");
    expect((await run(found.keygen, ["-q", "-t", "ed25519", "-N", "", "-f", source], cleanEnv())).code).toBe(0);
    const metadata = new CredentialMetadataStore(credentialsPath(root));
    await metadata.load();
    const agent = new ManagedSshAgent({ runtimeDirectory: credentialRuntimePath(root), sshAgentPath: found.agent, uatuArgv: CLI_ARGV });
    agents.push(agent);
    const explicitLocks = new Set<string>();
    const service = new SshCredentialService({
      secretsDirectory: credentialSecretsPath(root),
      runtimeDirectory: credentialRuntimePath(root),
      metadataStore: metadata,
      agent,
      sshKeygenPath: found.keygen,
      sshAddPath: found.add,
      createId: () => "unencrypted",
      explicitLocks,
    });

    const imported = await service.import("Unencrypted", ["ssh-authentication"], await readFile(source, "utf8"), "");
    expect(await service.testUsability(imported.id)).toBe(true);
    await agent.shutdown();
    expect(await service.testUsability(imported.id)).toBe(true);

    // An explicit Lock sticks: readiness checks must not auto-load the
    // unencrypted key back into the agent until an explicit unlock.
    await service.lock(imported.id);
    expect(await service.testUsability(imported.id)).toBe(false);
    expect(await service.testUsability(imported.id)).toBe(false);
    // A key-tool override rebuilds the service around the same agent; the
    // shared lock set keeps the explicit lock in force.
    const rebuilt = new SshCredentialService({
      secretsDirectory: credentialSecretsPath(root),
      runtimeDirectory: credentialRuntimePath(root),
      metadataStore: metadata,
      agent,
      sshKeygenPath: found.keygen,
      sshAddPath: found.add,
      explicitLocks,
    });
    expect(await rebuilt.testUsability(imported.id)).toBe(false);
    await service.unlock(imported.id, "");
    expect(await service.testUsability(imported.id)).toBe(true);
    // Disable locks; re-enable restores auto-load, as after a Hub restart.
    await service.setEnabled(imported.id, false);
    await service.setEnabled(imported.id, true);
    expect(await service.testUsability(imported.id)).toBe(true);

    await agent.shutdown();
    await rm(path.join(credentialSecretsPath(root), `${imported.id}.key`));
    expect(await service.testUsability(imported.id)).toBe(false);
  }, 30_000);

  test("a delete queued behind an in-flight unlock cannot leave the identity in the agent", async () => {
    const found = await tools();
    const root = await stateRoot("uatu-ssh-unlock-race-");
    const source = path.join(root, "source");
    expect((await run(found.keygen, ["-q", "-t", "ed25519", "-N", "", "-f", source], cleanEnv())).code).toBe(0);
    // ssh-add slowed enough that the delete arrives while the unlock's add
    // is still pending.
    const slowAdd = path.join(root, "slow-ssh-add");
    await writeFile(slowAdd, `#!/bin/sh\nsleep 0.2\nexec '${found.add}' "$@"\n`, { mode: 0o700 });
    const metadata = new CredentialMetadataStore(credentialsPath(root));
    await metadata.load();
    const agent = new ManagedSshAgent({ runtimeDirectory: credentialRuntimePath(root), sshAgentPath: found.agent, uatuArgv: CLI_ARGV });
    agents.push(agent);
    const service = new SshCredentialService({
      secretsDirectory: credentialSecretsPath(root),
      runtimeDirectory: credentialRuntimePath(root),
      metadataStore: metadata,
      agent,
      sshKeygenPath: found.keygen,
      sshAddPath: slowAdd,
      createId: () => "race",
    });
    const imported = await service.import("Race", ["ssh-authentication"], await readFile(source, "utf8"), "");
    await service.lock(imported.id);

    const unlocking = service.unlock(imported.id, "");
    const deleting = service.delete(imported.id, true);
    // Serialized per credential: the unlock completes first with its
    // identity loaded, then the delete removes both the identity and the
    // credential — never the interleaving that strands a loaded identity
    // for a deleted credential.
    await expect(unlocking).resolves.toBeUndefined();
    expect(await deleting).toBe(true);
    const remaining = await run(found.add, ["-l"], { ...cleanEnv(), SSH_AUTH_SOCK: agent.socketPath });
    expect(remaining.output).toContain("no identities");
  }, 30_000);

  test("readiness queued behind an explicit lock does not auto-load the key", async () => {
    const found = await tools();
    const root = await stateRoot("uatu-ssh-readiness-lock-race-");
    const source = path.join(root, "source");
    expect((await run(found.keygen, ["-q", "-t", "ed25519", "-N", "", "-f", source], cleanEnv())).code).toBe(0);
    const failAdds = path.join(root, "fail-adds");
    const controlledAdd = path.join(root, "controlled-ssh-add");
    await writeFile(controlledAdd, [
      "#!/bin/sh",
      `if [ -f '${failAdds}' ] && [ "$1" != '-d' ] && [ "$1" != '-T' ]; then`,
      "  /bin/sleep 0.2",
      "  exit 1",
      "fi",
      `exec '${found.add}' "$@"`,
    ].join("\n"), { mode: 0o700 });
    const metadata = new CredentialMetadataStore(credentialsPath(root));
    await metadata.load();
    const agent = new ManagedSshAgent({ runtimeDirectory: credentialRuntimePath(root), sshAgentPath: found.agent, uatuArgv: CLI_ARGV });
    agents.push(agent);
    const service = new SshCredentialService({
      secretsDirectory: credentialSecretsPath(root),
      runtimeDirectory: credentialRuntimePath(root),
      metadataStore: metadata,
      agent,
      sshKeygenPath: found.keygen,
      sshAddPath: controlledAdd,
      createId: () => "readiness-race",
    });
    const imported = await service.import("Race", ["ssh-authentication"], await readFile(source, "utf8"), "");
    await service.lock(imported.id);
    await service.setEnabled(imported.id, false);
    await service.setEnabled(imported.id, true);
    await writeFile(failAdds, "fail\n");

    const failingUnlock = service.unlock(imported.id, "");
    const locking = service.lock(imported.id);
    const readiness = service.testUsability(imported.id);
    await expect(failingUnlock).rejects.toThrow("could not be unlocked");
    await expect(locking).resolves.toBeUndefined();
    expect(await readiness).toBe(false);
    expect((await run(found.add, ["-l"], { ...cleanEnv(), SSH_AUTH_SOCK: agent.socketPath })).output).toContain("no identities");

    await rm(failAdds);
    await service.unlock(imported.id, "");
    expect(await service.testUsability(imported.id)).toBe(true);
  }, 30_000);

  test("failed import removes an identity loaded by ssh-add before deleting its backing", async () => {
    const found = await tools();
    const root = await stateRoot("uatu-ssh-import-rollback-");
    const source = path.join(root, "source");
    expect((await run(found.keygen, ["-q", "-t", "ed25519", "-N", "", "-f", source], cleanEnv())).code).toBe(0);
    const addThenFail = path.join(root, "add-then-fail");
    await writeFile(addThenFail, [
      "#!/bin/sh",
      "case \"$1\" in",
      `  -*) exec '${found.add}' "$@" ;;`,
      "esac",
      `'${found.add}' "$@" >/dev/null 2>&1`,
      "exit 1",
    ].join("\n"), { mode: 0o700 });
    const metadata = new CredentialMetadataStore(credentialsPath(root));
    await metadata.load();
    const agent = new ManagedSshAgent({ runtimeDirectory: credentialRuntimePath(root), sshAgentPath: found.agent, uatuArgv: CLI_ARGV });
    agents.push(agent);
    const service = new SshCredentialService({
      secretsDirectory: credentialSecretsPath(root),
      runtimeDirectory: credentialRuntimePath(root),
      metadataStore: metadata,
      agent,
      sshKeygenPath: found.keygen,
      sshAddPath: addThenFail,
      createId: () => "rollback",
    });

    await expect(service.import("Rollback", ["ssh-authentication"], await readFile(source, "utf8"), ""))
      .rejects.toThrow("could not be unlocked");
    expect(metadata.snapshot().credentials).toHaveLength(0);
    expect(await Bun.file(path.join(credentialSecretsPath(root), "rollback.key")).exists()).toBe(false);
    expect(await Bun.file(path.join(credentialSecretsPath(root), "rollback.key.pub")).exists()).toBe(false);
    expect((await run(found.add, ["-l"], { ...cleanEnv(), SSH_AUTH_SOCK: agent.socketPath })).output).toContain("no identities");
  }, 30_000);

  test("failed import preserves catalog and backing when a possibly loaded identity cannot be removed", async () => {
    const found = await tools();
    const root = await stateRoot("uatu-ssh-import-cleanup-failure-");
    const source = path.join(root, "source");
    expect((await run(found.keygen, ["-q", "-t", "ed25519", "-N", "", "-f", source], cleanEnv())).code).toBe(0);
    const brokenAdd = path.join(root, "broken-cleanup-ssh-add");
    await writeFile(brokenAdd, [
      "#!/bin/sh",
      "case \"$1\" in",
      "  -d) exit 1 ;;",
      `  -*) exec '${found.add}' "$@" ;;`,
      "esac",
      `'${found.add}' "$@" >/dev/null 2>&1`,
      "exit 1",
    ].join("\n"), { mode: 0o700 });
    const metadata = new CredentialMetadataStore(credentialsPath(root));
    await metadata.load();
    const agent = new ManagedSshAgent({ runtimeDirectory: credentialRuntimePath(root), sshAgentPath: found.agent, uatuArgv: CLI_ARGV });
    agents.push(agent);
    const shutdown = agent.shutdown.bind(agent);
    agent.shutdown = async () => { throw new Error("simulated agent cleanup failure"); };
    const service = new SshCredentialService({
      secretsDirectory: credentialSecretsPath(root),
      runtimeDirectory: credentialRuntimePath(root),
      metadataStore: metadata,
      agent,
      sshKeygenPath: found.keygen,
      sshAddPath: brokenAdd,
      createId: () => "cleanup-failure",
    });
    try {
      await expect(service.import("Cleanup failure", ["ssh-authentication"], await readFile(source, "utf8"), ""))
        .rejects.toThrow("possibly loaded identity could not be removed");
      expect(metadata.snapshot().credentials.map(item => item.id)).toEqual(["cleanup-failure"]);
      expect(await Bun.file(path.join(credentialSecretsPath(root), "cleanup-failure.key")).exists()).toBe(true);
      expect(await Bun.file(path.join(credentialSecretsPath(root), "cleanup-failure.key.pub")).exists()).toBe(true);
    } finally {
      agent.shutdown = shutdown;
      await shutdown();
    }
  }, 30_000);

  test("bounds mkfifo setup and removes partial runtime artifacts", async () => {
    const found = await tools();
    const root = await stateRoot("uatu-ssh-mkfifo-timeout-");
    const metadata = new CredentialMetadataStore(credentialsPath(root));
    await metadata.load();
    const agent = new ManagedSshAgent({ runtimeDirectory: credentialRuntimePath(root), sshAgentPath: found.agent, uatuArgv: CLI_ARGV });
    agents.push(agent);
    const generatingService = new SshCredentialService({
      secretsDirectory: credentialSecretsPath(root),
      runtimeDirectory: credentialRuntimePath(root),
      metadataStore: metadata,
      agent,
      sshKeygenPath: found.keygen,
      sshAddPath: found.add,
      createId: () => "fifo-timeout",
    });
    const credential = await generatingService.generate("FIFO timeout", ["ssh-authentication"], "fifo-timeout-secret");
    const fifoAudit = path.join(root, "fifo-path");
    const fakeMkfifo = path.join(root, "mkfifo");
    const delayedArtifact = path.join(credentialRuntimePath(root), "delayed.pipe");
    await writeFile(fakeMkfifo, [
      "#!/bin/sh",
      `printf '%s\\n' "$3" > '${fifoAudit}'`,
      `(sleep 1; touch '${delayedArtifact}') &`,
      "/bin/sleep 5",
    ].join("\n"), { mode: 0o700 });
    const boundedService = new SshCredentialService({
      secretsDirectory: credentialSecretsPath(root),
      runtimeDirectory: credentialRuntimePath(root),
      metadataStore: metadata,
      agent,
      sshKeygenPath: found.keygen,
      sshAddPath: found.add,
      mkfifoPath: fakeMkfifo,
      operationTimeoutMs: 500,
    });

    const started = Date.now();
    await expect(boundedService.unlock(credential.id, "fifo-timeout-secret"))
      .rejects.toThrow("passphrase channel could not be created");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await readFile(fifoAudit, "utf8")).toStartWith(`${credentialRuntimePath(root)}/.`);
    expect((await readdir(credentialRuntimePath(root))).some(file => file.endsWith(".askpass") || file.endsWith(".pipe"))).toBe(false);
    expect((await readdir(credentialSecretsPath(root))).some(file => file.endsWith(".askpass") || file.endsWith(".pipe"))).toBe(false);
    await Bun.sleep(1_200);
    expect(await Bun.file(delayedArtifact).exists()).toBe(false);
  }, 30_000);

  test("timeouts terminate descendants retaining PTY and stdout handles", async () => {
    const found = await tools();
    const root = await stateRoot("uatu-ssh-descendant-timeout-");
    const metadata = new CredentialMetadataStore(credentialsPath(root));
    await metadata.load();
    const agent = new ManagedSshAgent({ runtimeDirectory: credentialRuntimePath(root), sshAgentPath: found.agent, uatuArgv: CLI_ARGV });
    agents.push(agent);
    const script = async (name: string, marker: string): Promise<string> => {
      const executable = path.join(root, name);
      await writeFile(executable, [
        "#!/bin/sh",
        `(sleep 1; touch '${marker}') &`,
        "/bin/sleep 5",
      ].join("\n"), { mode: 0o700 });
      return executable;
    };

    const ptyMarker = path.join(root, "pty-descendant-survived");
    const ptyKeygen = await script("pty-keygen", ptyMarker);
    const ptyService = new SshCredentialService({
      secretsDirectory: credentialSecretsPath(root),
      runtimeDirectory: credentialRuntimePath(root),
      metadataStore: metadata,
      agent,
      sshKeygenPath: ptyKeygen,
      sshAddPath: found.add,
      operationTimeoutMs: 200,
      createId: () => "pty-timeout",
    });
    const ptyStarted = Date.now();
    await expect(ptyService.generate("PTY timeout", ["ssh-authentication"], "pty-timeout-secret"))
      .rejects.toThrow("generation failed");
    expect(Date.now() - ptyStarted).toBeLessThan(1_500);

    const stdoutMarker = path.join(root, "stdout-descendant-survived");
    const stdoutKeygen = await script("stdout-keygen", stdoutMarker);
    const stdoutService = new SshCredentialService({
      secretsDirectory: credentialSecretsPath(root),
      runtimeDirectory: credentialRuntimePath(root),
      metadataStore: metadata,
      agent,
      sshKeygenPath: stdoutKeygen,
      sshAddPath: found.add,
      operationTimeoutMs: 200,
      createId: () => "stdout-timeout",
    });
    const stdoutStarted = Date.now();
    await expect(stdoutService.import("stdout timeout", ["ssh-signing"], "not an SSH key\n", ""))
      .rejects.toThrow("could not be unlocked");
    expect(Date.now() - stdoutStarted).toBeLessThan(1_500);

    const source = path.join(root, "askpass-source");
    expect((await run(found.keygen, ["-q", "-t", "ed25519", "-N", "askpass-secret", "-f", source], cleanEnv())).code).toBe(0);
    const setupService = new SshCredentialService({
      secretsDirectory: credentialSecretsPath(root),
      runtimeDirectory: credentialRuntimePath(root),
      metadataStore: metadata,
      agent,
      sshKeygenPath: found.keygen,
      sshAddPath: found.add,
      createId: () => "askpass-timeout",
    });
    const credential = await setupService.import(
      "askpass timeout",
      ["ssh-authentication"],
      await readFile(source, "utf8"),
      "askpass-secret",
    );
    await setupService.lock(credential.id);
    const askpassMarker = path.join(root, "askpass-descendant-survived");
    const slowAdd = await script("slow-add", askpassMarker);
    const askpassService = new SshCredentialService({
      secretsDirectory: credentialSecretsPath(root),
      runtimeDirectory: credentialRuntimePath(root),
      metadataStore: metadata,
      agent,
      sshKeygenPath: found.keygen,
      sshAddPath: slowAdd,
      operationTimeoutMs: 200,
    });
    const askpassStarted = Date.now();
    await expect(askpassService.unlock(credential.id, "askpass-secret")).rejects.toThrow("could not be unlocked");
    expect(Date.now() - askpassStarted).toBeLessThan(1_500);

    await Bun.sleep(1_100);
    expect(await Bun.file(ptyMarker).exists()).toBe(false);
    expect(await Bun.file(stdoutMarker).exists()).toBe(false);
    expect(await Bun.file(askpassMarker).exists()).toBe(false);
  }, 30_000);

  test("deleting a locked key keeps other loaded identities available", async () => {
    const found = await tools();
    const root = await stateRoot("uatu-ssh-delete-locked-");
    const metadata = new CredentialMetadataStore(credentialsPath(root));
    await metadata.load();
    const agent = new ManagedSshAgent({ runtimeDirectory: credentialRuntimePath(root), sshAgentPath: found.agent, uatuArgv: CLI_ARGV });
    agents.push(agent);
    let id = 0;
    const service = new SshCredentialService({
      secretsDirectory: credentialSecretsPath(root),
      runtimeDirectory: credentialRuntimePath(root),
      metadataStore: metadata,
      agent,
      sshKeygenPath: found.keygen,
      sshAddPath: found.add,
      createId: () => `locked-${++id}`,
    });
    const passphrase = "uatu-delete-locked-passphrase";
    const retained = await service.generate("Retained", ["ssh-authentication"], passphrase);
    const doomed = await service.generate("Doomed", ["ssh-authentication"], passphrase);
    await service.unlock(retained.id, passphrase);
    await service.unlock(doomed.id, passphrase);
    await service.lock(doomed.id);
    expect(await service.testUsability(doomed.id)).toBe(false);

    // ssh-add -d for the already-absent identity fails, but whole-agent
    // shutdown must not be the fallback: the retained credential stays
    // loaded in the shared agent.
    expect(await service.delete(doomed.id)).toBe(true);
    expect(agent.isRunning()).toBe(true);
    expect(await service.testUsability(retained.id)).toBe(true);
  }, 30_000);

  test("rejects concurrent imports of the same key and removes rejected backing files", async () => {
    const found = await tools();
    const root = await stateRoot("uatu-ssh-duplicate-");
    const source = path.join(root, "source");
    expect((await run(found.keygen, ["-q", "-t", "ed25519", "-N", "", "-f", source], cleanEnv())).code).toBe(0);
    const metadata = new CredentialMetadataStore(credentialsPath(root));
    await metadata.load();
    const agent = new ManagedSshAgent({ runtimeDirectory: credentialRuntimePath(root), sshAgentPath: found.agent, uatuArgv: CLI_ARGV });
    agents.push(agent);
    let id = 0;
    const service = new SshCredentialService({
      secretsDirectory: credentialSecretsPath(root),
      runtimeDirectory: credentialRuntimePath(root),
      metadataStore: metadata,
      agent,
      sshKeygenPath: found.keygen,
      sshAddPath: found.add,
      createId: () => `duplicate-${++id}`,
    });
    const privateKey = await readFile(source, "utf8");

    const results = await Promise.allSettled([
      service.import("First", ["ssh-authentication"], privateKey, ""),
      service.import("Second", ["ssh-signing"], privateKey, ""),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")?.reason.message).toBe("An SSH credential with this fingerprint already exists.");
    const winner = metadata.snapshot().credentials[0]!;
    for (const candidate of ["duplicate-1", "duplicate-2"]) {
      const privatePath = path.join(credentialSecretsPath(root), `${candidate}.key`);
      expect(await Bun.file(privatePath).exists()).toBe(candidate === winner.id);
      expect(await Bun.file(`${privatePath}.pub`).exists()).toBe(candidate === winner.id);
    }
  }, 30_000);

  test("uses only the Hub socket and leaves an ambient agent and its identities unchanged", async () => {
    const found = await tools();
    const ambientRoot = await stateRoot("uatu-ambient-agent-");
    const hubRoot = await stateRoot("uatu-hub-agent-");
    const ambient = new ManagedSshAgent({ runtimeDirectory: credentialRuntimePath(ambientRoot), sshAgentPath: found.agent, uatuArgv: CLI_ARGV });
    agents.push(ambient);
    const ambientSocket = await ambient.start();
    const ambientKey = path.join(credentialSecretsPath(ambientRoot), "ambient");
    expect((await run(found.keygen, ["-q", "-t", "ed25519", "-N", "", "-f", ambientKey], cleanEnv())).code).toBe(0);
    expect((await run(found.add, [ambientKey], { ...cleanEnv(), SSH_AUTH_SOCK: ambientSocket })).code).toBe(0);
    const ambientBefore = await run(found.add, ["-l"], { ...cleanEnv(), SSH_AUTH_SOCK: ambientSocket });
    expect(ambientBefore.code).toBe(0);

    const metadata = new CredentialMetadataStore(credentialsPath(hubRoot));
    await metadata.load();
    const hubAgent = new ManagedSshAgent({
      runtimeDirectory: credentialRuntimePath(hubRoot),
      sshAgentPath: found.agent,
      uatuArgv: CLI_ARGV,
      servicePath: process.env.PATH,
    });
    agents.push(hubAgent);
    const service = new SshCredentialService({
      secretsDirectory: credentialSecretsPath(hubRoot),
      runtimeDirectory: credentialRuntimePath(hubRoot),
      metadataStore: metadata,
      agent: hubAgent,
      sshKeygenPath: found.keygen,
      sshAddPath: found.add,
      createId: () => "managed",
    });
    const previousAmbient = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = ambientSocket;
    try {
      expect(hubAgent.currentSocket()).toBeUndefined();
      const credential = await service.generate("Managed", ["ssh-authentication"], "managed-agent-secret");
      expect(hubAgent.currentSocket()).toBeUndefined();
      await service.unlock(credential.id, "managed-agent-secret");
      expect(hubAgent.currentSocket()).toBe(path.join(credentialRuntimePath(hubRoot), "ssh-agent.sock"));
      expect(hubAgent.currentSocket()).not.toBe(ambientSocket);
      await service.lock(credential.id);
      await hubAgent.shutdown();
    } finally {
      if (previousAmbient === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = previousAmbient;
    }

    const ambientAfter = await run(found.add, ["-l"], { ...cleanEnv(), SSH_AUTH_SOCK: ambientSocket });
    expect(ambientAfter.code).toBe(0);
    expect(ambientAfter.output).toBe(ambientBefore.output);
    expect((await lstat(ambientSocket)).isSocket()).toBe(true);
  }, 30_000);
});

async function wrapper(root: string, name: string, executable: string, audit: string): Promise<string> {
  const filePath = path.join(root, `${name}-wrapper.sh`);
  await writeFile(filePath, [
    "#!/bin/sh",
    `printf 'SSH_ASKPASS=%s UATU_SSH_ASKPASS_PIPE=%s\\n' "$SSH_ASKPASS" "$UATU_SSH_ASKPASS_PIPE" >> '${audit}'`,
    `printf '%s\\n' \"$0 $* SSH_AUTH_SOCK=\${SSH_AUTH_SOCK-}\" >> '${audit}'`,
    `exec '${executable}' \"$@\"`,
  ].join("\n"), { mode: 0o700 });
  await chmod(filePath, 0o700);
  return filePath;
}

function cleanEnv(): Record<string, string> {
  return { PATH: process.env.PATH ?? "", LANG: "C", LC_ALL: "C" };
}
