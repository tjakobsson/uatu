/**
 * Transport-independent mobile Hub seam. Implementations supply data/effects,
 * never markup, navigation, form drafts, or a second workspace state owner.
 * This is NOT a new public wire API. All server-domain dependencies erase.
 *
 * Reads have no start/stop side effects. Navigation/unsubscription is not
 * cancellation. Secrets are write-only, must not enter logs/replay, and are
 * cleared by the submitting frontend after each attempt. Adapters validate
 * untrusted responses; these types are not runtime validation or authorization.
 */
import type {
  CredentialAssignment, CredentialRecord, CredentialTool, PublicCredentialDto,
  PublicToolReadinessDto, ReadinessResult, SshCredentialRecord,
} from "../credential-types";
import type { WorkspaceEntry } from "../registry";
import type { TerminalSessionInfo } from "../../terminal/server";
import type { CloneJobEvent, CloneJobPhase, CloneJobResult } from "../clone-jobs";
import type {
  AuthenticationSelection, ConfigureExistingInput, CreateWorkspaceInput,
  OnboardingErrorCode, OnboardingResult,
} from "../onboarding";
import type {
  CreateFolderInput, CreateFolderResult, RenameFolderInput, RenameFolderResult,
  RemoveFolderInput, RemoveFolderResult,
} from "../folder-manager";
import type { SessionsStoppedResult } from "../sessions";
import type { DefaultWorkspaceParentState } from "../preferences";
import type { CreateTokenCredential } from "../token-credentials";
import type { HubSessionRecord } from "../auth";

export type BranchState =
  | { kind: "named"; name: string; commit?: never }
  | { kind: "detached"; commit: string; name?: never }
  | { kind: "unborn"; name: string; commit?: never }
  | { kind: "non-git"; name?: never; commit?: never }
  | { kind: "loading"; name?: never; commit?: never }
  | { kind: "unavailable"; message: string; name?: never; commit?: never };

/** Sanitized, contextual diagnostics only; never raw tool output or secrets. */
export type BackendProblem =
  | { kind: "invalid-input" | "conflict" | "not-found" | "unavailable" | "forbidden"; message: string }
  | { kind: "unauthorized"; message: string }
  | { kind: "rate-limited"; message: string; retryAfterSeconds: number };

/** A disconnected mutation is NOT proof it failed. Reconcile before retrying. */
export type OperationResult<T> =
  | { status: "completed"; value: T; problem?: never }
  | { status: "rejected"; problem: BackendProblem; value?: never }
  | { status: "indeterminate"; message: string; value?: never; problem?: never };

export type ReadResult<T> =
  | { status: "available"; value: T }
  | { status: "unavailable"; problem: BackendProblem; value?: never };

/** Owned by the view; stale data never becomes authoritative running status. */
export type LoadState<T> =
  | { status: "loading"; previous?: T }
  | { status: "ready"; value: T }
  | { status: "unavailable"; problem: BackendProblem; previous?: T };

export type WorkspaceRuntime =
  | { status: "running"; shells: LoadState<Array<Pick<TerminalSessionInfo, "attached" | "label">>> }
  | { status: "stopped"; shells?: never };

export type WorkspaceView = WorkspaceEntry & {
  runtime: WorkspaceRuntime;
  branch: BranchState;
  credentialRestartRequired: boolean;
  // Assignment presence is neither readiness nor a security boundary.
  assignments: CredentialAssignment[];
  workspaceApiRevision: number;
};

export type HubIdentity = { user: string; host: string; version: string };
export type AuthenticationState =
  | { status: "authenticated"; identity: HubIdentity }
  | { status: "signed-out"; identity?: never };

/** Public device handle, never the bearer/cookie session secret. Time is issued, not last-active. */
export type DeviceView = Pick<HubSessionRecord, "deviceLabel" | "issuedAt"> & { handle: string; current: boolean };
export type CredentialView<T extends CredentialRecord["type"]> = Extract<PublicCredentialDto, { type: T }>;
export type CredentialTarget<T extends CredentialRecord["type"] = CredentialRecord["type"]> = {
  id: string; type: T;
};
export type KeyTarget = CredentialTarget<"ssh" | "openpgp">;
export type PublicKeyView = { id: string; type: "ssh" | "openpgp"; publicKey: string; fingerprint: string };

