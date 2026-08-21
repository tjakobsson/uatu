import { randomUUID } from "node:crypto";

import { CredentialMetadataStore, CredentialTokenStore } from "./credential-store";
import {
  normalizeProviderHost,
  type TokenCredentialRecord,
} from "./credential-types";

const MAX_TOKEN_BYTES = 64 * 1024;

export type TokenCredentialCapability = "https-git" | "github-cli" | "gitlab-cli";

export type CreateTokenCredential = {
  name: string;
  host: string;
  username?: string;
  token: string;
  capabilities: TokenCredentialCapability[];
};

function validateSecret(token: string): string {
  if (token === "" || token.includes("\0") || /[\r\n]/.test(token)) {
    throw new Error("token must be a non-empty protocol value");
  }
  if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw new Error("token exceeds the size limit");
  return token;
}

export class TokenCredentialManager {
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly metadata: CredentialMetadataStore,
    private readonly secrets: CredentialTokenStore,
  ) {}

  async load(): Promise<void> {
    await Promise.all([this.metadata.load(), this.secrets.load()]);
  }

  create(
    input: CreateTokenCredential,
    createId: () => string = randomUUID,
    now: () => Date = () => new Date(),
  ): Promise<TokenCredentialRecord> {
    return this.enqueue(async () => {
      const id = createId();
      const token = validateSecret(input.token);
      const host = normalizeProviderHost(input.host);
      await this.secrets.set(id, token);
      try {
        return await this.metadata.create({
          name: input.name,
          type: "token",
          capabilities: [...input.capabilities],
          enabled: true,
          metadata: { host, ...(input.username === undefined ? {} : { username: input.username }) },
        }, () => id, now) as TokenCredentialRecord;
      } catch (error) {
        await this.secrets.delete(id).catch(() => undefined);
        throw error;
      }
    });
  }

  setEnabled(credentialId: string, enabled: boolean): Promise<TokenCredentialRecord> {
    return this.enqueue(async () => {
      const credential = this.requireToken(credentialId);
      if (credential.enabled === enabled) return credential;
      return await this.metadata.setEnabled(credentialId, enabled) as TokenCredentialRecord;
    });
  }

  delete(credentialId: string, unassign = false): Promise<boolean> {
    return this.enqueue(async () => {
      this.requireToken(credentialId);
      // The cleanup transaction holds the metadata mutation queue through
      // secret deletion and any rollback, so a concurrent assignment cannot
      // install a replacement default that the rollback would then duplicate.
      return this.metadata.deleteCredentialWithCleanup(credentialId, unassign, async () => {
        await this.secrets.delete(credentialId);
      });
    });
  }

  resolve(credentialId: string): { credential: TokenCredentialRecord; token: string } | undefined {
    const credential = this.metadata.snapshot().credentials.find(item => item.id === credentialId);
    if (!credential || credential.type !== "token" || !credential.enabled) return undefined;
    const token = this.secrets.get(credentialId);
    return token === undefined ? undefined : { credential, token };
  }

  private requireToken(credentialId: string): TokenCredentialRecord {
    const credential = this.metadata.snapshot().credentials.find(item => item.id === credentialId);
    if (!credential || credential.type !== "token") throw new Error(`unknown token credential: ${credentialId}`);
    return credential;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationChain.then(operation, operation);
    this.mutationChain = next.catch(() => undefined);
    return next;
  }
}
