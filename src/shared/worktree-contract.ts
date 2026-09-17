// The worktree operation contract — one wire shape shared by the Hub
// worktree service (src/hub/worktree-*.ts), the workspace picker
// (src/shell/worktree-picker.ts + hub-nav.ts), the Hub's own pages
// (src/hub/worktree-pages.ts), and the later agent-invoked CLI. Presentation
// lives in those callers; this module is the transport shape, its bounded
// phase vocabulary, the ownership/identity rules, and the sanitized error
// contract. See openspec/changes/add-git-worktree-workspaces/design.md §2–§6.
//
// Pure module: no DOM, no Bun, no Node imports. Every side imports it.
//
// Three identities stay distinct, deliberately (design §2):
//   repositoryId  canonical common-directory identity — what groups a main
//                 checkout and its linked trees, and what operations
//                 serialize on. Never a display name or a path prefix.
//   checkoutId    canonical identity of one checkout inside that repository.
//                 Ownership is decided by comparing THIS, never a path: a
//                 reused path must not inherit an older record's ownership.
//   workspaceId   the Hub registration, present only once registered. A
//                 checkout can exist with no workspace (registration failed
//                 and the tree was retained) and a registration can exist
//                 with no checkout (the path went missing).
//
// Provenance (`uatu` ownership) is durable and independent of registration:
// forgetting a workspace keeps it, re-registering the same verified tree
// recovers it, and a path reused by another tree never acquires it.

import { validWorktreeBranch } from "./worktree-branches";

export const WORKTREE_OWNERSHIPS = ["main", "uatu", "external", "uncertain"] as const;
export type WorktreeOwnership = (typeof WORKTREE_OWNERSHIPS)[number];

// "present" is the ordinary case; "missing" is a registered path that is not
// there; "replaced" is a path occupied by a checkout that is not the one the
// registration names. Neither of the latter two is ever repaired silently.
export const WORKTREE_AVAILABILITIES = ["present", "missing", "replaced"] as const;
export type WorktreeAvailability = (typeof WORKTREE_AVAILABILITIES)[number];

export type WorktreeIdentity = {
  readonly repositoryId: string;
  readonly checkoutId: string;
};

export type WorktreeCheckout = {
  readonly checkoutId: string;
  readonly repositoryId: string;
  // Absent until the checkout is registered as a Hub workspace.
  readonly workspaceId?: string;
  // The registered main workspace this checkout belongs to, when known.
  readonly parentWorkspaceId?: string;
  readonly path: string;
  // The exact local branch, slashes included — it is also the child's
  // display name. `null` for a detached or unreadable HEAD, which the UI
  // states explicitly rather than guessing `main`.
  readonly branch: string | null;
  readonly detached: boolean;
  readonly main: boolean;
  readonly ownership: WorktreeOwnership;
  readonly availability: WorktreeAvailability;
  readonly registered: boolean;
  readonly running: boolean;
  readonly locked: boolean;
  // Immutable branch-creation snapshot (design §3). NOT the upstream, NOT
  // the checkout's starting revision, and never inferred from either.
  readonly sourceRef?: string;
  readonly upstream?: string;
  // Short revision the checkout started at — diagnostics, not provenance.
  readonly head?: string;
};

export const WORKTREE_INVENTORY_STATUSES = ["ready", "loading", "error"] as const;
export type WorktreeInventoryStatus = (typeof WORKTREE_INVENTORY_STATUSES)[number];

export type WorktreeRefs = {
  readonly local: readonly string[];
  // Remote-qualified, e.g. "origin/release".
  readonly remote: readonly string[];
  // Unix epoch milliseconds of the last successful fetch, or null when the
  // listing is cached from repository state alone. Cached refs are never
  // described as network-fresh.
  readonly fetchedAt: number | null;
};

// The repositoryId an inventory carries when the repository could not be
// identified at all — a Git probe that failed, a workspace that is not a
// repository. It is a reserved word, not a digest, so it can never collide
// with a real canonical identity; it is legal ONLY on an explicitly stale
// `status: "error"` listing with no checkouts, which is what keeps "we do
// not know which repository this is" from being read as a repository.
export const WORKTREE_UNKNOWN_REPOSITORY = "unknown";

export function isWorktreeIdentityUnknown(repositoryId: string): boolean {
  return repositoryId === WORKTREE_UNKNOWN_REPOSITORY;
}

