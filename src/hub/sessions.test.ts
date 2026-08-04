import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RunningSession, SessionBackend } from "./backend";
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
      start: () =>
        new Promise<RunningSession>(resolve => {
          releaseStart = resolve;
        }),
    };
    const sessions = new SessionManager(registry, { local: backend });

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

describe("SessionManager.stop during an in-flight start", () => {
  test("awaits the start and terminates the child instead of reporting not-running", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-stop-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/slow");

    let releaseStart!: (session: RunningSession) => void;
    const backend: SessionBackend = {
      start: () =>
        new Promise<RunningSession>(resolve => {
          releaseStart = resolve;
        }),
    };
    const sessions = new SessionManager(registry, { local: backend });

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
      start: () =>
        new Promise<RunningSession>(resolve => {
          releaseStart = resolve;
        }),
    };
    const sessions = new SessionManager(registry, { local: backend });

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
});

describe("SessionManager start during an in-flight stop", () => {
  test("start waits for the teardown instead of spawning a second child", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-sessions-race-"));
    tempDirectories.push(dir);
    const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
    await registry.load();
    await registry.register("/srv/workspaces/contended");

    let startCalls = 0;
    let releaseStop!: () => void;
    const backend: SessionBackend = {
      start: async () => {
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
    const sessions = new SessionManager(registry, { local: backend });

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
      start: async () => {
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
    const sessions = new SessionManager(registry, { local: backend });

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
      start: () => {
        startCalls += 1;
        return new Promise<RunningSession>(resolve => {
          releaseStart = resolve;
        });
      },
    };
    const sessions = new SessionManager(registry, { local: backend });

    const a = sessions.start("joined");
    const b = sessions.start("joined");
    await tick();
    releaseStart(fakeSession("joined"));
    const [sessionA, sessionB] = await Promise.all([a, b]);
    expect(startCalls).toBe(1);
    expect(sessionA).toBe(sessionB);
  });
});