/** Frontend-only facts, not additions to the public credential/tool wire DTOs.
 * Unknown must never be inferred from diagnostic prose, a name or effective path. */
export type KnownFact<T> = { status: "known"; value: T } | { status: "unknown"; value?: never };
export type NotApplicableFact = { status: "not-applicable"; value?: never };
export type CredentialFacts =
  | { id: string; type: "ssh"; protection: KnownFact<"protected" | "unprotected">;
      lock: KnownFact<"locked" | "unlocked">; userId: NotApplicableFact }
  | { id: string; type: "openpgp"; protection: KnownFact<"protected" | "unprotected">;
      lock: KnownFact<"locked" | "unlocked">; userId: KnownFact<string> }
  | { id: string; type: "token"; protection: NotApplicableFact; lock: NotApplicableFact;
      userId: NotApplicableFact };
export type ToolConfiguration = { tool: CredentialTool; savedOverride: KnownFact<string | null> };

/** Exactly one source. Check the 1 MiB size limit BEFORE reading a File. */
export type PrivateKeySource =
  | { kind: "file"; file: File; text?: never }
  | { kind: "paste"; text: string; file?: never };
export type GenerateSshIntent = {
  name: string; capabilities: SshCredentialRecord["capabilities"]; passphrase: string;
};
export type ImportSshIntent = GenerateSshIntent & { source: PrivateKeySource };
export type GenerateOpenPgpIntent = { name: string; userId: string; passphrase: string };
export type ImportOpenPgpIntent = { name: string; source: PrivateKeySource };

/** Only explicit confirmation permits the adapter to stop dependent sessions first. */
export type StopConsent = "ask" | "stop-dependent-workspaces";
export type CoordinatedResult<T> = SessionsStoppedResult<T>;
export type AssignmentSelection =
  | { authentication: AuthenticationSelection; signing?: { credentialId: string } }
  | { authentication?: AuthenticationSelection; signing: { credentialId: string } };
/** Unselected roles are unchanged, not removed. Removal is a separate operation. */
export type AssignWorkspaceIntent = {
  workspaceId: string;
  mode: "edit-current" | "assign-new";
  selection: AssignmentSelection;
};
export type RemoveAssignmentIntent = { assignment: CredentialAssignment; stop: StopConsent };

export type StartWorkspaceIntent = {
  workspaceId: string;
  // UI confirmation only; adapter still validates actual assignments/readiness.
  unassigned: "not-confirmed" | "confirmed-without-credentials";
};
export type StartWorkspaceResult =
  | { status: "running"; workspaceId: string }
  | { status: "confirm-unassigned"; workspaceId: string }
  | { status: "requires-unlock"; credentials: [KeyTarget, ...KeyTarget[]] };

/** Refine the legacy booleans without losing its registration/creation facts. */
export type ConfiguredWorkspaceResult =
  | (OnboardingResult & {
      created: false; alreadyRegistered: true; createdFolder: false;
      started: false; startError: null;
    })
  | (OnboardingResult & { created: true; alreadyRegistered: false } & (
      | { started: true; startError: null }
      | { started: false; startError: string | null }
    ));
export type OnboardingOutcome =
  | { status: "configured"; result: ConfiguredWorkspaceResult }
  | { status: "failed"; code: OnboardingErrorCode; message: string;
      retainedPath?: string; committedEntry?: WorkspaceEntry };
/** New-workspace creation initializes Git; submission requires explicit consent. */
export type CreateNewWorkspaceIntent = CreateWorkspaceInput & { gitInitConsent: "confirmed" };

export type FolderRegistration =
  | { status: "unregistered"; workspace?: never; runtime?: never }
  | { status: "registered"; workspace: WorkspaceEntry; runtime: WorkspaceRuntime };
export type FolderListing = {
  path: string;
  parent: string | null;
  directories: Array<{ name: string; git: boolean; registration: FolderRegistration }>;
};

/** Clone identity does not implicitly become a retained workspace assignment. */
export type CloneIntent = {
  url: string;
  dest: string;
  folderName: string;
  displayName: string;
  credentialId: string | null;
  retainedAuthentication: AuthenticationSelection[];
  signing: string | null;
  start: boolean;
};
/** Mint once before submitting, retain across unknown acceptance/reload, never
 * derive from URL/credentials. One authenticated context owns the attempt.
 * Reusing an accepted id returns its original job, never new work. */
