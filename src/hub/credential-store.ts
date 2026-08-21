import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

import {
  CREDENTIAL_STATE_VERSION,
  CREDENTIAL_TOOL_STATE_VERSION,
  type CredentialState,
  type CredentialAssignment,
  type CredentialRecord,
  type NewCredential,
  type CredentialTool,
  type CredentialToolOverride,
  type CredentialToolState,
  parseCredentialState,
  parseCredentialToolOverride,
  parseCredentialToolState,
} from "./credential-types";

const TOKEN_STATE_VERSION = 1 as const;

type TokenEntry = {
  credentialId: string;
  token: string;
};

type TokenState = {
  version: typeof TOKEN_STATE_VERSION;
  tokens: TokenEntry[];
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function parseObject(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object`);
  return value as Record<string, unknown>;
}

function rejectUnknown(record: Record<string, unknown>, fields: readonly string[], context: string): void {
  const allowed = new Set(fields);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`unknown ${context} field: ${key}`);
  }
}

function nonEmptyString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

function parseTokenState(value: unknown): TokenState {
  const state = parseObject(value, "credential token state");
  rejectUnknown(state, ["version", "tokens"], "credential token state");
  if (state.version !== TOKEN_STATE_VERSION) throw new Error("unsupported credential token state version");
  if (!Array.isArray(state.tokens)) throw new Error("credential tokens must be an array");
  const tokens = state.tokens.map(value => {
    const entry = parseObject(value, "credential token");
    rejectUnknown(entry, ["credentialId", "token"], "credential token");
    return {
      credentialId: nonEmptyString(entry.credentialId, "credential token id"),
      token: nonEmptyString(entry.token, "credential token"),
    };
  });
  if (new Set(tokens.map(entry => entry.credentialId)).size !== tokens.length) {
    throw new Error("credential token ids must be unique");
  }
  return { version: TOKEN_STATE_VERSION, tokens };
}

async function loadState<T>(
  filePath: string,
  empty: T,
  parse: (value: unknown) => T,
  label: string,
  secret = false,
): Promise<T> {
  let text: string;
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`${label} path must be a regular file`);
    if (secret && (stats.mode & 0o077) !== 0) throw new Error(`${label} has unsafe permissions`);
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return clone(empty);
    throw error;
  }
  try {
    return parse(JSON.parse(text));
  } catch (error) {
    throw new Error(`${label} is corrupt: ${filePath}`, { cause: error });
  }
}

class AtomicStateWriter {
  private saveCounter = 0;

  constructor(private readonly filePath: string) {}

  async write(value: unknown): Promise<void> {
    const temp = `${this.filePath}.${process.pid}.${(this.saveCounter += 1)}.tmp`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temp, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
}

abstract class SerializedStore {
  private mutationChain: Promise<unknown> = Promise.resolve();

  protected enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationChain.then(operation, operation);
    this.mutationChain = next.catch(() => undefined);
    return next;
  }
}

export class CredentialMetadataStore extends SerializedStore {
  private state: CredentialState = { version: CREDENTIAL_STATE_VERSION, credentials: [], assignments: [] };
  private readonly writer: AtomicStateWriter;

  constructor(private readonly filePath: string) {
    super();
    this.writer = new AtomicStateWriter(filePath);
  }

  async load(): Promise<void> {
    this.state = await loadState(
      this.filePath,
      { version: CREDENTIAL_STATE_VERSION, credentials: [], assignments: [] },
      parseCredentialState,
      "credential metadata",
    );
  }

  snapshot(): CredentialState {
    return clone(this.state);
  }

  create(
    credential: NewCredential,
    createId: () => string = randomUUID,
    now: () => Date = () => new Date(),
  ): Promise<CredentialRecord> {
    return this.enqueue(async () => {
      const nextCredential = parseCredentialState({
        version: CREDENTIAL_STATE_VERSION,
        credentials: [{ ...credential, id: createId(), createdAt: now().toISOString() }],
        assignments: [],
      }).credentials[0]!;
      if (this.state.credentials.some(item => item.id === nextCredential.id)) {
        throw new Error(`credential id already exists: ${nextCredential.id}`);
      }
      const next = clone(this.state);
      next.credentials.push(nextCredential);
      const parsed = parseCredentialState(next);
      await this.writer.write(parsed);
      this.state = parsed;
      return clone(nextCredential);
    });
  }

  assign(value: unknown, replace = false): Promise<CredentialAssignment> {
    const assignment = parseCredentialState({
      version: CREDENTIAL_STATE_VERSION,
      credentials: [],
      assignments: [value],
    }).assignments[0]!;
    return this.enqueue(async () => {
      const next = clone(this.state);
      const credential = next.credentials.find(item => item.id === assignment.credentialId);
      if (!credential) throw new Error(`unknown credential: ${assignment.credentialId}`);
      this.assertAssignmentCapability(credential, assignment);

      const conflictIndex = next.assignments.findIndex(existing => (
        existing.workspaceId === assignment.workspaceId
        && existing.role === assignment.role
        && (existing.role === "signing" || existing.host === (assignment as typeof existing).host)
      ));
      if (conflictIndex !== -1) {
        const existing = next.assignments[conflictIndex]!;
        if (existing.credentialId === assignment.credentialId) return clone(existing);
        if (!replace) {
          throw new Error(`credential assignment conflicts with existing default: ${existing.credentialId}`);
        }
        next.assignments.splice(conflictIndex, 1);
      }
      next.assignments.push(assignment);
      const parsed = parseCredentialState(next);
      await this.writer.write(parsed);
      this.state = parsed;
      return clone(assignment);
    });
  }

  unassign(workspaceId: string, credentialId: string, role?: CredentialAssignment["role"], host?: string): Promise<boolean> {
    return this.enqueue(async () => {
      const next = clone(this.state);
      const retained = next.assignments.filter(assignment => !(
        assignment.workspaceId === workspaceId
        && assignment.credentialId === credentialId
        && (role === undefined || assignment.role === role)
        && (host === undefined || (assignment.role === "authentication" && assignment.host === host))
      ));
      if (retained.length === next.assignments.length) return false;
      next.assignments = retained;
      const parsed = parseCredentialState(next);
      await this.writer.write(parsed);
      this.state = parsed;
      return true;
    });
  }

  removeWorkspaceAssignments(workspaceId: string): Promise<number> {
    return this.enqueue(async () => {
      const next = clone(this.state);
      const retained = next.assignments.filter(assignment => assignment.workspaceId !== workspaceId);
      const removed = next.assignments.length - retained.length;
      if (removed === 0) return 0;
      next.assignments = retained;
      const parsed = parseCredentialState(next);
      await this.writer.write(parsed);
      this.state = parsed;
      return removed;
    });
  }

  deleteCredential(credentialId: string, unassign = false): Promise<boolean> {
    return this.deleteCredentialWithCleanup(credentialId, unassign, async () => {});
  }

  deleteCredentialWithCleanup(
    credentialId: string,
    unassign: boolean,
    cleanup: (credential: CredentialRecord) => Promise<void>,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const previous = clone(this.state);
      const next = clone(this.state);
      const credentialIndex = next.credentials.findIndex(item => item.id === credentialId);
      if (credentialIndex === -1) return false;
      const references = next.assignments.filter(assignment => assignment.credentialId === credentialId);
      if (references.length > 0 && !unassign) {
        throw new Error(`credential is assigned to ${references.length} workspace default(s)`);
      }
      next.credentials.splice(credentialIndex, 1);
      next.assignments = next.assignments.filter(assignment => assignment.credentialId !== credentialId);
      const parsed = parseCredentialState(next);
      await this.writer.write(parsed);
      this.state = parsed;
      try {
        await cleanup(clone(previous.credentials[credentialIndex]!));
      } catch (cleanupError) {
        try {
          await this.writer.write(previous);
          this.state = previous;
        } catch (rollbackError) {
          throw new AggregateError([cleanupError, rollbackError], `credential cleanup and metadata rollback failed: ${credentialId}`);
        }
        throw cleanupError;
      }
      return true;
    });
  }

  setEnabled(credentialId: string, enabled: boolean): Promise<CredentialRecord> {
    return this.enqueue(async () => {
      const next = clone(this.state);
      const credential = next.credentials.find(item => item.id === credentialId);
      if (!credential) throw new Error(`unknown credential: ${credentialId}`);
      credential.enabled = enabled;
      const parsed = parseCredentialState(next);
      await this.writer.write(parsed);
      this.state = parsed;
      return clone(parsed.credentials.find(item => item.id === credentialId)!);
    });
  }

  transaction(mutate: (draft: CredentialState) => void): Promise<CredentialState> {
    return this.enqueue(async () => {
      const draft = clone(this.state);
      mutate(draft);
      const next = parseCredentialState(draft);
      await this.writer.write(next);
      this.state = next;
      return clone(next);
    });
  }

  private assertAssignmentCapability(credential: CredentialRecord, assignment: CredentialAssignment): void {
    if (assignment.role === "signing") {
      if (!credential.capabilities.some(capability => capability === "ssh-signing" || capability === "openpgp-signing")) {
        throw new Error(`credential does not support signing: ${credential.id}`);
      }
      return;
    }
    if (!credential.capabilities.some(capability =>
      capability === "ssh-authentication"
      || capability === "https-git"
      || capability === "github-cli"
      || capability === "gitlab-cli")) {
      throw new Error(`credential does not support authentication: ${credential.id}`);
    }
    if (credential.type === "token" && credential.metadata.host !== assignment.host) {
      throw new Error(`credential host does not match assignment host: ${credential.metadata.host}`);
    }
  }
}

export class CredentialTokenStore extends SerializedStore {
  private state: TokenState = { version: TOKEN_STATE_VERSION, tokens: [] };
  private readonly writer: AtomicStateWriter;

  constructor(private readonly filePath: string) {
    super();
    this.writer = new AtomicStateWriter(filePath);
  }

  async load(): Promise<void> {
    this.state = await loadState(
      this.filePath,
      { version: TOKEN_STATE_VERSION, tokens: [] },
      parseTokenState,
      "credential token store",
      true,
    );
  }

  get(credentialId: string): string | undefined {
    return this.state.tokens.find(entry => entry.credentialId === credentialId)?.token;
  }

  set(credentialId: string, token: string): Promise<void> {
    const entry = parseTokenState({ version: TOKEN_STATE_VERSION, tokens: [{ credentialId, token }] }).tokens[0]!;
    return this.enqueue(async () => {
      const next = clone(this.state);
      const existing = next.tokens.find(item => item.credentialId === credentialId);
      if (existing) existing.token = entry.token;
      else next.tokens.push(entry);
      const parsed = parseTokenState(next);
      await this.writer.write(parsed);
      this.state = parsed;
    });
  }

  delete(credentialId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const next = clone(this.state);
      const index = next.tokens.findIndex(entry => entry.credentialId === credentialId);
      if (index === -1) return false;
      next.tokens.splice(index, 1);
      const parsed = parseTokenState(next);
      await this.writer.write(parsed);
      this.state = parsed;
      return true;
    });
  }
}

export class CredentialToolOverrideStore extends SerializedStore {
  private state: CredentialToolState = { version: CREDENTIAL_TOOL_STATE_VERSION, overrides: [] };
  private readonly writer: AtomicStateWriter;

  constructor(private readonly filePath: string) {
    super();
    this.writer = new AtomicStateWriter(filePath);
  }

  async load(): Promise<void> {
    this.state = await loadState(
      this.filePath,
      { version: CREDENTIAL_TOOL_STATE_VERSION, overrides: [] },
      parseCredentialToolState,
      "credential tool overrides",
    );
  }

  list(): CredentialToolOverride[] {
    return clone(this.state.overrides);
  }

  get(tool: CredentialTool): CredentialToolOverride | undefined {
    const override = this.state.overrides.find(item => item.tool === tool);
    return override ? { ...override } : undefined;
  }

  set(value: unknown): Promise<CredentialToolOverride> {
    const override = parseCredentialToolOverride(value);
    return this.enqueue(async () => {
      const next = clone(this.state);
      const existing = next.overrides.find(item => item.tool === override.tool);
      if (existing) existing.path = override.path;
      else next.overrides.push(override);
      const parsed = parseCredentialToolState(next);
      await this.writer.write(parsed);
      this.state = parsed;
      return { ...override };
    });
  }

  delete(tool: CredentialTool): Promise<boolean> {
    return this.enqueue(async () => {
      const next = clone(this.state);
      const index = next.overrides.findIndex(item => item.tool === tool);
      if (index === -1) return false;
      next.overrides.splice(index, 1);
      const parsed = parseCredentialToolState(next);
      await this.writer.write(parsed);
      this.state = parsed;
      return true;
    });
  }
}