export type WorktreeInventory = {
  readonly repositoryId: string;
  readonly sourceWorkspaceId: string;
  readonly status: WorktreeInventoryStatus;
  readonly checkouts: readonly WorktreeCheckout[];
  readonly refs: WorktreeRefs;
  // Set when status is "error": the listing shown is explicitly stale.
  readonly error?: WorktreeError;
};

export const WORKTREE_OPERATION_KINDS = ["create", "register", "start", "fetch", "refresh", "delete", "forget"] as const;
export type WorktreeOperationKind = (typeof WORKTREE_OPERATION_KINDS)[number];

export const WORKTREE_CREATE_MODES = ["new-branch", "existing-local", "remote-tracking"] as const;
export type WorktreeCreateMode = (typeof WORKTREE_CREATE_MODES)[number];

export type WorktreeRefSelection = {
  readonly kind: "local" | "remote";
  // The exact committed ref. An edited combobox commits no selection at all
  // rather than a near match, so this is never a substitution.
  readonly ref: string;
};

export type WorktreeCreateRequest = {
  readonly sourceWorkspaceId: string;
  readonly mode: WorktreeCreateMode;
  // The target local branch. Required for "new-branch"; for the other two
  // modes the service derives it (existing local ref, or the remote ref
  // minus its remote prefix) and rejects a mismatching client guess.
  readonly branch?: string;
  readonly base: WorktreeRefSelection;
  // Stopped by default; an explicit start is post-commit intent whose
  // failure leaves the configured workspace stopped.
  readonly start?: boolean;
};

// Deletion and forgetting are addressed by the CHECKOUT, not by a path: a
// path reused by another tree must never be deletable through an older
// reference. `reference` is a registered workspace id or a canonical
// checkout id — a retained, unregistered checkout has only the latter.
export type WorktreeDeleteRequest = {
  readonly sourceWorkspaceId: string;
  readonly reference: string;
  // The destructive button IS the authorization. `stop` additionally
  // authorizes stopping the KNOWN Uatu activity the dialog named; it never
  // claims Uatu can stop an external application.
  readonly stop?: boolean;
};

export type WorktreeForgetRequest = {
  readonly sourceWorkspaceId: string;
  readonly reference: string;
  // Authorizes stopping the workspace's Uatu sessions first; without it a
  // running workspace is refused. Unregistration only ever happens stopped.
  readonly stop?: boolean;
};

// What preflight found. `ok: false` carries the ONE blocker that replaces
// the dialog's normal consequences; there is no force path past it.
export type WorktreeDeletionPreflight =
  | {
    readonly ok: true;
    readonly checkout: WorktreeCheckout;
    // Whether proceeding needs the caller's explicit stop authorization.
    readonly requiresStop: boolean;
  }
  | { readonly ok: false; readonly checkout?: WorktreeCheckout; readonly error: WorktreeError };

// Bounded, ordered, and never re-entered. A phase names the last boundary an
// operation provably passed, which is what restart recovery reconciles
// against actual Git state — it is not a progress percentage.
export const WORKTREE_CREATE_PHASES = [
  "validating",
  "reserving",
  "creating",
  "verifying",
  "registering",
  "assigning",
  "starting",
  "complete",
] as const;
export type WorktreeCreatePhase = (typeof WORKTREE_CREATE_PHASES)[number];

export const WORKTREE_DELETE_PHASES = [
  "preflight",
  "fencing",
  "stopping",
  "rechecking",
  "removing",
  "unregistering",
  "complete",
] as const;
export type WorktreeDeletePhase = (typeof WORKTREE_DELETE_PHASES)[number];

export type WorktreePhase = WorktreeCreatePhase | WorktreeDeletePhase;

const PHASES: Record<"create" | "delete", readonly WorktreePhase[]> = {
  create: WORKTREE_CREATE_PHASES,
  delete: WORKTREE_DELETE_PHASES,
};

export type WorktreePhasedOperation = keyof typeof PHASES;

export function worktreePhases(operation: WorktreePhasedOperation): readonly WorktreePhase[] {
  return PHASES[operation];
}

export function isWorktreePhase(operation: WorktreePhasedOperation, value: unknown): value is WorktreePhase {
  return typeof value === "string" && (PHASES[operation] as readonly string[]).includes(value);
}

