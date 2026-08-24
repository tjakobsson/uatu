import { promises as fs } from "node:fs";

export const PERSONAL_WORKSPACE_STATE_VERSION = 1 as const;

export type PersonalWorkspaceState = {
  version: typeof PERSONAL_WORKSPACE_STATE_VERSION;
  documentPath?: string;
  follow?: boolean;
  previewMode?: "rendered" | "source" | "diff";
  compareTarget?: "base" | "last-commit";
  filesFilter?: "all" | "changed";
  lastPtyId?: string;
};

type MutableField = Exclude<keyof PersonalWorkspaceState, "version">;
export type PersonalWorkspaceStatePatch = Partial<Record<MutableField, string | boolean | null>> & {
  version?: typeof PERSONAL_WORKSPACE_STATE_VERSION;
};

type PersistedState = {
  version: typeof PERSONAL_WORKSPACE_STATE_VERSION;
  records: Record<string, Record<string, PersonalWorkspaceState>>;
  pendingForgets: Record<string, Record<string, PersonalWorkspaceState>>;
};

function emptyDictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function cloneRecords(
  source: PersistedState["records"],
): PersistedState["records"] {
  const clone = emptyDictionary<Record<string, PersonalWorkspaceState>>();
  for (const [user, workspaces] of Object.entries(source)) {
    const userRecords = emptyDictionary<PersonalWorkspaceState>();
    for (const [workspaceId, state] of Object.entries(workspaces)) {
      userRecords[workspaceId] = { ...state };
    }
    clone[user] = userRecords;
  }
  return clone;
}

function clonePendingForgets(
  source: PersistedState["pendingForgets"],
): PersistedState["pendingForgets"] {
  const clone = emptyDictionary<Record<string, PersonalWorkspaceState>>();
  for (const [workspaceId, users] of Object.entries(source)) {
    const workspaceRecords = emptyDictionary<PersonalWorkspaceState>();
    for (const [user, state] of Object.entries(users)) {
      workspaceRecords[user] = { ...state };
    }
    clone[workspaceId] = workspaceRecords;
  }
  return clone;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PATCH_FIELDS = new Set([
  "version",
  "documentPath",
  "follow",
  "previewMode",
  "compareTarget",
  "filesFilter",
  "lastPtyId",
]);

function emptyState(): PersonalWorkspaceState {
  return { version: PERSONAL_WORKSPACE_STATE_VERSION };
}

function isRelativeDocumentPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\")) {
    return false;
  }
  if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return false;
  return value.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}

function parseState(value: unknown): PersonalWorkspaceState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== PERSONAL_WORKSPACE_STATE_VERSION) return null;
  try {
    return applyPatch(emptyState(), parsePersonalWorkspaceStatePatch(record));
  } catch {
    return null;
  }
}

export function parsePersonalWorkspaceStatePatch(value: unknown): PersonalWorkspaceStatePatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("personal state patch must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PATCH_FIELDS.has(key)) throw new Error(`unknown personal state field: ${key}`);
  }
  if (record.version !== undefined && record.version !== PERSONAL_WORKSPACE_STATE_VERSION) {
    throw new Error("unsupported personal state version");
  }
  const patch: PersonalWorkspaceStatePatch = {};
  if (record.version !== undefined) patch.version = PERSONAL_WORKSPACE_STATE_VERSION;

  if (record.documentPath !== undefined) {
    if (record.documentPath !== null && !isRelativeDocumentPath(record.documentPath)) {
      throw new Error("documentPath must be a normalized relative path");
    }
    patch.documentPath = record.documentPath;
  }
  if (record.follow !== undefined) {
    if (record.follow !== null && typeof record.follow !== "boolean") {
      throw new Error("follow must be a boolean or null");
    }
    patch.follow = record.follow;
  }
  if (record.previewMode !== undefined) {
    if (
      record.previewMode !== null
      && record.previewMode !== "rendered"
      && record.previewMode !== "source"
      && record.previewMode !== "diff"
    ) throw new Error("invalid previewMode");
    patch.previewMode = record.previewMode as PersonalWorkspaceStatePatch["previewMode"];
  }
  if (record.compareTarget !== undefined) {
    if (record.compareTarget !== null && record.compareTarget !== "base" && record.compareTarget !== "last-commit") {
      throw new Error("invalid compareTarget");
    }
    patch.compareTarget = record.compareTarget as PersonalWorkspaceStatePatch["compareTarget"];
  }
  if (record.filesFilter !== undefined) {
    if (record.filesFilter !== null && record.filesFilter !== "all" && record.filesFilter !== "changed") {
      throw new Error("invalid filesFilter");
    }
    patch.filesFilter = record.filesFilter as PersonalWorkspaceStatePatch["filesFilter"];
  }
  if (record.lastPtyId !== undefined) {
    if (record.lastPtyId !== null && (typeof record.lastPtyId !== "string" || !UUID_RE.test(record.lastPtyId))) {
      throw new Error("lastPtyId must be a UUID or null");
    }
    patch.lastPtyId = record.lastPtyId;
  }
  return patch;
}

