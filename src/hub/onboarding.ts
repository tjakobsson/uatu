// Atomic workspace onboarding: one coordinator that validates a full
// configuration request (folder, display name, credential selections),
// then commits the registry entry and the requested credential assignments
// as one coherent result. A durable pending-onboarding journal brackets the
// two-store commit so a crash between them recovers to either the complete
// desired state or the recorded previous state — never a registered
// workspace with half its selected assignments.
//
// Session start is post-commit INTENT, not transaction state: an explicitly
// requested first start that fails leaves the configured stopped workspace
// in place and reports the startup error.

import { promises as nodeFs } from "node:fs";
import path from "node:path";

import type { CredentialMetadataStore } from "./credential-store";
import { normalizeProviderHost, type CredentialAssignment, type CredentialRecord, type CredentialState } from "./credential-types";
import { FolderManagerError, reconcileRegisteredAliasPaths } from "./folder-manager";
import { gitInit, probeGitRepository, type GitProbeResult } from "./git";
import { normalizeAbsolutePath, type PathReservationCoordinator } from "./path-reservations";
import {
  validateWorkspaceDisplayName,
  workspaceSlug,
  type WorkspaceEntry,
  type WorkspaceRegistry,
} from "./registry";
import type { SessionManager } from "./sessions";

const JOURNAL_VERSION = 1 as const;

export type OnboardingErrorCode =
  | "invalid-input"
  | "not-found"
  | "conflict"
  | "needs-init"
  | "credential"
  | "git-init"
  | "internal"
  | "recovery-required";

export class OnboardingError extends Error {
  constructor(
    readonly code: OnboardingErrorCode,
    message: string,
    options?: ErrorOptions & { retainedPath?: string; committedEntry?: WorkspaceEntry },
  ) {
    super(message, options);
    this.name = "OnboardingError";
    this.retainedPath = options?.retainedPath;
    this.committedEntry = options?.committedEntry;
  }

  // Set when a created repository outlives a failed onboarding: the folder
  // was initialized, cannot be proven free of user content, and is retained
  // for retry through the Existing folder flow.
  readonly retainedPath: string | undefined;

  // Set when both stores committed and only the journal failed to clear:
  // the workspace is fully registered and recovery will preserve it, so
  // callers can report the committed entry instead of a phantom failure.
  readonly committedEntry: WorkspaceEntry | undefined;
}

export type AuthenticationSelection = { credentialId: string; host: string };

export type ConfigureExistingInput = {
  path: string;
  displayName: string;
  authentication: AuthenticationSelection[];
  signing: string | null;
  init: boolean;
  start: boolean;
};

export type CreateWorkspaceInput = {
  parent: string;
  folderName: string;
  displayName: string;
  authentication: AuthenticationSelection[];
  signing: string | null;
  start: boolean;
};

export type OnboardingResult = {
  entry: WorkspaceEntry;
  // Whether this call created the registration (false only for the
  // configure-existing idempotent short-circuit on an already-registered
  // path, kept for the legacy registration adapter).
  created: boolean;
  alreadyRegistered: boolean;
  createdFolder: boolean;
  started: boolean;
  startError: string | null;
};

type PendingOnboarding = {
  version: typeof JOURNAL_VERSION;
  operation: "configure-existing" | "create-new";
  createdFolder: boolean;
  entry: WorkspaceEntry;
  previousEntry: WorkspaceEntry | null;
  previousAssignments: CredentialAssignment[];
  desiredAssignments: CredentialAssignment[];
};

type FileSystem = Pick<typeof nodeFs, "lstat" | "realpath" | "mkdir" | "rmdir" | "readFile" | "open" | "unlink" | "chmod" | "rm" | "rename" | "readdir">;

type OnboardingRegistry = Pick<WorkspaceRegistry, "byId" | "byPath" | "list" | "registerWithStatus" | "remove" | "replacePathPrefix" | "restoreEntries">;
type OnboardingCredentials = Pick<CredentialMetadataStore, "snapshot" | "transaction">;
type OnboardingSessions = Pick<SessionManager, "runExclusive" | "startWhileLifecycleQueueHeld">;

export type OnboardingGit = {
  probe(folder: string): Promise<GitProbeResult>;
  init(folder: string): Promise<{ ok: true } | { ok: false; error: string }>;
};

