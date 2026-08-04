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
import type { WorkspaceEntry, WorkspaceRegistry } from "./registry";

export function sessionBasePath(workspaceId: string): string {
  return `/s/${workspaceId}/`;
}

export class SessionManager {
  private readonly running = new Map<string, RunningSession>();
  // Published at CALL time — before the operation even reaches the front of
  // the chain — so gates (forget) and joiners see a queued start, not just
  // an executing one. Cleared when the call settles.
  private readonly starting = new Map<string, Promise<RunningSession>>();
  // Per-workspace operation chain tails.
  private readonly lifecycle = new Map<string, Promise<unknown>>();

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly backends: Record<WorkspaceEntry["backend"], SessionBackend>,
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

  // Starts (or joins the pending start of) the session for a registered
  // workspace.
  start(workspaceId: string): Promise<RunningSession> {
    const joined = this.starting.get(workspaceId);
    if (joined) {
      return joined;
    }

    const operation = this.enqueue(workspaceId, async () => {
      const existing = this.running.get(workspaceId);
      if (existing) {
        return existing;
      }

      const workspace = this.registry.byId(workspaceId);
      if (!workspace) {
        throw new Error(`unknown workspace: ${workspaceId}`);
      }
      const backend = this.backends[workspace.backend];
      if (!backend) {
        throw new Error(`no backend registered for '${workspace.backend}'`);
      }

      const session = await backend.start(workspace, sessionBasePath(workspace.id));
      this.running.set(workspace.id, session);
      // Reap on child exit so a crashed session shows as stopped rather
      // than proxying into a dead endpoint forever.
      void session.exited.then(() => {
        if (this.running.get(workspace.id) === session) {
          this.running.delete(workspace.id);
        }
      });
      return session;
    });

    let published: Promise<RunningSession>;
    published = operation.finally(() => {
      if (this.starting.get(workspaceId) === published) {
        this.starting.delete(workspaceId);
      }
    });
    this.starting.set(workspaceId, published);
    return published;
  }

  stop(workspaceId: string): Promise<boolean> {
    return this.enqueue(workspaceId, async () => {
      const session = this.running.get(workspaceId);
      if (!session) {
        return false;
      }
      this.running.delete(workspaceId);
      await session.stop();
      return true;
    });
  }

  async stopAll(): Promise<void> {
    // Every workspace with a live child OR a pending/queued start gets a
    // stop enqueued behind whatever it is doing.
    const ids = new Set([...this.running.keys(), ...this.starting.keys()]);
    await Promise.all([...ids].map(id => this.stop(id).catch(() => undefined)));
  }
}