function applyPatch(
  current: PersonalWorkspaceState,
  patch: PersonalWorkspaceStatePatch,
): PersonalWorkspaceState {
  const next = { ...current, version: PERSONAL_WORKSPACE_STATE_VERSION };
  for (const field of PATCH_FIELDS) {
    if (field === "version" || !(field in patch)) continue;
    const value = patch[field as MutableField];
    if (value === null) {
      delete next[field as MutableField];
    } else if (value !== undefined) {
      Object.assign(next, { [field]: value });
    }
  }
  return next;
}

export class PersonalWorkspaceStateStore {
  private records: PersistedState["records"] = emptyDictionary();
  private pendingForgets: PersistedState["pendingForgets"] = emptyDictionary();
  private mutationChain: Promise<unknown> = Promise.resolve();
  private saveCounter = 0;

  constructor(private readonly filePath: string) {}

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationChain.then(operation, operation);
    this.mutationChain = next.catch(() => undefined);
    return next;
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.records = emptyDictionary();
        this.pendingForgets = emptyDictionary();
        return;
      }
      throw error;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`personal workspace state is corrupt: ${this.filePath}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`personal workspace state is corrupt: ${this.filePath}`);
    }
    const envelope = raw as { version?: unknown; records?: unknown; pendingForgets?: unknown };
    if (
      envelope.version !== PERSONAL_WORKSPACE_STATE_VERSION
      || !envelope.records
      || typeof envelope.records !== "object"
      || Array.isArray(envelope.records)
    ) throw new Error(`personal workspace state is corrupt: ${this.filePath}`);

    const records = emptyDictionary<Record<string, PersonalWorkspaceState>>();
    for (const [user, workspaces] of Object.entries(envelope.records as Record<string, unknown>)) {
      if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) {
        throw new Error(`personal workspace state is corrupt: ${this.filePath}`);
      }
      records[user] = emptyDictionary();
      for (const [workspaceId, candidate] of Object.entries(workspaces as Record<string, unknown>)) {
        const state = parseState(candidate);
        if (!state) throw new Error(`personal workspace state is corrupt: ${this.filePath}`);
        records[user]![workspaceId] = state;
      }
    }
    this.records = records;
    this.pendingForgets = this.parsePendingForgets(envelope.pendingForgets ?? {});
    await fs.chmod(this.filePath, 0o600);
  }

  get(user: string, workspaceId: string): PersonalWorkspaceState {
    return { ...(this.records[user]?.[workspaceId] ?? emptyState()) };
  }

  patch(
    user: string,
    workspaceId: string,
    value: unknown,
  ): Promise<PersonalWorkspaceState> {
    const patch = parsePersonalWorkspaceStatePatch(value);
    return this.enqueueMutation(async () => {
      const previous = cloneRecords(this.records);
      const next = applyPatch(this.get(user, workspaceId), patch);
      this.records[user] ??= emptyDictionary();
      this.records[user]![workspaceId] = next;
      try {
        await this.save();
      } catch (error) {
        this.records = previous;
        throw error;
      }
      return { ...next };
    });
  }

  removeWorkspace(workspaceId: string): Promise<boolean> {
    return this.enqueueMutation(async () => {
      const previous = cloneRecords(this.records);
      let removed = false;
      for (const [user, workspaces] of Object.entries(this.records)) {
        if (workspaceId in workspaces) {
          delete workspaces[workspaceId];
          removed = true;
        }
        if (Object.keys(workspaces).length === 0) delete this.records[user];
      }
      if (!removed) return false;
      try {
        await this.save();
      } catch (error) {
        this.records = previous;
        throw error;
      }
      return true;
    });
  }

  forgetWorkspace(
    workspaceId: string,
    removeRegistryEntry: () => Promise<boolean>,
    finalizeCommittedForget: () => Promise<void> = async () => {},
  ): Promise<boolean> {
    return this.enqueueMutation(async () => {
      const removedRecords = this.collectWorkspaceRecords(workspaceId);
      this.pendingForgets[workspaceId] = removedRecords;
      this.deleteWorkspaceRecords(workspaceId);
      try {
        await this.save();
      } catch (error) {
        this.restoreWorkspaceRecords(workspaceId, removedRecords);
        delete this.pendingForgets[workspaceId];
        try {
          await this.save();
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `failed to forget '${workspaceId}' and roll back personal state`);
        }
        throw error;
      }
      try {
        const removed = await removeRegistryEntry();
        if (!removed) throw new Error(`unknown workspace: ${workspaceId}`);
      } catch (error) {
        this.restoreWorkspaceRecords(workspaceId, removedRecords);
        delete this.pendingForgets[workspaceId];
        try {
          await this.save();
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `failed to forget '${workspaceId}' and roll back personal state`);
        }
        throw error;
      }

      // The registry is the commit marker. Cleanup that can be retried must
      // happen after it, while the durable journal still records the forget.
      await finalizeCommittedForget();
      delete this.pendingForgets[workspaceId];
      try {
        await this.save();
      } catch (error) {
        // Registry deletion is already committed. Keep the journal in memory
        // so a later save or restart can finish the forget without resurrecting
        // records for a workspace that no longer exists.
        this.pendingForgets[workspaceId] = removedRecords;
        throw error;
      }
      return true;
    });
  }

  recoverPendingForgets(
    workspaceExists: (workspaceId: string) => boolean,
    finalizeCommittedForget: (workspaceId: string) => Promise<void> = async () => {},
  ): Promise<void> {
    return this.enqueueMutation(async () => {
      if (Object.keys(this.pendingForgets).length === 0) return;
      const previousRecords = cloneRecords(this.records);
      const previousPending = clonePendingForgets(this.pendingForgets);
      try {
        for (const [workspaceId, removedRecords] of Object.entries(this.pendingForgets)) {
          if (workspaceExists(workspaceId)) {
            this.restoreWorkspaceRecords(workspaceId, removedRecords);
          } else {
            await finalizeCommittedForget(workspaceId);
          }
          delete this.pendingForgets[workspaceId];
        }
        await this.save();
      } catch (error) {
        this.records = previousRecords;
        this.pendingForgets = previousPending;
        throw error;
      }
    });
  }

  private parsePendingForgets(value: unknown): PersistedState["pendingForgets"] {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`personal workspace state is corrupt: ${this.filePath}`);
    }
    const pending = emptyDictionary<Record<string, PersonalWorkspaceState>>();
    for (const [workspaceId, users] of Object.entries(value as Record<string, unknown>)) {
      if (!users || typeof users !== "object" || Array.isArray(users)) {
        throw new Error(`personal workspace state is corrupt: ${this.filePath}`);
      }
      pending[workspaceId] = emptyDictionary();
      for (const [user, candidate] of Object.entries(users as Record<string, unknown>)) {
        const state = parseState(candidate);
        if (!state) throw new Error(`personal workspace state is corrupt: ${this.filePath}`);
        pending[workspaceId]![user] = state;
      }
    }
    return pending;
  }

  private collectWorkspaceRecords(workspaceId: string): Record<string, PersonalWorkspaceState> {
    const collected = emptyDictionary<PersonalWorkspaceState>();
    for (const [user, workspaces] of Object.entries(this.records)) {
      const state = workspaces[workspaceId];
      if (state) collected[user] = { ...state };
    }
    return collected;
  }

  private deleteWorkspaceRecords(workspaceId: string): void {
    for (const [user, workspaces] of Object.entries(this.records)) {
      delete workspaces[workspaceId];
      if (Object.keys(workspaces).length === 0) delete this.records[user];
    }
  }

  private restoreWorkspaceRecords(
    workspaceId: string,
    records: Record<string, PersonalWorkspaceState>,
  ): void {
    for (const [user, state] of Object.entries(records)) {
      this.records[user] ??= emptyDictionary();
      this.records[user]![workspaceId] = { ...state };
    }
  }

  private async save(): Promise<void> {
    const serialized = `${JSON.stringify({
      version: PERSONAL_WORKSPACE_STATE_VERSION,
      records: this.records,
      pendingForgets: this.pendingForgets,
    } satisfies PersistedState, null, 2)}\n`;
    const temp = `${this.filePath}.${process.pid}.${(this.saveCounter += 1)}.tmp`;
    try {
      await fs.writeFile(temp, serialized, { mode: 0o600 });
      // Settle the mode before publishing — the writeFile mode above is
      // masked by the umask, and the rename is the commit point every
      // mutation's rollback depends on: a failure after it would leave the
      // new records on disk while the caller restored the old ones in memory.
      await fs.chmod(temp, 0o600);
      await fs.rename(temp, this.filePath);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
