import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RunningSession, SessionBackend } from "./backend";
import {
  EMPTY_CREDENTIAL_CONTEXT_RESOLVER,
  EMPTY_RESOLVED_CREDENTIAL_CONTEXT,
  type CredentialContextResolver,
  type ResolvedCredentialContext,
} from "./credential-context";
import type { SshCredentialRecord, TokenCredentialRecord } from "./credential-types";
import { WorkspaceRegistry } from "./registry";
import { SessionManager } from "./sessions";

const tempDirectories: string[] = [];

// Lifecycle operations run on the workspace's chain (a microtask later),
// so tests yield once before touching hooks the operation installs.
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function fakeSession(workspaceId: string, onStop?: () => void): RunningSession {
  return {
    workspaceId,
    basePath: `/s/${workspaceId}/`,
    endpoint: { hostname: "127.0.0.1", port: 1 },
    token: null,
    exited: new Promise<number | null>(() => undefined),
    stop: async () => onStop?.(),
  };
}

describe("SessionManager.isStarting", () => {
  test("reports in-flight starts so forget cannot race a spawning child", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/slow");

    let releaseStart!: (session: RunningSession) => void;
    const backend: SessionBackend = {
      start: (_workspace, _basePath, _credentials) =>
        new Promise<RunningSession>(resolve => {
          releaseStart = resolve;
        }),
    };
    const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);

    expect(sessions.isStarting("slow")).toBe(false);
    const startPromise = sessions.start("slow");
    // Backend start is in flight: starting, not yet running.
    expect(sessions.isStarting("slow")).toBe(true);
    expect(sessions.isRunning("slow")).toBe(false);

    await tick();
    releaseStart(fakeSession("slow"));
    await startPromise;
    expect(sessions.isStarting("slow")).toBe(false);
    expect(sessions.isRunning("slow")).toBe(true);
  });
});

describe("SessionManager credential contexts", () => {
  test("passes the resolved context explicitly and reports assignment changes as restart-required", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-session-credentials-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/project");
    let revision = "before";
    const resolver: CredentialContextResolver = {
      revision: () => revision,
      runExclusive: operation => operation(),
      resolve: async (): Promise<ResolvedCredentialContext> => ({
        ...structuredClone(EMPTY_RESOLVED_CREDENTIAL_CONTEXT),
        revision,
      }),
    };
    let received: ResolvedCredentialContext | undefined;
    const backend: SessionBackend = {
      start: async (workspace, _basePath, credentials) => {
        received = credentials;
        return fakeSession(workspace.id);
      },
    };
    const sessions = new SessionManager(registry, { local: backend }, resolver);

    await sessions.start("project");
    expect(received?.revision).toBe("before");
    expect(sessions.credentialRestartRequired("project")).toBe(false);
    revision = "after";
    expect(sessions.credentialRestartRequired("project")).toBe(true);
    await sessions.stop("project");
    expect(sessions.credentialRestartRequired("project")).toBe(false);
  });

  test("tracks projected credential ids and clears them when the child exits", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-session-projections-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/projected");
    const token: TokenCredentialRecord = {
      id: "provider-token",
      name: "Provider token",
      type: "token",
      enabled: true,
      capabilities: ["github-cli"],
      metadata: { host: "github.com" },
      createdAt: "2026-08-22T00:00:00.000Z",
    };
    const signing: SshCredentialRecord = {
      id: "signing-key",
      name: "Signing key",
      type: "ssh",
      enabled: true,
      capabilities: ["ssh-signing"],
      metadata: { publicKey: "ssh-ed25519 AAAATEST", fingerprint: "SHA256:test" },
      createdAt: "2026-08-22T00:00:00.000Z",
    };
    let markExited!: (code: number | null) => void;
    const exited = new Promise<number | null>(resolve => { markExited = resolve; });
    const resolver: CredentialContextResolver = {
      revision: () => "projected",
      runExclusive: operation => operation(),
      resolve: async () => ({
        ...structuredClone(EMPTY_RESOLVED_CREDENTIAL_CONTEXT),
        authentication: [{ host: "github.com", credential: token, token: "secret" }],
        signing,
      }),
    };
    const backend: SessionBackend = {
      start: async workspace => ({ ...fakeSession(workspace.id), exited }),
    };
    const sessions = new SessionManager(registry, { local: backend }, resolver);

    await sessions.start("projected");
    expect(sessions.runningWorkspaceIdsUsingCredential(token.id)).toEqual(["projected"]);
    expect(sessions.runningWorkspaceIdsUsingCredential(signing.id)).toEqual(["projected"]);
    markExited(1);
    await tick();
    expect(sessions.runningWorkspaceIdsUsingCredential(token.id)).toEqual([]);
    expect(sessions.runningWorkspaceIdsUsingCredential(signing.id)).toEqual([]);
  });
});

