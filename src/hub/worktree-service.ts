// The Hub's worktree operation service: one place where inventory, refs,
// fetch and creation happen, shared by the UI today and the agent-invoked
// CLI later (design §2, §7). Every mutation is serialized per repository,
// journaled before it runs, bounded, and non-force.
//
// It owns no presentation and no HTTP: the routes hand it an authenticated
// user and a validated request, and it answers with the shared contract
// DTOs. Operations are scoped to the user who started them — the journal
// records the initiator, and progress is only ever reported to them.

import {
  toWorktreeError,
  WorktreeOperationError,
  type WorktreeCheckout,
  type WorktreeCreateRequest,
  type WorktreeInventory,
  type WorktreeOperationProgress,
  type WorktreeError,
  type WorktreeOperationResult,
  type WorktreeRefs,
} from "../shared/worktree-contract";
import { initialWorktreeBase } from "../shared/worktree-branches";
import type { WorkspaceEntry, WorkspaceRegistry } from "./registry";
import type { SessionManager } from "./sessions";
import { WorktreeOperationCoordinator } from "./worktree-coordinator";
import {
  destinationOccupied,
  mainCheckoutPathFor,
  planWorktreeCreation,
  runWorktreeAdd,
  type WorktreeCreationPlan,
} from "./worktree-create";
import {
  createWorktreeFetchRunner,
  fetchWorktreeRemotes,
  type WorktreeFetchPolicy,
} from "./worktree-fetch";
import {
  createGitRunner,
  inspectCheckout,
  listRefs,
  listWorktrees,
  probeGitCapabilities,
  repositoryContext,
  type CheckoutInspection,
  type GitRunner,
  type WorktreeGitOptions,
  type WorktreeRecord,
} from "./worktree-git";
import {
  ownershipForCheckout,
  recoverWorktreeOperation,
  registerCreatedWorktree,
  WorktreeJournal,
  WorktreeProvenanceStore,
  type WorktreeRecoveryOutcome,
  type WorktreeRegistrar,
} from "./worktree-journal";

// A repository with an implausible number of linked trees must not turn one
// inventory read into hundreds of subprocesses.
const INVENTORY_LIMIT = 64;

export type WorktreeServiceOptions = {
  registry: Pick<WorkspaceRegistry, "byId" | "byPath" | "list">;
  sessions: Pick<SessionManager, "isRunning">;
  journal: WorktreeJournal;
  provenance: WorktreeProvenanceStore;
  registrar: WorktreeRegistrar;
  coordinator?: WorktreeOperationCoordinator;
  // The Hub-wide precondition for a registered-state mutation: a pending
  // folder-mutation journal freezes worktree creation too, because the
  // registration it ends in is frozen for the same reason. Checked before
  // Git runs, so a frozen Hub produces no retained checkout at all.
  assertOperationsAllowed?: () => Promise<void>;
  git?: WorktreeGitOptions;
  // Absent means fetch is unavailable rather than unauthenticated: a Hub
  // without a credential store must not fall back to ambient credentials.
  fetchPolicy?: WorktreeFetchPolicy;
  fetchEnv?: NodeJS.ProcessEnv;
  now?: () => number;
  newOperationId?: () => string;
};

type RepositoryView = {
  readonly source: WorkspaceEntry;
  readonly repositoryId: string;
  readonly mainPath: string;
  readonly records: readonly WorktreeRecord[];
  readonly refs: { readonly local: readonly string[]; readonly remote: readonly string[] };
};

function notFound(message: string): WorktreeOperationError {
  return WorktreeOperationError.of("not-found", message);
}

export class WorktreeService {
  private readonly coordinator: WorktreeOperationCoordinator;
  private readonly run: GitRunner;
  private readonly now: () => number;
  private readonly newOperationId: () => string;
  // Freshness is per repository and in memory: after a restart a listing is
  // truthfully "cached" again rather than claiming a fetch nobody made.
  private readonly fetchedAt = new Map<string, number>();

