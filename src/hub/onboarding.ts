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
    options?: ErrorOptions & { retainedPath?: string },
  ) {
    super(message, options);
    this.name = "OnboardingError";
    this.retainedPath = options?.retainedPath;
  }

  // Set when a created repository outlives a failed onboarding: the folder
  // was initialized, cannot be proven free of user content, and is retained
  // for retry through the Existing folder flow.
  readonly retainedPath: string | undefined;
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

type OnboardingRegistry = Pick<WorkspaceRegistry, "byId" | "byPath" | "registerWithStatus" | "remove" | "restoreEntries">;
type OnboardingCredentials = Pick<CredentialMetadataStore, "snapshot" | "transaction">;
type OnboardingSessions = Pick<SessionManager, "start" | "runExclusive">;

export type OnboardingGit = {
  probe(folder: string): Promise<GitProbeResult>;
  init(folder: string): Promise<{ ok: true } | { ok: false; error: string }>;
};

export type WorkspaceOnboardingOptions = {
  journalPath: string;
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
    const committed = await this.enqueue(() => this.commitExisting(input));
    if (committed.alreadyRegistered || !input.start) return committed;
    return await this.startCommitted(committed);
  }

  // Creates a new child repository under a canonical parent and registers
  // it stopped with its configuration.
  async createWorkspace(value: unknown): Promise<OnboardingResult> {
    const input = parseCreateWorkspace(value);
    const committed = await this.enqueue(() => this.commitCreate(input));
    if (!input.start) return committed;
    return await this.startCommitted(committed);
  }

  // Clone completion path: the folder was just produced by a clone job that
  // still holds the target's path reservation, so this skips reservation
  // and the git probe and commits registration plus retained assignments.
  configureCloned(options: {
    path: string;
    displayName: string;
    authentication: AuthenticationSelection[];
    signing: string | null;
  }): Promise<OnboardingResult> {
    return this.enqueue(async () => {
      const canonical = await this.canonicalDirectory(options.path);
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
      const current = this.options.registry.byId(pending.entry.id);
      const committed = current !== undefined
        && normalizeAbsolutePath(current.path) === pending.entry.path
        && current.displayName === pending.entry.displayName;
      if (committed) {
        await this.replaceWorkspaceAssignments(pending.entry.id, pending.desiredAssignments);
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

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationChain.then(operation, operation);
    this.operationChain = next.catch(() => undefined);
    return next;
  }

  private async startCommitted(committed: OnboardingResult): Promise<OnboardingResult> {
    try {
      await this.options.sessions.start(committed.entry.id);
      return { ...committed, started: true };
    } catch (error) {
      // The configuration committed; a failed explicitly-requested start
      // preserves the stopped workspace and reports the error.
      return { ...committed, started: false, startError: error instanceof Error ? error.message : String(error) };
    }
  }

  private async commitExisting(input: ConfigureExistingInput): Promise<OnboardingResult> {
    const canonical = await this.canonicalDirectory(input.path);
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
      });
    } finally {
      reservation.release();
    }
  }

  private async commitCreate(input: CreateWorkspaceInput): Promise<OnboardingResult> {
    const parent = await this.canonicalDirectory(input.parent);
    const destination = path.join(parent, input.folderName);
    const reservation = this.reserve([destination]);
    try {
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
  }): Promise<OnboardingResult> {
    const planned = this.planWorkspaceId(options.canonical);
    const desired = resolveOnboardingAssignments(
      planned,
      { authentication: options.authentication, signing: options.signing },
      this.options.credentials.snapshot(),
    );
    return await this.commitPlanned({ ...options, planned, desired });
  }

  // The journaled two-store commit. Runs only inside the operation chain.
  private async commitPlanned(options: {
    operation: PendingOnboarding["operation"];
    canonical: string;
    displayName: string;
    planned: string;
    desired: CredentialAssignment[];
    createdFolder: boolean;
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
    // The whole two-store commit runs inside the workspace's session
    // lifecycle queue. The registry save makes the id visible to
    // /api/hub/state and the start route mid-commit; without this section a
    // concurrent start could run before the assignment commit and project
    // the old (empty) assignment set into the new session. Queued here, that
    // start executes only after both stores committed.
    await this.options.sessions.runExclusive(options.planned, async () => {
      try {
        await this.journal.write(pending);
      } catch (error) {
        throw safeFsError(error, "onboarding journal write failed");
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
        // needs clearing.
        await this.journal.clear().catch(() => undefined);
        throw error instanceof OnboardingError ? error : safeFsError(error, "workspace registration failed");
      }

      try {
        await this.replaceWorkspaceAssignments(entry.id, options.desired);
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
        // state, but an uncleaned journal must still be surfaced.
        throw new OnboardingError("recovery-required", "workspace onboarding committed but its journal could not be cleared; restart the Hub to reconcile", { cause: error });
      }
    });

    return {
      entry: { ...entry },
      created: true,
      alreadyRegistered: false,
      createdFolder: options.createdFolder,
      started: false,
      startError: null,
    };
  }

  private async replaceWorkspaceAssignments(workspaceId: string, assignments: CredentialAssignment[]): Promise<void> {
    const current = this.options.credentials.snapshot().assignments
      .filter(assignment => assignment.workspaceId === workspaceId);
    const unchanged = current.length === assignments.length
      && assignments.every(assignment => current.some(existing => JSON.stringify(existing) === JSON.stringify(assignment)));
    if (unchanged) return;
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
