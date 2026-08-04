// A wedged child (accepts connections, never answers) must degrade the
// dashboard's shell summary to "omitted" — not hang /api/hub/state.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RunningSession, SessionBackend } from "./backend";
import { createSessionCookieValue, hashPassword } from "./auth";
import type { HubConfig } from "./config";
import { WorkspaceRegistry } from "./registry";
import { startHubServer } from "./server";
import { SessionManager } from "./sessions";

const KEY = "timeout-test-signing-key-0123456789";

let tempRoot = "";
let tarpit: ReturnType<typeof Bun.serve> | null = null;
let hub: ReturnType<typeof startHubServer> | null = null;
let sessions: SessionManager;

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-tarpit-"));
  // Accepts requests and never responds.
  tarpit = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: () => new Promise<Response>(() => undefined),
  });

  const registry = new WorkspaceRegistry(path.join(tempRoot, "registry.json"));
  await registry.load();
  await registry.register(path.join(tempRoot, "workspaces", "wedged"));

  const backend: SessionBackend = {
    start: async (workspace): Promise<RunningSession> => ({
      workspaceId: workspace.id,
      basePath: `/s/${workspace.id}/`,
      endpoint: { hostname: "127.0.0.1", port: tarpit!.port! },
      token: "tok",
      exited: new Promise<number | null>(() => undefined),
      stop: async () => undefined,
    }),
  };
  sessions = new SessionManager(registry, { local: backend });
  await sessions.start("wedged");

  const config: HubConfig = {
    port: 0 as number,
    host: "127.0.0.1",
    tls: null,
    users: [{ name: "t", passwordHash: await hashPassword("x") }],
    workspacesDir: path.join(tempRoot, "workspaces"),
    stateDir: path.join(tempRoot, "state"),
  };
  hub = startHubServer({ config, registry, sessions, signingKey: KEY });
});

afterAll(async () => {
  hub?.stop(true);
  tarpit?.stop(true);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

describe("hub state with a wedged child", () => {
  test(
    "/api/hub/state completes with the shell summary omitted",
    async () => {
      const cookie = `uatu_hub=${createSessionCookieValue("t", KEY)}`;
      const started = Date.now();
      const response = await fetch(`http://127.0.0.1:${hub!.port}/api/hub/state`, {
        headers: { cookie },
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        workspaces: { id: string; running: boolean; shells?: unknown }[];
      };
      const wedged = payload.workspaces.find(workspace => workspace.id === "wedged");
      expect(wedged?.running).toBe(true);
      expect(wedged?.shells).toBeUndefined();
      // Bounded by the fetch timeout, not the tarpit.
      expect(Date.now() - started).toBeLessThan(5000);
    },
    10_000,
  );
});
