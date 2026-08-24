// The hub's session manager: which workspaces currently have a live child,
// starting and stopping them through the SessionBackend seam, and the
// stop-everything path used at hub shutdown. Purely in-memory — the
// registry owns persistence; a hub restart restarts sessions from the
// dashboard's resume action (see design D7).
//
// LIFECYCLE OPERATIONS ARE SERIALIZED PER WORKSPACE: every start and stop
// runs to completion on that workspace's chain before the next begins, so
// operation interleavings are impossible by construction. This replaced a
// growing choreography of point fixes (stop must cover an in-flight start,
// start must join an in-flight stop, a queued start must be visible to a
// second stop, …) — with a chain, each operation simply observes the true
// settled state left by its predecessor.

import type { RunningSession, SessionBackend } from "./backend";
import type { CredentialContextResolver } from "./credential-context";
import type { WorkspaceEntry, WorkspaceRegistry } from "./registry";

export function sessionBasePath(workspaceId: string): string {
  return `/s/${workspaceId}/`;
}

function shuttingDownMessage(workspaceId: string): string {
  return `the hub is shutting down; refusing to start session '${workspaceId}'`;
}

export type SessionsStoppedResult<T> =
  | { status: "completed"; value: T }
  | { status: "needs-stop"; workspaceIds: string[] };

