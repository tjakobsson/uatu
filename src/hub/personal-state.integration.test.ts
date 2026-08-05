import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SessionBackend } from "./backend";
import { createSessionCookieValue } from "./auth";
import type { HubConfig } from "./config";
import { PersonalWorkspaceStateStore } from "./personal-state";
import { WorkspaceRegistry } from "./registry";
import { startHubServer } from "./server";
import { SessionManager } from "./sessions";

const KEY = "personal-state-integration-key-0123456789";
const tempDirectories: string[] = [];
const servers: ReturnType<typeof startHubServer>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(tempDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function startFixture(local = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-personal-api-"));
  tempDirectories.push(dir);
  const registry = new WorkspaceRegistry(path.join(dir, "registry.json"));
  await registry.load();
  await registry.register("/srv/workspaces/project");
  const personalState = new PersonalWorkspaceStateStore(path.join(dir, "personal.json"));
  await personalState.load();
  const backend: SessionBackend = {
    start: async () => {
      throw new Error("personal-state requests must not start or contact a child");
    },
  };
  const sessions = new SessionManager(registry, { local: backend });
  const config: HubConfig = {
    port: 0,
    host: "127.0.0.1",
    tls: null,
    users: local
      ? []
      : [
          { name: "alice", passwordHash: "unused" },
          { name: "bob", passwordHash: "unused" },
        ],
    local,
  };
  const server = startHubServer({ config, registry, sessions, personalState, signingKey: KEY });
  servers.push(server);
  return {
    dir,
    registry,
    personalState,
    origin: `http://127.0.0.1:${server.port}`,
  };
}

function cookie(user: string): string {
  return `uatu_hub=${createSessionCookieValue(user, KEY)}`;
}

describe("Hub personal workspace state API", () => {
  test("is authenticated, user-isolated, partial, and served while the child is stopped", async () => {
    const fixture = await startFixture();
    const url = `${fixture.origin}/s/project/api/personal-state`;
    expect((await fetch(url)).status).toBe(401);

    const initial = await fetch(url, { headers: { cookie: cookie("alice") } });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ version: 1 });

    const patched = await fetch(url, {
      method: "PATCH",
      headers: { cookie: cookie("alice"), origin: fixture.origin, "content-type": "application/json" },
      body: JSON.stringify({ documentPath: "README.md", follow: false }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ version: 1, documentPath: "README.md", follow: false });

    await fetch(url, {
      method: "PATCH",
      headers: { cookie: cookie("alice"), origin: fixture.origin, "content-type": "application/json" },
      body: JSON.stringify({ filesFilter: "changed" }),
    });
    expect(fixture.personalState.get("alice", "project")).toEqual({
      version: 1,
      documentPath: "README.md",
      follow: false,
      filesFilter: "changed",
    });
    expect(fixture.personalState.get("bob", "project")).toEqual({ version: 1 });

    const text = JSON.stringify(await (await fetch(url, { headers: { cookie: cookie("alice") } })).json());
    expect(text).not.toContain("/srv/workspaces/project");
    expect(text).not.toContain("token");

    const reloaded = new PersonalWorkspaceStateStore(path.join(fixture.dir, "personal.json"));
    await reloaded.load();
    expect(reloaded.get("alice", "project").documentPath).toBe("README.md");
  });

  test("rejects foreign origins, malformed data, unknown fields, and unsupported methods", async () => {
    const fixture = await startFixture();
    const url = `${fixture.origin}/s/project/api/personal-state`;
    const request = (body: unknown, origin = fixture.origin) => fetch(url, {
      method: "PATCH",
      headers: { cookie: cookie("alice"), origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect((await request({ follow: false }, "https://attacker.example")).status).toBe(403);
    expect((await request({ user: "bob" })).status).toBe(400);
    expect((await request({ documentPath: "/etc/passwd" })).status).toBe(400);
    expect((await request({ lastPtyId: "bad" })).status).toBe(400);
    expect(fixture.personalState.get("alice", "project")).toEqual({ version: 1 });

    const method = await fetch(url, { method: "POST", headers: { cookie: cookie("alice"), origin: fixture.origin } });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET, PATCH");
  });

  test("local mode always owns state as the stable local identity", async () => {
    const fixture = await startFixture(true);
    const response = await fetch(`${fixture.origin}/s/project/api/personal-state`, {
      method: "PATCH",
      headers: { origin: fixture.origin, "content-type": "application/json" },
      body: JSON.stringify({ previewMode: "source" }),
    });
    expect(response.status).toBe(200);
    expect(fixture.personalState.get("local", "project")).toEqual({ version: 1, previewMode: "source" });
  });

  test("forget removes every user's state along with the stopped registry entry", async () => {
    const fixture = await startFixture();
    await fixture.personalState.patch("alice", "project", { follow: false });
    await fixture.personalState.patch("bob", "project", { filesFilter: "changed" });
    const response = await fetch(`${fixture.origin}/api/hub/workspaces/project/forget`, {
      method: "POST",
      headers: { cookie: cookie("alice"), origin: fixture.origin },
    });
    expect(response.status).toBe(200);
    expect(fixture.registry.byId("project")).toBeUndefined();
    expect(fixture.personalState.get("alice", "project")).toEqual({ version: 1 });
    expect(fixture.personalState.get("bob", "project")).toEqual({ version: 1 });
  });
});