  constructor(private readonly options: WorktreeServiceOptions) {
    this.coordinator = options.coordinator ?? new WorktreeOperationCoordinator();
    this.run = options.git?.run ?? createGitRunner(options.git ?? {});
    this.now = options.now ?? Date.now;
    this.newOperationId = options.newOperationId ?? (() => crypto.randomUUID());
  }

  // The initial Create from selection, from the ONE shared helper: local
  // main, else the sole remote main, else no selection at all. Never the
  // parent's current checkout.
  defaultCreateBase(refs: Pick<WorktreeRefs, "local" | "remote">): string {
    return initialWorktreeBase([...refs.local], [...refs.remote]);
  }

  busy(repositoryId: string): boolean {
    return this.coordinator.busy(repositoryId);
  }

  // --- Reading ------------------------------------------------------------

  private async repositoryView(sourceWorkspaceId: string): Promise<RepositoryView> {
    const source = this.options.registry.byId(sourceWorkspaceId);
    if (!source) throw notFound("That workspace is not registered. Refresh and try again.");
    const capabilities = await probeGitCapabilities(source.path, { ...this.options.git, run: this.run });
    if (!capabilities.supported) {
      throw WorktreeOperationError.of("git-unsupported", capabilities.reason ?? "Worktree operations are unavailable on this Hub.");
    }
    const context = await repositoryContext(source.path, { ...this.options.git, run: this.run });
    if (context.kind === "not-a-repository") throw notFound("That workspace is not a Git repository.");
    if (context.kind === "indeterminate") {
      throw WorktreeOperationError.of("inventory-unavailable", `The repository could not be inspected: ${context.detail}`, { retry: "refresh" });
    }
    if (context.bare) throw WorktreeOperationError.of("git-unsupported", "A bare repository cannot host Uatu worktree destinations.");
    const [inventory, refs] = await Promise.all([
      listWorktrees(source.path, { ...this.options.git, run: this.run }),
      listRefs(source.path, { ...this.options.git, run: this.run }),
    ]);
    if (inventory.kind !== "inventory") {
      throw WorktreeOperationError.of("inventory-unavailable", `The worktree inventory could not be read: ${inventory.detail}`, { retry: "refresh" });
    }
    if (refs.kind !== "refs") {
      throw WorktreeOperationError.of("inventory-unavailable", `The repository's branches could not be read: ${refs.detail}`, { retry: "refresh" });
    }
    return {
      source,
      repositoryId: context.identity.repositoryId,
      mainPath: mainCheckoutPathFor(context.commonDirectory),
      records: inventory.records.slice(0, INVENTORY_LIMIT),
      refs,
    };
  }

  private async checkoutFor(
    view: RepositoryView,
    record: WorktreeRecord,
    inspection?: CheckoutInspection,
  ): Promise<WorktreeCheckout> {
    const probe = inspection ?? await inspectCheckout(record.path, { ...this.options.git, run: this.run });
    const registered = this.options.registry.byPath(record.path);
    const main = record.path === view.mainPath;
    const resolved = await ownershipForCheckout({
      provenance: this.options.provenance,
      inspection: probe,
      checkoutPath: record.path,
      main,
      ...(registered?.worktree
        ? { registeredIdentity: { repositoryId: registered.worktree.repositoryId, checkoutId: registered.worktree.checkoutId } }
        : {}),
    });
    const checkoutId = probe.identity?.checkoutId ?? registered?.worktree?.checkoutId ?? record.path;
    return {
      checkoutId,
      repositoryId: view.repositoryId,
      ...(registered ? { workspaceId: registered.id } : {}),
      ...(registered?.worktree ? { parentWorkspaceId: registered.worktree.parentWorkspaceId } : {}),
      path: record.path,
      branch: record.detached ? null : record.branch,
      detached: record.detached,
      main,
      ownership: resolved.ownership,
      availability: resolved.availability,
      registered: registered !== undefined,
      running: registered !== undefined && this.options.sessions.isRunning(registered.id),
      locked: record.locked,
      ...(resolved.record?.sourceRef === undefined ? {} : { sourceRef: resolved.record.sourceRef }),
      ...(record.head === null ? {} : { head: record.head.slice(0, 12) }),
    };
  }

