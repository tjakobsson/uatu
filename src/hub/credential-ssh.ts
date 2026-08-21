import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";

import { CredentialMetadataStore } from "./credential-store";
import { ManagedSshAgent } from "./credential-ssh-agent";
import type { CredentialCapability, SshCredentialRecord } from "./credential-types";

const ECHO_FLAG = 0x00000008;
const OPERATION_TIMEOUT_MS = 15_000;
const MAX_PRIVATE_KEY_BYTES = 1_048_576;
const MAX_PUBLIC_OUTPUT_BYTES = 32_768;
const SSH_PUBLIC_KEY = /(?:^|[\r\n ])((?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-[^\s]+|sk-[^\s]+) [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?)/;

type SshCapability = Extract<CredentialCapability, "ssh-authentication" | "ssh-signing">;

export type SshCredentialServiceOptions = {
  secretsDirectory: string;
  metadataStore: CredentialMetadataStore;
  agent: ManagedSshAgent;
  sshKeygenPath: string;
  sshAddPath: string;
  servicePath?: string;
  operationTimeoutMs?: number;
  createId?: () => string;
};

type PtyResult = { exitCode: number; publicOutput: string };

function credentialFile(directory: string, credentialId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(credentialId)) throw new Error("invalid SSH credential id");
  return path.join(directory, `${credentialId}.key`);
}

function encryptedPrivateKey(value: string): boolean {
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(value) || /Proc-Type:\s*4,ENCRYPTED/i.test(value)) return true;
  const match = value.match(/-----BEGIN OPENSSH PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+)-----END OPENSSH PRIVATE KEY-----/);
  if (!match) return false;
  try {
    const bytes = Buffer.from(match[1]!.replace(/\s/g, ""), "base64");
    const magic = Buffer.from("openssh-key-v1\0");
    if (!bytes.subarray(0, magic.length).equals(magic)) return false;
    const cipherLength = bytes.readUInt32BE(magic.length);
    const cipher = bytes.subarray(magic.length + 4, magic.length + 4 + cipherLength).toString("ascii");
    return cipher !== "none";
  } catch {
    return false;
  }
}

function publicMetadata(publicKey: string): { publicKey: string; fingerprint: string } {
  const normalized = publicKey.trim();
  const parts = normalized.split(/\s+/);
  if (parts.length < 2 || !SSH_PUBLIC_KEY.test(normalized)) throw new Error("SSH tool did not produce a supported public key");
  let blob: Buffer;
  try {
    blob = Buffer.from(parts[1]!, "base64");
  } catch {
    throw new Error("SSH tool produced an invalid public key");
  }
  if (blob.length === 0) throw new Error("SSH tool produced an invalid public key");
  const digest = createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  return { publicKey: normalized, fingerprint: `SHA256:${digest}` };
}

async function assertPrivateKeyFile(filePath: string): Promise<void> {
  const stats = await fs.lstat(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("SSH private key path is unsafe");
  if ((stats.mode & 0o077) !== 0) throw new Error("SSH private key has unsafe permissions");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("SSH private key is not owned by the current user");
  }
}

async function runSecretPty(options: {
  executable: string;
  args: string[];
  env: Record<string, string>;
  responses: string[];
  timeoutMs: number;
  capturePublicKey?: boolean;
}): Promise<PtyResult> {
  let output = "";
  let promptOutput = "";
  let responseIndex = 0;
  let processExited = false;
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({
    cols: 80,
    rows: 24,
    data(activeTerminal, bytes) {
      const chunk = decoder.decode(bytes.subarray(0, MAX_PUBLIC_OUTPUT_BYTES), { stream: true });
      promptOutput = `${promptOutput}${chunk}`.slice(-4_096);
      for (const secret of options.responses) promptOutput = promptOutput.replaceAll(secret, "[redacted]");
      if (options.capturePublicKey && output.length < MAX_PUBLIC_OUTPUT_BYTES) {
        output = `${output}${chunk}`.slice(0, MAX_PUBLIC_OUTPUT_BYTES);
        for (const secret of options.responses) output = output.replaceAll(secret, "[redacted]");
      }
      const prompts = (promptOutput.match(/passphrase[^:\r\n]*:/gi) ?? []).length;
      while (responseIndex < prompts && responseIndex < options.responses.length) {
        activeTerminal.localFlags &= ~ECHO_FLAG;
        activeTerminal.write(`${options.responses[responseIndex++]!}\n`);
      }
    },
  });
  const child = Bun.spawn([options.executable, ...options.args], {
    detached: true,
    terminal,
    env: options.env,
  });
  const timer = setTimeout(() => {
    if (!processExited) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may exit at the timeout boundary.
      }
    }
  }, options.timeoutMs);
  try {
    const exitCode = (await child.exited) ?? 1;
    processExited = true;
    output += decoder.decode();
    for (const secret of options.responses) output = output.replaceAll(secret, "[redacted]");
    return { exitCode, publicOutput: output };
  } finally {
    clearTimeout(timer);
    terminal.close();
  }
}

