import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { CredentialMetadataStore } from "./credential-store";
import type {
  OpenPgpCredentialMetadata,
  OpenPgpCredentialRecord,
  ReadinessResult,
} from "./credential-types";

const COMMAND_OUTPUT_LIMIT = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const PRIVATE_IMPORT_LIMIT = 1024 * 1024;

export const OPENPGP_SIGNING_CHALLENGE = "uatu hub OpenPGP signing capability v1\n";

export type OpenPgpCommand = {
  executable: string;
  args: string[];
  env: Record<string, string>;
  input?: string;
  timeoutMs: number;
};

export type OpenPgpCommandResult = {
  exitCode: number;
  timedOut: boolean;
  outputExceeded: boolean;
  stdout: string;
};

export type OpenPgpCommandRunner = (command: OpenPgpCommand) => Promise<OpenPgpCommandResult>;

export type OpenPgpCredentialManagerOptions = {
  gnupgHome: string;
  metadataStore: CredentialMetadataStore;
  gpgPath: string | null;
  gpgconfPath: string | null;
  servicePath?: string;
  timeoutMs?: number;
  runCommand?: OpenPgpCommandRunner;
};

async function collectBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ text: string; exceeded: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let exceeded = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = limit - size;
      if (remaining > 0) {
        chunks.push(next.value.slice(0, remaining));
        size += Math.min(next.value.length, remaining);
      }
      if (next.value.length > remaining) exceeded = true;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder().decode(bytes), exceeded };
}

export const runOpenPgpCommand: OpenPgpCommandRunner = async command => {
  const child = Bun.spawn([command.executable, ...command.args], {
    stdin: command.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: command.env,
  });
  if (command.input !== undefined) {
    const stdin = child.stdin as { write(value: string): unknown; end(): unknown };
    stdin.write(command.input);
    stdin.end();
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // The command may have exited while the timeout callback was queued.
    }
  }, command.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      collectBounded(child.stdout, COMMAND_OUTPUT_LIMIT),
      collectBounded(child.stderr, COMMAND_OUTPUT_LIMIT),
      child.exited,
    ]);
    return {
      exitCode,
      timedOut,
      outputExceeded: stdout.exceeded || stderr.exceeded,
      stdout: stdout.text,
    };
  } finally {
    clearTimeout(timer);
  }
};

function nonEmpty(value: string, label: string): string {
  if (value.trim() === "" || value.includes("\0")) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function fingerprintFromColonOutput(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const fields = line.split(":");
    if (fields[0] === "fpr" && /^[A-F0-9]{40,64}$/.test(fields[9] ?? "")) return fields[9]!;
  }
  return null;
}

function primaryFingerprintsFromColonOutput(output: string): string[] {
  const fingerprints: string[] = [];
  let awaitingPrimaryFingerprint = false;
  for (const line of output.split(/\r?\n/)) {
    const fields = line.split(":");
    if (fields[0] === "sec") {
      awaitingPrimaryFingerprint = true;
    } else if (fields[0] === "ssb") {
      awaitingPrimaryFingerprint = false;
    } else if (awaitingPrimaryFingerprint && fields[0] === "fpr" && /^[A-F0-9]{40,64}$/.test(fields[9] ?? "")) {
      fingerprints.push(fields[9]!);
      awaitingPrimaryFingerprint = false;
    }
  }
  return fingerprints;
}

function fingerprintFromStatusOutput(output: string): string | null {
  const match = output.match(/^\[GNUPG:\] KEY_CREATED [A-Z] ([A-F0-9]{40,64})$/m);
  return match?.[1] ?? null;
}

function hasSigningSecret(output: string): boolean {
  return output.split(/\r?\n/).some(line => {
    const fields = line.split(":");
    return (fields[0] === "sec" || fields[0] === "ssb") && /s/i.test(fields[11] ?? "");
  });
}

function failedCommand(): OpenPgpCommandResult {
  return { exitCode: -1, timedOut: false, outputExceeded: false, stdout: "" };
}

function unavailable(layer: ReadinessResult["layer"], message: string): ReadinessResult {
  return { layer, status: "unavailable", message };
}

function ready(layer: ReadinessResult["layer"], message: string): ReadinessResult {
  return { layer, status: "ready", message };
}