  private refsFor(view: RepositoryView): WorktreeRefs {
    return {
      local: [...view.refs.local],
      remote: [...view.refs.remote],
      // Cached refs are never described as network-fresh.
      fetchedAt: this.fetchedAt.get(view.repositoryId) ?? null,
    };
  }

  async inventory(sourceWorkspaceId: string): Promise<WorktreeInventory> {
    let view: RepositoryView;
    try {
      view = await this.repositoryView(sourceWorkspaceId);
    } catch (error) {
      // The repository could not be identified at all, so there is no
      // identity to report: an explicitly stale, empty listing carrying the
      // sanitized reason. (When this DTO is published over the wire in
      // section 5, the empty identity needs a wire-legal spelling — the
      // contract parser requires a non-empty repositoryId.)
      return {
        repositoryId: "",
        sourceWorkspaceId,
        status: "error",
        checkouts: [],
        refs: { local: [], remote: [], fetchedAt: null },
        error: toWorktreeError(error, "The worktree inventory is unavailable."),
      };
    }
    const checkouts: WorktreeCheckout[] = [];
    for (const record of view.records) checkouts.push(await this.checkoutFor(view, record));
    return {
      repositoryId: view.repositoryId,
      sourceWorkspaceId,
      status: "ready",
      checkouts,
      refs: this.refsFor(view),
    };
  }

  async refs(sourceWorkspaceId: string): Promise<WorktreeRefs> {
    return this.refsFor(await this.repositoryView(sourceWorkspaceId));
  }

  // --- Fetch --------------------------------------------------------------

  // One explicit "Fetch remote branches". It uses the PARENT's credential
  // policy and nothing else; on failure the cached listing and its previous
  // freshness stamp are returned unchanged with the error.
  async fetch(sourceWorkspaceId: string): Promise<{ refs: WorktreeRefs; error?: WorktreeError }> {
    const view = await this.repositoryView(sourceWorkspaceId);
    if (!this.options.fetchPolicy) {
      return {
        refs: this.refsFor(view),
        error: WorktreeOperationError.of("fetch-authentication", "Remote fetch is unavailable on this Hub.", { retry: "none" }).detail,
      };
    }
    // The policy owner is the parent for a child, the workspace itself for a
    // main checkout: a child never has a credential policy of its own.
    const parentWorkspaceId = view.source.worktree?.parentWorkspaceId ?? view.source.id;
    const outcome = await this.coordinator.run({ repositoryId: view.repositoryId }, () => fetchWorktreeRemotes({
      run: this.run,
      repositoryPath: view.source.path,
      parentWorkspaceId,
      policy: this.options.fetchPolicy!,
      ...(this.options.fetchEnv === undefined ? {} : { env: this.options.fetchEnv }),
      runWith: createWorktreeFetchRunner(this.options.git ?? {}),
      now: this.now,
    }));
    if (!outcome.ok) {
      // Cached refs are re-read rather than assumed: a partial fetch may
      // have updated some of them, and the listing must stay truthful.
      const after = await this.repositoryView(sourceWorkspaceId);
      return { refs: this.refsFor(after), error: outcome.error };
    }
    this.fetchedAt.set(view.repositoryId, outcome.fetchedAt);
    const after = await this.repositoryView(sourceWorkspaceId);
    return { refs: this.refsFor(after) };
  }

  // --- Creation -----------------------------------------------------------

  async create(user: string, request: WorktreeCreateRequest): Promise<WorktreeOperationResult> {
    const operationId = this.newOperationId();
    try {
      await this.options.assertOperationsAllowed?.();
      const view = await this.repositoryView(request.sourceWorkspaceId);
      return await this.coordinator.run({
        repositoryId: view.repositoryId,
        // The destination lives beside the main checkout, not below it, so
        // the whole sibling parent is reserved for the operation.
        paths: [view.mainPath, `${view.mainPath}.worktrees`],
      }, () => this.createWhileFenced(user, operationId, view, request));
    } catch (error) {
      return { ok: false, operationId, kind: "create", error: toWorktreeError(error, "The worktree could not be created.") };
    }
  }

