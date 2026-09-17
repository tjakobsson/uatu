// Durable worktree operation intent, creation provenance, and the restart
// recovery that reconciles them against actual Git state.
//
// Two files under the Hub state root, with deliberately different lifetimes:
//
//   pending-worktree-operation.json  ONE in-flight operation. Written before
//     the mutation it describes, advanced only forward through the bounded
//     create phases, and cleared when the operation is provably finished.
//     While it stands, no second worktree operation starts.
//   worktree-provenance.json  the durable record of what Uatu created. It
//     OUTLIVES registration: forgetting a workspace keeps it, re-registering
//     the same verified checkout recovers it, and a path reused by another
//     tree never inherits it, because every match is by checkout identity.
//
// The rule that shapes all of it: an interrupted operation may never delete
// content and may never claim ownership it cannot prove. Verification is a
// fresh Git probe, never the record's own say-so.

import { promises as nodeFs } from "node:fs";
import path from "node:path";

import {
  canAdvanceWorktreePhase,
  isWorktreePhase,
  resolveWorktreeOwnership,
  WorktreeOperationError,
  type WorktreeCreateMode,
  type WorktreeCreatePhase,
  type WorktreeIdentity,
  type WorktreeOwnership,
} from "../shared/worktree-contract";
import type { CheckoutInspection } from "./worktree-git";

const JOURNAL_VERSION = 1 as const;
const PROVENANCE_VERSION = 1 as const;

type FileSystem = Pick<typeof nodeFs, "lstat" | "readFile" | "open" | "unlink" | "chmod" | "rm" | "rename">;

export type WorktreeOperationIntent = {
  readonly version: typeof JOURNAL_VERSION;
  readonly operationId: string;
  readonly kind: "create";
  readonly phase: WorktreeCreatePhase;
  // Who asked. Scopes progress and results to the initiating Hub user.
  readonly user: string;
  readonly repositoryId: string;
  readonly sourceWorkspaceId: string;
  readonly sourcePath: string;
  readonly destination: string;
  readonly mode: WorktreeCreateMode;
  readonly branch: string;
  readonly base: { readonly kind: "local" | "remote"; readonly ref: string };
  // The immutable creation snapshot. Recorded from the explicitly selected
  // ref BEFORE the mutation, so it can never be re-derived from a parent
  // checkout that has moved on.
  readonly sourceRef?: string;
  // Filled in once Git's result has been verified — this is what makes a
  // retry idempotent and what lets recovery recognize its own tree.
  readonly checkoutId?: string;
  readonly workspaceId?: string;
};

export type WorktreeProvenanceRecord = {
  readonly version: typeof PROVENANCE_VERSION;
  readonly repositoryId: string;
  readonly checkoutId: string;
  // Where it was created. Corroborating only: identity decides ownership.
  readonly path: string;
  readonly branch: string;
  readonly sourceRef?: string;
  readonly operationId: string;
  readonly createdBy: string;
  // Unix epoch milliseconds.
  readonly createdAt: number;
};

function invalid(message: string): WorktreeOperationError {
  return WorktreeOperationError.of("invalid-input", message);
}

function requireString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== "string" || value === "") throw new Error(`${label} requires ${field}`);
  return value;
}

function closed(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!fields.includes(key)) throw new Error(`${label} contains an unknown field: ${key}`);
  }
  return record;
}

