import type { CredentialMetadataStore } from "./credential-store";
import type { SshCredentialService } from "./credential-ssh";
import type { CredentialToolManager } from "./credential-tools";
import type { OpenPgpCredentialManager } from "./openpgp-credentials";
import type { TokenCredentialManager } from "./token-credentials";
import {
  CREDENTIAL_TOOLS,
  normalizeProviderHost,
  toPublicCredentialDto,
  type CredentialAssignment,
  type CredentialTool,
  type PublicCredentialDto,
  type ReadinessResult,
} from "./credential-types";

const MAX_JSON_BYTES = 1_100_000;
const MAX_NAME_BYTES = 256;
const MAX_PASSPHRASE_BYTES = 4_096;
const MAX_KEY_BYTES = 1_048_576;
const MAX_TOKEN_BYTES = 65_536;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

type JsonObject = Record<string, unknown>;

export type CredentialApiServices = {
  metadata: CredentialMetadataStore;
  tools: CredentialToolManager;
  ssh: SshCredentialService | null;
  openpgp: OpenPgpCredentialManager;
  tokens: TokenCredentialManager;
  workspaceExists(workspaceId: string): boolean;
  toolsChanged?(): Promise<void>;
};

export class CredentialOperationRateLimiter {
  private attempts = new Map<string, number[]>();

  allow(key: string, limit: number, now = Date.now()): boolean {
    const recent = (this.attempts.get(key) ?? []).filter(value => now - value < 60_000);
    if (recent.length >= limit) {
      this.attempts.set(key, recent);
      return false;
    }
    recent.push(now);
    this.attempts.set(key, recent);
    return true;
  }
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be an object");
  return value as JsonObject;
}

function fields(value: JsonObject, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) throw new Error("request contains an unknown field");
  }
}

function scalar(value: unknown, label: string, maxBytes: number): string {
  const parsed = text(value, label, maxBytes);
  if (/\p{Cc}/u.test(parsed)) throw new Error(`${label} contains invalid characters`);
  return parsed;
}

function secret(value: unknown, label: string, allowEmpty = false): string {
  const parsed = text(value, label, MAX_PASSPHRASE_BYTES, allowEmpty);
  if (/\p{Cc}/u.test(parsed)) throw new Error(`${label} contains invalid characters`);
  return parsed;
}

function text(value: unknown, label: string, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.includes("\0") || (!allowEmpty && value.trim() === "")) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (Buffer.byteLength(value) > maxBytes) throw new Error(`${label} exceeds the size limit`);
  return value;
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function stringArray(value: unknown, allowed: readonly string[], label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > allowed.length) throw new Error(`${label} is invalid`);
  if (value.some(item => typeof item !== "string" || !allowed.includes(item))) throw new Error(`${label} is invalid`);
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
  return value as string[];
}

export async function readCredentialJson(request: Request): Promise<JsonObject> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new Error("content-type must be application/json");
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new Error("request body exceeds the size limit");
  if (!request.body) throw new Error("request body must be an object");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new Error("request body exceeds the size limit");
      }
      chunks.push(next.value);
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
  try {
    return object(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (error instanceof Error && error.message === "request body must be an object") throw error;
    throw new Error("invalid JSON body");
  }
}