describe("SessionManager credential runtime section", () => {
  test("holds one runtime section across context resolution and the spawn", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-runtime-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/sectioned");
    const events: string[] = [];
    const resolver: CredentialContextResolver = {
      revision: () => "steady",
      runExclusive: async operation => {
        events.push("enter");
        try {
          return await operation();
        } finally {
          events.push("exit");
        }
      },
      resolve: async () => {
        events.push("resolve");
        return structuredClone(EMPTY_RESOLVED_CREDENTIAL_CONTEXT);
      },
    };
    const backend: SessionBackend = {
      start: async workspace => {
        events.push("spawn");
        return fakeSession(workspace.id);
      },
    };
    const sessions = new SessionManager(registry, { local: backend }, resolver);

    await sessions.start("sectioned");
    // An agent replacement drains gate sections, so spawning inside the
    // section means the child captures a socket no replacement has retired.
    expect(events).toEqual(["enter", "resolve", "spawn", "exit"]);
  });
});

describe("SessionManager.stop during an in-flight start", () => {
  test("awaits the start and terminates the child instead of reporting not-running", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-stop-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/slow");

    let releaseStart!: (session: RunningSession) => void;
    const backend: SessionBackend = {
      start: (_workspace, _basePath, _credentials) =>
        new Promise<RunningSession>(resolve => {
          releaseStart = resolve;
        }),
    };
    const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);

    let stopped = false;
    void sessions.start("slow");
    const stopPromise = sessions.stop("slow");
    await tick();
    // The spawn resolves AFTER the stop was requested — the classic race.
    releaseStart(fakeSession("slow", () => {
      stopped = true;
    }));

    expect(await stopPromise).toBe(true);
    expect(stopped).toBe(true);
    expect(sessions.isRunning("slow")).toBe(false);
    expect(sessions.isStarting("slow")).toBe(false);
  });

  test("stopAll settles in-flight starts and terminates their children", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-stopall-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/slow");

    let releaseStart!: (session: RunningSession) => void;
    const backend: SessionBackend = {
      start: (_workspace, _basePath, _credentials) =>
        new Promise<RunningSession>(resolve => {
          releaseStart = resolve;
        }),
    };
    const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);

    let stopped = false;
    void sessions.start("slow");
    const stopAllPromise = sessions.stopAll();
    await tick();
    releaseStart(fakeSession("slow", () => {
      stopped = true;
    }));
    await stopAllPromise;
    expect(stopped).toBe(true);
    expect(sessions.runningIds()).toEqual([]);
  });

  test("stopAll waits for a lifecycle-held start and terminates its child", async () => {
    // Onboarding's in-commit start runs inside a lifecycle section it
    // already holds, so it never publishes into `starting`. Shutdown
    // arriving while the backend spawn is in flight must still cover it,
    // or the child finishes spawning after the state lease is released.
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-stopall-held-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/committing");

    let releaseStart!: (session: RunningSession) => void;
    const backend: SessionBackend = {
      start: () =>
        new Promise<RunningSession>(resolve => {
          releaseStart = resolve;
        }),
    };
    const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);

    // The commit holds the queue and starts inside it.
    const commit = sessions.runExclusive("committing", () => sessions.startWhileLifecycleQueueHeld("committing"));
    await tick();
    expect(sessions.isRunning("committing")).toBe(false);
    expect(sessions.isStarting("committing")).toBe(false);

    let stopped = false;
    const stopAllPromise = sessions.stopAll();
    await tick();
    // The spawn resolves after shutdown began — exactly the leak window.
    releaseStart(fakeSession("committing", () => {
      stopped = true;
    }));

    await commit;
    await stopAllPromise;
    expect(stopped).toBe(true);
    expect(sessions.runningIds()).toEqual([]);
  });

  test("stopAll refuses an in-commit start that enters after its snapshot", async () => {
    // The commit holds the lifecycle queue from its first store write, but
    // only announces the start when it reaches startWhileLifecycleQueueHeld.
    // A shutdown landing in between snapshots no work at all — nothing is
    // running, starting, or lifecycle-held — so it finishes and releases the
    // state lease while the accepted handler is still mid-commit. The start
    // that follows must be refused, not spawned.
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-stopall-late-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/committing");

    let spawned = 0;
    const backend: SessionBackend = {
      start: async workspace => {
        spawned += 1;
        return fakeSession(workspace.id);
      },
    };
    const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);

    let releasePersistence!: () => void;
    const persisted = new Promise<void>(resolve => { releasePersistence = resolve; });
    let startError: unknown;
    const commit = sessions.runExclusive("committing", async () => {
      // Stands in for the registry save and the assignment commit.
      await persisted;
      try {
        await sessions.startWhileLifecycleQueueHeld("committing");
      } catch (error) {
        // Exactly how the onboarding coordinator absorbs a failed
        // explicitly-requested start: committed, stopped, error reported.
        startError = error;
      }
    });
    await tick();

    await sessions.stopAll();
    releasePersistence();
    await commit;

    expect(spawned).toBe(0);
    expect(startError).toBeInstanceOf(Error);
    expect((startError as Error).message).toContain("shutting down");
    expect(sessions.runningIds()).toEqual([]);
    expect(sessions.isStarting("committing")).toBe(false);
  });

  test("stopAll refuses a start requested after its snapshot", async () => {
    // Same window through the public path: stopServer() lets an accepted
    // request finish, and its POST .../start reaches the manager after
    // shutdown snapshotted.
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-stopall-late-start-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/late");

    let spawned = 0;
    const backend: SessionBackend = {
      start: async workspace => {
        spawned += 1;
        return fakeSession(workspace.id);
      },
    };
    const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);

    await sessions.stopAll();
    let rolledBack = false;
    await expect(sessions.start("late", async () => { rolledBack = true; })).rejects.toThrow(/shutting down/);
    expect(spawned).toBe(0);
    // The refusal is not a start failure: nothing may mutate registered
    // state while teardown is finishing.
    expect(rolledBack).toBe(false);
    expect(sessions.isStarting("late")).toBe(false);
    expect(sessions.runningIds()).toEqual([]);
  });

  test("stopAll attempts every session and aggregates failures", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-stopall-fail-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/first");
    await registry.register("/srv/workspaces/second");
    const stopped: string[] = [];
    const backend: SessionBackend = {
      start: async workspace => ({
        ...fakeSession(workspace.id),
        stop: async () => {
          stopped.push(workspace.id);
          throw new Error(`${workspace.id} refused stop`);
        },
      }),
    };
    const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
    await Promise.all([sessions.start("first"), sessions.start("second")]);

    let failure: unknown;
    try {
      await sessions.stopAll();
    } catch (error) {
      failure = error;
    }
    expect(new Set(stopped)).toEqual(new Set(["first", "second"]));
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
  });
});