export class SessionManager {
  private readonly running = new Map<string, RunningSession>();
  // Published at CALL time — before the operation even reaches the front of
  // the chain — so gates (forget) and joiners see a queued start, not just
  // an executing one. Cleared when the call settles.
  private readonly starting = new Map<string, Promise<RunningSession>>();
  // In-flight startWhileLifecycleQueueHeld calls, counted per workspace.
  // These never enter `starting`: that map publishes queue-ENTERING start()
  // calls, and a joiner handed one of these would be waiting on a start it
  // cannot serialize against. Shutdown must still see them, or a child
  // spawning inside an onboarding commit outlives stopAll().
  private readonly lifecycleHeldStarts = new Map<string, number>();
  // Latched by stopAll() BEFORE it snapshots its worklist. The two maps
  // above only cover starts that have already announced themselves; a start
  // that enters afterwards would spawn a child no queued stop covers. The
  // latch never clears: once teardown has begun there is no supported way
  // back to serving, and a hub whose shutdown failed keeps the state lease
  // precisely so nothing new is spawned under it.
  private shuttingDown = false;
  private readonly startFailureCallbacks = new Map<string, Array<() => Promise<void>>>();
  // Per-workspace operation chain tails.
  private readonly lifecycle = new Map<string, Promise<unknown>>();
  private readonly runningCredentialRevisions = new Map<string, string>();
  private readonly runningCredentialIds = new Map<string, Set<string>>();

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly backends: Record<WorkspaceEntry["backend"], SessionBackend>,
    private readonly credentials: CredentialContextResolver,
    // Precondition for spawning a child, evaluated INSIDE the queued start
    // operation (see start()). Injected rather than imported because the
    // folder manager that owns the recovery journal takes this manager as a
    // dependency and is therefore assembled after it.
    private readonly assertStartAllowed?: () => Promise<void>,
  ) {}

  get(workspaceId: string): RunningSession | undefined {
    return this.running.get(workspaceId);
  }

  isRunning(workspaceId: string): boolean {
    return this.running.has(workspaceId);
  }

  // True from the moment a start() call is made until it settles — covering
  // starts still queued behind an earlier operation. Callers that must not
  // race a start (forget, above all) treat this as active.
  isStarting(workspaceId: string): boolean {
    return this.starting.has(workspaceId);
  }

  runningIds(): string[] {
    return [...this.running.keys()];
  }

  runningWorkspaceIdsUsingCredential(credentialId: string): string[] {
    return [...this.runningCredentialIds.entries()]
      .filter(([, credentialIds]) => credentialIds.has(credentialId))
      .map(([workspaceId]) => workspaceId)
      .sort();
  }

  credentialRestartRequired(workspaceId: string): boolean {
    const startedRevision = this.runningCredentialRevisions.get(workspaceId);
    return startedRevision !== undefined && startedRevision !== this.credentials.revision(workspaceId);
  }

  // Enqueues one lifecycle operation behind every earlier one for the same
  // workspace; a failed predecessor does not block successors.
  private enqueue<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycle.get(workspaceId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.lifecycle.set(workspaceId, next.then(
      () => undefined,
      () => undefined,
    ));
    return next;
  }

  runExclusive<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    return this.enqueue(workspaceId, operation);
  }

  runWhileStopped<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    return this.enqueue(workspaceId, async () => {
      if (this.running.has(workspaceId)) {
        throw new Error(`stop the session for '${workspaceId}' before forgetting it`);
      }
      return operation();
    });
  }

  // Acquires every affected queue NESTED in ascending id order — the same
  // total order server.ts's revokeExclusive uses for its multi-workspace
  // acquisitions — so the two composite shapes cannot deadlock. A
  // simultaneous barrier across all queues can: it would hold a later
  // queue while waiting for an earlier queue's predecessor, while that
  // predecessor (a nested composite already holding the earlier queue)
  // waits to acquire the later one.
  async runWithSessionsStopped<T>(
    workspaceIds: Iterable<string>,
    stopAuthorized: boolean,
    operation: () => Promise<T>,
  ): Promise<SessionsStoppedResult<T>> {
    const ids = [...new Set(workspaceIds)].sort();
    const acquire = async (index: number): Promise<SessionsStoppedResult<T>> => {
      if (index < ids.length) {
        return this.enqueue(ids[index]!, () => acquire(index + 1));
      }
      const needsStop = ids.filter(id => this.running.has(id));
      if (needsStop.length > 0 && !stopAuthorized) {
        return { status: "needs-stop", workspaceIds: needsStop };
      }

      if (stopAuthorized) {
        const results = await Promise.allSettled(ids.map(id => this.stopWhileLifecycleQueueHeld(id)));
        const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
        if (failures.length > 0) {
          throw new AggregateError(failures, "one or more affected workspace sessions failed to stop");
        }
      }

      return { status: "completed", value: await operation() };
    };
    return acquire(0);
  }

  // Starts (or joins the pending start of) the session for a registered
  // workspace.
  start(workspaceId: string, onFailure?: () => Promise<void>): Promise<RunningSession> {
    const joined = this.starting.get(workspaceId);
    // A request accepted before stopServer() can reach here after shutdown
    // snapshotted; publishing into `starting` now would be too late to be
    // stopped. Refused before the failure callbacks are registered, so a
    // refusal never triggers a registration rollback mid-teardown — the
    // workspace is simply left registered and stopped. Joining an already
    // published start is still safe: that one IS in the snapshot.
    if (!joined && this.shuttingDown) {
      return Promise.reject(new Error(shuttingDownMessage(workspaceId)));
    }
    if (onFailure) {
      const callbacks = this.startFailureCallbacks.get(workspaceId) ?? [];
      callbacks.push(onFailure);
      this.startFailureCallbacks.set(workspaceId, callbacks);
    }
    if (joined) {
      return joined;
    }

    // The queued operation bypasses the shutdown gate on purpose: this call
    // is published in `starting` from here on, so stopAll() either saw it
    // and queued a stop behind it, or has not latched yet.
    const operation = this.enqueue(workspaceId, () => this.spawnWhileLifecycleQueueHeld(workspaceId, true));

    let published: Promise<RunningSession>;
    published = operation.finally(() => {
      if (this.starting.get(workspaceId) === published) {
        this.starting.delete(workspaceId);
        this.startFailureCallbacks.delete(workspaceId);
      }
    });
    this.starting.set(workspaceId, published);
    return published;
  }

  // PRECONDITION: the caller already owns this workspace's lifecycle queue
  // (or IS the queued start operation). Onboarding uses this to run a
  // requested first start inside the same exclusive section as its
  // two-store commit, so a forget queued mid-commit cannot slip between
  // the commit and the start.
  //
  // Refuses once shutdown has begun. The commit that owns this queue was
  // accepted before stopServer(), but it can arrive here after stopAll()
  // snapshotted — while persisting the registry and assignments, say — and
  // an unregistered start would then spawn a child that outlives teardown.
  // The gate and the registration below are both synchronous with the call,
  // and stopAll() latches before it snapshots, so no start can fall between
  // the two. Onboarding treats the refusal as any other failed in-commit
  // start: the workspace stays committed and stopped, with startError set.
  //
  // Unfenced on purpose (see the fence note in spawnWhileLifecycleQueueHeld):
  // the caller was admitted through its own fence over BOTH recovery
  // journals and has held this workspace's lifecycle queue ever since, so
  // no folder mutation can have journaled in between.
  async startWhileLifecycleQueueHeld(workspaceId: string): Promise<RunningSession> {
    if (this.shuttingDown) throw new Error(shuttingDownMessage(workspaceId));
    return this.spawnWhileLifecycleQueueHeld(workspaceId, false);
  }

  // `fencePendingMutation` marks the entry point that reaches here from
  // outside any exclusive section — start() — and so has to prove no
  // recovery journal is pending itself.
  private async spawnWhileLifecycleQueueHeld(workspaceId: string, fencePendingMutation: boolean): Promise<RunningSession> {
    // Registered for the whole call — including the backend spawn — so a
    // shutdown arriving mid-commit enqueues a stop behind the section that
    // holds this queue, and waits for it there.
    this.lifecycleHeldStarts.set(workspaceId, (this.lifecycleHeldStarts.get(workspaceId) ?? 0) + 1);
    try {
      const existing = this.running.get(workspaceId);
      if (existing) {
        return existing;
      }

      // The folder-mutation journal fence runs HERE, under this workspace's
      // lifecycle queue, and not at the route that asked for the start.
      // Registered folder renames and removals write, clear, and roll back
      // their journal inside the runWithSessionsStopped callback, which
      // holds the lifecycle queue of EVERY workspace the mutation touches
      // for the whole journalled window. So while this operation owns the
      // queue no mutation of this workspace can be mid-journal, and a
      // journal that a failed rollback or finalization left behind is
      // already on disk for the check to observe. A check made before the
      // call — at the route — proves nothing: a mutation may journal
      // between it and the moment the queue grants this operation, and the
      // child would then be spawned with this workspace's credentials and
      // personal identity in whatever content now sits at the registered
      // path. Checked before the spawn block below, so a refusal spawns
      // nothing and mutates no registered state (the caller's failure
      // cleanup unregisters, which is itself fenced while recovery is
      // pending). Skipped for a caller that already owns this queue from an
      // earlier fence of its own — see startWhileLifecycleQueueHeld.
      if (fencePendingMutation) await this.assertStartAllowed?.();

      let workspace: WorkspaceEntry;
      let session: RunningSession;
      let credentialRevision = "";
      let credentialIds = new Set<string>();
      try {
        const found = this.registry.byId(workspaceId);
        if (!found) throw new Error(`unknown workspace: ${workspaceId}`);
        workspace = found;
        const backend = this.backends[workspace.backend];
        if (!backend) throw new Error(`no backend registered for '${workspace.backend}'`);
        // One credential-runtime section spans resolution AND spawn, so a
        // tool-override replacement cannot retire the agent between the
        // gated usability check and the child capturing its socket.
        session = await this.credentials.runExclusive(async () => {
          const credentialContext = await this.credentials.resolve(workspace);
          const started = await backend.start(workspace, sessionBasePath(workspace.id), credentialContext);
          credentialRevision = credentialContext.revision;
          credentialIds = new Set([
            ...credentialContext.authentication.map(item => item.credential.id),
            ...(credentialContext.signing ? [credentialContext.signing.id] : []),
          ]);
          return started;
        });
      } catch (error) {
        const callbacks = this.startFailureCallbacks.get(workspaceId) ?? [];
        for (let index = 0; index < callbacks.length; index += 1) {
          try {
            await callbacks[index]!();
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], `session startup and registration cleanup failed: ${workspaceId}`);
          }
        }
        throw error;
      }
      this.running.set(workspace.id, session);
      this.runningCredentialRevisions.set(workspace.id, credentialRevision);
      this.runningCredentialIds.set(workspace.id, credentialIds);
      // Reap on child exit so a crashed session shows as stopped rather
      // than proxying into a dead endpoint forever.
      void session.exited.then(() => {
        if (this.running.get(workspace.id) === session) {
          this.running.delete(workspace.id);
          this.runningCredentialRevisions.delete(workspace.id);
          this.runningCredentialIds.delete(workspace.id);
        }
      });
      return session;
    } finally {
      const remaining = (this.lifecycleHeldStarts.get(workspaceId) ?? 1) - 1;
      if (remaining > 0) this.lifecycleHeldStarts.set(workspaceId, remaining);
      else this.lifecycleHeldStarts.delete(workspaceId);
    }
  }

  // onStopped runs inside the same lifecycle operation, after the child is
  // down — cleanup that must not interleave with queued operations on this
  // workspace (clone rollback removing the registration) goes there. It runs
  // even when no child was alive (it may have crashed and been reaped), but
  // not when stopping the child fails.
  stop(workspaceId: string, onStopped?: () => Promise<void>): Promise<boolean> {
    return this.enqueue(workspaceId, async () => {
      const stopped = await this.stopWhileLifecycleQueueHeld(workspaceId);
      await onStopped?.();
      return stopped;
    });
  }

  // PRECONDITION: the caller already owns this workspace's lifecycle queue.
  // This does not enqueue or run cleanup callbacks. A failed backend stop
  // leaves the running session, revision, and credential projection intact.
  async stopWhileLifecycleQueueHeld(workspaceId: string): Promise<boolean> {
    const session = this.running.get(workspaceId);
    if (!session) return false;
    await session.stop();
    this.running.delete(workspaceId);
    this.runningCredentialRevisions.delete(workspaceId);
    this.runningCredentialIds.delete(workspaceId);
    return true;
  }

  async stopAll(): Promise<void> {
    // Latched first: from here on no new start is admitted, so the snapshot
    // below is complete rather than merely current.
    this.shuttingDown = true;
    // Every workspace with a live child OR a pending/queued start gets a
    // stop enqueued behind whatever it is doing — including a start running
    // inside a lifecycle section someone else holds (onboarding's in-commit
    // start), which the enqueued stop follows out of that section.
    const ids = new Set([...this.running.keys(), ...this.starting.keys(), ...this.lifecycleHeldStarts.keys()]);
    const results = await Promise.allSettled([...ids].map(id => this.stop(id)));
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "one or more workspace sessions failed to stop");
  }
}
