import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CredentialMetadataStore } from "./credential-store";
import {
  OPENPGP_SIGNING_CHALLENGE,
  OpenPgpCredentialManager,
  type OpenPgpCommand,
  type OpenPgpCommandRunner,
} from "./openpgp-credentials";
import { toPublicCredentialDto } from "./credential-types";

const FINGERPRINT = "0123456789ABCDEF0123456789ABCDEF01234567";
const PUBLIC_KEY = "-----BEGIN PGP PUBLIC KEY BLOCK-----\npublic-only\n-----END PGP PUBLIC KEY BLOCK-----";
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(runCommand?: OpenPgpCommandRunner, paths: { gpg?: string | null; gpgconf?: string | null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "uatu-openpgp-"));
  tempDirectories.push(root);
  const gnupgHome = path.join(root, "managed-gnupg");
  await mkdir(gnupgHome, { mode: 0o700 });
  const store = new CredentialMetadataStore(path.join(root, "credentials.json"));
  await store.load();
  const manager = new OpenPgpCredentialManager({
    gnupgHome,
    metadataStore: store,
    gpgPath: paths.gpg === undefined ? "/managed/bin/gpg" : paths.gpg,
    gpgconfPath: paths.gpgconf === undefined ? "/managed/bin/gpgconf" : paths.gpgconf,
    servicePath: "/managed/bin",
    ...(runCommand ? { runCommand } : {}),
  });
  return { root, gnupgHome, store, manager };
}

function fakeGpg() {
  const commands: Array<Omit<OpenPgpCommand, "input">> = [];
  let cached = false;
  let deleted = false;
  const run: OpenPgpCommandRunner = async command => {
    const { input: _, ...publicCommand } = command;
    commands.push(structuredClone(publicCommand));
    const args = command.args;
    let stdout = "";
    let exitCode = 0;
    if (args.includes("--quick-generate-key")) {
      stdout = `[GNUPG:] KEY_CREATED B ${FINGERPRINT}\n`;
    } else if (args.includes("show-only")) {
      stdout = `sec:-:255:22:ABCD:0:0:::::s:::\nfpr:::::::::${FINGERPRINT}:\n`;
    } else if (args.includes("--list-secret-keys")) {
      exitCode = deleted ? 2 : 0;
      stdout = deleted ? "" : `sec:-:255:22:ABCD:0:0:::::s:::\nfpr:::::::::${FINGERPRINT}:\n`;
    } else if (args.includes("--export")) {
      stdout = `${PUBLIC_KEY}\n`;
    } else if (args.includes("--detach-sign")) {
      if (args.includes("loopback")) cached = true;
      if (args.includes("error") && !cached) exitCode = 2;
      if (exitCode === 0) {
        const output = args[args.indexOf("--output") + 1];
        if (output) await writeFile(output, "local-signature", { mode: 0o600 });
      }
    } else if (args.includes("--delete-secret-and-public-key")) {
      deleted = true;
    }
    return { exitCode, timedOut: false, outputExceeded: false, stdout };
  };
  return { run, commands, isDeleted: () => deleted };
}

async function createCredential(
  store: CredentialMetadataStore,
  options: { enabled?: boolean } = {},
) {
  return store.create({
    name: "Release signing",
    type: "openpgp",
    capabilities: ["openpgp-signing"],
    enabled: options.enabled ?? true,
    metadata: { fingerprint: FINGERPRINT, publicKey: PUBLIC_KEY },
  }, () => "pgp-1", () => new Date("2026-08-20T12:00:00Z"));
}

