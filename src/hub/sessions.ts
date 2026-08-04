// The hub's session manager: which workspaces currently have a live child,
// starting and stopping them through the SessionBackend seam, and the
// stop-everything path used at hub shutdown. Purely in-memory — the
// registry owns persistence; a hub restart restarts sessions from the
// dashboard's resume action (see design D7).

import type { RunningSession, SessionBackend } from "./backend";
import type { WorkspaceEntry, WorkspaceRegistry } from "./registry";

export function sessionBasePath(workspaceId: string): string {
  return `/s/${workspaceId}/`;
}

export class SessionManager {
  private readonly running = new Map<string, RunningSession>();
  private readonly starting = new Map<string, Promise<RunningSession>>();
  // Mirror of `starting` for teardown: while a stop is settling, a start
  // for the same workspace must wait — otherwise it would spawn a second
  // child beside the one still shutting down (port/resource overlap, and
  // the old child's exit reaper no longer matches once replaced).
  private readonly stopping = new Map<string, Promise<void>>();

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

  // True while a backend start is in flight but not yet installed. Callers
  // that must not race a start (forget, above all: removing the registry
  // entry mid-start would strand a live child off the dashboard) treat
  // starting as active.
  isStarting(workspaceId: string): boolean {
    return this.starting.has(workspaceId);
  }

  runningIds(): string[] {
    return [...this.running.keys()];
  }

  // Starts (or joins the in-flight start of) the session for a registered
  // workspace. A crashed/exited child is reaped lazily on the next lookup.
  async start(workspaceId: string): Promise<RunningSession> {
    // Join any in-flight stop first — see `stopping` above.
    const stopInFlight = this.stopping.get(workspaceId);
    if (stopInFlight) {
      await stopInFlight.catch(() => undefined);
    }
    const existing = this.running.get(workspaceId);
    if (existing) {
      return existing;
    }
    const inFlight = this.starting.get(workspaceId);
    if (inFlight) {
      return inFlight;
    }

    const workspace = this.registry.byId(workspaceId);
    if (!workspace) {
      throw new Error(`unknown workspace: ${workspaceId}`);
    }
    const backend = this.backends[workspace.backend];
    if (!backend) {
      throw new Error(`no backend registered for '${workspace.backend}'`);
    }

    const startPromise = backend
      .start(workspace, sessionBasePath(workspace.id))
      .then(session => {
        this.running.set(workspace.id, session);
        // Reap on child exit so a crashed session shows as stopped rather
        // than proxying into a dead endpoint forever.
        void session.exited.then(() => {
          if (this.running.get(workspace.id) === session) {
            this.running.delete(workspace.id);
          }
        });
        return session;
      })
      .finally(() => {
        this.starting.delete(workspace.id);
      });

    this.starting.set(workspace.id, startPromise);
    return startPromise;
  }

  async stop(workspaceId: string): Promise<boolean> {
    // A stop must also cover an in-flight start: returning "not running"
    // while backend.start() is pending would let the spawn resolve into a
    // live child moments after the caller was told it was stopped. The
    // start promise's install handler runs before it settles, so awaiting
    // it guarantees the running map reflects the outcome.
    const pending = this.starting.get(workspaceId);
    if (pending) {
      await pending.catch(() => undefined);
    }
    const session = this.running.get(workspaceId);
    if (!session) {
      return false;
    }
    this.running.delete(workspaceId);
    // Publish the teardown so a concurrent start() waits for it instead of
    // spawning a replacement beside the still-exiting child.
    const teardown = session.stop().finally(() => {
      if (this.stopping.get(workspaceId) === teardown) {
        this.stopping.delete(workspaceId);
      }
    });
    this.stopping.set(workspaceId, teardown);
    await teardown;
    return true;
  }

  async stopAll(): Promise<void> {
    // Settle every in-flight start first so late-resolving children are in
    // the running map and get stopped rather than surviving shutdown.
    const pending = [...this.starting.values()];
    if (pending.length > 0) {
      await Promise.all(pending.map(promise => promise.catch(() => undefined)));
    }
    const sessions = [...this.running.values()];
    this.running.clear();
    await Promise.all(sessions.map(session => session.stop().catch(() => undefined)));
    // And any teardown a concurrent per-workspace stop() still owns.
    await Promise.all([...this.stopping.values()].map(promise => promise.catch(() => undefined)));
  }
}