export type WorkspaceOnboardingOptions = {
  journalPath: string;
  // Journals of sibling coordinators (the folder-mutation journal) whose
  // pending record also freezes onboarding: registering or creating at a
  // path a pending folder removal recorded would hand its recovery an
  // unrecognized directory and abort the next startup.
  recoveryJournalPaths?: readonly string[];
  registry: OnboardingRegistry;
  credentials: OnboardingCredentials;
  sessions: OnboardingSessions;
  reservations: PathReservationCoordinator;
  gitCommand?: () => string;
  git?: OnboardingGit;
  fs?: FileSystem;
};

function invalid(message: string): OnboardingError {
  return new OnboardingError("invalid-input", message);
}

function closedObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("request must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(fields);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalid(`request contains an unknown field: ${key}`);
  }
  return record;
}

function absolutePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.includes("\0") || !path.isAbsolute(value)) {
    throw invalid(`${field} must be an absolute path`);
  }
  return normalizeAbsolutePath(value);
}

// Same visible-segment rules as the folder manager's create operation.
function visibleFolderSegment(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || value.trim() === ""
    || value === "."
    || value === ".."
    || value.startsWith(".")
    || value.includes("/")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw invalid(`${field} must be one visible non-hidden path segment`);
  }
  return value;
}

function displayName(value: unknown): string {
  try {
    return validateWorkspaceDisplayName(value);
  } catch (error) {
    throw new OnboardingError("invalid-input", error instanceof Error ? error.message : String(error), { cause: error });
  }
}

function booleanFlag(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw invalid(`${field} must be a boolean`);
  return value;
}

function authenticationSelections(value: unknown): AuthenticationSelection[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid("authentication must be an array of credential selections");
  return value.map(item => {
    const selection = closedObject(item, ["credentialId", "host"]);
    if (typeof selection.credentialId !== "string" || selection.credentialId === "") {
      throw invalid("authentication selection requires a credentialId");
    }
    if (typeof selection.host !== "string" || selection.host === "") {
      throw invalid("authentication selection requires a host");
    }
    return { credentialId: selection.credentialId, host: selection.host };
  });
}

function signingSelection(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value === "") throw invalid("signing must be a credential id");
  return value;
}

export function parseConfigureExisting(value: unknown): ConfigureExistingInput {
  const input = closedObject(value, ["path", "displayName", "authentication", "signing", "init", "start"]);
  return {
    path: absolutePath(input.path, "path"),
    displayName: displayName(input.displayName),
    authentication: authenticationSelections(input.authentication),
    signing: signingSelection(input.signing),
    init: booleanFlag(input.init, "init", false),
    // Stopped is the documented default: omitting start never starts.
    start: booleanFlag(input.start, "start", false),
  };
}

export function parseCreateWorkspace(value: unknown): CreateWorkspaceInput {
  const input = closedObject(value, ["parent", "folderName", "displayName", "authentication", "signing", "start"]);
  return {
    parent: absolutePath(input.parent, "parent"),
    folderName: visibleFolderSegment(input.folderName, "folderName"),
    displayName: displayName(input.displayName),
    authentication: authenticationSelections(input.authentication),
    signing: signingSelection(input.signing),
    start: booleanFlag(input.start, "start", false),
  };
}