// The public operation surface consumers hold instead of the class, so the
// hub can interpose a facade that serializes operations with OpenPGP runtime
// replacement (a gpg/gpgconf override swapping the manager).
export type OpenPgpCredentialOperations = Pick<
  OpenPgpCredentialManager,
  "generate" | "import" | "unlock" | "enable" | "disable" | "delete" | "test" | "readiness"
>;

export class OpenPgpCredentialManager {
  private readonly gnupgHome: string;
  private readonly metadataStore: CredentialMetadataStore;
  private readonly gpgPath: string | null;
  private readonly gpgconfPath: string | null;
  private readonly servicePath: string;
  private readonly timeoutMs: number;
  private readonly runCommand: OpenPgpCommandRunner;
  private operationChain: Promise<unknown> = Promise.resolve();

  constructor(options: OpenPgpCredentialManagerOptions) {
    this.gnupgHome = options.gnupgHome;
    this.metadataStore = options.metadataStore;
    this.gpgPath = options.gpgPath;
    this.gpgconfPath = options.gpgconfPath;
    this.servicePath = options.servicePath ?? process.env.PATH ?? "";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.runCommand = options.runCommand ?? runOpenPgpCommand;
  }

  readiness(credentialId?: string): Promise<ReadinessResult[]> {
    return this.enqueue(async () => {
      if (!this.gpgPath) return [unavailable("binary", "GnuPG is unavailable; install it or configure its absolute path.")];
      const results = [ready("binary", "GnuPG is available.")];
      if (!credentialId) return results;
      const credential = this.credential(credentialId);
      if (!credential.enabled) {
        results.push(unavailable("credential", "The OpenPGP credential is disabled."));
        return results;
      }
      const listed = await this.gpg(["--with-colons", "--list-secret-keys", credential.metadata.fingerprint]);
      if (!this.succeeded(listed)) {
        results.push(unavailable("credential", "The OpenPGP secret key is unavailable."));
        return results;
      }
      results.push(ready("credential", "The OpenPGP secret key is available."));
      const cached = await this.sign(credential.metadata.fingerprint, "cached");
      results.push(cached ? ready("runtime", "The OpenPGP signing key is unlocked in the Hub agent.") : unavailable("runtime", "The OpenPGP signing key requires unlock."));
      return results;
    });
  }

  generate(input: { name: string; userId: string; passphrase: string }): Promise<OpenPgpCredentialRecord> {
    return this.enqueue(async () => {
      this.requireGpg();
      const name = nonEmpty(input.name, "credential name");
      const userId = nonEmpty(input.userId, "OpenPGP user id");
      const passphrase = nonEmpty(input.passphrase, "OpenPGP passphrase");
      const generated = await this.gpg([
        "--status-fd", "1",
        "--pinentry-mode", "loopback",
        "--passphrase-fd", "0",
        "--quick-generate-key", userId, "ed25519", "sign", "0",
      ], `${passphrase}\n`);
      const fingerprint = this.succeeded(generated) ? fingerprintFromStatusOutput(generated.stdout) : null;
      if (!fingerprint) throw new Error("OpenPGP key generation failed.");
      return this.persistCredential(name, fingerprint);
    });
  }

  import(input: { name: string; privateKey: string }): Promise<OpenPgpCredentialRecord> {
    return this.enqueue(async () => {
      this.requireGpg();
      const name = nonEmpty(input.name, "credential name");
      const privateKey = nonEmpty(input.privateKey, "OpenPGP private key");
      if (Buffer.byteLength(privateKey) > PRIVATE_IMPORT_LIMIT) throw new Error("OpenPGP private key exceeds the input limit.");
      const inspected = await this.gpg([
        "--with-colons", "--import-options", "show-only", "--dry-run", "--import",
      ], privateKey);
      const fingerprints = this.succeeded(inspected) ? primaryFingerprintsFromColonOutput(inspected.stdout) : [];
      if (fingerprints.length !== 1) throw new Error("OpenPGP import must contain exactly one primary private key.");
      const fingerprint = fingerprints[0]!;
      this.assertFingerprintAvailable(fingerprint);
      const imported = await this.gpg(["--import"], privateKey);
      if (!this.succeeded(imported)) {
        await this.deleteUnreferencedKey(fingerprint);
        throw new Error("OpenPGP private key import failed.");
      }
      const secret = await this.gpg(["--with-colons", "--list-secret-keys", fingerprint]);
      if (!this.succeeded(secret)
        || fingerprintFromColonOutput(secret.stdout) !== fingerprint
        || !hasSigningSecret(secret.stdout)) {
        await this.deleteUnreferencedKey(fingerprint);
        throw new Error("Imported OpenPGP material does not contain a signing secret key.");
      }
      return this.persistCredential(name, fingerprint);
    });
  }