  private async createWhileFenced(
    user: string,
    operationId: string,
    view: RepositoryView,
    request: WorktreeCreateRequest,
  ): Promise<WorktreeOperationResult> {
    let plan: WorktreeCreationPlan;
    try {
      plan = await planWorktreeCreation({
        request,
        mainPath: view.mainPath,
        refs: view.refs,
        records: view.records,
        occupied: destinationOccupied,
      });
    } catch (error) {
      // Nothing was journaled and nothing ran: a pure refusal.
      return { ok: false, operationId, kind: "create", phase: "validating", error: toWorktreeError(error, "The worktree could not be created.") };
    }

    // Intent before mutation. A second, different operation while one is
    // pending is refused here rather than queued.
    await this.options.journal.begin({
      operationId,
      kind: "create",
      phase: "validating",
      user,
      repositoryId: view.repositoryId,
      sourceWorkspaceId: view.source.id,
      sourcePath: view.source.path,
      destination: plan.destination,
      mode: plan.mode,
      branch: plan.branch,
      base: { kind: plan.base.kind, ref: plan.base.ref },
      sourceRef: plan.sourceRef,
    });
    await this.options.journal.advance(operationId, "reserving");
    await this.options.journal.advance(operationId, "creating");

    const outcome = await runWorktreeAdd(this.run, view.source.path, plan);
    if (!outcome.ok) {
      const inspection = await inspectCheckout(plan.destination, { ...this.options.git, run: this.run });
      // Only a destination Git provably did not create is cleared: an
      // uncertain one keeps its journal so recovery reconciles it, and
      // nothing is ever removed here.
      if (!inspection.present) await this.options.journal.clear();
      return { ok: false, operationId, kind: "create", phase: "creating", error: outcome.error.detail };
    }

    const inspection = await inspectCheckout(plan.destination, { ...this.options.git, run: this.run });
    if (!inspection.present || !inspection.identityReadable || !inspection.identity) {
      return {
        ok: false,
        operationId,
        kind: "create",
        phase: "creating",
        error: WorktreeOperationError.of("identity-uncertain", "The new checkout could not be verified. Its files are retained; reconcile it before retrying.", { retry: "refresh", phase: "creating" }).detail,
      };
    }
    await this.options.journal.advance(operationId, "verifying", { checkoutId: inspection.identity.checkoutId });

    try {
      const registration = await registerCreatedWorktree({
        journal: this.options.journal,
        provenance: this.options.provenance,
        registrar: this.options.registrar,
        inspect: checkoutPath => inspectCheckout(checkoutPath, { ...this.options.git, run: this.run }),
        operationId,
        start: request.start === true,
      });
      const checkout = await this.createdCheckout(view, plan, inspection, registration.workspaceId);
      return {
        ok: true,
        operationId,
        kind: "create",
        phase: "complete",
        checkout: { ...checkout, running: registration.started },
        registered: true,
        started: registration.started,
        ...(registration.startError === undefined
          ? {}
          : { startError: WorktreeOperationError.of("start-failed", `The workspace could not be started: ${registration.startError}. It remains stopped; retry Start.`, { retry: "retry-start" }).detail }),
      };
    } catch (error) {
      // Git succeeded and something after it did not: the checkout and its
      // branch are RETAINED and named, so a retry registers this same tree.
      const retained = await this.createdCheckout(view, plan, inspection);
      return {
        ok: false,
        operationId,
        kind: "create",
        phase: "registering",
        error: toWorktreeError(error, "The checkout was created but could not be registered."),
        retainedCheckout: retained,
      };
    }
  }