describe("OpenPgpCredentialManager generation and import", () => {
  test("generates in the dedicated home and persists only public metadata", async () => {
    const fake = fakeGpg();
    const { manager, store, gnupgHome } = await fixture(fake.run);
    const credential = await manager.generate({
      name: "Release signing",
      userId: "Uatu Release <release@example.test>",
      passphrase: "sentinel-generation-passphrase",
    });

    expect(credential.metadata).toEqual({ fingerprint: FINGERPRINT, publicKey: PUBLIC_KEY });
    expect(store.snapshot().credentials).toEqual([credential]);
    expect(JSON.stringify(credential)).not.toContain("sentinel-generation-passphrase");
    expect(JSON.stringify(store.snapshot())).not.toContain("sentinel-generation-passphrase");
    for (const command of fake.commands) {
      expect(command.args).toContain(gnupgHome);
      expect(command.env).toEqual({ GNUPGHOME: gnupgHome, PATH: "/managed/bin", LANG: "C", LC_ALL: "C" });
      expect(JSON.stringify(command)).not.toContain("sentinel-generation-passphrase");
    }
  });

  test("imports private material through stdin and exports no private fields", async () => {
    const fake = fakeGpg();
    const { manager, store } = await fixture(fake.run);
    const privateKey = "-----BEGIN PGP PRIVATE KEY BLOCK-----\nsentinel-private-export\n-----END PGP PRIVATE KEY BLOCK-----";
    const credential = await manager.import({ name: "Imported signing", privateKey });
    const dto = toPublicCredentialDto(credential, [], []);

    expect(dto.metadata).toEqual({ fingerprint: FINGERPRINT, publicKey: PUBLIC_KEY });
    expect(JSON.stringify(dto)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(dto)).not.toContain("sentinel-private-export");
    expect(JSON.stringify(store.snapshot())).not.toContain("sentinel-private-export");
    expect(fake.commands.flatMap(command => command.args)).not.toContain(privateKey);
  });

  test("rejects an existing imported fingerprint without touching its backing key", async () => {
    const fake = fakeGpg();
    const { manager, store } = await fixture(fake.run);
    await createCredential(store);

    await expect(manager.import({ name: "Duplicate", privateKey: "private-key-input" })).rejects.toThrow(/already exists/);
    expect(store.snapshot().credentials.map(credential => credential.id)).toEqual(["pgp-1"]);
    expect(fake.commands.filter(command => command.args.includes("--import") && !command.args.includes("show-only"))).toHaveLength(0);
    expect(fake.commands.some(command => command.args.includes("--delete-secret-and-public-key"))).toBe(false);
    expect(fake.isDeleted()).toBe(false);
  });

  test("rejects a bundle containing multiple primary private keys before import", async () => {
    const fake = fakeGpg();
    const secondFingerprint = "89ABCDEF0123456789ABCDEF0123456789ABCDEF";
    const run: OpenPgpCommandRunner = async command => {
      const result = await fake.run(command);
      if (!command.args.includes("show-only")) return result;
      return {
        ...result,
        stdout: result.stdout + `sec:-:255:22:EFGH:0:0:::::s:::\nfpr:::::::::${secondFingerprint}:\n`,
      };
    };
    const { manager, store } = await fixture(run);

    await expect(manager.import({ name: "Bundle", privateKey: "two-private-keys" })).rejects.toThrow(/exactly one primary private key/);
    expect(store.snapshot().credentials).toEqual([]);
    expect(fake.commands.filter(command => command.args.includes("--import") && !command.args.includes("show-only"))).toHaveLength(0);
  });

  test("rejects a generated fingerprint already in the catalog without deleting it", async () => {
    const fake = fakeGpg();
    const { manager, store } = await fixture(fake.run);
    await createCredential(store);

    await expect(manager.generate({ name: "Duplicate", userId: "Duplicate <duplicate@example.test>", passphrase: "secret" })).rejects.toThrow(/already exists/);
    expect(store.snapshot().credentials.map(credential => credential.id)).toEqual(["pgp-1"]);
    expect(fake.commands.some(command => command.args.includes("--delete-secret-and-public-key"))).toBe(false);
    expect(fake.isDeleted()).toBe(false);
  });

  test("degrades without GnuPG instead of failing manager startup", async () => {
    let invoked = false;
    const { manager } = await fixture(async () => {
      invoked = true;
      throw new Error("must not run");
    }, { gpg: null, gpgconf: null });

    expect(await manager.readiness()).toEqual([{
      layer: "binary",
      status: "unavailable",
      message: "GnuPG is unavailable; install it or configure its absolute path.",
    }]);
    await expect(manager.generate({ name: "key", userId: "test", passphrase: "secret" })).rejects.toThrow(/unavailable/);
    expect(invoked).toBe(false);
  });

  test("rejects imported secret material without signing capability", async () => {
    const fake = fakeGpg();
    const run: OpenPgpCommandRunner = async command => {
      const result = await fake.run(command);
      if (command.args.includes("--list-secret-keys")) return { ...result, stdout: result.stdout.replace(":s:::", ":e:::") };
      return result;
    };
    const { manager, store } = await fixture(run);
    await expect(manager.import({ name: "Encryption only", privateKey: "private-key-input" })).rejects.toThrow(/signing secret key/);
    expect(store.snapshot().credentials).toEqual([]);
  });

  test("maps a stale or unstartable GnuPG path to sanitized readiness", async () => {
    const { manager, store } = await fixture(async () => {
      throw new Error("ambient-home/sentinel-command-error");
    });
    await createCredential(store);
    const readiness = await manager.readiness("pgp-1");
    expect(readiness).toContainEqual({ layer: "credential", status: "unavailable", message: "The OpenPGP secret key is unavailable." });
    expect(JSON.stringify(readiness)).not.toContain("sentinel-command-error");
  });
});