  unlock(credentialId: string, passphrase: string): Promise<ReadinessResult[]> {
    return this.enqueue(async () => {
      this.requireGpg();
      const credential = this.enabledCredential(credentialId);
      nonEmpty(passphrase, "OpenPGP passphrase");
      if (!await this.sign(credential.metadata.fingerprint, "loopback", passphrase)) {
        return [unavailable("runtime", "OpenPGP unlock failed.")];
      }
      if (!await this.sign(credential.metadata.fingerprint, "cached")) {
        return [unavailable("runtime", "The Hub OpenPGP agent did not cache the signing key.")];
      }
      return [ready("runtime", "The OpenPGP signing key is unlocked in the Hub agent.")];
    });
  }

  test(credentialId: string): Promise<ReadinessResult[]> {
    return this.enqueue(async () => {
      this.requireGpg();
      const credential = this.enabledCredential(credentialId);
      const files = this.challengeFiles();
      try {
        await fs.writeFile(files.challenge, OPENPGP_SIGNING_CHALLENGE, { mode: 0o600 });
        const signed = await this.gpg([
          "--pinentry-mode", "error",
          "--local-user", credential.metadata.fingerprint,
          "--output", files.signature,
          "--detach-sign", files.challenge,
        ]);
        if (!this.succeeded(signed)) return [unavailable("capability", "OpenPGP signing test failed or requires unlock.")];
        const verified = await this.gpg(["--verify", files.signature, files.challenge]);
        if (!this.succeeded(verified)) return [unavailable("capability", "OpenPGP signature verification failed.")];
        return [ready("capability", "The fixed Hub challenge was signed and verified locally.")];
      } finally {
        await this.removeChallengeFiles(files);
      }
    });
  }

  shutdown(): Promise<ReadinessResult[]> {
    return this.enqueue(() => this.stopAgent());
  }

  disable(credentialId: string): Promise<void> {
    return this.enqueue(() => this.setEnabled(credentialId, false));
  }

  enable(credentialId: string): Promise<void> {
    return this.enqueue(() => this.setEnabled(credentialId, true));
  }

