// TLS integration: the hub terminates HTTPS from user-supplied PEM files
// (generated self-signed here) and marks its cookie Secure when it does.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LocalProcessBackend } from "./backend";
import { hashPassword, HubSessionStore } from "./auth";
import type { HubConfig } from "./config";
import { PersonalWorkspaceStateStore } from "./personal-state";
import { WorkspaceRegistry } from "./registry";
import { startHubServer } from "./server";
import { SessionManager } from "./sessions";

let tempRoot = "";
let server: ReturnType<typeof startHubServer> | null = null;
let sessions: SessionManager;

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-tls-"));
  const certPath = path.join(tempRoot, "cert.pem");
  const keyPath = path.join(tempRoot, "key.pem");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath, "-days", "1", "-nodes", "-subj", "/CN=localhost"],
    { stdio: "ignore" },
  );

  const config: HubConfig = {
    port: 0 as number,
    host: "127.0.0.1",
    tls: { cert: certPath, key: keyPath },
    users: [{ name: "tobias", passwordHash: await hashPassword("open sesame") }],
    stateDir: path.join(tempRoot, "state"),
  };
  const registry = new WorkspaceRegistry(path.join(tempRoot, "registry.json"));
  await registry.load();
  const personalState = new PersonalWorkspaceStateStore(path.join(tempRoot, "personal-state.json"));
  await personalState.load();
  const sessionStore = new HubSessionStore(path.join(tempRoot, "sessions.json"));
  await sessionStore.load();
  sessions = new SessionManager(registry, { local: new LocalProcessBackend() });
  server = startHubServer({ config, registry, sessions, sessionStore, personalState });
}, 30_000);

afterAll(async () => {
  await sessions?.stopAll();
  server?.stop(true);
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

describe("hub over HTTPS", () => {
  test("serves HTTPS from the configured certificate", async () => {
    const response = await fetch(`https://127.0.0.1:${server!.port}/login`, {
      tls: { rejectUnauthorized: false },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Sign in");
  });

  test("plain HTTP does not answer on the TLS port", async () => {
    await expect(
      fetch(`http://127.0.0.1:${server!.port}/login`, { signal: AbortSignal.timeout(3_000) }),
    ).rejects.toThrow();
  });

  test("the login cookie carries Secure when the hub terminates TLS", async () => {
    const response = await fetch(`https://127.0.0.1:${server!.port}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "tobias", password: "open sesame" }),
      tls: { rejectUnauthorized: false },
    });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("uatu_hub=");
    expect(setCookie).toContain("Secure");
  });
});