async function runQuiet(
  executable: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<number> {
  const child = Bun.spawn([executable, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may exit at the timeout boundary.
    }
  }, timeoutMs);
  try {
    const exitCode = (await child.exited) ?? 1;
    return timedOut ? 124 : exitCode;
  } finally {
    clearTimeout(timer);
  }
}

async function readPublicKey(executable: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<PtyResult> {
  const child = Bun.spawn([executable, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env });
  let processExited = false;
  const timer = setTimeout(() => {
    if (!processExited) child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const reader = child.stdout.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = MAX_PUBLIC_OUTPUT_BYTES - size;
      if (remaining > 0) chunks.push(next.value.slice(0, remaining));
      size += Math.min(next.value.length, Math.max(remaining, 0));
    }
    const exitCode = (await child.exited) ?? 1;
    processExited = true;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return { exitCode, publicOutput: new TextDecoder().decode(bytes) };
  } finally {
    clearTimeout(timer);
  }
}

async function runSecretAskpass(options: {
  executable: string;
  args: string[];
  env: Record<string, string>;
  passphrase: string;
  runtimeDirectory: string;
  timeoutMs: number;
}): Promise<number> {
  const operationId = randomUUID();
  const askpassPath = path.join(options.runtimeDirectory, `.${operationId}.askpass`);
  const secretPipePath = path.join(options.runtimeDirectory, `.${operationId}.pipe`);
  let secretPipe: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    await fs.writeFile(askpassPath, "#!/bin/sh\nIFS= read -r secret < \"$UATU_SSH_ASKPASS_PIPE\"\nprintf '%s\\n' \"$secret\"\n", { mode: 0o700 });
    let mkfifo;
    try {
      mkfifo = Bun.spawn(["mkfifo", "-m", "600", secretPipePath], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: options.env,
      });
    } catch {
      throw new Error("SSH passphrase channel could not be created");
    }
    if (await mkfifo.exited !== 0) throw new Error("SSH passphrase channel could not be created");
    secretPipe = await fs.open(secretPipePath, constants.O_RDWR);
    const child = Bun.spawn([options.executable, ...options.args], {
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...options.env,
        DISPLAY: "uatu",
        SSH_ASKPASS: askpassPath,
        SSH_ASKPASS_REQUIRE: "force",
        UATU_SSH_ASKPASS_PIPE: secretPipePath,
      },
    });
    await secretPipe.writeFile(`${options.passphrase}\n`);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may exit at the timeout boundary.
      }
    }, options.timeoutMs);
    try {
      const exitCode = (await child.exited) ?? 1;
      return timedOut ? 124 : exitCode;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await secretPipe?.close().catch(() => undefined);
    await Promise.all([askpassPath, secretPipePath].map(file => fs.rm(file, { force: true })));
  }
}

export class SshCredentialService {
  private readonly servicePath: string;
  private readonly timeoutMs: number;
  private readonly createId: () => string;

  constructor(private readonly options: SshCredentialServiceOptions) {
    this.servicePath = options.servicePath ?? process.env.PATH ?? "";
    this.timeoutMs = options.operationTimeoutMs ?? OPERATION_TIMEOUT_MS;
    this.createId = options.createId ?? randomUUID;
  }