describe("SessionManager start during an in-flight stop", () => {
  test("queue-owned stop preserves running state and credential revision on failure", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-exclusive-stop-fail-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/exclusive-stop-fail");
    let revision = "started";
    let failStop = true;
    const token: TokenCredentialRecord = {
      id: "stop-token",
      name: "Stop token",
      type: "token",
      enabled: true,
      capabilities: ["gitlab-cli"],
      metadata: { host: "gitlab.com" },
      createdAt: "2026-08-22T00:00:00.000Z",
    };
    const resolver: CredentialContextResolver = {
      revision: () => revision,
      runExclusive: operation => operation(),
      resolve: async () => ({
        ...structuredClone(EMPTY_RESOLVED_CREDENTIAL_CONTEXT),
        revision,
        authentication: [{ host: "gitlab.com", credential: token, token: "secret" }],
      }),
    };
    const backend: SessionBackend = {
      start: async workspace => ({
        ...fakeSession(workspace.id),
        stop: async () => {
          if (failStop) throw new Error("backend refused queue-owned stop");
        },
      }),
    };
    const sessions = new SessionManager(registry, { local: backend }, resolver);
    await sessions.start("exclusive-stop-fail");
    revision = "changed";
    expect(sessions.runningWorkspaceIdsUsingCredential(token.id)).toEqual(["exclusive-stop-fail"]);

    await expect(sessions.runExclusive("exclusive-stop-fail", () =>
      sessions.stopWhileLifecycleQueueHeld("exclusive-stop-fail"))).rejects.toThrow("backend refused queue-owned stop");
    expect(sessions.isRunning("exclusive-stop-fail")).toBe(true);
    expect(sessions.credentialRestartRequired("exclusive-stop-fail")).toBe(true);
    expect(sessions.runningWorkspaceIdsUsingCredential(token.id)).toEqual(["exclusive-stop-fail"]);

    failStop = false;
    expect(await sessions.runExclusive("exclusive-stop-fail", () =>
      sessions.stopWhileLifecycleQueueHeld("exclusive-stop-fail"))).toBe(true);
    expect(sessions.isRunning("exclusive-stop-fail")).toBe(false);
    expect(sessions.credentialRestartRequired("exclusive-stop-fail")).toBe(false);
    expect(sessions.runningWorkspaceIdsUsingCredential(token.id)).toEqual([]);
  });

  test("a failed backend stop retains the running session for retry", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-stop-fail-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/stop-fail");

    let stopCalls = 0;
    const backend: SessionBackend = {
      start: async (_workspace, _basePath, _credentials) => ({
        ...fakeSession("stop-fail"),
        stop: async () => {
          stopCalls += 1;
          if (stopCalls === 1) throw new Error("backend refused stop");
        },
      }),
    };
    const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
    await sessions.start("stop-fail");

    await expect(sessions.stop("stop-fail")).rejects.toThrow("backend refused stop");
    expect(sessions.isRunning("stop-fail")).toBe(true);
    expect(await sessions.stop("stop-fail")).toBe(true);
    expect(sessions.isRunning("stop-fail")).toBe(false);
  });

  test("start waits for the teardown instead of spawning a second child", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-race-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/contended");

    let startCalls = 0;
    let releaseStop!: () => void;
    const backend: SessionBackend = {
      start: async (_workspace, _basePath, _credentials) => {
        startCalls += 1;
        const id = startCalls;
        return {
          workspaceId: "contended",
          basePath: "/s/contended/",
          endpoint: { hostname: "127.0.0.1", port: id },
          token: null,
          exited: new Promise<number | null>(() => undefined),
          stop: () =>
            id === 1
              ? new Promise<void>(resolve => {
                  releaseStop = resolve;
                })
              : Promise.resolve(),
        };
      },
    };
    const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);

    await sessions.start("contended");
    expect(startCalls).toBe(1);

    const stopPromise = sessions.stop("contended");
    await tick();
    // Old child is mid-teardown; a concurrent start must NOT spawn yet.
    const startPromise = sessions.start("contended");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(startCalls).toBe(1);

    releaseStop();
    const [stopped, restarted] = await Promise.all([stopPromise, startPromise]);
    expect(stopped).toBe(true);
    expect(startCalls).toBe(2);
    expect(restarted.endpoint.port).toBe(2);
    expect(sessions.isRunning("contended")).toBe(true);
  });
});