export type CloneSubmissionIntent = CloneIntent & { attemptId: string };
export type CloneAttemptState =
  | { status: "accepted"; jobId: string }
  | { status: "pending"; jobId?: never }
  | { status: "not-accepted"; jobId?: never }
  | { status: "expired"; jobId?: never };
/** not-accepted is authoritative AND fenced: that id can never later start work.
 * Only that result (or a definitive rejection/requires-unlock response) permits
 * a newly authorized attempt with a NEW id. Pending/expired/unavailable never
 * authorize blind resubmission. Read unavailability is not not-accepted. */
export type CloneSubmission =
  | { status: "accepted"; jobId: string }
  | { status: "requires-unlock"; credential: KeyTarget };
/** Cancellation acknowledgement is not the terminal job event. A job may have won the race. */
export type CloneCancellation =
  | { status: "cancelled" | "terminal" }
  | { status: "cleanup-failed"; message: string };
/** Retain the authoritative domain result, including partial checkout/registration outcomes. */
export type CloneProgress =
  | { status: "running"; phase: CloneJobPhase; result?: never }
  | { status: "finished"; result: CloneJobResult; phase?: never };
export type CloneStreamEvent =
  | { type: "job-event"; event: CloneJobEvent }
  | { type: "disconnected"; message: string }
  | { type: "unavailable"; reason: "not-found-or-expired" | "unauthorized"; message: string };

/** Monotonic adapter generations. Reject older completions before revealing retained content. */
export type Invalidation =
  | { scope: "authentication"; generation: number;
      reason: "unauthorized" | "current-session-revoked" | "signed-out" }
  | { scope: "workspace"; workspaceId: string; generation: number;
      reason: "stopped" | "removed" }
  | { scope: "catalog"; generation: number;
      resource: "workspaces" | "credentials" | "tools" | "devices" | "default-folder" };
export type Unsubscribe = () => void;

/**
 * Named operations, not a dispatch(action, payload) escape hatch. Unexpected
 * calls must fail closed. Expected errors use typed results; programming errors
 * may reject. Awaiting a promise models pending acceptance, not job completion.
 *
 * A view captures auth/workspace generations before each call and discards stale
 * completions after invalidation. Stop-dependent operations must stop BEFORE
 * catalog mutation; failed stop leaves that catalog unchanged (some sessions
 * may already have stopped). Re-read status after partial/indeterminate effects.
 *
 * Navigation preferences/shared-UID dismissal remain browser-owned through their
 * existing owners, NOT server effects. Workspace HTTP/SSE/WS protocols remain
 * with the existing surface clients, not this Hub management interface.
 */
export interface MobileHubBackend {
  readAuthentication(): Promise<ReadResult<AuthenticationState>>;
  signIn(intent: { user: string; password: string; deviceLabel?: string }): Promise<OperationResult<HubIdentity>>;
  signOut(): Promise<OperationResult<{ status: "signed-out" }>>;
  readWorkspaces(): Promise<ReadResult<WorkspaceView[]>>;
  readWorkspace(workspaceId: string): Promise<ReadResult<WorkspaceView>>;
  readCredentials(): Promise<ReadResult<PublicCredentialDto[]>>;
  readCredentialFacts(target: CredentialTarget): Promise<ReadResult<CredentialFacts>>;
  readTools(): Promise<ReadResult<PublicToolReadinessDto[]>>;
  readToolConfiguration(tool: CredentialTool): Promise<ReadResult<ToolConfiguration>>;
  readDevices(): Promise<ReadResult<DeviceView[]>>;
  revokeDevice(handle: string): Promise<OperationResult<{ status: "revoked"; current: boolean }>>;
  readDefaultFolder(): Promise<ReadResult<DefaultWorkspaceParentState>>;
  setDefaultFolder(path: string | null): Promise<OperationResult<DefaultWorkspaceParentState>>;