  async generate(name: string, capabilities: SshCapability[], passphrase: string): Promise<SshCredentialRecord> {
    this.validateInput(name, capabilities, passphrase);
    const id = this.createId();
    const privatePath = credentialFile(this.options.secretsDirectory, id);
    const publicPath = `${privatePath}.pub`;
    await this.assertAvailablePaths(privatePath, publicPath);
    try {
      const result = await runSecretPty({
        executable: this.options.sshKeygenPath,
        args: ["-q", "-t", "ed25519", "-f", privatePath, "-C", `uatu:${id}`],
        env: this.toolEnvironment(),
        responses: [passphrase, passphrase],
        timeoutMs: this.timeoutMs,
      });
      if (result.exitCode !== 0) throw new Error("SSH key generation failed");
      await assertPrivateKeyFile(privatePath);
      await fs.chmod(publicPath, 0o600);
      const metadata = publicMetadata(await fs.readFile(publicPath, "utf8"));
      return await this.options.metadataStore.create({
        name,
        enabled: true,
        type: "ssh",
        capabilities,
        metadata,
      }, () => id) as SshCredentialRecord;
    } catch (error) {
      await Promise.all([privatePath, publicPath].map(file => fs.rm(file, { force: true })));
      throw error;
    }
  }

  async import(name: string, capabilities: SshCapability[], privateKey: string, passphrase: string): Promise<SshCredentialRecord> {
    this.validateInput(name, capabilities);
    if (Buffer.byteLength(privateKey) > MAX_PRIVATE_KEY_BYTES) throw new Error("SSH private key exceeds the size limit");
    const encrypted = encryptedPrivateKey(privateKey);
    if (encrypted && passphrase === "") throw new Error("SSH private key passphrase is required");
    if (/[\x00-\x1f\x7f]/.test(passphrase)) throw new Error("SSH passphrase contains invalid characters");
    const id = this.createId();
    const privatePath = credentialFile(this.options.secretsDirectory, id);
    const publicPath = `${privatePath}.pub`;
    await this.assertAvailablePaths(privatePath, publicPath);
    let privateCreated = false;
    let publicCreated = false;
    let credentialCreated = false;
    try {
      await fs.writeFile(privatePath, privateKey, { flag: "wx", mode: 0o600 });
      privateCreated = true;
      await assertPrivateKeyFile(privatePath);
      const result = encrypted
        ? await runSecretPty({
            executable: this.options.sshKeygenPath,
            args: ["-y", "-f", privatePath],
            env: this.toolEnvironment(),
            responses: [passphrase],
            timeoutMs: this.timeoutMs,
            capturePublicKey: true,
          })
        : await readPublicKey(this.options.sshKeygenPath, ["-y", "-f", privatePath], this.toolEnvironment(), this.timeoutMs);
      if (result.exitCode !== 0) throw new Error("SSH private key could not be unlocked");
      const match = result.publicOutput.match(SSH_PUBLIC_KEY);
      if (!match?.[1]) throw new Error("SSH private key did not yield a public key");
      const metadata = publicMetadata(match[1]);
      await fs.writeFile(publicPath, `${metadata.publicKey}\n`, { flag: "wx", mode: 0o600 });
      publicCreated = true;
      const credential = await this.options.metadataStore.create({
        name,
        enabled: true,
        type: "ssh",
        capabilities,
        metadata,
      }, () => id) as SshCredentialRecord;
      credentialCreated = true;
      await this.unlock(id, passphrase);
      return credential;
    } catch (error) {
      if (credentialCreated) await this.options.metadataStore.deleteCredential(id, true).catch(() => undefined);
      await Promise.all([
        ...(privateCreated ? [fs.rm(privatePath, { force: true })] : []),
        ...(publicCreated ? [fs.rm(publicPath, { force: true })] : []),
      ]);
      throw error;
    }
  }

  async unlock(credentialId: string, passphrase: string): Promise<void> {
    if (/[\x00-\x1f\x7f]/.test(passphrase)) throw new Error("SSH passphrase contains invalid characters");
    const credential = this.credential(credentialId);
    if (!credential.enabled) throw new Error("SSH credential is disabled");
    const privatePath = credentialFile(this.options.secretsDirectory, credentialId);
    if (passphrase === "" && encryptedPrivateKey(await fs.readFile(privatePath, "utf8"))) {
      throw new Error("SSH private key passphrase is required");
    }
    const socket = await this.options.agent.start();
    const exitCode = await runSecretAskpass({
      executable: this.options.sshAddPath,
      args: [privatePath],
      env: this.agentEnvironment(socket),
      passphrase,
      runtimeDirectory: this.options.secretsDirectory,
      timeoutMs: this.timeoutMs,
    });
    if (exitCode !== 0 || !(await this.testUsability(credentialId))) {
      throw new Error("SSH credential could not be unlocked");
    }
  }