describe("SessionManager serialized lifecycle", () => {
  test("a stop arriving behind a queued start terminates that start's child", async () => {
    // The ninth-review scenario: stop A pending → start queued behind the
    // teardown → second stop arrives. With serialized ops the second stop
    // runs AFTER the queued start, sees its installed child, and stops it.
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-chain-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/chained");

    let startCalls = 0;
    const stops: number[] = [];
    let releaseFirstStop!: () => void;
    const backend: SessionBackend = {
      start: async (_workspace, _basePath, _credentials) => {
        startCalls += 1;
        const id = startCalls;
        return {
          workspaceId: "chained",
          basePath: "/s/chained/",
          endpoint: { hostname: "127.0.0.1", port: id },
          token: null,
          exited: new Promise<number | null>(() => undefined),
          stop: () => {
            stops.push(id);
            return id === 1
              ? new Promise<void>(resolve => {
                  releaseFirstStop = resolve;
                })
              : Promise.resolve();
          },
        };
      },
    };
    const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);

    await sessions.start("chained");
    const firstStop = sessions.stop("chained");
    const queuedStart = sessions.start("chained");
    // The queued start is visible immediately — this is what lets gates
    // and later stops account for it.
    expect(sessions.isStarting("chained")).toBe(true);
    const secondStop = sessions.stop("chained");

    await tick();
    releaseFirstStop();
    const [stopped1, restarted, stopped2] = await Promise.all([firstStop, queuedStart, secondStop]);
    expect(stopped1).toBe(true);
    expect(restarted.endpoint.port).toBe(2);
    // The second stop found and terminated the queued start's child.
    expect(stopped2).toBe(true);
    expect(stops).toEqual([1, 2]);
    expect(sessions.isRunning("chained")).toBe(false);
    expect(sessions.isStarting("chained")).toBe(false);
  });

  test("concurrent start() calls join the same pending start", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-join-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/joined");

    let startCalls = 0;
    let releaseStart!: (session: RunningSession) => void;
    const backend: SessionBackend = {
      start: (_workspace, _basePath, _credentials) => {
        startCalls += 1;
        return new Promise<RunningSession>(resolve => {
          releaseStart = resolve;
        });
      },
    };
    const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);

    const a = sessions.start("joined");
    const b = sessions.start("joined");
    await tick();
    releaseStart(fakeSession("joined"));
    const [sessionA, sessionB] = await Promise.all([a, b]);
    expect(startCalls).toBe(1);
    expect(sessionA).toBe(sessionB);
  });

  test("runs failed-start cleanup before the next workspace mutation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-cleanup-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/cleanup");
    const order: string[] = [];
    let rejectStart!: (error: Error) => void;
    const backend: SessionBackend = {
      start: () => new Promise<RunningSession>((_resolve, reject) => {
        order.push("start");
        rejectStart = reject;
      }),
    };
    const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
    const starting = sessions.start("cleanup");
    const joined = sessions.start("cleanup", async () => { order.push("cleanup"); });
    const queued = sessions.runExclusive("cleanup", async () => { order.push("queued"); });
    await tick();
    rejectStart(new Error("failed"));

    await expect(starting).rejects.toThrow("failed");
    await expect(joined).rejects.toThrow("failed");
    await queued;
    expect(order).toEqual(["start", "cleanup", "queued"]);
  });

  test("runs stop cleanup before the next workspace mutation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-stop-cleanup-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/stop-cleanup");
    const order: string[] = [];
    const backend: SessionBackend = {
      start: async workspace => fakeSession(workspace.id, () => order.push("stop")),
    };
    const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
    await sessions.start("stop-cleanup");

    const stopping = sessions.stop("stop-cleanup", async () => { order.push("cleanup"); });
    const queued = sessions.runExclusive("stop-cleanup", async () => { order.push("queued"); });
    expect(await stopping).toBe(true);
    await queued;
    expect(order).toEqual(["stop", "cleanup", "queued"]);

    // Without a live child (it may have crashed and been reaped) the cleanup
    // still runs — the caller's rollback must not depend on the child.
    expect(await sessions.stop("stop-cleanup", async () => { order.push("reaped-cleanup"); })).toBe(false);
    expect(order).toEqual(["stop", "cleanup", "queued", "reaped-cleanup"]);
  });

  test("skips stop cleanup when the child refuses to stop", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-stop-refused-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/stop-refused");
    const backend: SessionBackend = {
      start: async workspace => ({
        ...fakeSession(workspace.id),
        stop: async () => { throw new Error("backend refused stop"); },
      }),
    };
    const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
    await sessions.start("stop-refused");

    let cleaned = false;
    await expect(sessions.stop("stop-refused", async () => { cleaned = true; })).rejects.toThrow("backend refused stop");
    expect(cleaned).toBe(false);
    expect(sessions.isRunning("stop-refused")).toBe(true);
  });
});