export function parseWorktreeIntent(value: unknown): WorktreeOperationIntent {
  const record = closed(
    value,
    ["version", "operationId", "kind", "phase", "user", "repositoryId", "sourceWorkspaceId", "sourcePath", "destination", "mode", "branch", "base", "sourceRef", "checkoutId", "workspaceId"],
    "pending worktree operation",
  );
  if (record.version !== JOURNAL_VERSION) throw new Error("unsupported pending worktree operation version");
  if (record.kind !== "create") throw new Error("unsupported pending worktree operation kind");
  // An unrecognized phase must never be read as "somewhere harmless": it
  // would re-enable exactly the ambiguity the bounded vocabulary removes.
  if (!isWorktreePhase("create", record.phase)) throw new Error("unsupported pending worktree operation phase");
  const base = closed(record.base, ["kind", "ref"], "pending worktree operation base");
  if (base.kind !== "local" && base.kind !== "remote") throw new Error("invalid pending worktree operation base kind");
  const mode = record.mode;
  if (mode !== "new-branch" && mode !== "existing-local" && mode !== "remote-tracking") {
    throw new Error("invalid pending worktree operation mode");
  }
  for (const field of ["sourcePath", "destination"]) {
    if (!path.isAbsolute(requireString(record, field, "pending worktree operation"))) {
      throw new Error("pending worktree operation paths must be absolute");
    }
  }
  return {
    version: JOURNAL_VERSION,
    operationId: requireString(record, "operationId", "pending worktree operation"),
    kind: "create",
    phase: record.phase as WorktreeCreatePhase,
    user: requireString(record, "user", "pending worktree operation"),
    repositoryId: requireString(record, "repositoryId", "pending worktree operation"),
    sourceWorkspaceId: requireString(record, "sourceWorkspaceId", "pending worktree operation"),
    sourcePath: record.sourcePath as string,
    destination: record.destination as string,
    mode: mode as WorktreeCreateMode,
    branch: requireString(record, "branch", "pending worktree operation"),
    base: { kind: base.kind, ref: requireString(base, "ref", "pending worktree operation base") },
    ...(record.sourceRef === undefined ? {} : { sourceRef: requireString(record, "sourceRef", "pending worktree operation") }),
    ...(record.checkoutId === undefined ? {} : { checkoutId: requireString(record, "checkoutId", "pending worktree operation") }),
    ...(record.workspaceId === undefined ? {} : { workspaceId: requireString(record, "workspaceId", "pending worktree operation") }),
  };
}

export function parseWorktreeProvenance(value: unknown): WorktreeProvenanceRecord {
  const record = closed(
    value,
    ["version", "repositoryId", "checkoutId", "path", "branch", "sourceRef", "operationId", "createdBy", "createdAt"],
    "worktree provenance record",
  );
  if (record.version !== PROVENANCE_VERSION) throw new Error("unsupported worktree provenance version");
  if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) throw new Error("invalid worktree provenance timestamp");
  return {
    version: PROVENANCE_VERSION,
    repositoryId: requireString(record, "repositoryId", "worktree provenance record"),
    checkoutId: requireString(record, "checkoutId", "worktree provenance record"),
    path: requireString(record, "path", "worktree provenance record"),
    branch: requireString(record, "branch", "worktree provenance record"),
    ...(record.sourceRef === undefined ? {} : { sourceRef: requireString(record, "sourceRef", "worktree provenance record") }),
    operationId: requireString(record, "operationId", "worktree provenance record"),
    createdBy: requireString(record, "createdBy", "worktree provenance record"),
    createdAt: record.createdAt,
  };
}

// Durable single-record write: temp file → fsync → rename → fsync directory.
// Identical in shape to the onboarding and folder-mutation journals, so a
// power loss cannot publish a record whose contents never reached disk.
class DurableJsonFile {
  private counter = 0;

  constructor(
    private readonly filePath: string,
    private readonly fs: FileSystem,
    private readonly syncsDirectory: boolean,
  ) {}