// Resolves the requested credential selections into concrete assignments
// for the planned workspace id, before any registry or filesystem mutation.
// Missing, disabled, incapable, host-incompatible, or conflicting
// selections fail here, leaving no partial state anywhere.
export function resolveOnboardingAssignments(
  workspaceId: string,
  input: { authentication: AuthenticationSelection[]; signing: string | null },
  state: CredentialState,
): CredentialAssignment[] {
  const desired: CredentialAssignment[] = [];
  const hosts = new Set<string>();
  const requireCredential = (credentialId: string): CredentialRecord => {
    const credential = state.credentials.find(item => item.id === credentialId);
    if (!credential) throw new OnboardingError("credential", `unknown credential: ${credentialId}`);
    if (!credential.enabled) throw new OnboardingError("credential", `credential is disabled: ${credential.name}`);
    return credential;
  };
  for (const selection of input.authentication) {
    let host: string;
    try {
      host = normalizeProviderHost(selection.host);
    } catch (error) {
      throw new OnboardingError("invalid-input", error instanceof Error ? error.message : String(error), { cause: error });
    }
    if (hosts.has(host)) {
      throw new OnboardingError("credential", `conflicting authentication defaults for one host: ${host}`);
    }
    hosts.add(host);
    const credential = requireCredential(selection.credentialId);
    const authCapable = credential.capabilities.some(capability =>
      capability === "ssh-authentication"
      || capability === "https-git"
      || capability === "github-cli"
      || capability === "gitlab-cli");
    if (!authCapable) {
      throw new OnboardingError("credential", `credential does not support authentication: ${credential.name}`);
    }
    if (credential.type === "token" && credential.metadata.host !== host) {
      throw new OnboardingError("credential", `credential host does not match the selected host: ${credential.metadata.host}`);
    }
    desired.push({ workspaceId, credentialId: credential.id, role: "authentication", host });
  }
  if (input.signing !== null) {
    const credential = requireCredential(input.signing);
    if (!credential.capabilities.some(capability => capability === "ssh-signing" || capability === "openpgp-signing")) {
      throw new OnboardingError("credential", `credential does not support signing: ${credential.name}`);
    }
    desired.push({ workspaceId, credentialId: credential.id, role: "signing" });
  }
  return desired;
}

function sameAssignmentSet(left: CredentialAssignment[], right: CredentialAssignment[]): boolean {
  return left.length === right.length
    && right.every(assignment => left.some(existing => JSON.stringify(existing) === JSON.stringify(assignment)));
}

// Rebuilds the input-shaped selections from resolved assignments so a
// desired set can be re-judged by resolveOnboardingAssignments later.
function selectionsFromAssignments(desired: CredentialAssignment[]): {
  authentication: AuthenticationSelection[];
  signing: string | null;
} {
  return {
    authentication: desired
      .filter(assignment => assignment.role === "authentication")
      .map(assignment => ({ credentialId: assignment.credentialId, host: assignment.host })),
    signing: desired.find(assignment => assignment.role === "signing")?.credentialId ?? null,
  };
}

function closedJournalObject(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const allowed = new Set(fields);
  if (Object.keys(record).some(key => !allowed.has(key))) throw new Error(`${label} contains an unknown field`);
  return record;
}

function parseJournalEntry(value: unknown): WorkspaceEntry {
  const entry = closedJournalObject(value, ["id", "path", "backend", "displayName"], "onboarding journal entry");
  if (typeof entry.id !== "string" || entry.id === "" || entry.backend !== "local") {
    throw new Error("invalid onboarding journal entry");
  }
  if (typeof entry.path !== "string" || !path.isAbsolute(entry.path)) {
    throw new Error("onboarding journal path must be absolute");
  }
  return {
    id: entry.id,
    path: normalizeAbsolutePath(entry.path),
    backend: "local",
    displayName: validateWorkspaceDisplayName(entry.displayName),
  };
}

function parseJournalAssignment(value: unknown): CredentialAssignment {
  const record = closedJournalObject(
    value,
    (value as { role?: unknown })?.role === "authentication"
      ? ["workspaceId", "credentialId", "role", "host"]
      : ["workspaceId", "credentialId", "role"],
    "onboarding journal assignment",
  );
  if (typeof record.workspaceId !== "string" || typeof record.credentialId !== "string") {
    throw new Error("invalid onboarding journal assignment");
  }
  if (record.role === "authentication") {
    if (typeof record.host !== "string" || record.host === "") throw new Error("invalid onboarding journal assignment host");
    return { workspaceId: record.workspaceId, credentialId: record.credentialId, role: "authentication", host: record.host };
  }
  if (record.role !== "signing") throw new Error("invalid onboarding journal assignment role");
  return { workspaceId: record.workspaceId, credentialId: record.credentialId, role: "signing" };
}