describe("SessionManager composite lifecycle barrier", () => {
  test("reports every running or in-flight affected workspace without stopping or mutating", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-composite-conflict-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/alpha");
    await registry.register("/srv/workspaces/beta");

    let releaseBeta!: (session: RunningSession) => void;
    const stopped: string[] = [];
    const backend: SessionBackend = {
      start: workspace => workspace.id === "beta"
        ? new Promise<RunningSession>(resolve => { releaseBeta = resolve; })
        : Promise.resolve(fakeSession(workspace.id, () => stopped.push(workspace.id))),
    };
    const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
    await sessions.start("alpha");
    const betaStart = sessions.start("beta");
    let mutated = false;
    const resultPromise = sessions.runWithSessionsStopped(
      ["beta", "alpha", "beta"],
      false,
      async () => { mutated = true; },
    );

    await tick();
    releaseBeta(fakeSession("beta", () => stopped.push("beta")));
    await betaStart;

    expect(await resultPromise).toEqual({ status: "needs-stop", workspaceIds: ["alpha", "beta"] });
    expect(stopped).toEqual([]);
    expect(mutated).toBe(false);
    expect(sessions.runningIds().sort()).toEqual(["alpha", "beta"]);
  });

  test("authorized operation stops running and in-flight sessions before its callback", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-composite-stop-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/alpha");
    await registry.register("/srv/workspaces/beta");
    const token: TokenCredentialRecord = {
      id: "composite-token",
      name: "Composite token",
      type: "token",
      enabled: true,
      capabilities: ["github-cli"],
      metadata: { host: "github.com" },
      createdAt: "2026-08-23T00:00:00.000Z",
    };
    const resolver: CredentialContextResolver = {
      revision: () => "composite",
      runExclusive: operation => operation(),
      resolve: async () => ({
        ...structuredClone(EMPTY_RESOLVED_CREDENTIAL_CONTEXT),
        authentication: [{ host: "github.com", credential: token, token: "secret" }],
      }),
    };
    let releaseBeta!: (session: RunningSession) => void;
    const events: string[] = [];
    const backend: SessionBackend = {
      start: workspace => workspace.id === "beta"
        ? new Promise<RunningSession>(resolve => { releaseBeta = resolve; })
        : Promise.resolve(fakeSession(workspace.id, () => events.push(`stop:${workspace.id}`))),
    };
    const sessions = new SessionManager(registry, { local: backend }, resolver);
    await sessions.start("alpha");
    const betaStart = sessions.start("beta");
    const resultPromise = sessions.runWithSessionsStopped(["beta", "alpha"], true, async () => {
      events.push("callback");
      expect(sessions.runningIds()).toEqual([]);
      expect(sessions.runningWorkspaceIdsUsingCredential(token.id)).toEqual([]);
      return "updated";
    });

    await tick();
    releaseBeta(fakeSession("beta", () => events.push("stop:beta")));
    await betaStart;

    expect(await resultPromise).toEqual({ status: "completed", value: "updated" });
    expect(events).toEqual(["stop:alpha", "stop:beta", "callback"]);
    expect(sessions.isStarting("beta")).toBe(false);
  });

  test("does not invoke the callback when any affected session fails to stop", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-composite-failure-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/alpha");
    await registry.register("/srv/workspaces/beta");
    const stops: string[] = [];
    const backend: SessionBackend = {
      start: async workspace => ({
        ...fakeSession(workspace.id),
        stop: async () => {
          stops.push(workspace.id);
          if (workspace.id === "beta") throw new Error("beta refused stop");
        },
      }),
    };
    const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
    await Promise.all([sessions.start("alpha"), sessions.start("beta")]);
    let mutated = false;

    let failure: unknown;
    try {
      await sessions.runWithSessionsStopped(["beta", "alpha"], true, async () => { mutated = true; });
    } catch (error) {
      failure = error;
    }

    expect(stops).toEqual(["alpha", "beta"]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toEqual(new Error("beta refused stop"));
    expect(mutated).toBe(false);
    expect(sessions.isRunning("alpha")).toBe(false);
    expect(sessions.isRunning("beta")).toBe(true);
  });

  test("composite stop coordination cannot deadlock against nested acquisitions", async () => {
    // Mirrors server.ts's revokeExclusive shape: a composite that holds
    // alpha while acquiring beta. If the folder composite installed one
    // simultaneous barrier across both queues, the two would wait on each
    // other forever; sorted nested acquisition shares its total order.
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-composite-deadlock-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/alpha");
    await registry.register("/srv/workspaces/beta");
    const backend: SessionBackend = { start: async workspace => fakeSession(workspace.id) };
    const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);

    let releaseAlpha!: () => void;
    const alphaHeld = new Promise<void>(resolve => { releaseAlpha = resolve; });
    const inflight = sessions.runExclusive("alpha", () => alphaHeld);
    // The nested composite queues on alpha behind the in-flight op...
    const nested = sessions.runExclusive("alpha", () => sessions.runExclusive("beta", async () => "nested"));
    await tick();
    // ...and the folder composite arrives on [alpha, beta] after it.
    const composite = sessions.runWithSessionsStopped(["alpha", "beta"], false, async () => "composite");
    await tick();
    releaseAlpha();

    expect(await nested).toBe("nested");
    expect(await composite).toEqual({ status: "completed", value: "composite" });
    await inflight;
  });

  test("queues a start until a registered path update has completed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-composite-path-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    const workspace = await registry.register("/srv/workspaces/before");
    const startedPaths: string[] = [];
    const backend: SessionBackend = {
      start: async entry => {
        startedPaths.push(entry.path);
        return fakeSession(entry.id);
      },
    };
    const sessions = new SessionManager(registry, { local: backend }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
    let updateEntered!: () => void;
    const entered = new Promise<void>(resolve => { updateEntered = resolve; });
    let finishUpdate!: () => void;
    const updateGate = new Promise<void>(resolve => { finishUpdate = resolve; });
    const update = sessions.runWithSessionsStopped([workspace.id], false, async () => {
      await registry.replacePathPrefix("/srv/workspaces/before", "/srv/workspaces/after");
      updateEntered();
      await updateGate;
    });
    await entered;

    const start = sessions.start(workspace.id);
    const stop = sessions.stop(workspace.id);
    await tick();
    expect(startedPaths).toEqual([]);

    finishUpdate();
    expect(await update).toEqual({ status: "completed", value: undefined });
    await start;
    expect(await stop).toBe(true);
    expect(startedPaths).toEqual(["/srv/workspaces/after"]);
    expect(sessions.isRunning(workspace.id)).toBe(false);
  });
});