// Phases only ever move forward, one recorded boundary at a time or further.
// A backward or unknown transition is a bug or a tampered journal, and the
// caller must refuse it rather than replay a mutation it already performed.
export function canAdvanceWorktreePhase(
  operation: WorktreePhasedOperation,
  from: WorktreePhase,
  to: WorktreePhase,
): boolean {
  const order = PHASES[operation];
  const start = order.indexOf(from);
  const end = order.indexOf(to);
  return start >= 0 && end > start;
}

export function isTerminalWorktreePhase(operation: WorktreePhasedOperation, phase: WorktreePhase): boolean {
  const order = PHASES[operation];
  return order.indexOf(phase) === order.length - 1;
}

// Every refusal the UI and the CLI can receive. The set is closed: a caller
// that cannot map a code refuses rather than inventing a recovery.
export const WORKTREE_ERROR_CODES = [
  "invalid-input",
  // Git itself, or this Git version, cannot perform the request.
  "git-unsupported",
  "not-found",
  // The branch name exists already; nothing was reset.
  "branch-exists",
  // The branch is checked out in another tree — never forced, and the
  // existing checkout is offered instead (see `conflictCheckoutId`).
  "branch-in-use",
  "destination-occupied",
  // A selected ref is gone or was never available; no ref is substituted.
  "ref-unavailable",
  "fetch-authentication",
  "fetch-network",
  // Git created the checkout and registration failed; the tree is retained.
  "registration-failed",
  "start-failed",
  // Tracked, untracked or ignored data would be lost.
  "local-data",
  "git-lock",
  // Activity Uatu does not own and cannot promise to stop.
  "external-activity",
  "nested-dependency",
  "stop-failed",
  // The action requires verified Uatu creation provenance.
  "ownership-required",
  // The recorded identity cannot be confirmed; content is retained.
  "identity-uncertain",
  "inventory-unavailable",
  // A generic folder move would break Git worktree dependencies (§6).
  "folder-dependency",
  // …or its safety could not be established at all. Fails closed.
  "folder-dependency-unknown",
  "conflict",
  "permission-denied",
  "timeout",
  "cancelled",
  "internal",
] as const;
export type WorktreeErrorCode = (typeof WORKTREE_ERROR_CODES)[number];

// The single follow-up the originating flow offers. "none" keeps a compact
// error compact: no path dump, no generic navigation.
export const WORKTREE_RETRY_ACTIONS = [
  "none",
  "retry-registration",
  "retry-start",
  "retry-fetch",
  "retry-delete",
  "refresh",
  "open-existing",
] as const;
export type WorktreeRetryAction = (typeof WORKTREE_RETRY_ACTIONS)[number];

export type WorktreeError = {
  readonly code: WorktreeErrorCode;
  // Already sanitized: no absolute path, no credential, no control
  // character, bounded length. Built with worktreeError() below.
  readonly message: string;
  readonly retry: WorktreeRetryAction;
  // The existing checkout an occupancy conflict points at.
  readonly conflictCheckoutId?: string;
  // The checkout that outlived a failed operation and must not be recreated.
  readonly retainedCheckoutId?: string;
  // The last boundary the operation provably passed before failing.
  readonly phase?: WorktreePhase;
};

export const WORKTREE_MESSAGE_LIMIT = 300;