describe("OpenPgpCredentialManager lifecycle and capability", () => {
  test("unlocks with loopback input, detects cache, then signs and verifies the fixed challenge", async () => {
    const fake = fakeGpg();
    const { manager, store, gnupgHome } = await fixture(fake.run);
    await createCredential(store);

    expect(await manager.readiness("pgp-1")).toContainEqual({
      layer: "runtime",
      status: "unavailable",
      message: "The OpenPGP signing key requires unlock.",
    });
    const unlock = await manager.unlock("pgp-1", "sentinel-unlock-passphrase");
    expect(unlock).toEqual([{ layer: "runtime", status: "ready", message: "The OpenPGP signing key is unlocked in the Hub agent." }]);
    expect(await manager.test("pgp-1")).toEqual([{
      layer: "capability",
      status: "ready",
      message: "The fixed Hub challenge was signed and verified locally.",
    }]);

    const loopback = fake.commands.find(command => command.args.includes("--passphrase-fd"));
    expect(loopback?.args).toContain("loopback");
    expect(JSON.stringify(fake.commands)).not.toContain("sentinel-unlock-passphrase");
    expect(JSON.stringify(unlock)).not.toContain("sentinel-unlock-passphrase");
    expect(OPENPGP_SIGNING_CHALLENGE).toBe("uatu hub OpenPGP signing capability v1\n");
    expect((await readdir(gnupgHome)).filter(name => name.startsWith(".uatu-"))).toEqual([]);
  });

  test("disables, enables, shuts down the shared agent, and transactionally deletes", async () => {
    const fake = fakeGpg();
    const { manager, store, gnupgHome } = await fixture(fake.run);
    await createCredential(store);
    await store.assign({ workspaceId: "uatu", credentialId: "pgp-1", role: "signing" });

    expect(await manager.disable("pgp-1")).toBeUndefined();
    expect(store.snapshot().credentials[0]?.enabled).toBe(false);
    await manager.enable("pgp-1");
    expect(store.snapshot().credentials[0]?.enabled).toBe(true);
    expect(await manager.shutdown()).toEqual([{ layer: "runtime", status: "ready", message: "The Hub OpenPGP agent was stopped." }]);
    await expect(manager.delete("pgp-1")).rejects.toThrow(/assigned/);
    expect(await manager.delete("pgp-1", true)).toBe(true);
    expect(store.snapshot()).toEqual({ version: 1, credentials: [], assignments: [] });
    expect(fake.isDeleted()).toBe(true);

    // Two kills: disable falls back to stopping the agent (no
    // gpg-connect-agent beside the fake gpgconf path for targeted
    // eviction), and the explicit shutdown.
    const lifecycle = fake.commands.filter(command => command.executable.endsWith("gpgconf"));
    expect(lifecycle).toHaveLength(2);
    for (const command of lifecycle) {
      expect(command.args).toEqual(["--homedir", gnupgHome, "--kill", "gpg-agent"]);
    }
  });

  test("disable evicts only this key's cached passphrases when gpg-connect-agent is available", async () => {
    const binDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-gnupg-bin-"));
    tempDirectories.push(binDirectory);
    const gpgconfPath = path.join(binDirectory, "gpgconf");
    const connectAgentPath = path.join(binDirectory, "gpg-connect-agent");
    await writeFile(gpgconfPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(connectAgentPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const fake = fakeGpg();
    const keygrips = ["A".repeat(40), "B".repeat(40)];
    const run: OpenPgpCommandRunner = async command => {
      if (command.args.includes("--with-keygrip")) {
        const listed = await fake.run(command);
        return { ...listed, stdout: `${listed.stdout}${keygrips.map(value => `grp:::::::::${value}:`).join("\n")}\n` };
      }
      if (command.executable === connectAgentPath) {
        await fake.run(command);
        return { exitCode: 0, timedOut: false, outputExceeded: false, stdout: "OK\n" };
      }
      return fake.run(command);
    };
    const { manager, store } = await fixture(run, { gpgconf: gpgconfPath });
    await createCredential(store);

    await manager.disable("pgp-1");
    expect(store.snapshot().credentials[0]?.enabled).toBe(false);
    const evictions = fake.commands.filter(command => command.executable === connectAgentPath);
    expect(evictions.map(command => command.args[0])).toEqual(keygrips.map(value => `clear_passphrase ${value}`));
    // Targeted eviction succeeded: the shared agent was not stopped, so
    // unrelated cached credentials stay usable.
    expect(fake.commands.some(command => command.executable === gpgconfPath)).toBe(false);
  });

  test("rolls catalog deletion back when private-key deletion fails", async () => {
    const fake = fakeGpg();
    const failing: OpenPgpCommandRunner = async command => {
      const result = await fake.run(command);
      if (command.args.includes("--delete-secret-and-public-key")) return { ...result, exitCode: 2 };
      return result;
    };
    const { manager, store } = await fixture(failing);
    await createCredential(store);
    await expect(manager.delete("pgp-1")).rejects.toThrow("OpenPGP credential deletion failed.");
    expect(store.snapshot().credentials.map(credential => credential.id)).toEqual(["pgp-1"]);
  });

  test("holds metadata mutations until failed key deletion rolls back", async () => {
    const fake = fakeGpg();
    let markDeleteReached!: () => void;
    let releaseDelete!: () => void;
    const deleteReached = new Promise<void>(resolve => { markDeleteReached = resolve; });
    const deleteGate = new Promise<void>(resolve => { releaseDelete = resolve; });
    const failing: OpenPgpCommandRunner = async command => {
      const result = await fake.run(command);
      if (command.args.includes("--delete-secret-and-public-key")) {
        markDeleteReached();
        await deleteGate;
        return { ...result, exitCode: 2 };
      }
      return result;
    };
    const { manager, store } = await fixture(failing);
    await createCredential(store);
    await store.create({
      name: "Replacement",
      type: "openpgp",
      capabilities: ["openpgp-signing"],
      enabled: true,
      metadata: { fingerprint: "B".repeat(40), publicKey: PUBLIC_KEY },
    }, () => "pgp-2");
    await store.assign({ workspaceId: "uatu", credentialId: "pgp-1", role: "signing" });

    const deleting = manager.delete("pgp-1", true);
    await deleteReached;
    const replacement = store.assign({ workspaceId: "uatu", credentialId: "pgp-2", role: "signing" });
    await Bun.sleep(1);
    releaseDelete();

    await expect(deleting).rejects.toThrow("OpenPGP credential deletion failed.");
    await expect(replacement).rejects.toThrow("conflicts");
    expect(store.snapshot().assignments).toEqual([{ workspaceId: "uatu", credentialId: "pgp-1", role: "signing" }]);
  });

  test("keeps a shared key when deleting a legacy duplicate record", async () => {
    const fake = fakeGpg();
    const { manager, store } = await fixture(fake.run);
    await createCredential(store);
    await store.create({
      name: "Legacy duplicate",
      type: "openpgp",
      capabilities: ["openpgp-signing"],
      enabled: true,
      metadata: { fingerprint: FINGERPRINT, publicKey: PUBLIC_KEY },
    }, () => "pgp-2");

    expect(await manager.delete("pgp-1")).toBe(true);
    expect(store.snapshot().credentials.map(credential => credential.id)).toEqual(["pgp-2"]);
    expect(fake.commands.some(command => command.args.includes("--delete-secret-and-public-key"))).toBe(false);
    expect(await manager.readiness("pgp-2")).toContainEqual({
      layer: "credential",
      status: "ready",
      message: "The OpenPGP secret key is available.",
    });
  });
});

describe("OpenPGP ambient separation", () => {
  test("uses only the Hub home and scoped gpgconf lifecycle with ambient state present", async () => {
    const ambientHome = await mkdtemp(path.join(os.tmpdir(), "uatu-ambient-gnupg-"));
    tempDirectories.push(ambientHome);
    const ambientMarker = path.join(ambientHome, "agent.marker");
    await writeFile(ambientMarker, "system-agent-running", { mode: 0o600 });
    const executableRoot = await mkdtemp(path.join(os.tmpdir(), "uatu-fake-gpgconf-"));
    tempDirectories.push(executableRoot);
    const gpgconf = path.join(executableRoot, "gpgconf");
    await writeFile(gpgconf, "#!/bin/sh\nprintf '%s\\n' \"$GNUPGHOME\" \"$@\" > \"$GNUPGHOME/lifecycle.trace\"\n", { mode: 0o700 });
    const previousHome = process.env.GNUPGHOME;
    const previousAgent = process.env.GPG_AGENT_INFO;
    process.env.GNUPGHOME = ambientHome;
    process.env.GPG_AGENT_INFO = path.join(ambientHome, "S.gpg-agent:123:1");
    try {
      const { manager, gnupgHome } = await fixture(undefined, { gpgconf });
      expect(await manager.shutdown()).toEqual([{ layer: "runtime", status: "ready", message: "The Hub OpenPGP agent was stopped." }]);
      const trace = await readFile(path.join(gnupgHome, "lifecycle.trace"), "utf8");
      expect(trace.split("\n")).toEqual([gnupgHome, "--homedir", gnupgHome, "--kill", "gpg-agent", ""]);
      expect(await readFile(ambientMarker, "utf8")).toBe("system-agent-running");
      expect((await stat(ambientMarker)).isFile()).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.GNUPGHOME;
      else process.env.GNUPGHOME = previousHome;
      if (previousAgent === undefined) delete process.env.GPG_AGENT_INFO;
      else process.env.GPG_AGENT_INFO = previousAgent;
    }
  });
});