function parseJournal(value: unknown): PendingOnboarding {
  const record = closedJournalObject(
    value,
    ["version", "operation", "createdFolder", "entry", "previousEntry", "previousAssignments", "desiredAssignments"],
    "pending onboarding journal",
  );
  if (record.version !== JOURNAL_VERSION) throw new Error("unsupported onboarding journal version");
  if (record.operation !== "configure-existing" && record.operation !== "create-new") {
    throw new Error("unsupported onboarding journal operation");
  }
  if (typeof record.createdFolder !== "boolean") throw new Error("invalid onboarding journal createdFolder");
  if (!Array.isArray(record.previousAssignments) || !Array.isArray(record.desiredAssignments)) {
    throw new Error("invalid onboarding journal assignments");
  }
  return {
    version: JOURNAL_VERSION,
    operation: record.operation,
    createdFolder: record.createdFolder,
    entry: parseJournalEntry(record.entry),
    previousEntry: record.previousEntry === null ? null : parseJournalEntry(record.previousEntry),
    previousAssignments: record.previousAssignments.map(parseJournalAssignment),
    desiredAssignments: record.desiredAssignments.map(parseJournalAssignment),
  };
}

// Same durable-file contract as the folder-mutation journal: owner-only
// single regular file, atomic replace, strict closed parse on read.
class OnboardingJournalFile {
  private counter = 0;

  constructor(private readonly filePath: string, private readonly fs: FileSystem) {}

  async read(): Promise<PendingOnboarding | undefined> {
    try {
      const stats = await this.fs.lstat(this.filePath);
      if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) throw new Error("journal must be a single regular file");
      if ((stats.mode & 0o777) !== 0o600) throw new Error("journal permissions must be 0600");
      if (typeof process.getuid === "function" && stats.uid !== process.getuid()) throw new Error("journal is not owned by the current user");
      return parseJournal(JSON.parse(await this.fs.readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("pending onboarding journal is invalid", { cause: error });
    }
  }

  async write(record: PendingOnboarding): Promise<void> {
    const temp = `${this.filePath}.${process.pid}.${this.counter += 1}.tmp`;
    let created = false;
    try {
      const handle = await this.fs.open(temp, "wx", 0o600);
      created = true;
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.fs.rename(temp, this.filePath);
      created = false;
      await this.fs.chmod(this.filePath, 0o600);
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
    }
  }
}

function safeFsError(error: unknown, fallback: string): OnboardingError {
  if (error instanceof OnboardingError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return new OnboardingError("not-found", "folder was not found", { cause: error });
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new OnboardingError("invalid-input", "filesystem permission denied", { cause: error });
  }
  if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EBUSY") {
    return new OnboardingError("conflict", "destination conflicts with an existing filesystem entry", { cause: error });
  }
  if (code === "ENOTDIR" || code === "EISDIR") {
    return new OnboardingError("invalid-input", "path is not a directory", { cause: error });
  }
  return new OnboardingError("internal", fallback, { cause: error });
}

