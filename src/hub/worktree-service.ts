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
  canDeleteWorktree,
  toWorktreeError,
  unknownWorktreeInventory,
  WorktreeOperationError,
  type WorktreeDeleteRequest,
  type WorktreeDeletionPreflight,
  type WorktreeForgetRequest,
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
  stampCheckoutIdentity,
  type CheckoutInspection,
  type GitRunner,
  type WorktreeGitOptions,
  type WorktreeRecord,
} from "./worktree-git";
import { inspectRemovalSafety, runWorktreeRemove } from "./worktree-delete";
import {
  ownershipForCheckout,
  recoverWorktreeOperation,
  clearRemovalMarker,
  removalMarkerPresent,
  writeRemovalMarker,
  type WorktreeDeleteIntent,
  registerCreatedWorktree,
  WorktreeJournal,
  WorktreeProvenanceStore,
  type WorktreeRecoveryOutcome,
  type WorktreeRegistrar,
} from "./worktree-journal";

// Shared by both unregister APIs, including Hubs without the worktree API
// enabled. Check before deleting ANY Hub state, not merely in registry.remove:
// registered children retain this id as their live credential/settings owner.
export function assertNoRegisteredWorktreeDependents(registry: Pick<WorkspaceRegistry, "list">, workspaceId: string): void {
  if (registry.list().some(candidate => candidate.worktree?.parentWorkspaceId === workspaceId)) {
    throw WorktreeOperationError.of("conflict", "Remove this repository's worktrees from Uatu first; they inherit its settings.");
  }
}

// A repository with an implausible number of linked trees must not turn one
// inventory read into hundreds of subprocesses.
const INVENTORY_LIMIT = 64;
const AVAILABILITY_CACHE_MS = 2_000;

// The Hub-side registration cleanup a removal or a forget ends in: the
// registry entry, its personal state and its credential assignments. Called
// while the caller ALREADY holds the workspace's lifecycle queue, so it must
// not take that queue itself. Never touches the filesystem.
export type WorktreeUnregister = (workspaceId: string) => Promise<void>;