export class CredentialApi {
  private toolOperationChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly services: CredentialApiServices) {}

  async listCredentials(): Promise<PublicCredentialDto[]> {
    const state = this.services.metadata.snapshot();
    return Promise.all(state.credentials.map(async credential => toPublicCredentialDto(
      credential,
      state.assignments.filter(item => item.credentialId === credential.id),
      await this.readiness(credential.id),
    )));
  }

  listTools() {
    return this.services.tools.list();
  }

  publicKey(credentialId: string) {
    const credential = this.credential(credentialId);
    if (credential.type === "token") throw new Error("token credentials do not have public keys");
    return {
      id: credential.id,
      type: credential.type,
      publicKey: credential.metadata.publicKey,
      fingerprint: credential.metadata.fingerprint,
    };
  }

  async generateSsh(body: JsonObject) {
    fields(body, ["name", "capabilities", "passphrase"]);
    const service = this.requireSsh();
    const credential = await service.generate(
      scalar(body.name, "credential name", MAX_NAME_BYTES),
      stringArray(body.capabilities, ["ssh-authentication", "ssh-signing"], "SSH capabilities") as Array<"ssh-authentication" | "ssh-signing">,
      secret(body.passphrase, "passphrase"),
    );
    return this.dto(credential.id);
  }

  async importSsh(body: JsonObject) {
    fields(body, ["name", "capabilities", "privateKey", "passphrase"]);
    const credential = await this.requireSsh().import(
      scalar(body.name, "credential name", MAX_NAME_BYTES),
      stringArray(body.capabilities, ["ssh-authentication", "ssh-signing"], "SSH capabilities") as Array<"ssh-authentication" | "ssh-signing">,
      text(body.privateKey, "SSH private key", MAX_KEY_BYTES),
      secret(body.passphrase, "passphrase", true),
    );
    return this.dto(credential.id);
  }

  async generateOpenPgp(body: JsonObject) {
    fields(body, ["name", "userId", "passphrase"]);
    const credential = await this.services.openpgp.generate({
      name: scalar(body.name, "credential name", MAX_NAME_BYTES),
      userId: scalar(body.userId, "OpenPGP user id", MAX_NAME_BYTES),
      passphrase: secret(body.passphrase, "passphrase"),
    });
    return this.dto(credential.id);
  }

  async importOpenPgp(body: JsonObject) {
    fields(body, ["name", "privateKey"]);
    const credential = await this.services.openpgp.import({
      name: scalar(body.name, "credential name", MAX_NAME_BYTES),
      privateKey: text(body.privateKey, "OpenPGP private key", MAX_KEY_BYTES),
    });
    return this.dto(credential.id);
  }

  async createToken(body: JsonObject) {
    fields(body, ["name", "host", "username", "token", "capabilities"]);
    const capabilities = stringArray(body.capabilities, ["https-git", "github-cli", "gitlab-cli"], "token capabilities") as Array<"https-git" | "github-cli" | "gitlab-cli">;
    const credential = await this.services.tokens.create({
      name: scalar(body.name, "credential name", MAX_NAME_BYTES),
      host: scalar(body.host, "provider host", MAX_NAME_BYTES),
      ...(body.username === undefined ? {} : { username: scalar(body.username, "username", MAX_NAME_BYTES) }),
      token: text(body.token, "token", MAX_TOKEN_BYTES),
      capabilities,
    });
    return this.dto(credential.id);
  }

  async unlock(credentialId: string, body: JsonObject) {
    fields(body, ["passphrase"]);
    const credential = this.credential(credentialId);
    const passphrase = secret(body.passphrase, "passphrase");
    if (credential.type === "ssh") await this.requireSsh().unlock(credentialId, passphrase);
    else if (credential.type === "openpgp") {
      const failure = (await this.services.openpgp.unlock(credentialId, passphrase)).find(result => result.status === "unavailable");
      if (failure) throw new Error(failure.message);
    }
    else throw new Error("token credentials do not support unlock");
    return this.dto(credentialId);
  }

  async lock(credentialId: string, body: JsonObject) {
    fields(body, []);
    const credential = this.credential(credentialId);
    if (credential.type === "ssh") await this.requireSsh().lock(credentialId);
    else if (credential.type === "openpgp") throw new Error("OpenPGP credentials do not support individual lock; disable the credential instead");
    else throw new Error("token credentials do not support lock");
    return this.dto(credentialId);
  }

  async setEnabled(credentialId: string, body: JsonObject, enabled: boolean) {
    fields(body, []);
    const credential = this.credential(credentialId);
    if (credential.type === "ssh") await this.requireSsh().setEnabled(credentialId, enabled);
    else if (credential.type === "openpgp") {
      if (enabled) await this.services.openpgp.enable(credentialId);
      else await this.services.openpgp.disable(credentialId);
    } else await this.services.tokens.setEnabled(credentialId, enabled);
    return this.dto(credentialId);
  }

  async assign(credentialId: string, body: JsonObject): Promise<CredentialAssignment> {
    fields(body, ["workspaceId", "role", "host", "replace"]);
    const workspaceId = id(body.workspaceId, "workspace id");
    if (!this.services.workspaceExists(workspaceId)) throw new Error(`unknown workspace: ${workspaceId}`);
    if (body.role !== "authentication" && body.role !== "signing") throw new Error("assignment role is invalid");
    if (body.replace !== undefined) bool(body.replace, "replace");
    const assignment = body.role === "authentication"
      ? { workspaceId, credentialId, role: body.role, host: scalar(body.host, "provider host", MAX_NAME_BYTES) }
      : { workspaceId, credentialId, role: body.role };
    return this.services.metadata.assign(assignment, body.replace === true);
  }

  async unassign(credentialId: string, body: JsonObject): Promise<boolean> {
    fields(body, ["workspaceId", "role", "host"]);
    const workspaceId = id(body.workspaceId, "workspace id");
    if (body.role !== undefined && body.role !== "authentication" && body.role !== "signing") throw new Error("assignment role is invalid");
    if (body.role === "authentication" && body.host === undefined) throw new Error("authentication assignment host is required");
    if (body.role !== "authentication" && body.host !== undefined) throw new Error("host applies only to authentication assignments");
    const host = body.host === undefined
      ? undefined
      : normalizeProviderHost(scalar(body.host, "provider host", MAX_NAME_BYTES));
    return this.services.metadata.unassign(
      workspaceId,
      credentialId,
      body.role as CredentialAssignment["role"] | undefined,
      host,
    );
  }

  async test(credentialId: string, body: JsonObject): Promise<ReadinessResult[]> {
    fields(body, []);
    const credential = this.credential(credentialId);
    if (credential.type === "ssh") {
      const ready = await this.requireSsh().testUsability(credentialId);
      return [{ layer: "capability", status: ready ? "ready" : "unavailable", message: ready ? "The SSH credential is loaded in the Hub agent." : "The SSH credential is locked or unavailable." }];
    }
    if (credential.type === "openpgp") return this.services.openpgp.test(credentialId);
    return [{ layer: "credential", status: this.services.tokens.resolve(credentialId) ? "ready" : "unavailable", message: this.services.tokens.resolve(credentialId) ? "The token credential is enabled and available." : "The token credential is disabled or unavailable." }];
  }

  async delete(credentialId: string, body: JsonObject): Promise<boolean> {
    fields(body, ["confirm", "unassign"]);
    if (body.confirm !== true) throw new Error("credential deletion requires confirmation");
    if (body.unassign !== undefined) bool(body.unassign, "unassign");
    const credential = this.credential(credentialId);
    if (credential.type === "ssh") return this.requireSsh().delete(credentialId, body.unassign === true);
    if (credential.type === "openpgp") return this.services.openpgp.delete(credentialId, body.unassign === true);
    return this.services.tokens.delete(credentialId, body.unassign === true);
  }

  async setTool(tool: string, body: JsonObject) {
    if (!(CREDENTIAL_TOOLS as readonly string[]).includes(tool)) throw new Error("credential tool is invalid");
    fields(body, ["path"]);
    return this.enqueueToolOperation(async () => {
      const result = body.path === null
        ? await this.services.tools.clearOverride(tool as CredentialTool)
        : await this.services.tools.setOverride(tool as CredentialTool, text(body.path, "tool path", 32_768));
      await this.services.toolsChanged?.();
      return result;
    });
  }

  async testTool(tool: string, body: JsonObject) {
    if (!(CREDENTIAL_TOOLS as readonly string[]).includes(tool)) throw new Error("credential tool is invalid");
    fields(body, []);
    return this.enqueueToolOperation(async () => {
      await this.services.tools.reprobeAll();
      await this.services.toolsChanged?.();
      return this.services.tools.list().find(item => item.tool === tool)!;
    });
  }

  private enqueueToolOperation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.toolOperationChain.then(operation, operation);
    this.toolOperationChain = next.catch(() => undefined);
    return next;
  }

  private credential(credentialId: string) {
    id(credentialId, "credential id");
    const credential = this.services.metadata.snapshot().credentials.find(item => item.id === credentialId);
    if (!credential) throw new Error(`unknown credential: ${credentialId}`);
    return credential;
  }

  private async dto(credentialId: string): Promise<PublicCredentialDto> {
    const state = this.services.metadata.snapshot();
    const credential = state.credentials.find(item => item.id === credentialId);
    if (!credential) throw new Error(`unknown credential: ${credentialId}`);
    return toPublicCredentialDto(
      credential,
      state.assignments.filter(item => item.credentialId === credentialId),
      await this.readiness(credentialId),
    );
  }

  private async readiness(credentialId: string): Promise<ReadinessResult[]> {
    const credential = this.credential(credentialId);
    if (!credential.enabled) return [{ layer: "credential", status: "unavailable", message: "The credential is disabled." }];
    if (credential.type === "ssh") {
      if (!this.services.ssh) return [{ layer: "binary", status: "unavailable", message: "OpenSSH tooling is unavailable." }];
      const usable = await this.services.ssh.testUsability(credentialId);
      return [{ layer: "runtime", status: usable ? "ready" : "unavailable", message: usable ? "The SSH credential is unlocked." : "The SSH credential requires unlock." }];
    }
    if (credential.type === "openpgp") return this.services.openpgp.readiness(credentialId);
    return [{ layer: "credential", status: this.services.tokens.resolve(credentialId) ? "ready" : "unavailable", message: this.services.tokens.resolve(credentialId) ? "The token credential is available." : "The token credential is unavailable." }];
  }

  private requireSsh(): SshCredentialService {
    if (!this.services.ssh) throw new Error("OpenSSH credential tooling is unavailable");
    return this.services.ssh;
  }
}

export function credentialApiError(error: unknown): { status: number; message: string } {
  const message = error instanceof Error ? error.message : "credential operation failed";
  if (/unlock failed|could not be unlocked/.test(message)) return { status: 400, message };
  if (/assigned to|conflicts|already exists|disabled|\blocked\b|requires unlock/.test(message)) return { status: 409, message };
  if (/unknown credential|unknown workspace/.test(message)) return { status: 404, message };
  if (/unavailable|did not cache/.test(message)) return { status: 503, message };
  if (/must|invalid|unknown field|does not|cannot|exceeds|requires confirmation|not support|not have|failed validation|host/.test(message)) {
    return { status: 400, message };
  }
  return { status: 500, message: "credential operation failed" };
}