  delete(credentialId: string, unassign = false): Promise<boolean> {
    return this.enqueue(async () => {
      this.requireGpg();
      const snapshot = this.metadataStore.snapshot();
      const credential = snapshot.credentials.find(item => item.id === credentialId);
      if (!credential) return false;
      if (credential.type !== "openpgp") throw new Error(`credential is not OpenPGP: ${credentialId}`);
      return this.metadataStore.deleteCredentialWithCleanup(credentialId, unassign, async () => {
        if (this.hasFingerprint(credential.metadata.fingerprint)) return;
        const deleted = await this.gpg(["--yes", "--delete-secret-and-public-key", credential.metadata.fingerprint]);
        if (!this.succeeded(deleted)) throw new Error("OpenPGP credential deletion failed.");
      });
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationChain.then(operation, operation);
    this.operationChain = next.catch(() => undefined);
    return next;
  }

  private environment(): Record<string, string> {
    return {
      GNUPGHOME: this.gnupgHome,
      PATH: this.servicePath,
      LANG: "C",
      LC_ALL: "C",
    };
  }

  private gpg(args: string[], input?: string): Promise<OpenPgpCommandResult> {
    this.requireGpg();
    return this.runCommand({
      executable: this.gpgPath!,
      args: ["--homedir", this.gnupgHome, "--batch", "--no-tty", ...args],
      env: this.environment(),
      ...(input === undefined ? {} : { input }),
      timeoutMs: this.timeoutMs,
    }).catch(() => failedCommand());
  }

  private succeeded(result: OpenPgpCommandResult): boolean {
    return result.exitCode === 0 && !result.timedOut && !result.outputExceeded;
  }

  private requireGpg(): void {
    if (!this.gpgPath) throw new Error("OpenPGP tooling is unavailable; install GnuPG or configure its absolute path.");
  }

  private credential(credentialId: string): OpenPgpCredentialRecord {
    const credential = this.metadataStore.snapshot().credentials.find(item => item.id === credentialId);
    if (!credential) throw new Error(`unknown credential: ${credentialId}`);
    if (credential.type !== "openpgp") throw new Error(`credential is not OpenPGP: ${credentialId}`);
    return credential;
  }

  private enabledCredential(credentialId: string): OpenPgpCredentialRecord {
    const credential = this.credential(credentialId);
    if (!credential.enabled) throw new Error("OpenPGP credential is disabled.");
    return credential;
  }

  private async publicMetadata(fingerprint: string): Promise<OpenPgpCredentialMetadata> {
    const exported = await this.gpg(["--armor", "--export", fingerprint]);
    if (!this.succeeded(exported)
      || !exported.stdout.includes("-----BEGIN PGP PUBLIC KEY BLOCK-----")
      || exported.stdout.includes("PRIVATE KEY")) {
      throw new Error("OpenPGP public-key export failed.");
    }
    return { fingerprint, publicKey: exported.stdout.trim() };
  }

  private async persistCredential(name: string, fingerprint: string): Promise<OpenPgpCredentialRecord> {
    this.assertFingerprintAvailable(fingerprint);
    try {
      const metadata = await this.publicMetadata(fingerprint);
      const credential = await this.metadataStore.create({
        name,
        type: "openpgp",
        capabilities: ["openpgp-signing"],
        enabled: true,
        metadata,
      });
      return credential as OpenPgpCredentialRecord;
    } catch (error) {
      await this.deleteUnreferencedKey(fingerprint);
      throw error;
    }
  }

  private hasFingerprint(fingerprint: string): boolean {
    return this.metadataStore.snapshot().credentials.some(credential =>
      credential.type === "openpgp" && credential.metadata.fingerprint === fingerprint);
  }

  private assertFingerprintAvailable(fingerprint: string): void {
    if (this.hasFingerprint(fingerprint)) {
      throw new Error("An OpenPGP credential with this fingerprint already exists.");
    }
  }

  private async deleteUnreferencedKey(fingerprint: string): Promise<void> {
    if (this.hasFingerprint(fingerprint)) return;
    await this.gpg(["--yes", "--delete-secret-and-public-key", fingerprint]).catch(() => undefined);
  }

  private challengeFiles(): { challenge: string; signature: string } {
    const id = randomUUID();
    return {
      challenge: path.join(this.gnupgHome, `.uatu-challenge-${id}`),
      signature: path.join(this.gnupgHome, `.uatu-signature-${id}`),
    };
  }

  private async sign(fingerprint: string, mode: "loopback" | "cached", passphrase?: string): Promise<boolean> {
    const files = this.challengeFiles();
    try {
      await fs.writeFile(files.challenge, OPENPGP_SIGNING_CHALLENGE, { mode: 0o600 });
      const result = await this.gpg([
        "--pinentry-mode", mode === "loopback" ? "loopback" : "error",
        ...(mode === "loopback" ? ["--passphrase-fd", "0"] : []),
        "--local-user", fingerprint,
        "--output", files.signature,
        "--detach-sign", files.challenge,
      ], mode === "loopback" ? `${passphrase ?? ""}\n` : undefined);
      return this.succeeded(result);
    } finally {
      await this.removeChallengeFiles(files);
    }
  }

  private async removeChallengeFiles(files: { challenge: string; signature: string }): Promise<void> {
    await Promise.all([
      fs.rm(files.challenge, { force: true }),
      fs.rm(files.signature, { force: true }),
    ]);
  }

  private async stopAgent(): Promise<ReadinessResult[]> {
    if (!this.gpgconfPath) return [unavailable("runtime", "gpgconf is unavailable; the Hub OpenPGP agent could not be stopped.")];
    const result = await this.runCommand({
      executable: this.gpgconfPath,
      args: ["--homedir", this.gnupgHome, "--kill", "gpg-agent"],
      env: this.environment(),
      timeoutMs: this.timeoutMs,
    }).catch(() => failedCommand());
    if (!this.succeeded(result)) return [unavailable("runtime", "The Hub OpenPGP agent could not be stopped.")];
    return [ready("runtime", "The Hub OpenPGP agent was stopped.")];
  }

  private async setEnabled(credentialId: string, enabled: boolean): Promise<void> {
    await this.metadataStore.transaction(state => {
      const credential = state.credentials.find(item => item.id === credentialId);
      if (!credential) throw new Error(`unknown credential: ${credentialId}`);
      if (credential.type !== "openpgp") throw new Error(`credential is not OpenPGP: ${credentialId}`);
      credential.enabled = enabled;
    });
  }
}
