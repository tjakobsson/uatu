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

function fakeSession(workspaceId: string): RunningSession {
  return {
    workspaceId,
    basePath: `/s/${workspaceId}/`,
    endpoint: { hostname: "127.0.0.1", port: 1 },
    token: null,
    exited: new Promise<number | null>(() => undefined),
    stop: async () => undefined,
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