  private async syncDirectory(): Promise<void> {
    if (!this.syncsDirectory) return;
    const handle = await this.fs.open(path.dirname(this.filePath), "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async read(): Promise<unknown | undefined> {
    try {
      const stats = await this.fs.lstat(this.filePath);
      if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) throw new Error("state file must be a single regular file");
      if (typeof process.getuid === "function" && stats.uid !== process.getuid()) throw new Error("state file is not owned by the current user");
      return JSON.parse(await this.fs.readFile(this.filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async write(value: unknown): Promise<void> {
    const temp = `${this.filePath}.${process.pid}.${this.counter += 1}.tmp`;
    let created = false;
    try {
      const handle = await this.fs.open(temp, "wx", 0o600);
      created = true;
      try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.fs.rename(temp, this.filePath);
      created = false;
      await this.fs.chmod(this.filePath, 0o600);
      await this.syncDirectory();
    } catch (error) {
      if (created) await this.fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async clear(): Promise<void> {
    try {
      await this.fs.unlink(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    // The unlink already removed it from the live namespace, so the clear
    // IS done; only its durability is in doubt, and a resurrected record
    // describes a finished operation that recovery reconciles again.
    await this.syncDirectory().catch(() => undefined);
  }
}

export type WorktreeJournalOptions = {
  fs?: FileSystem;
  platform?: NodeJS.Platform;
};

export class WorktreeJournal {
  private readonly file: DurableJsonFile;

  constructor(filePath: string, options: WorktreeJournalOptions = {}) {
    const fs = options.fs ?? nodeFs;
    this.file = new DurableJsonFile(filePath, fs, (options.platform ?? process.platform) !== "win32");
  }

  async read(): Promise<WorktreeOperationIntent | undefined> {
    const value = await this.file.read();
    if (value === undefined) return undefined;
    try {
      return parseWorktreeIntent(value);
    } catch (error) {
      // A journal that cannot be understood is NOT cleared: clearing it
      // would discard the only record of a mutation that may have run.
      throw WorktreeOperationError.of(
        "identity-uncertain",
        "A pending worktree operation record could not be read. Resolve it before running another worktree operation.",
        { retry: "none" },
        { cause: error },
      );
    }
  }

  // Records the intent before the mutation it describes. A second, different
  // operation while one is pending is refused rather than queued: the record
  // is the fence. Re-recording the SAME operation id is idempotent, which is
  // what makes a retry safe after a failure whose outcome is unknown.
  async begin(intent: Omit<WorktreeOperationIntent, "version">): Promise<WorktreeOperationIntent> {
    const pending = await this.read();
    if (pending && pending.operationId !== intent.operationId) {
      throw WorktreeOperationError.of(
        "conflict",
        "Another worktree operation is still in progress. Wait for it to finish, then retry.",
        { retry: "refresh" },
      );
    }
    if (pending) return pending;
    const record = parseWorktreeIntent({ ...intent, version: JOURNAL_VERSION });
    await this.file.write(record);
    return record;
  }

  // Phases only advance. A backward or foreign phase is refused, so a
  // tampered or stale record can never replay a mutation already performed.
  async advance(
    operationId: string,
    phase: WorktreeCreatePhase,
    fields: Partial<Pick<WorktreeOperationIntent, "checkoutId" | "workspaceId" | "sourceRef">> = {},
  ): Promise<WorktreeOperationIntent> {
    const pending = await this.read();
    if (!pending || pending.operationId !== operationId) {
      throw invalid("no pending worktree operation matches this operation id");
    }
    if (!canAdvanceWorktreePhase("create", pending.phase, phase)) {
      throw invalid(`a worktree operation cannot move from ${pending.phase} to ${phase}`);
    }
    const record = parseWorktreeIntent({ ...pending, ...fields, phase });
    await this.file.write(record);
    return record;
  }

  clear(): Promise<void> {
    return this.file.clear();
  }
}

export class WorktreeProvenanceStore {
  private readonly file: DurableJsonFile;
  private records: WorktreeProvenanceRecord[] | undefined;

  constructor(filePath: string, options: WorktreeJournalOptions = {}) {
    const fs = options.fs ?? nodeFs;
    this.file = new DurableJsonFile(filePath, fs, (options.platform ?? process.platform) !== "win32");
  }

  async load(): Promise<readonly WorktreeProvenanceRecord[]> {
    if (this.records) return this.records;
    const value = await this.file.read();
    if (value === undefined) {
      this.records = [];
      return this.records;
    }
    const record = closed(value, ["version", "records"], "worktree provenance store");
    if (record.version !== PROVENANCE_VERSION) throw new Error("unsupported worktree provenance version");
    if (!Array.isArray(record.records)) throw new Error("invalid worktree provenance records");
    this.records = record.records.map(parseWorktreeProvenance);
    return this.records;
  }

  async record(entry: Omit<WorktreeProvenanceRecord, "version">): Promise<WorktreeProvenanceRecord> {
    const records = [...await this.load()];
    const parsed = parseWorktreeProvenance({ ...entry, version: PROVENANCE_VERSION });
    const existing = records.findIndex(candidate => candidate.checkoutId === parsed.checkoutId);
    // Re-recording one checkout replaces its record rather than accumulating
    // duplicates, so an idempotent retry leaves exactly one.
    if (existing >= 0) records[existing] = parsed;
    else records.push(parsed);
    await this.file.write({ version: PROVENANCE_VERSION, records });
    this.records = records;
    return parsed;
  }

  // Removed only after a removal has been VERIFIED (task 5.4). Nothing else
  // deletes provenance — least of all forgetting a registration.
  async forgetCheckout(checkoutId: string): Promise<boolean> {
    const records = await this.load();
    const remaining = records.filter(record => record.checkoutId !== checkoutId);
    if (remaining.length === records.length) return false;
    await this.file.write({ version: PROVENANCE_VERSION, records: remaining });
    this.records = remaining;
    return true;
  }

  async byCheckoutId(checkoutId: string): Promise<WorktreeProvenanceRecord | undefined> {
    return (await this.load()).find(record => record.checkoutId === checkoutId);
  }

  // Path lookup exists for diagnostics and for recognizing OUR OWN retained
  // destination during recovery. It never decides ownership on its own: the
  // caller still compares identities.
  async byPath(checkoutPath: string): Promise<WorktreeProvenanceRecord | undefined> {
    const resolved = path.resolve(checkoutPath);
    return (await this.load()).find(record => path.resolve(record.path) === resolved);
  }
}

// Ownership for one observed checkout, combining the durable record with a
// fresh probe. This is the only ownership entry point services should use.
export async function ownershipForCheckout(options: {
  provenance: WorktreeProvenanceStore;
  inspection: CheckoutInspection;
  checkoutPath: string;
  main?: boolean;
  registeredIdentity?: WorktreeIdentity;
}): Promise<{ ownership: WorktreeOwnership; availability: "present" | "missing" | "replaced"; record?: WorktreeProvenanceRecord }> {
  const { inspection } = options;
  const record = inspection.identity ? await options.provenance.byCheckoutId(inspection.identity.checkoutId) : undefined;
  const resolved = resolveWorktreeOwnership({
    main: options.main === true,
    present: inspection.present,
    identityReadable: inspection.identityReadable,
    ...(inspection.identity ? { observed: inspection.identity } : {}),
    observedPath: options.checkoutPath,
    ...(options.registeredIdentity ? { registered: options.registeredIdentity } : {}),
    ...(record ? { provenance: { identity: { repositoryId: record.repositoryId, checkoutId: record.checkoutId }, path: record.path } } : {}),
  });
  return { ...resolved, ...(record ? { record } : {}) };
}

// --- Restart recovery ------------------------------------------------------

export type WorktreeRecoveryOutcome =
  // The journal was written but the mutation provably never happened.
  | { readonly kind: "nothing-created"; readonly operationId: string }
  // Git created the tree and registration did not complete. The checkout and
  // its branch are RETAINED; the caller offers registration retry.
  | { readonly kind: "retained-unregistered"; readonly operationId: string; readonly checkoutPath: string; readonly identity: WorktreeIdentity }
  // Everything the journal describes is in place.
  | { readonly kind: "completed"; readonly operationId: string; readonly workspaceId: string }
  // The destination holds something we cannot prove is ours. Content is kept
  // and reconciliation is required; nothing is deleted, nothing is claimed.
  | { readonly kind: "uncertain"; readonly operationId: string; readonly checkoutPath: string; readonly detail: string };

export type WorktreeRecoveryOptions = {
  journal: WorktreeJournal;
  provenance: WorktreeProvenanceStore;
  // A fresh Git probe of the destination. Recovery never trusts the record.
  inspect(checkoutPath: string): Promise<CheckoutInspection>;
  // The Hub registration at that path, if any.
  registeredWorkspaceId?(checkoutPath: string): string | undefined;
};

export async function recoverWorktreeOperation(options: WorktreeRecoveryOptions): Promise<WorktreeRecoveryOutcome | undefined> {
  const pending = await options.journal.read();
  if (!pending) return undefined;
  const inspection = await options.inspect(pending.destination);
  const uncertain = async (detail: string): Promise<WorktreeRecoveryOutcome> => {
    // The record is kept: an operation whose outcome cannot be established
    // must stay visible until a human resolves it, and clearing it would
    // also unfreeze folder mutations over a path in an unknown state.
    return { kind: "uncertain", operationId: pending.operationId, checkoutPath: pending.destination, detail };
  };

  if (!inspection.present) {
    // Nothing at the destination: whatever ran, it left no tree. The branch
    // it may have created is deliberately left alone — branches are never
    // deleted by Uatu.
    await options.journal.clear();
    return { kind: "nothing-created", operationId: pending.operationId };
  }
  if (!inspection.identityReadable) return uncertain(inspection.detail ?? "the destination's identity could not be read");
  if (!inspection.identity) return uncertain("the destination holds content that is not a Git checkout");
  if (inspection.identity.repositoryId !== pending.repositoryId) {
    return uncertain("the destination holds a checkout of another repository");
  }
  // Before `creating`, this process had not run Git at all, so a checkout at
  // the destination is someone else's work, however plausible it looks.
  if (pending.phase === "validating" || pending.phase === "reserving") {
    return uncertain("the destination was already occupied before creation began");
  }
  if (pending.checkoutId !== undefined && pending.checkoutId !== inspection.identity.checkoutId) {
    return uncertain("the destination holds a different checkout than the one recorded");
  }

  // Ours: record provenance (idempotently — a crash between Git and the
  // provenance write is the common case) and report what remains.
  await options.provenance.record({
    repositoryId: inspection.identity.repositoryId,
    checkoutId: inspection.identity.checkoutId,
    path: pending.destination,
    branch: pending.branch,
    ...(pending.sourceRef === undefined ? {} : { sourceRef: pending.sourceRef }),
    operationId: pending.operationId,
    createdBy: pending.user,
    createdAt: Date.now(),
  });
  // The registry is asked fresh: a journal that reached `complete` still
  // reports a retained checkout if its registration is not actually there.
  const workspaceId = options.registeredWorkspaceId?.(pending.destination);
  await options.journal.clear();
  if (workspaceId !== undefined) return { kind: "completed", operationId: pending.operationId, workspaceId };
  return {
    kind: "retained-unregistered",
    operationId: pending.operationId,
    checkoutPath: pending.destination,
    identity: inspection.identity,
  };
}

// --- Registration ----------------------------------------------------------

// The onboarding seam. Task 4.3 binds this to WorkspaceOnboardingCoordinator,
// which commits the registry entry and the parent's credential assignments
// together; nothing here knows how that commit is made.
export type WorktreeRegistrar = {
  register(input: {
    path: string;
    displayName: string;
    parentWorkspaceId: string;
    // The VERIFIED Git identity of the tree being registered. The
    // registration records it, so a later retry recognizes the same
    // checkout instead of registering a second one, and a path reused by
    // another tree never inherits the relationship.
    identity: WorktreeIdentity;
    start: boolean;
  }): Promise<{ workspaceId: string; started: boolean; startError?: string }>;
};

export type RegisterCreatedWorktreeOptions = {
  journal: WorktreeJournal;
  provenance: WorktreeProvenanceStore;
  registrar: WorktreeRegistrar;
  inspect(checkoutPath: string): Promise<CheckoutInspection>;
  operationId: string;
  start?: boolean;
};

export type RegisterCreatedWorktreeResult = {
  readonly workspaceId: string;
  readonly started: boolean;
  readonly startError?: string;
};

// Registers a checkout Git already created, and is safe to call again after
// any failure: it re-verifies the SAME tree by identity and never creates a
// second one. The child's display name is its exact local branch.
export async function registerCreatedWorktree(options: RegisterCreatedWorktreeOptions): Promise<RegisterCreatedWorktreeResult> {
  const pending = await options.journal.read();
  if (!pending || pending.operationId !== options.operationId) {
    throw invalid("no pending worktree operation matches this operation id");
  }
  if (pending.checkoutId === undefined) throw invalid("the checkout has not been verified yet");
  const inspection = await options.inspect(pending.destination);
  if (!inspection.present || !inspection.identityReadable || !inspection.identity) {
    throw WorktreeOperationError.of(
      "identity-uncertain",
      "The retained checkout could not be verified. Nothing was changed or removed.",
      { retry: "none", phase: pending.phase },
    );
  }
  if (inspection.identity.checkoutId !== pending.checkoutId) {
    throw WorktreeOperationError.of(
      "identity-uncertain",
      "The retained path no longer holds the checkout that was created. Nothing was changed or removed.",
      { retry: "none", phase: pending.phase },
    );
  }

  // Provenance first: a crash between a successful registration and the
  // provenance write would otherwise leave a registered tree Uatu created
  // but cannot prove it created.
  await options.provenance.record({
    repositoryId: inspection.identity.repositoryId,
    checkoutId: inspection.identity.checkoutId,
    path: pending.destination,
    branch: pending.branch,
    ...(pending.sourceRef === undefined ? {} : { sourceRef: pending.sourceRef }),
    operationId: pending.operationId,
    createdBy: pending.user,
    createdAt: Date.now(),
  });
  if (pending.phase !== "registering") await options.journal.advance(pending.operationId, "registering");

  let registration: Awaited<ReturnType<WorktreeRegistrar["register"]>>;
  try {
    registration = await options.registrar.register({
      path: pending.destination,
      displayName: pending.branch,
      parentWorkspaceId: pending.sourceWorkspaceId,
      identity: inspection.identity,
      start: options.start === true,
    });
  } catch (error) {
    // The checkout and its branch are retained, and the journal stays at
    // `registering` so a retry resumes here instead of creating another tree.
    throw WorktreeOperationError.of(
      "registration-failed",
      "Registration failed. The checkout and branch are retained. Retry registration; do not create another checkout.",
      { retry: "retry-registration", retainedCheckoutId: pending.checkoutId, phase: "registering" },
      { cause: error },
    );
  }
  await options.journal.advance(pending.operationId, "complete", { workspaceId: registration.workspaceId });
  await options.journal.clear();
  return {
    workspaceId: registration.workspaceId,
    started: registration.started,
    ...(registration.startError === undefined ? {} : { startError: registration.startError }),
  };
}
