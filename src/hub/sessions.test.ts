import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RunningSession, SessionBackend } from "./backend";
import { WorkspaceRegistry } from "./registry";
import { SessionManager } from "./sessions";

const tempDirectories: string[] = [];

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