  async lock(credentialId: string): Promise<void> {
    this.credential(credentialId);
    const socket = this.options.agent.currentSocket();
    if (!socket) return;
    const exitCode = await runQuiet(
      this.options.sshAddPath,
      ["-d", `${credentialFile(this.options.secretsDirectory, credentialId)}.pub`],
      this.agentEnvironment(socket),
      this.timeoutMs,
    );
    if (exitCode !== 0 && await this.agentHasKey(credentialId)) {
      await this.options.agent.shutdown();
      throw new Error("SSH credential could not be removed; the managed agent was stopped");
    }
  }

  async setEnabled(credentialId: string, enabled: boolean): Promise<void> {
    this.credential(credentialId);
    await this.options.metadataStore.transaction(state => {
      const credential = state.credentials.find(item => item.id === credentialId);
      if (!credential || credential.type !== "ssh") throw new Error("unknown SSH credential");
      credential.enabled = enabled;
    });
    if (!enabled) await this.lock(credentialId);
  }

  async delete(credentialId: string, unassign = false): Promise<boolean> {
    this.credential(credentialId);
    const removed = await this.options.metadataStore.deleteCredential(credentialId, unassign);
    if (!removed) return false;
    await this.lockBacking(credentialId);
    const privatePath = credentialFile(this.options.secretsDirectory, credentialId);
    await Promise.all([privatePath, `${privatePath}.pub`].map(file => fs.rm(file, { force: true })));
    return true;
  }

  async testUsability(credentialId: string): Promise<boolean> {
    const credential = this.credential(credentialId);
    if (!credential.enabled) return false;
    if (await this.agentHasKey(credentialId)) return true;
    const privateKey = await fs.readFile(credentialFile(this.options.secretsDirectory, credentialId), "utf8");
    if (encryptedPrivateKey(privateKey)) return false;
    try {
      await this.unlock(credentialId, "");
      return true;
    } catch {
      return false;
    }
  }

  private async agentHasKey(credentialId: string): Promise<boolean> {
    const socket = this.options.agent.currentSocket();
    if (!socket) return false;
    return await runQuiet(
      this.options.sshAddPath,
      ["-T", `${credentialFile(this.options.secretsDirectory, credentialId)}.pub`],
      this.agentEnvironment(socket),
      this.timeoutMs,
    ) === 0;
  }

  private async lockBacking(credentialId: string): Promise<void> {
    const socket = this.options.agent.currentSocket();
    if (!socket) return;
    const publicPath = `${credentialFile(this.options.secretsDirectory, credentialId)}.pub`;
    const exitCode = await runQuiet(this.options.sshAddPath, ["-d", publicPath], this.agentEnvironment(socket), this.timeoutMs);
    if (exitCode !== 0) await this.options.agent.shutdown();
  }

  private credential(credentialId: string): SshCredentialRecord {
    const credential = this.options.metadataStore.snapshot().credentials.find(item => item.id === credentialId);
    if (!credential || credential.type !== "ssh") throw new Error("unknown SSH credential");
    credentialFile(this.options.secretsDirectory, credential.id);
    return credential;
  }

  private validateInput(name: string, capabilities: SshCapability[], passphrase?: string): void {
    if (name.trim() === "" || name.includes("\0")) throw new Error("SSH credential name must not be empty");
    if (passphrase !== undefined && (passphrase === "" || /[\x00-\x1f\x7f]/.test(passphrase))) throw new Error("SSH passphrase contains invalid characters");
    if (capabilities.length === 0 || new Set(capabilities).size !== capabilities.length) {
      throw new Error("SSH credential must declare unique capabilities");
    }
    if (capabilities.some(value => value !== "ssh-authentication" && value !== "ssh-signing")) {
      throw new Error("invalid SSH credential capability");
    }
  }

  private toolEnvironment(): Record<string, string> {
    return { PATH: this.servicePath, LANG: "C", LC_ALL: "C" };
  }

  private agentEnvironment(socket: string): Record<string, string> {
    return { ...this.toolEnvironment(), SSH_AUTH_SOCK: socket };
  }

  private async assertAvailablePaths(...paths: string[]): Promise<void> {
    for (const filePath of paths) {
      try {
        await fs.lstat(filePath);
        throw new Error("SSH credential backing path already exists");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }
}