  startWorkspace(intent: StartWorkspaceIntent): Promise<OperationResult<StartWorkspaceResult>>;
  stopWorkspace(workspaceId: string): Promise<OperationResult<{ status: "stopped" | "already-stopped" }>>;
  renameWorkspace(intent: { workspaceId: string; displayName: string }): Promise<OperationResult<WorkspaceEntry>>;
  // Forget removes registration/personal state, never files; a running workspace must stop separately.
  forgetWorkspace(workspaceId: string): Promise<OperationResult<{ status: "forgotten" | "not-found" }>>;
  assignWorkspace(intent: AssignWorkspaceIntent): Promise<OperationResult<CredentialAssignment[]>>;
  assignCredential(intent: { assignment: CredentialAssignment; replace: boolean }): Promise<OperationResult<CredentialAssignment>>;
  removeAssignment(intent: RemoveAssignmentIntent): Promise<OperationResult<CoordinatedResult<{ removed: boolean }>>>;

  generateSsh(intent: GenerateSshIntent): Promise<OperationResult<CredentialView<"ssh">>>;
  importSsh(intent: ImportSshIntent): Promise<OperationResult<CredentialView<"ssh">>>;
  generateOpenPgp(intent: GenerateOpenPgpIntent): Promise<OperationResult<CredentialView<"openpgp">>>;
  importOpenPgp(intent: ImportOpenPgpIntent): Promise<OperationResult<CredentialView<"openpgp">>>;
  createToken(intent: CreateTokenCredential): Promise<OperationResult<CredentialView<"token">>>;
  readPublicKey(target: KeyTarget): Promise<ReadResult<PublicKeyView>>;
  // Unlock alone never starts a workspace or creates a clone job. Only an
  // already-authorized frontend continuation may resume the original intent.
  unlockCredential(intent: { target: KeyTarget; passphrase: string }): Promise<OperationResult<CredentialView<"ssh" | "openpgp">>>;
  lockSsh(target: CredentialTarget<"ssh">): Promise<OperationResult<CredentialView<"ssh">>>;
  enableCredential(target: CredentialTarget): Promise<OperationResult<PublicCredentialDto>>;
  disableCredential(intent: { target: CredentialTarget; stop: StopConsent }): Promise<OperationResult<CoordinatedResult<PublicCredentialDto>>>;
  deleteCredential(intent: { target: CredentialTarget; confirm: true; unassign: boolean; stop: StopConsent }): Promise<OperationResult<CoordinatedResult<{ deleted: boolean }>>>;
  testCredential(target: CredentialTarget): Promise<OperationResult<ReadinessResult[]>>;
  setToolOverride(intent: { tool: CredentialTool; path: string | null }): Promise<OperationResult<PublicToolReadinessDto>>;
  testTool(tool: CredentialTool): Promise<OperationResult<PublicToolReadinessDto>>;

  browseFolders(path?: string): Promise<ReadResult<FolderListing>>;
  configureExisting(intent: ConfigureExistingInput): Promise<OperationResult<OnboardingOutcome>>;
  createWorkspace(intent: CreateNewWorkspaceIntent): Promise<OperationResult<OnboardingOutcome>>;
  createFolder(intent: CreateFolderInput): Promise<OperationResult<CreateFolderResult>>;
  renameFolder(intent: Omit<RenameFolderInput, "stop"> & { stop: StopConsent }): Promise<OperationResult<CoordinatedResult<RenameFolderResult>>>;
  removeEmptyFolder(intent: Omit<RemoveFolderInput, "stop"> & { stop: StopConsent }): Promise<OperationResult<CoordinatedResult<RemoveFolderResult>>>;

  submitClone(intent: CloneSubmissionIntent): Promise<OperationResult<CloneSubmission>>;
  reconcileCloneAttempt(intent: { attemptId: string }): Promise<ReadResult<CloneAttemptState>>;
  // Reconnect to an accepted job; never submit a replacement to discover its state.
  subscribeClone(intent: { jobId: string; afterEventId: number }, listener: (event: CloneStreamEvent) => void): Unsubscribe;
  // All input is secret, regardless of what a remote prompt appears to request.
  sendCloneInput(intent: { jobId: string; input: string }): Promise<OperationResult<{ status: "accepted" }>>;
  cancelClone(jobId: string): Promise<OperationResult<CloneCancellation>>;
  subscribeInvalidation(listener: (event: Invalidation) => void): Unsubscribe;
}