export type WorktreeServiceOptions = {
  registry: Pick<WorkspaceRegistry, "byId" | "byPath" | "list">;
  sessions: Pick<SessionManager, "isRunning"> & Partial<Pick<SessionManager, "isStarting" | "runWithSessionsStopped" | "runExclusive">>;
  // Absent: deletion and forgetting are unavailable rather than half-done.
  unregister?: WorktreeUnregister;
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
  // The state list is polled; a child's identity probe is cached briefly.
  private readonly availabilityCache = new Map<string, { at: number; path: string; repositoryId: string; checkoutId: string; value: "present" | "missing" | "replaced"; ownership: "uatu" | "external" | "uncertain" }>();

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
    // The branch's recorded creation history — the checkout's own record
    // first, then the branch's surviving history. Never inferred.
    const sourceRef = main || record.detached || record.branch === null
      ? undefined
      : resolved.record?.sourceRef ?? await this.options.provenance.branchOrigin(view.repositoryId, record.branch);
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
      // An unavailable checkout is never reported running: nothing can be
      // opened there until the identity conflict is resolved.
      running: registered !== undefined && resolved.availability === "present" && this.options.sessions.isRunning(registered.id),
      locked: record.locked,
      ...(sourceRef === undefined ? {} : { sourceRef }),
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
      // The repository could not be identified at all: the contract's one
      // "identity unknown" spelling, explicitly stale and empty.
      return unknownWorktreeInventory(sourceWorkspaceId, toWorktreeError(error, "The worktree inventory is unavailable."));
    }
    const checkouts: WorktreeCheckout[] = [];
    for (const record of view.records) checkouts.push(await this.checkoutFor(view, record));
    checkouts.push(...await this.unlistedRegistrations(view, checkouts));
    // Reconciliation publishes its invalidation after this read. The state
    // endpoint must reflect that same inventory, not a still-valid two-second
    // presentation cache from before the external change.
    for (const checkout of checkouts) {
      if (checkout.workspaceId && checkout.ownership !== "main") this.availabilityCache.set(checkout.workspaceId, {
        at: this.now(), path: checkout.path, value: checkout.availability,
        repositoryId: checkout.repositoryId, checkoutId: checkout.checkoutId, ownership: checkout.ownership,
      });
    }
    return {
      repositoryId: view.repositoryId,
      sourceWorkspaceId,
      status: "ready",
      checkouts,
      refs: this.refsFor(view),
    };
  }

  // Registered children Git no longer lists at their path (the folder was
  // deleted and pruned, or something else now lives there). They stay
  // visible as missing or replaced — never recreated, never forgotten,
  // never silently dropped from the picker.
  private async unlistedRegistrations(view: RepositoryView, listed: readonly WorktreeCheckout[]): Promise<WorktreeCheckout[]> {
    const listedPaths = new Set(listed.map(checkout => checkout.path));
    const rows: WorktreeCheckout[] = [];
    for (const entry of this.options.registry.list()) {
      const link = entry.worktree;
      if (!link || link.repositoryId !== view.repositoryId || listedPaths.has(entry.path)) continue;
      const inspection = await inspectCheckout(entry.path, { ...this.options.git, run: this.run });
      const resolved = await ownershipForCheckout({
        provenance: this.options.provenance,
        inspection,
        checkoutPath: entry.path,
        registeredIdentity: { repositoryId: link.repositoryId, checkoutId: link.checkoutId },
      });
      // The canonical identity resolver also distinguishes unreadable
      // (present/uncertain) from readable replacement and missing paths.
      const availability = resolved.availability;
      const origin = await this.options.provenance.branchOrigin(view.repositoryId, entry.displayName);
      rows.push({
        checkoutId: link.checkoutId,
        repositoryId: view.repositoryId,
        workspaceId: entry.id,
        parentWorkspaceId: link.parentWorkspaceId,
        path: entry.path,
        // Git cannot report a branch for a tree it no longer lists; the
        // registration's name IS the branch it was registered with.
        branch: entry.displayName,
        detached: false,
        main: false,
        ownership: resolved.ownership,
        availability,
        registered: true,
        running: false,
        locked: false,
        ...(origin === undefined ? {} : { sourceRef: origin }),
      });
    }
    return rows;
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
        ...(request.mode === "existing-local"
          ? await this.options.provenance.branchOrigin(view.repositoryId, request.base.ref).then(origin => origin === undefined ? {} : { branchOrigin: origin })
          : {}),
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
      ...(plan.sourceRef === undefined ? {} : { sourceRef: plan.sourceRef }),
    });
    await this.options.journal.advance(operationId, "reserving");
    await this.options.journal.advance(operationId, "creating");

    const outcome = await runWorktreeAdd(this.run, view.source.path, plan);
    if (!outcome.ok) {
      const inspection = await inspectCheckout(plan.destination, { ...this.options.git, run: this.run });
      // Only a destination Git provably did not create is cleared: an
      // uncertain one keeps its journal so recovery reconciles it, and
      // nothing is ever removed here.
      if (!inspection.present) await this.options.journal.clear(operationId);
      return { ok: false, operationId, kind: "create", phase: "creating", error: outcome.error.detail };
    }

    // Stamp the new tree before its identity is recorded anywhere, so a
    // later tree at this path can never inherit it (worktree-git).
    try {
      await stampCheckoutIdentity(plan.destination, { ...this.options.git, run: this.run });
    } catch {
      // Git already created the tree. Keep its files and the creating intent,
      // but never persist an unstamped, path-derived identity as ownership.
      // Recovery/retry must refuse this unverified intent, not adopt whatever
      // later occupies the destination by stamping it on retry.
      return {
        ok: false,
        operationId,
        kind: "create",
        phase: "creating",
        error: WorktreeOperationError.of("identity-uncertain", "The new checkout's identity could not be stamped. Its files are retained; reconcile it outside Uatu before retrying.", { retry: "refresh", phase: "creating" }).detail,
      };
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
      return { ok: false, operationId, kind: "register", error: toWorktreeError(error, "The retained checkout could not be registered.") };
    }
  }

  // --- Registering an existing checkout ----------------------------------------

  // Explicit registration of a checkout Git lists but Hub does not: an
  // external discovery, or a Uatu-created tree that was removed from Uatu
  // earlier. It stays where it is, keeps whatever provenance its IDENTITY
  // has (none for an external tree), is named by its exact branch, and is
  // governed live by the parent's policy. Nothing is moved or copied.
  async registerExisting(user: string, sourceWorkspaceId: string, reference: string, start = false): Promise<WorktreeOperationResult> {
    const pending = await this.options.journal.read().catch(() => undefined);
    if (pending?.kind === "create" && (pending.operationId === reference || pending.checkoutId === reference)) {
      return this.retryRegistration(user, reference, start);
    }
    const operationId = this.newOperationId();
    try {
      await this.options.assertOperationsAllowed?.();
      const view = await this.repositoryView(sourceWorkspaceId);
      return await this.coordinator.run({ repositoryId: view.repositoryId }, async () => {
        const current = await this.repositoryView(sourceWorkspaceId);
        let target: { record: WorktreeRecord; inspection: CheckoutInspection; checkout: WorktreeCheckout } | undefined;
        for (const record of current.records) {
          const inspection = await inspectCheckout(record.path, { ...this.options.git, run: this.run });
          if (inspection.identity?.checkoutId !== reference) continue;
          target = { record, inspection, checkout: await this.checkoutFor(current, record, inspection) };
          break;
        }
        if (!target) throw WorktreeOperationError.of("not-found", "That checkout is no longer listed by Git. Refresh the inventory.", { retry: "refresh" });
        const { checkout, inspection } = target;
        if (checkout.main) throw WorktreeOperationError.of("invalid-input", "The main checkout is registered as the repository itself.");
        if (checkout.registered) throw WorktreeOperationError.of("conflict", "That checkout is already registered. Open it instead.", { retry: "open-existing" });
        if (checkout.ownership === "uncertain" || checkout.availability !== "present" || !inspection.identity) {
          throw WorktreeOperationError.of("identity-uncertain", "Uatu cannot confirm this checkout's identity, so it was not registered.", { retry: "refresh" });
        }
        if (checkout.branch === null) {
          throw WorktreeOperationError.of("invalid-input", "A detached checkout has no branch to name it by. Check out a branch outside Uatu first.");
        }
        // A tree Uatu created keeps the identity its provenance names; an
        // external tree is stamped now, so a replacement at its path is
        // recognized as one rather than inheriting the registration.
        const identity = checkout.ownership === "uatu"
          ? inspection.identity
          : await stampCheckoutIdentity(checkout.path, { ...this.options.git, run: this.run });
        const registration = await this.options.registrar.register({
          path: checkout.path,
          displayName: checkout.branch,
          parentWorkspaceId: current.source.id,
          identity,
          start,
        });
        return {
          ok: true as const,
          operationId,
          kind: "register" as const,
          phase: "complete" as const,
          checkout: { ...checkout, checkoutId: identity.checkoutId, workspaceId: registration.workspaceId, parentWorkspaceId: current.source.id, registered: true, running: registration.started },
          registered: true,
          started: registration.started,
          ...(registration.startError === undefined
            ? {}
            : { startError: WorktreeOperationError.of("start-failed", `The workspace could not be started: ${registration.startError}. It remains stopped; retry Start.`, { retry: "retry-start" }).detail }),
        };
      });
    } catch (error) {
      return { ok: false, operationId, kind: "register", error: toWorktreeError(error, "The checkout could not be registered. Nothing changed.") };
    }
  }

  // --- Removal --------------------------------------------------------------

  private deletionUnavailable(): WorktreeOperationError | undefined {
    const { sessions } = this.options;
    if (!this.options.unregister || !sessions.runWithSessionsStopped || !sessions.isStarting) {
      return WorktreeOperationError.of("internal", "Worktree deletion is unavailable on this Hub.");
    }
    return undefined;
  }

  // The checkout a delete/forget reference names, resolved against a FRESH
  // Git listing: a registered workspace id, or a canonical checkout id for
  // a retained, unregistered tree. A path is never accepted as a reference.
  private async resolveTarget(view: RepositoryView, reference: string): Promise<{ record: WorktreeRecord; checkout: WorktreeCheckout; inspection: CheckoutInspection } | undefined> {
    const entry = this.options.registry.byId(reference);
    for (const record of view.records) {
      const registered = this.options.registry.byPath(record.path);
      const inspection = await inspectCheckout(record.path, { ...this.options.git, run: this.run });
      const matches = entry !== undefined
        ? registered?.id === entry.id
        : inspection.identity?.checkoutId === reference;
      if (!matches) continue;
      return { record, checkout: await this.checkoutFor(view, record, inspection), inspection };
    }
    return undefined;
  }

  // What the confirmation dialog shows: may this checkout be deleted, and
  // does proceeding need the explicit "Stop and delete". Read-only.
  async preflightDelete(request: WorktreeDeleteRequest): Promise<WorktreeDeletionPreflight> {
    try {
      const unavailable = this.deletionUnavailable();
      if (unavailable) throw unavailable;
      const view = await this.repositoryView(request.sourceWorkspaceId);
      return await this.preflightIn(view, request.reference);
    } catch (error) {
      return { ok: false, error: toWorktreeError(error, "Deletion could not be checked. Nothing was removed.") };
    }
  }

  private async preflightIn(view: RepositoryView, reference: string): Promise<WorktreeDeletionPreflight> {
    const target = await this.resolveTarget(view, reference);
    if (!target) {
      // A registered child Git no longer lists is missing or replaced; it
      // is never deletable, only restorable or forgettable.
      return { ok: false, error: WorktreeOperationError.of("identity-uncertain", "This worktree is not available at its recorded location. Nothing was removed.", { retry: "refresh" }).detail };
    }
    const { checkout } = target;
    if (checkout.main) {
      return { ok: false, checkout, error: WorktreeOperationError.of("ownership-required", "The main checkout cannot be deleted.").detail };
    }
    if (!canDeleteWorktree(checkout)) {
      const error = checkout.ownership === "uncertain" || checkout.availability !== "present"
        ? WorktreeOperationError.of("identity-uncertain", "Uatu cannot confirm this worktree's identity, so it will not delete it. Restore or verify it outside Uatu.")
        : WorktreeOperationError.of("ownership-required", "Only a worktree Uatu created can be deleted. Remove it from Uatu instead; its files stay.");
      return { ok: false, checkout, error: error.detail };
    }
    const blocker = await inspectRemovalSafety({ run: this.run, checkoutPath: checkout.path, records: view.records });
    if (blocker) return { ok: false, checkout, error: blocker.detail };
    const workspaceId = checkout.workspaceId;
    const active = workspaceId !== undefined
      && (this.options.sessions.isRunning(workspaceId) || this.options.sessions.isStarting?.(workspaceId) === true);
    return { ok: true, checkout, requiresStop: active };
  }

  // confirm → fence → stop → recheck → non-force remove → verify → clean up.
  // Every failure before the removal leaves files AND registration exactly
  // as they were. The branch is never an argument to anything here.
  async delete(user: string, request: WorktreeDeleteRequest): Promise<WorktreeOperationResult> {
    const operationId = this.newOperationId();
    const refuse = (error: unknown, phase?: WorktreeDeleteIntent["phase"], fallback = "The worktree could not be deleted. Files and registration were kept."): WorktreeOperationResult => ({
      ok: false, operationId, kind: "delete", ...(phase === undefined ? {} : { phase }), error: toWorktreeError(error, fallback),
    });
    try {
      const unavailable = this.deletionUnavailable();
      if (unavailable) throw unavailable;
      // A removal whose files are already gone but whose Hub cleanup did not
      // finish is retried here — never re-run against the path.
      const pending = await this.options.journal.read();
      if (pending?.kind === "delete" && (pending.workspaceId === request.reference || pending.checkoutId === request.reference)) {
        if (pending.user !== user) throw WorktreeOperationError.of("permission-denied", "That operation belongs to another user.");
        const outcome = await this.recover(pending.operationId);
        if (outcome?.kind === "removed") return { ok: true, operationId: pending.operationId, kind: "delete", phase: "complete", registered: false, started: false };
        if (outcome?.kind === "removal-cleanup-pending") {
          throw WorktreeOperationError.of("internal", "The worktree's files were removed and its branch kept, but Hub cleanup has not finished. Retry shortly.", { retry: "retry-delete", phase: "unregistering" });
        }
        if (outcome?.kind === "removal-not-performed") {
          throw WorktreeOperationError.of("conflict", "The previous deletion did not remove the worktree. Refresh and review it before deleting again.", { retry: "refresh" });
        }
        throw WorktreeOperationError.of("identity-uncertain", "Uatu cannot verify the previous deletion. Files and registration have been left unchanged by recovery. Reconcile the checkout outside Uatu, then refresh before attempting another deletion.", { retry: "none" });
      }
      await this.options.assertOperationsAllowed?.();
      const view = await this.repositoryView(request.sourceWorkspaceId);
      const target = await this.resolveTarget(view, request.reference);
      const paths = target ? [target.checkout.path] : [];
      return await this.coordinator.run({ repositoryId: view.repositoryId, paths }, () => this.deleteWhileFenced(user, operationId, request, refuse));
    } catch (error) {
      return refuse(error);
    }
  }

  private async deleteWhileFenced(
    user: string,
    operationId: string,
    request: WorktreeDeleteRequest,
    refuse: (error: unknown, phase?: WorktreeDeleteIntent["phase"], fallback?: string) => WorktreeOperationResult,
  ): Promise<WorktreeOperationResult> {
    const sessions = this.options.sessions as Required<WorktreeServiceOptions["sessions"]>;
    // Re-read under the repository fence: nothing Uatu does can change it
    // between here and the removal.
    const view = await this.repositoryView(request.sourceWorkspaceId);
    const preflight = await this.preflightIn(view, request.reference);
    if (!preflight.ok) return refuse(new WorktreeOperationError(preflight.error), "preflight");
    const checkout = preflight.checkout;
    if (preflight.requiresStop && request.stop !== true) {
      return refuse(WorktreeOperationError.of("conflict", "This worktree is running. Choose Stop and delete to stop its Uatu sessions first. Nothing was removed.", { retry: "retry-delete", phase: "preflight" }), "preflight");
    }
    const context = await repositoryContext(checkout.path, { ...this.options.git, run: this.run });
    if (context.kind !== "checkout" || context.identity.checkoutId !== checkout.checkoutId || context.main) {
      return refuse(WorktreeOperationError.of("identity-uncertain", "The worktree could not be verified, so it was not removed.", { retry: "refresh", phase: "preflight" }), "preflight");
    }
    const administrativeDirectory = context.gitDirectory;
    await this.options.journal.begin({
      operationId,
      kind: "delete",
      administrativeDirectory,
      phase: "preflight",
      user,
      repositoryId: view.repositoryId,
      sourceWorkspaceId: view.source.id,
      sourcePath: view.mainPath,
      destination: checkout.path,
      checkoutId: checkout.checkoutId,
      branch: checkout.branch ?? "detached",
      ...(checkout.workspaceId === undefined ? {} : { workspaceId: checkout.workspaceId }),
    });
    const clear = async () => { await this.options.journal.clear(operationId); };
    // Held in an object: the closure below advances it, and the catch reads it.
    // `retained` marks a journal kept on purpose for recovery to reconcile.
    const progress: { phase: WorktreeDeleteIntent["phase"]; retained: boolean; markerWritten: boolean } = { phase: "fencing", retained: false, markerWritten: false };
    try {
      await this.options.journal.advance(operationId, "fencing");
      if (request.stop === true) {
        progress.phase = "stopping";
        await this.options.journal.advance(operationId, "stopping");
      }
      const ids = checkout.workspaceId === undefined ? [] : [checkout.workspaceId];
      // Holding the workspace's lifecycle queue is the start fence: a start
      // already in flight finishes first (and is then stopped, when
      // authorized), and a start requested now waits until this returns —
      // by which time the registration is gone or intact, never half-removed.
      const outcome = await sessions.runWithSessionsStopped(ids, request.stop === true, async () => {
        progress.phase = "rechecking";
        await this.options.journal.advance(operationId, "rechecking");
        await this.options.assertOperationsAllowed?.();
        const current = await this.repositoryView(request.sourceWorkspaceId);
        const recheck = await this.preflightIn(current, request.reference);
        if (!recheck.ok) throw new WorktreeOperationError({ ...recheck.error, phase: "rechecking" });
        if (recheck.checkout.checkoutId !== checkout.checkoutId || recheck.checkout.path !== checkout.path) {
          throw WorktreeOperationError.of("identity-uncertain", "The worktree changed while deletion was prepared. Nothing was removed.", { retry: "refresh", phase: "rechecking" });
        }
        // Written into Git's administrative directory for this tree, which
        // `git worktree remove` deletes with it: its survival is what proves
        // "not removed" even when a new tree reuses the same name.
        await writeRemovalMarker(administrativeDirectory, operationId);
        progress.markerWritten = true;
        progress.phase = "removing";
        await this.options.journal.advance(operationId, "removing");
        // Marker/journal persistence yields to external writers. Revalidate
        // after those writes: non-force Git removal protects tracked and
        // untracked changes, but WILL remove ignored files. This narrows the
        // preparation race; it cannot atomically fence external writers after
        // our final probe or during Git's removal.
        const finalView = await this.repositoryView(request.sourceWorkspaceId);
        // Ownership/registration remain fenced; probe the already-resolved
        // path directly rather than inspecting every unrelated checkout again.
        const finalIdentity = await inspectCheckout(checkout.path, { ...this.options.git, run: this.run });
        const sameCheckout = finalIdentity.present && finalIdentity.identityReadable
          && finalIdentity.identity?.checkoutId === checkout.checkoutId
          && finalIdentity.identity.repositoryId === checkout.repositoryId;
        const blocker = sameCheckout
          ? await inspectRemovalSafety({ run: this.run, checkoutPath: checkout.path, records: finalView.records })
          : undefined;
        if (!sameCheckout || blocker) {
          throw WorktreeOperationError.of(blocker?.detail.code ?? "identity-uncertain", `The worktree changed while deletion was prepared. ${blocker?.detail.message ?? "Its identity could not be verified. Nothing was removed."}`, { retry: blocker?.detail.retry ?? "refresh", phase: "removing" });
        }
        const removed = await runWorktreeRemove(this.run, current.mainPath, checkout.path);
        const after = await inspectCheckout(checkout.path, { ...this.options.git, run: this.run });
        if (after.present && !after.identityReadable) {
          progress.retained = true;
          throw WorktreeOperationError.of("identity-uncertain", "The worktree's folder could not be verified after removal. Nothing more was changed; refresh the inventory.", { retry: "refresh", phase: "removing" });
        }
        const marker = await removalMarkerPresent(administrativeDirectory, operationId);
        if (marker === null) {
          progress.retained = true;
          throw WorktreeOperationError.of("identity-uncertain", "The removal could not be verified. Nothing more was changed; refresh the inventory.", { retry: "refresh", phase: "removing" });
        }
        const stillOurs = after.present && after.identity?.checkoutId === checkout.checkoutId && after.identity.repositoryId === checkout.repositoryId;
        if (!removed.ok || stillOurs) {
          if (!removed.ok && !stillOurs && after.present) {
            // Git failed AND the path now holds something else: uncertain;
            // the journal stays for recovery to reconcile.
            progress.retained = true;
            throw WorktreeOperationError.of("identity-uncertain", "The worktree's location changed during removal. Nothing more was removed; refresh the inventory.", { retry: "refresh", phase: "removing" });
          }
          // Still ours: nothing was removed, so nothing is left to recover.
          if (!stillOurs) progress.retained = true;
          throw removed.ok
            ? WorktreeOperationError.of("conflict", "Git reported success but the worktree is still present. Nothing was unregistered.", { retry: "refresh", phase: "removing" })
            : removed.error;
        }
        // Verified gone. From here only Hub metadata is touched.
        progress.phase = "unregistering";
        progress.retained = true;
        const intent = await this.options.journal.advance(operationId, "unregistering") as WorktreeDeleteIntent;
        try {
          await this.completeRemoval(intent, true);
        } catch (error) {
          throw WorktreeOperationError.of("internal", "The worktree's files were removed and its branch kept, but Hub cleanup did not finish. Retry to finish it.", { retry: "retry-delete", phase: "unregistering" }, { cause: error });
        }
        await this.options.journal.advance(operationId, "complete");
        await clear();
      });
      if (outcome.status === "needs-stop") {
        await clear();
        return refuse(WorktreeOperationError.of("conflict", "This worktree started running. Choose Stop and delete to stop its Uatu sessions first. Nothing was removed.", { retry: "retry-delete", phase: "fencing" }), "fencing");
      }
      // The registration is gone with the files, so the reported checkout
      // carries no workspace id: `registered` and `workspaceId` are one fact
      // in the contract, and a removed tree must not still name a live one.
      const { workspaceId: _unregistered, ...removed } = checkout;
      return { ok: true, operationId, kind: "delete", phase: "complete", checkout: { ...removed, registered: false, running: false }, registered: false, started: false };
    } catch (error) {
      if (!progress.retained) {
        // Keep the proof that removal did not happen until the journal is
        // durably gone. This covers final-probe exceptions and Git refusals
        // too; if clearing fails, recovery still has the marker it needs.
        // Intentionally retained/uncertain outcomes must keep both records.
        await clear().then(async () => {
          if (progress.markerWritten) await clearRemovalMarker(administrativeDirectory);
        }).catch(() => undefined);
      }
      if (progress.phase === "stopping" && !(error instanceof WorktreeOperationError)) {
        return refuse(WorktreeOperationError.of("stop-failed", "Its Uatu sessions could not be stopped, so nothing was removed.", { retry: "retry-delete", phase: "stopping" }), "stopping");
      }
      return refuse(error, progress.phase);
    }
  }

  // The Hub side of a verified removal. Provenance FIRST: Git reuses a
  // removed tree's administrative name, so a later tree at the same path
  // carries the same checkout identity and must not find our record. The
  // registration is removed only while it still names that checkout; a
  // workspace that has since taken the id or the path is left alone.
  private async completeRemoval(intent: WorktreeDeleteIntent, queueHeld: boolean): Promise<void> {
    await this.options.provenance.forgetCheckout(intent.checkoutId);
    const workspaceId = intent.workspaceId;
    if (workspaceId === undefined) return;
    const unregister = async () => {
      const entry = this.options.registry.byId(workspaceId);
      if (!entry || entry.worktree?.checkoutId !== intent.checkoutId || entry.path !== intent.destination) return;
      await this.options.unregister!(workspaceId);
    };
    if (queueHeld || !this.options.sessions.runExclusive) await unregister();
    else await this.options.sessions.runExclusive(workspaceId, unregister);
  }

  // --- Forget ("Remove from Uatu") --------------------------------------------

  // Unregisters a STOPPED workspace and nothing else: checkout, branch,
  // files and creation provenance all stay, so re-registering the same
  // verified tree later recovers its Uatu ownership.
  async forget(user: string, request: WorktreeForgetRequest): Promise<WorktreeOperationResult> {
    const operationId = this.newOperationId();
    const refuse = (error: unknown): WorktreeOperationResult => ({
      ok: false, operationId, kind: "forget", error: toWorktreeError(error, "The workspace could not be removed from Uatu. Nothing changed."),
    });
    void user;
    try {
      const { sessions } = this.options;
      if (!this.options.unregister || !sessions.runWithSessionsStopped || !sessions.isStarting) {
        throw WorktreeOperationError.of("internal", "Removing a worktree from Uatu is unavailable on this Hub.");
      }
      const entry = this.options.registry.byId(request.reference);
      if (!entry) throw WorktreeOperationError.of("not-found", "That workspace is not registered. Refresh and try again.", { retry: "refresh" });
      const source = this.options.registry.byId(request.sourceWorkspaceId);
      const family = entry.worktree?.parentWorkspaceId ?? entry.id;
      if (!source || (source.worktree?.parentWorkspaceId ?? source.id) !== family) {
        throw WorktreeOperationError.of("not-found", "That workspace does not belong to this repository.");
      }
      // A main workspace owns its children's live policy: removing it first
      // would leave them governed by nothing.
      assertNoRegisteredWorktreeDependents(this.options.registry, entry.id);
      // Holding the lifecycle queue fences starts AND child onboarding, which
      // acquires the parent queue together with its own before committing.
      // The stop (when authorized) and final dependent check happen under it,
      // and unregistration runs only once stopped.
      const outcome = await sessions.runWithSessionsStopped([entry.id], request.stop === true, async () => {
        await this.options.assertOperationsAllowed?.();
        const current = this.options.registry.byId(entry.id);
        if (!current || current.path !== entry.path) {
          throw WorktreeOperationError.of("not-found", "That workspace changed. Refresh and try again.", { retry: "refresh" });
        }
        assertNoRegisteredWorktreeDependents(this.options.registry, entry.id);
        await this.options.unregister!(entry.id);
      });
      if (outcome.status === "needs-stop") {
        throw WorktreeOperationError.of("conflict", "Stop this workspace before removing it from Uatu. Nothing changed.");
      }
      return { ok: true, operationId, kind: "forget", phase: "complete", registered: false, started: false };
    } catch (error) {
      if (error instanceof AggregateError) {
        return refuse(WorktreeOperationError.of("stop-failed", "Its Uatu sessions could not be stopped, so it was not removed from Uatu.", { retry: "none" }));
      }
      return refuse(error);
    }
  }

  // --- Start guard -------------------------------------------------------------

  // A registered child starts only while its recorded checkout is the one at
  // its path: a missing tree cannot start, and a replaced one must never
  // start a session inside somebody else's checkout.
  async assertStartable(workspaceId: string): Promise<void> {
    const entry = this.options.registry.byId(workspaceId);
    if (!entry?.worktree) return;
    const inspection = await inspectCheckout(entry.path, { ...this.options.git, run: this.run });
    if (!inspection.present) {
      throw WorktreeOperationError.of("identity-uncertain", "This worktree's folder is missing. Restore it outside Uatu, then refresh; nothing will be recreated.", { retry: "refresh" });
    }
    if (!inspection.identityReadable || inspection.identity?.checkoutId !== entry.worktree.checkoutId || inspection.identity.repositoryId !== entry.worktree.repositoryId) {
      throw WorktreeOperationError.of("identity-uncertain", "This worktree's folder now holds a different checkout. Resolve it outside Uatu before starting.", { retry: "refresh" });
    }
  }

  // Cheap facts for the Hub state list: provenance by the registration's
  // recorded identity plus a filesystem/identity probe of its path. The
  // probe runs Git only for a present path, once per registered child.
  async registeredOwnership(workspaceId: string): Promise<"uatu" | "external" | "uncertain"> {
    return (await this.registeredClassification(workspaceId)).ownership;
  }

  async registeredAvailability(workspaceId: string): Promise<"present" | "missing" | "replaced"> {
    return (await this.registeredClassification(workspaceId)).value;
  }

  private async registeredClassification(workspaceId: string): Promise<{ ownership: "uatu" | "external" | "uncertain"; value: "present" | "missing" | "replaced" }> {
    const entry = this.options.registry.byId(workspaceId);
    const link = entry?.worktree;
    if (!entry || !link) return { ownership: "external", value: "present" };
    const cached = this.availabilityCache.get(workspaceId);
    const now = this.now();
    const matches = (item: typeof cached) => item?.path === entry.path && item.repositoryId === link.repositoryId && item.checkoutId === link.checkoutId;
    if (cached && now - cached.at < AVAILABILITY_CACHE_MS && matches(cached)) return cached;
    const inspection = await inspectCheckout(entry.path, { ...this.options.git, run: this.run });
    const resolved = await ownershipForCheckout({ provenance: this.options.provenance, inspection, checkoutPath: entry.path, registeredIdentity: link });
    const refreshed = this.availabilityCache.get(workspaceId);
    if (refreshed && refreshed !== cached && matches(refreshed)) return refreshed;
    const value = { at: now, path: entry.path, repositoryId: link.repositoryId, checkoutId: link.checkoutId,
      value: resolved.availability, ownership: resolved.ownership as "uatu" | "external" | "uncertain" };
    this.availabilityCache.set(workspaceId, value);
    return value;
  }

  branchOrigin(repositoryId: string, branch: string): Promise<string | undefined> {
    return this.options.provenance.branchOrigin(repositoryId, branch);
  }

  // Maps any registered workspace to the main workspace its repository's
  // operations run against.
  sourceFor(workspaceId: string): string | undefined {
    const entry = this.options.registry.byId(workspaceId);
    if (!entry) return undefined;
    const parent = entry.worktree?.parentWorkspaceId;
    if (parent === undefined) return entry.id;
    return this.options.registry.byId(parent) ? parent : undefined;
  }

  // Every registered workspace whose picker shows this repository.
  familyOf(sourceWorkspaceId: string): string[] {
    return [sourceWorkspaceId, ...this.options.registry.list()
      .filter(entry => entry.worktree?.parentWorkspaceId === sourceWorkspaceId)
      .map(entry => entry.id)];
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

  // Startup and request-time reconciliation share the same fence as mutation.
  // A retry must not inspect/clear an ACTIVE deletion, nor recover a successor
  // that took the single journal slot while it waited for the repository.
  async recover(expectedOperationId?: string): Promise<WorktreeRecoveryOutcome | undefined> {
    const changed = () => WorktreeOperationError.of("conflict", "The pending worktree operation changed. Refresh before retrying.", { retry: "refresh" });
    const pending = await this.options.journal.read();
    if (expectedOperationId !== undefined && pending?.operationId !== expectedOperationId) throw changed();
    if (!pending) return undefined;
    return this.coordinator.run({ repositoryId: pending.repositoryId, paths: [pending.sourcePath, pending.destination] }, async () => {
      const current = await this.options.journal.read();
      if (current?.operationId !== pending.operationId) throw changed();
      return recoverWorktreeOperation({
        journal: this.options.journal,
        provenance: this.options.provenance,
        inspect: checkoutPath => inspectCheckout(checkoutPath, { ...this.options.git, run: this.run }),
        registeredWorkspaceId: checkoutPath => this.options.registry.byPath(checkoutPath)?.id,
        ...(this.options.unregister ? { completeRemoval: (intent: WorktreeDeleteIntent) => this.completeRemoval(intent, false) } : {}),
      });
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
      ...(plan.sourceRef === undefined ? {} : { sourceRef: plan.sourceRef }),
      ...(plan.upstream === undefined ? {} : { upstream: plan.upstream }),
    };
    return checkout;
  }
}