export class WorkspaceOnboardingCoordinator {
  private readonly fs: FileSystem;
  private readonly journal: OnboardingJournalFile;
  private readonly git: OnboardingGit;
  // Onboarding metadata transactions serialize: journal → registry →
  // assignments → clear runs to completion (or rollback) before the next
  // operation begins, so planned ids cannot be stolen mid-commit.
  private operationChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: WorkspaceOnboardingOptions) {
    this.fs = options.fs ?? nodeFs;
    this.journal = new OnboardingJournalFile(options.journalPath, this.fs);
    this.git = options.git ?? {
      probe: folder => probeGitRepository(folder, options.gitCommand?.() ?? "git"),
      init: folder => gitInit(folder, options.gitCommand?.() ?? "git"),
    };
  }

  // Registers an existing folder with a display name and credential
  // selections, committing everything before any optional start.
  async configureExisting(value: unknown): Promise<OnboardingResult> {
    const input = parseConfigureExisting(value);
    return await this.enqueue(() => this.commitExisting(input));
  }

  // Creates a new child repository under a canonical parent and registers
  // it stopped with its configuration.
  async createWorkspace(value: unknown): Promise<OnboardingResult> {
    const input = parseCreateWorkspace(value);
    return await this.enqueue(() => this.commitCreate(input));
  }

  // Clone completion path: the folder was just produced by a clone job that
  // still holds the target's path reservation, so this skips reservation
  // and the git probe and commits registration plus retained assignments.
  configureCloned(options: {
    path: string;
    displayName: string;
    authentication: AuthenticationSelection[];
    signing: string | null;
    start?: boolean;
  }): Promise<OnboardingResult> {
    return this.enqueue(async () => {
      await this.assertNoPendingOnboarding();
      const canonical = await this.canonicalDirectory(options.path);
      await this.reconcileRegisteredAliases();
      if (this.options.registry.byPath(canonical)) {
        throw new OnboardingError("conflict", `folder is already registered: ${canonical}`);
      }
      const name = displayName(options.displayName);
      return await this.commitMetadata({
        operation: "configure-existing",
        canonical,
        displayName: name,
        authentication: authenticationSelections(options.authentication),
        signing: signingSelection(options.signing),
        createdFolder: false,
        start: options.start === true,
      });
    });
  }

  // Startup recovery: a pending journal means the process died between the
  // registry and assignment commits (or before rollback finished). Compare
  // the journaled desired entry with the registry: when the registration
  // matches, complete the desired assignment set; otherwise restore the
  // recorded previous state. Created folders are never deleted here — an
  // initialized repository cannot be proven free of user content.
  recover(): Promise<void> {
    return this.enqueue(async () => {
      const pending = await this.journal.read();
      if (!pending) return;
      // Committed is recognized by immutable identity (id + path) only.
      // The display name is user-editable the moment the registry save
      // makes the entry visible, so a rename between commit and a crash
      // must not reclassify the registration as uncommitted — the newer
      // name is preserved and only the assignments are completed. The path
      // cannot drift the same way: the folder manager refuses registered
      // mutations while a recovery journal is pending.
      const current = this.options.registry.byId(pending.entry.id);
      const committed = current !== undefined
        && normalizeAbsolutePath(current.path) === pending.entry.path;
      if (committed) {
        await this.completeRecoveredAssignments(pending.entry.id, pending.desiredAssignments, pending.previousAssignments);
      } else {
        if (pending.previousEntry) {
          await this.options.registry.restoreEntries([pending.previousEntry]);
        } else if (current) {
          await this.options.registry.remove(pending.entry.id);
        }
        await this.replaceWorkspaceAssignments(pending.entry.id, pending.previousAssignments);
      }
      await this.journal.clear();
    });
  }

  // Whether a pending onboarding journal is on disk. Assignment-mutating
  // routes fence on this: recovery decides between completing and
  // preserving by comparing the current assignment set against the
  // journaled pre-commit set, and a mutation while the journal lingers
  // would make a deliberate revocation back to that set indistinguishable
  // from an unfinished commit.
  async hasPendingRecovery(): Promise<boolean> {
    try {
      await this.fs.lstat(this.options.journalPath);
      return true;
    } catch (error) {
      // Only a confirmed absence clears the fence. An uninspectable
      // journal (EACCES, I/O error) fails closed: proceeding could let a
      // later recovery overwrite the very mutation being admitted.
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationChain.then(operation, operation);
    this.operationChain = next.catch(() => undefined);
    return next;
  }

  private async commitExisting(input: ConfigureExistingInput): Promise<OnboardingResult> {
    await this.assertNoPendingOnboarding();
    const canonical = await this.canonicalDirectory(input.path);
    await this.reconcileRegisteredAliases();
    const existing = this.options.registry.byPath(canonical);
    if (existing) {
      // Idempotent short-circuit for the legacy registration adapter; the
      // dedicated configure operation maps this to a conflict before any
      // assignment work.
      return {
        entry: { ...existing },
        created: false,
        alreadyRegistered: true,
        createdFolder: false,
        started: false,
        startError: null,
      };
    }
    const reservation = this.reserve([canonical]);
    try {
      const probe = await this.git.probe(canonical);
      if (probe.kind === "not-a-repository" && !input.init) {
        throw new OnboardingError("needs-init", `${canonical} is not a git repository`);
      }
      // Credential validation happens before git init — the only filesystem
      // mutation this flow can make.
      const planned = this.planWorkspaceId(canonical);
      const desired = resolveOnboardingAssignments(planned, input, this.options.credentials.snapshot());
      if (probe.kind === "not-a-repository") {
        const initialized = await this.git.init(canonical);
        if (!initialized.ok) throw new OnboardingError("git-init", `git init failed: ${initialized.error}`);
      }
      return await this.commitPlanned({
        operation: "configure-existing",
        canonical,
        displayName: input.displayName,
        planned,
        desired,
        createdFolder: false,
        start: input.start,
      });
    } finally {
      reservation.release();
    }
  }

  private async commitCreate(input: CreateWorkspaceInput): Promise<OnboardingResult> {
    await this.assertNoPendingOnboarding();
    const parent = await this.canonicalDirectory(input.parent);
    const destination = path.join(parent, input.folderName);
    const reservation = this.reserve([destination]);
    try {
      // Reconciled like the existing-folder and clone flows: a stale
      // registration persisted through a symlinked ancestor must block its
      // canonical destination, or the new repository inherits the old
      // workspace's id and credential assignments through the alias.
      await this.reconcileRegisteredAliases();
      if (this.options.registry.byPath(destination)) {
        throw new OnboardingError("conflict", `destination is already a registered workspace: ${destination}`);
      }
      // Credential validation strictly precedes folder creation.
      const planned = this.planWorkspaceId(destination);
      const desired = resolveOnboardingAssignments(planned, input, this.options.credentials.snapshot());

      await this.assertMissing(destination);
      try {
        await this.fs.mkdir(destination);
      } catch (error) {
        throw safeFsError(error, "workspace folder creation failed");
      }

      const initialized = await this.git.init(destination);
      if (!initialized.ok) {
        // Nothing but our empty directory can exist before git init wrote
        // content; non-recursive rmdir removes it or proves it gained
        // content and must be retained.
        const cleaned = await this.fs.rmdir(destination).then(() => true, () => false);
        throw new OnboardingError("git-init", `git init failed: ${initialized.error}`, {
          retainedPath: cleaned ? undefined : destination,
        });
      }

      try {
        return await this.commitPlanned({
          operation: "create-new",
          canonical: destination,
          displayName: input.displayName,
          planned,
          desired,
          createdFolder: true,
          start: input.start,
        });
      } catch (error) {
        if (error instanceof OnboardingError && error.code === "recovery-required") throw error;
        // Metadata failed after the repository was initialized. The folder
        // now contains .git and possibly external content — retain it and
        // point retries at the Existing folder flow.
        throw new OnboardingError(
          error instanceof OnboardingError ? error.code : "internal",
          `${error instanceof Error ? error.message : String(error)}; the initialized repository was retained at ${destination} — retry through Existing folder`,
          { cause: error, retainedPath: destination },
        );
      }
    } finally {
      reservation.release();
    }
  }

  private async commitMetadata(options: {
    operation: PendingOnboarding["operation"];
    canonical: string;
    displayName: string;
    authentication: AuthenticationSelection[];
    signing: string | null;
    createdFolder: boolean;
    start: boolean;
  }): Promise<OnboardingResult> {
    const planned = this.planWorkspaceId(options.canonical);
    const desired = resolveOnboardingAssignments(
      planned,
      { authentication: options.authentication, signing: options.signing },
      this.options.credentials.snapshot(),
    );
    return await this.commitPlanned({ ...options, planned, desired });
  }

  // Legacy registries can hold alias paths; the canonical byPath and
  // planWorkspaceId lookups would miss them and mint a duplicate stable id
  // for the same repository. Flows registering existing folders reconcile
  // stored aliases first — the same shared pass the folder manager and the
  // legacy registration route run.
  private async reconcileRegisteredAliases(): Promise<void> {
    try {
      await reconcileRegisteredAliasPaths(this.options.registry, this.fs);
    } catch (error) {
      if (error instanceof FolderManagerError) {
        throw new OnboardingError(error.code === "conflict" ? "conflict" : "internal", error.message, { cause: error });
      }
      throw error;
    }
  }

  // A surviving journal is the only recovery record of an onboarding that
  // failed midway (rollback or clear failed). The journal holds one
  // record, so beginning another onboarding would replace it — and, on
  // success, clear it — leaving recovery unable to undo the earlier
  // partial registration. Sibling recovery journals (the folder-mutation
  // journal) fence for the reverse reason: creating or registering at a
  // path a pending folder removal recorded would hand its recovery an
  // unrecognized directory and abort the next startup. Mirrors
  // FolderManager.assertNoPendingMutation.
  private async assertNoPendingOnboarding(): Promise<void> {
    for (const journalPath of [this.options.journalPath, ...this.options.recoveryJournalPaths ?? []]) {
      let pending = true;
      try {
        await this.fs.lstat(journalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new OnboardingError("internal", "recovery journal inspection failed", { cause: error });
        }
        pending = false;
      }
      if (pending) {
        throw new OnboardingError("recovery-required", "a pending recovery journal requires Hub recovery before new workspace changes");
      }
    }
  }

  // The journaled two-store commit. Runs only inside the operation chain.
  private async commitPlanned(options: {
    operation: PendingOnboarding["operation"];
    canonical: string;
    displayName: string;
    planned: string;
    desired: CredentialAssignment[];
    createdFolder: boolean;
    start: boolean;
  }): Promise<OnboardingResult> {
    const entry: WorkspaceEntry = {
      id: options.planned,
      path: options.canonical,
      backend: "local",
      displayName: options.displayName,
    };
    const previousAssignments = this.options.credentials.snapshot().assignments
      .filter(assignment => assignment.workspaceId === options.planned);
    const pending: PendingOnboarding = {
      version: JOURNAL_VERSION,
      operation: options.operation,
      createdFolder: options.createdFolder,
      entry,
      previousEntry: null,
      previousAssignments,
      desiredAssignments: options.desired,
    };
    // The whole two-store commit — and a requested first start — runs
    // inside the workspace's session lifecycle queue. The registry save
    // makes the id visible to /api/hub/state and the workspace routes
    // mid-commit; without this section a concurrent start could run before
    // the assignment commit and project the old (empty) assignment set
    // into the new session, and a forget observed mid-commit could slip
    // between the commit and the requested start. Queued here, both
    // execute only after this whole section.
    let started = false;
    let startError: string | null = null;
    await this.options.sessions.runExclusive(options.planned, async () => {
      try {
        await this.journal.write(pending);
      } catch (error) {
        // A Hub-owned state write, not a folder-path problem: EACCES here
        // is a retryable server failure, never a request correction.
        throw new OnboardingError("internal", "onboarding journal write failed", { cause: error });
      }

      let registered: WorkspaceEntry;
      try {
        const result = await this.options.registry.registerWithStatus(options.canonical, "local", options.displayName);
        registered = result.entry;
        if (!result.created || registered.id !== options.planned) {
          // The planned id was taken between planning and commit — impossible
          // while every registration path flows through this chain, so treat
          // it as an internal invariant break and undo the registration.
          if (result.created) await this.options.registry.remove(registered.id);
          throw new OnboardingError("internal", `workspace id changed during onboarding commit: ${registered.id}`);
        }
      } catch (error) {
        // The registry rolls its own failed mutation back; only the journal
        // needs clearing. Registry persistence is a Hub-owned state write —
        // classified internal, like the journal above. A clear that itself
        // fails leaves every fenced mutation rejected until recovery, and
        // the response must say so rather than report only the
        // registration failure.
        const original = error instanceof OnboardingError ? error : new OnboardingError("internal", "workspace registration failed", { cause: error });
        try {
          await this.journal.clear();
        } catch (clearError) {
          throw new OnboardingError("recovery-required", "workspace onboarding failed and its journal could not be cleared; restart the Hub to reconcile", {
            cause: new AggregateError([original, clearError]),
          });
        }
        throw original;
      }

      try {
        await this.commitDesiredAssignments(entry.id, options.desired);
      } catch (error) {
        try {
          await this.options.registry.remove(entry.id);
          await this.replaceWorkspaceAssignments(entry.id, previousAssignments);
          await this.journal.clear();
        } catch (rollbackError) {
          throw new OnboardingError("recovery-required", "workspace onboarding failed and requires Hub recovery", {
            cause: new AggregateError([error, rollbackError]),
          });
        }
        throw new OnboardingError("credential", `credential assignment failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }

      try {
        await this.journal.clear();
      } catch (error) {
        // Both stores committed; recovery would simply confirm the desired
        // state, but an uncleaned journal must still be surfaced. The
        // committed entry travels with the error so callers (the clone
        // job) can report the preserved workspace.
        throw new OnboardingError("recovery-required", "workspace onboarding committed but its journal could not be cleared; restart the Hub to reconcile", { cause: error, committedEntry: { ...entry } });
      }

      if (options.start) {
        try {
          await this.options.sessions.startWhileLifecycleQueueHeld(entry.id);
          started = true;
        } catch (error) {
          // The configuration committed; a failed explicitly-requested
          // start preserves the stopped workspace and reports the error.
          startError = error instanceof Error ? error.message : String(error);
        }
      }
    });

    return {
      entry: { ...entry },
      created: true,
      alreadyRegistered: false,
      createdFolder: options.createdFolder,
      started,
      startError,
    };
  }

  // Commits the desired set, re-running the full selection rules against
  // the transaction draft. The set was resolved from a pre-commit snapshot,
  // and a concurrent credential mutation (delete, disable, capability or
  // host edit) can land in between; the store's own validation only rejects
  // dangling ids. A drifted selection throws inside the serialized
  // transaction, so nothing commits and the caller's normal credential
  // rollback path undoes the registration. Rollback keeps using
  // replaceWorkspaceAssignments — a restored previous state must never be
  // re-judged against newer credential rules.
  private async commitDesiredAssignments(workspaceId: string, desired: CredentialAssignment[]): Promise<void> {
    if (desired.length === 0) {
      await this.replaceWorkspaceAssignments(workspaceId, desired);
      return;
    }
    const selections = selectionsFromAssignments(desired);
    await this.options.credentials.transaction(draft => {
      resolveOnboardingAssignments(workspaceId, selections, draft);
      draft.assignments = draft.assignments.filter(assignment => assignment.workspaceId !== workspaceId);
      draft.assignments.push(...structuredClone(desired));
    });
  }

  // Completing a committed onboarding replays the journaled desired set —
  // unless state moved on while the journal lingered (its clear failed and
  // the hub kept serving until this restart). Two drift signals defer to
  // the newer state: the workspace's current assignments no longer match
  // the recorded pre-commit set (the desired set, or a later user choice,
  // already landed — replaying would undo a revocation or replacement),
  // or the desired set no longer resolves against the current store (a
  // credential was deleted or disabled after commit). Only the recorded
  // pre-commit state with a still-valid desired set is completed.
  private async completeRecoveredAssignments(
    workspaceId: string,
    desired: CredentialAssignment[],
    previous: CredentialAssignment[],
  ): Promise<void> {
    const current = this.options.credentials.snapshot().assignments
      .filter(assignment => assignment.workspaceId === workspaceId);
    if (!sameAssignmentSet(current, previous)) return;
    if (desired.length > 0) {
      try {
        resolveOnboardingAssignments(workspaceId, selectionsFromAssignments(desired), this.options.credentials.snapshot());
      } catch {
        return;
      }
    }
    await this.replaceWorkspaceAssignments(workspaceId, desired);
  }

  private async replaceWorkspaceAssignments(workspaceId: string, assignments: CredentialAssignment[]): Promise<void> {
    const current = this.options.credentials.snapshot().assignments
      .filter(assignment => assignment.workspaceId === workspaceId);
    if (sameAssignmentSet(current, assignments)) return;
    await this.options.credentials.transaction(draft => {
      draft.assignments = draft.assignments.filter(assignment => assignment.workspaceId !== workspaceId);
      draft.assignments.push(...structuredClone(assignments));
    });
  }

  private planWorkspaceId(canonical: string): string {
    const base = workspaceSlug(canonical);
    let id = base;
    let suffix = 2;
    while (this.options.registry.byId(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    return id;
  }

  private reserve(paths: readonly string[]) {
    const reservation = this.options.reservations.acquire(paths);
    if (!reservation) throw new OnboardingError("conflict", "folder path is reserved by another operation");
    return reservation;
  }

  private async canonicalDirectory(folderPath: string): Promise<string> {
    const normalized = absolutePath(folderPath, "path");
    let stats;
    try {
      stats = await this.fs.lstat(normalized);
    } catch (error) {
      throw safeFsError(error, "folder inspection failed");
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw invalid("path must name a direct non-symbolic-link directory");
    }
    try {
      return normalizeAbsolutePath(await this.fs.realpath(normalized));
    } catch (error) {
      throw safeFsError(error, "folder inspection failed");
    }
  }

  private async assertMissing(candidate: string): Promise<void> {
    try {
      await this.fs.lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw safeFsError(error, "destination inspection failed");
    }
    throw new OnboardingError("conflict", "destination already exists");
  }
}