const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;
// scheme://user:secret@host → scheme://host
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi;
// Known secret shapes and key=value secrets, whatever produced them.
const TOKEN_SHAPES = /\b(?:gh[pousr]_[A-Za-z0-9]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|sk-[A-Za-z0-9]{16,})\b/g;
const KEYED_SECRETS = /\b(?:password|passphrase|secret|token|authorization|api[_-]?key)\b\s*[:=]\s*\S+/gi;
// Absolute POSIX and Windows paths, including the quoted forms Git emits.
// The lookbehind keeps relative refs whole: the slash in "origin/release",
// "refs/heads/main" or "https://host/repo" follows a word character, a
// colon or another slash, so none of them starts a path match.
const ABSOLUTE_PATHS = /(?<![\w:@./\\-])(?:[A-Za-z]:)?(?:[/\\][\w.~@+%$#()\[\]-]+)+[/\\]?/g;

// Git, SSH and filesystem output reaches users through this and nothing
// else. It is not a formatter: it removes what must never be published
// (secrets) and what the compact flows must not dump (absolute paths), then
// bounds the result so no upstream can flood a dialog.
export function sanitizeWorktreeMessage(value: string): string {
  const redacted = value
    .replace(CONTROL_CHARACTERS, " ")
    .replace(URL_CREDENTIALS, "$1")
    .replace(TOKEN_SHAPES, "[redacted]")
    .replace(KEYED_SECRETS, match => `${match.slice(0, match.search(/[:=]/) + 1)} [redacted]`)
    .replace(ABSOLUTE_PATHS, "[path]")
    .replace(/\s+/g, " ")
    .trim();
  if (redacted.length <= WORKTREE_MESSAGE_LIMIT) return redacted;
  return `${redacted.slice(0, WORKTREE_MESSAGE_LIMIT - 1).trimEnd()}…`;
}

export function worktreeError(
  code: WorktreeErrorCode,
  message: string,
  extra: Omit<WorktreeError, "code" | "message" | "retry"> & { retry?: WorktreeRetryAction } = {},
): WorktreeError {
  const { retry = "none", ...rest } = extra;
  return { code, message: sanitizeWorktreeMessage(message), retry, ...rest };
}

// Carries a WorktreeError across the service boundary. Anything that is not
// one of these is an internal failure with no caller-actionable message.
export class WorktreeOperationError extends Error {
  readonly detail: WorktreeError;

  constructor(detail: WorktreeError, options?: ErrorOptions) {
    super(detail.message, options);
    this.name = "WorktreeOperationError";
    this.detail = detail;
  }

  static of(
    code: WorktreeErrorCode,
    message: string,
    extra?: Omit<WorktreeError, "code" | "message" | "retry"> & { retry?: WorktreeRetryAction },
    options?: ErrorOptions,
  ): WorktreeOperationError {
    return new WorktreeOperationError(worktreeError(code, message, extra), options);
  }
}

export function toWorktreeError(error: unknown, fallback: string): WorktreeError {
  if (error instanceof WorktreeOperationError) return error.detail;
  return worktreeError("internal", fallback);
}

export type WorktreeOperationProgress = {
  readonly operationId: string;
  readonly kind: WorktreeOperationKind;
  readonly phase: WorktreePhase;
  // Unix epoch milliseconds.
  readonly startedAt: number;
  readonly updatedAt: number;
};

export type WorktreeOperationResult =
  | {
    readonly ok: true;
    readonly operationId: string;
    readonly kind: WorktreeOperationKind;
    readonly phase: WorktreePhase;
    readonly checkout?: WorktreeCheckout;
    readonly registered: boolean;
    readonly started: boolean;
    // A failed explicit start does NOT fail the operation: the configured
    // workspace stays stopped and this reports why.
    readonly startError?: WorktreeError;
  }
  | {
    readonly ok: false;
    readonly operationId: string;
    readonly kind: WorktreeOperationKind;
    readonly phase?: WorktreePhase;
    readonly error: WorktreeError;
    // Present when Git succeeded and a later step did not: the caller
    // retries against THIS checkout and never creates a second one.
    readonly retainedCheckout?: WorktreeCheckout;
  };

// --- Ownership -------------------------------------------------------------

export type WorktreeOwnershipInput = {
  // The repository's main checkout, as Git reports it — not a name match.
  readonly main: boolean;
  // What Git reports at the path right now. Absent means either the path is
  // gone or what occupies it is not the checkout it should be.
  readonly observed?: WorktreeIdentity;
  readonly observedPath?: string;
  // Whether a directory exists at the path at all. Defaults to whatever the
  // identity fields imply, so a caller that only has an identity is right.
  readonly present?: boolean;
  // False when the path exists but its identity could not be read at all.
  readonly identityReadable?: boolean;
  // The identity the Hub registration names, when it is registered.
  readonly registered?: WorktreeIdentity;
  // The durable Uatu creation record, independent of registration.
  readonly provenance?: { readonly identity: WorktreeIdentity; readonly path: string };
};

function sameIdentity(left: WorktreeIdentity | undefined, right: WorktreeIdentity | undefined): boolean {
  return left !== undefined && right !== undefined
    && left.repositoryId === right.repositoryId && left.checkoutId === right.checkoutId;
}

// The one place ownership is decided. Names, `.claude/`, `opencode/`, a
// conventional `.worktrees/` path and the registration itself are all
// deliberately absent from these rules (design §2).
export function resolveWorktreeOwnership(
  input: WorktreeOwnershipInput,
): { ownership: WorktreeOwnership; availability: WorktreeAvailability } {
  const present = input.present ?? (input.observed !== undefined || input.identityReadable === false);
  if (input.main) return { ownership: "main", availability: present ? "present" : "missing" };
  if (!present) {
    const owned = sameIdentity(input.provenance?.identity, input.registered);
    return { ownership: owned ? "uatu" : "external", availability: "missing" };
  }
  // The path is there and Git cannot say what it is: never assert ownership
  // over it, and never let a destructive action proceed.
  if (input.identityReadable === false) return { ownership: "uncertain", availability: "present" };
  // Present, readable, and not the checkout it should be — something else
  // occupies the path. An identity conflict, never a repair.
  if (input.observed === undefined) {
    return { ownership: "uncertain", availability: input.registered === undefined ? "present" : "replaced" };
  }
  // A registration whose path now holds a different checkout is an identity
  // conflict, not a rename to follow.
  if (input.registered !== undefined && !sameIdentity(input.registered, input.observed)) {
    return { ownership: "uncertain", availability: "replaced" };
  }
  // Provenance is matched by checkout identity. The recorded path is only
  // corroborating: a tree that moved is still ours, and a different tree at
  // our recorded path is not.
  if (sameIdentity(input.provenance?.identity, input.observed)) return { ownership: "uatu", availability: "present" };
  return { ownership: "external", availability: "present" };
}

// Deletion is offered for verified Uatu-created linked trees only, and never
// for the main checkout, an external tree, an uncertain identity, or a path
// whose content cannot be confirmed.
export function canDeleteWorktree(checkout: Pick<WorktreeCheckout, "ownership" | "availability" | "main">): boolean {
  return checkout.ownership === "uatu" && checkout.availability === "present" && !checkout.main;
}

// --- Runtime validation ----------------------------------------------------
//
// The wire is validated on arrival on both sides: the client refuses a shape
// the Hub would not have produced, and the Hub refuses a body the UI would
// not have sent. Objects are closed — an unknown field is a contract
// mismatch, not something to ignore.

function fail(message: string): never {
  throw WorktreeOperationError.of("invalid-input", message);
}

function closed(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const allowed = new Set(fields);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${label} contains an unknown field: ${key}`);
  }
  return record;
}

function requiredString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== "string" || value === "") fail(`${label} requires ${field}`);
  return value;
}

function optionalString(record: Record<string, unknown>, field: string, label: string): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") fail(`${label} has an invalid ${field}`);
  return value;
}

function flag(record: Record<string, unknown>, field: string, label: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") fail(`${label} requires a boolean ${field}`);
  return value;
}

function member<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) fail(`${label} is not a known value`);
  return value as T;
}

export function parseWorktreeError(value: unknown): WorktreeError {
  const record = closed(value, ["code", "message", "retry", "conflictCheckoutId", "retainedCheckoutId", "phase"], "worktree error");
  const phase = record.phase === undefined
    ? undefined
    : isWorktreePhase("create", record.phase) || isWorktreePhase("delete", record.phase)
      ? record.phase as WorktreePhase
      : fail("worktree error has an unknown phase");
  return {
    code: member(record.code, WORKTREE_ERROR_CODES, "worktree error code"),
    message: sanitizeWorktreeMessage(requiredString(record, "message", "worktree error")),
    retry: member(record.retry, WORKTREE_RETRY_ACTIONS, "worktree error retry"),
    ...(record.conflictCheckoutId === undefined ? {} : { conflictCheckoutId: requiredString(record, "conflictCheckoutId", "worktree error") }),
    ...(record.retainedCheckoutId === undefined ? {} : { retainedCheckoutId: requiredString(record, "retainedCheckoutId", "worktree error") }),
    ...(phase === undefined ? {} : { phase }),
  };
}

export function parseWorktreeCheckout(value: unknown): WorktreeCheckout {
  const record = closed(
    value,
    [
      "checkoutId", "repositoryId", "workspaceId", "parentWorkspaceId", "path", "branch", "detached",
      "main", "ownership", "availability", "registered", "running", "locked", "sourceRef", "upstream", "head",
    ],
    "worktree checkout",
  );
  const branch = record.branch;
  if (branch !== null && (typeof branch !== "string" || branch === "")) fail("worktree checkout requires a branch or null");
  const detached = flag(record, "detached", "worktree checkout");
  if (detached && branch !== null) fail("a detached worktree checkout cannot name a branch");
  const availability = member(record.availability, WORKTREE_AVAILABILITIES, "worktree checkout availability");
  const registered = flag(record, "registered", "worktree checkout");
  const workspaceId = optionalString(record, "workspaceId", "worktree checkout");
  if (registered !== (workspaceId !== undefined)) fail("a registered worktree checkout requires a workspaceId");
  const running = flag(record, "running", "worktree checkout");
  if (running && availability !== "present") fail("an unavailable worktree checkout cannot be running");
  return {
    checkoutId: requiredString(record, "checkoutId", "worktree checkout"),
    repositoryId: requiredString(record, "repositoryId", "worktree checkout"),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(record.parentWorkspaceId === undefined ? {} : { parentWorkspaceId: requiredString(record, "parentWorkspaceId", "worktree checkout") }),
    path: requiredString(record, "path", "worktree checkout"),
    branch: branch as string | null,
    detached,
    main: flag(record, "main", "worktree checkout"),
    ownership: member(record.ownership, WORKTREE_OWNERSHIPS, "worktree checkout ownership"),
    availability,
    registered,
    running,
    locked: flag(record, "locked", "worktree checkout"),
    ...(record.sourceRef === undefined ? {} : { sourceRef: requiredString(record, "sourceRef", "worktree checkout") }),
    ...(record.upstream === undefined ? {} : { upstream: requiredString(record, "upstream", "worktree checkout") }),
    ...(record.head === undefined ? {} : { head: requiredString(record, "head", "worktree checkout") }),
  };
}

function parseRefs(value: unknown): WorktreeRefs {
  const record = closed(value, ["local", "remote", "fetchedAt"], "worktree refs");
  const refs = (field: "local" | "remote"): string[] => {
    const list = record[field];
    if (!Array.isArray(list) || list.some(ref => typeof ref !== "string" || ref === "")) fail(`worktree refs ${field} must be branch names`);
    return list as string[];
  };
  const fetchedAt = record.fetchedAt;
  if (fetchedAt !== null && (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt))) fail("worktree refs fetchedAt must be epoch milliseconds or null");
  return { local: refs("local"), remote: refs("remote"), fetchedAt: fetchedAt as number | null };
}

export function parseWorktreeInventory(value: unknown): WorktreeInventory {
  const record = closed(value, ["repositoryId", "sourceWorkspaceId", "status", "checkouts", "refs", "error"], "worktree inventory");
  if (!Array.isArray(record.checkouts)) fail("worktree inventory requires checkouts");
  const status = member(record.status, WORKTREE_INVENTORY_STATUSES, "worktree inventory status");
  if ((status === "error") !== (record.error !== undefined)) fail("worktree inventory status and error must agree");
  const checkouts = record.checkouts.map(parseWorktreeCheckout);
  const repositoryId = requiredString(record, "repositoryId", "worktree inventory");
  if (isWorktreeIdentityUnknown(repositoryId)) {
    // "Identity unknown" is a refusal to name a repository, so it may not
    // carry checkouts and may not be presented as a settled listing.
    if (status !== "error") fail("an unidentified worktree inventory must report an error");
    if (checkouts.length > 0) fail("an unidentified worktree inventory cannot list checkouts");
  } else if (checkouts.some(checkout => checkout.repositoryId !== repositoryId)) {
    fail("worktree inventory mixes repositories");
  }
  return {
    repositoryId,
    sourceWorkspaceId: requiredString(record, "sourceWorkspaceId", "worktree inventory"),
    status,
    checkouts,
    refs: parseRefs(record.refs),
    ...(record.error === undefined ? {} : { error: parseWorktreeError(record.error) }),
  };
}

// The one spelling for "the repository could not be identified": an
// explicitly stale, empty listing that names no repository and carries the
// sanitized reason. Round-trips through parseWorktreeInventory.
export function unknownWorktreeInventory(sourceWorkspaceId: string, error: WorktreeError): WorktreeInventory {
  return {
    repositoryId: WORKTREE_UNKNOWN_REPOSITORY,
    sourceWorkspaceId,
    status: "error",
    checkouts: [],
    refs: { local: [], remote: [], fetchedAt: null },
    error,
  };
}

export function parseWorktreeOperationResult(value: unknown): WorktreeOperationResult {
  const record = closed(
    value,
    ["ok", "operationId", "kind", "phase", "checkout", "registered", "started", "startError", "error", "retainedCheckout"],
    "worktree operation result",
  );
  const ok = flag(record, "ok", "worktree operation result");
  const operationId = requiredString(record, "operationId", "worktree operation result");
  const kind = member(record.kind, WORKTREE_OPERATION_KINDS, "worktree operation kind");
  const phased: WorktreePhasedOperation | undefined = kind === "create" || kind === "delete" ? kind : undefined;
  const phase = record.phase === undefined
    ? undefined
    : phased !== undefined && isWorktreePhase(phased, record.phase)
      ? record.phase as WorktreePhase
      : fail("worktree operation result has an unknown phase");
  if (!ok) {
    return {
      ok: false,
      operationId,
      kind,
      ...(phase === undefined ? {} : { phase }),
      error: parseWorktreeError(record.error),
      ...(record.retainedCheckout === undefined ? {} : { retainedCheckout: parseWorktreeCheckout(record.retainedCheckout) }),
    };
  }
  if (record.error !== undefined) fail("a successful worktree operation result cannot carry an error");
  const started = flag(record, "started", "worktree operation result");
  if (started && record.startError !== undefined) fail("a started worktree operation result cannot carry a start error");
  return {
    ok: true,
    operationId,
    kind,
    phase: phase ?? fail("a successful worktree operation result requires a phase"),
    ...(record.checkout === undefined ? {} : { checkout: parseWorktreeCheckout(record.checkout) }),
    registered: flag(record, "registered", "worktree operation result"),
    started,
    ...(record.startError === undefined ? {} : { startError: parseWorktreeError(record.startError) }),
  };
}

export function parseWorktreeDeleteRequest(value: unknown): WorktreeDeleteRequest {
  const record = closed(value, ["sourceWorkspaceId", "reference", "stop"], "worktree delete request");
  return {
    sourceWorkspaceId: requiredString(record, "sourceWorkspaceId", "worktree delete request"),
    reference: requiredString(record, "reference", "worktree delete request"),
    ...(record.stop === undefined ? {} : { stop: flag(record, "stop", "worktree delete request") }),
  };
}

export function parseWorktreeForgetRequest(value: unknown): WorktreeForgetRequest {
  const record = closed(value, ["sourceWorkspaceId", "reference", "stop"], "worktree forget request");
  return {
    sourceWorkspaceId: requiredString(record, "sourceWorkspaceId", "worktree forget request"),
    reference: requiredString(record, "reference", "worktree forget request"),
    ...(record.stop === undefined ? {} : { stop: flag(record, "stop", "worktree forget request") }),
  };
}

export function parseWorktreeCreateRequest(value: unknown): WorktreeCreateRequest {
  const record = closed(value, ["sourceWorkspaceId", "mode", "branch", "base", "start"], "worktree create request");
  const base = closed(record.base, ["kind", "ref"], "worktree create base");
  const mode = member(record.mode, WORKTREE_CREATE_MODES, "worktree create mode");
  const branch = optionalString(record, "branch", "worktree create request");
  if (mode === "new-branch" && branch === undefined) fail("a new branch requires a name");
  // Held to the branch grammar here, before any repository is touched: an
  // option-like name ("-f"), a revision expression or a traversal never
  // reaches a Git argument list.
  if (branch !== undefined && !validWorktreeBranch(branch)) fail("branch is not a valid branch name");
  const kind = member(base.kind, ["local", "remote"] as const, "worktree create base kind");
  if (mode === "existing-local" && kind !== "local") fail("an existing local branch requires a local ref");
  if (mode === "remote-tracking" && kind !== "remote") fail("a tracking branch requires a remote ref");
  return {
    sourceWorkspaceId: requiredString(record, "sourceWorkspaceId", "worktree create request"),
    mode,
    ...(branch === undefined ? {} : { branch }),
    base: { kind, ref: requiredString(base, "ref", "worktree create base") },
    ...(record.start === undefined ? {} : { start: flag(record, "start", "worktree create request") }),
  };
}