  // Retry-registration for a checkout a previous operation retained. It
  // never creates a tree: the pending journal names the one to verify.
  // `reference` is either that operation's id or the retained checkout's
  // identity — the compact recovery view knows the checkout, the CLI knows
  // the operation, and both mean this one pending operation.
  async retryRegistration(user: string, reference: string, start = false): Promise<WorktreeOperationResult> {
    const pending = await this.options.journal.read();
    if (!pending || (pending.operationId !== reference && pending.checkoutId !== reference)) {
      return { ok: false, operationId: reference, kind: "register", error: notFound("That operation is no longer pending. Refresh the inventory.").detail };
    }
    const operationId = pending.operationId;
    // Operations are scoped to the user who started them.
    if (pending.user !== user) {
      return { ok: false, operationId: reference, kind: "register", error: WorktreeOperationError.of("permission-denied", "That operation belongs to another user.").detail };
    }
    try {
      const view = await this.repositoryView(pending.sourceWorkspaceId);
      return await this.coordinator.run({ repositoryId: view.repositoryId, paths: [pending.destination] }, async () => {
        const registration = await registerCreatedWorktree({
          journal: this.options.journal,
          provenance: this.options.provenance,
          registrar: this.options.registrar,
          inspect: checkoutPath => inspectCheckout(checkoutPath, { ...this.options.git, run: this.run }),
          operationId,
          start,
        });
        const inspection = await inspectCheckout(pending.destination, { ...this.options.git, run: this.run });
        const record = view.records.find(candidate => candidate.path === pending.destination)
          ?? { path: pending.destination, head: null, branch: pending.branch, detached: false, bare: false, locked: false, lockReason: null, prunable: false };
        const checkout = await this.checkoutFor(view, record, inspection);
        return {
          ok: true as const,
          operationId,
          kind: "register" as const,
          phase: "complete" as const,
          checkout: { ...checkout, workspaceId: registration.workspaceId, registered: true, running: registration.started },
          registered: true,
          started: registration.started,
          ...(registration.startError === undefined
            ? {}
            : { startError: WorktreeOperationError.of("start-failed", `The workspace could not be started: ${registration.startError}. It remains stopped; retry Start.`, { retry: "retry-start" }).detail }),
        };
      });
    } catch (error) {
      return { ok: false, operationId, kind: "register", phase: "registering", error: toWorktreeError(error, "The retained checkout could not be registered.") };
    }
  }

  // Progress for the ONE pending operation, reported only to the user who
  // started it. An operation belonging to someone else is not found, not
  // described.
  async progress(user: string): Promise<WorktreeOperationProgress | undefined> {
    const pending = await this.options.journal.read();
    if (!pending || pending.user !== user) return undefined;
    const at = this.now();
    return { operationId: pending.operationId, kind: pending.kind, phase: pending.phase, startedAt: at, updatedAt: at };
  }

  // Startup reconciliation. Never deletes, never claims an uncertain tree.
  recover(): Promise<WorktreeRecoveryOutcome | undefined> {
    return recoverWorktreeOperation({
      journal: this.options.journal,
      provenance: this.options.provenance,
      inspect: checkoutPath => inspectCheckout(checkoutPath, { ...this.options.git, run: this.run }),
      registeredWorkspaceId: checkoutPath => this.options.registry.byPath(checkoutPath)?.id,
    });
  }

  private async createdCheckout(
    view: RepositoryView,
    plan: WorktreeCreationPlan,
    inspection: CheckoutInspection,
    workspaceId?: string,
  ): Promise<WorktreeCheckout> {
    const record = await this.options.provenance.byCheckoutId(inspection.identity!.checkoutId);
    const checkout: WorktreeCheckout = {
      checkoutId: inspection.identity!.checkoutId,
      repositoryId: view.repositoryId,
      ...(workspaceId === undefined ? {} : { workspaceId, parentWorkspaceId: view.source.id }),
      path: plan.destination,
      branch: plan.branch,
      detached: false,
      main: false,
      // Provenance is written by the registration step; before it lands the
      // tree is truthfully not yet provably ours.
      ownership: record ? "uatu" : "uncertain",
      availability: "present",
      registered: workspaceId !== undefined,
      running: false,
      locked: false,
      sourceRef: plan.sourceRef,
      ...(plan.upstream === undefined ? {} : { upstream: plan.upstream }),
    };
    return checkout;
  }
}
