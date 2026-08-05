// Boots the real `uatu hub` subcommand from source: config file in, URL line
// out, clean exit on SIGTERM. (Child-terminating shutdown is covered by the
// SessionManager stopAll test in hub.integration.test.ts — this exercises
// the process wiring around it.)

import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.ts");

let tempRoot = "";
let child: ChildProcess | null = null;

afterEach(async () => {
  child?.kill("SIGKILL");
  child = null;
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  }
});

describe("uatu hub process", () => {
  test(
    "boots from a config file, prints its URL, and exits cleanly on SIGTERM",
    async () => {
      tempRoot = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-main-"));
      const configPath = path.join(tempRoot, "hub.json");
      await writeFile(
        configPath,
        JSON.stringify({
          port: 4799,
          host: "127.0.0.1",
          users: [{ name: "t", passwordHash: "$argon2id$placeholder" }],
          stateDir: path.join(tempRoot, "state"),
        }),
      );

      child = spawn("bun", ["run", CLI_PATH, "hub", "--config", configPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const url = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("hub did not print a URL")), 20_000);
        let buffered = "";
        child!.stdout!.on("data", (chunk: Buffer) => {
          buffered += chunk.toString();
          const match = buffered.match(/https?:\/\/\S+/);
          if (match) {
            clearTimeout(timeout);
            resolve(match[0]);
          }
        });
        child!.on("exit", code => {
          clearTimeout(timeout);
          reject(new Error(`hub exited early (code ${code})`));
        });
      });
      expect(url).toBe("http://127.0.0.1:4799/");

      // Reachable, and the un-authed dashboard redirects to login.
      const response = await fetch("http://127.0.0.1:4799/", {
        headers: { accept: "text/html" },
        redirect: "manual",
      });
      expect(response.status).toBe(303);

      const exitCode = await new Promise<number | null>(resolve => {
        child!.on("exit", code => resolve(code));
        child!.kill("SIGTERM");
      });
      expect(exitCode).toBe(0);
      child = null;
    },
    30_000,
  );

  test(
    "a config carrying the removed workspacesDir key fails startup by name",
    async () => {
      tempRoot = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-main-removedkey-"));
      const configPath = path.join(tempRoot, "hub.json");
      await writeFile(
        configPath,
        JSON.stringify({
          port: 4797,
          users: [{ name: "t", passwordHash: "x" }],
          stateDir: path.join(tempRoot, "state"),
          workspacesDir: path.join(tempRoot, "workspaces"),
        }),
      );

      child = spawn("bun", ["run", CLI_PATH, "hub", "--config", configPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exitCode = await new Promise<number | null>(resolve => child!.on("exit", code => resolve(code)));
      expect(exitCode).toBe(1);
      expect(stderr).toContain("'workspacesDir' was removed");
      child = null;
    },
    30_000,
  );

  test(
    "--local serves without credentials, hides login, and exits on stdin EOF with its session stopped",
    async () => {
      tempRoot = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-main-local-"));
      const workspace = path.join(tempRoot, "myproject");
      const { execFileSync } = await import("node:child_process");
      execFileSync("mkdir", ["-p", workspace]);
      execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
      await writeFile(path.join(workspace, "README.md"), "# Local\n");

      child = spawn("bun", ["run", CLI_PATH, "hub", "--local", "--port", "0", "--exit-on-stdin-close"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, XDG_STATE_HOME: path.join(tempRoot, "state-home") },
      });

      const url = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("local hub did not print a URL")), 20_000);
        let buffered = "";
        child!.stdout!.on("data", (chunk: Buffer) => {
          buffered += chunk.toString();
          const match = buffered.match(/https?:\/\/\S+/);
          if (match) {
            clearTimeout(timeout);
            resolve(match[0]);
          }
        });
        child!.on("exit", code => {
          clearTimeout(timeout);
          reject(new Error(`local hub exited early (code ${code})`));
        });
      });
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

      // No credentials anywhere: dashboard and API serve as the implicit
      // local user, and the login routes do not exist. The local dashboard
      // also omits the Add Folder browser and sign-out — folder adding is
      // the desktop app's native picker.
      const dashboard = await fetch(url, { headers: { accept: "text/html" }, redirect: "manual" });
      expect(dashboard.status).toBe(200);
      const dashboardHtml = await dashboard.text();
      expect(dashboardHtml).not.toContain('id="browser"');
      expect(dashboardHtml).not.toContain('id="clone-form"');
      expect(dashboardHtml).not.toContain("Sign out");
      const state = await fetch(`${url}api/hub/state`);
      expect(state.status).toBe(200);
      const statePayload = (await state.json()) as { version: string; local: boolean };
      expect(statePayload.version.length).toBeGreaterThan(0);
      // Clients adapt to local mode from this flag (e.g. the workspace
      // switcher omits its sign-out entry).
      expect(statePayload.local).toBe(true);
      const login = await fetch(`${url}login`, { headers: { accept: "text/html" } });
      expect(login.status).toBe(404);
      const logout = await fetch(`${url}logout`, { method: "POST" });
      expect(logout.status).toBe(404);

      // A real session child through the local hub's API.
      const created = await fetch(`${url}api/hub/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: workspace }),
      });
      expect(created.status).toBe(200);
      const proxied = await fetch(`${url}s/myproject/api/state`);
      expect(proxied.status).toBe(200);

      // Supervisor death: stdin EOF must stop the session child and exit
      // cleanly, exactly like SIGTERM.
      const exitCode = await new Promise<number | null>(resolve => {
        child!.on("exit", code => resolve(code));
        child!.stdin!.end();
      });
      expect(exitCode).toBe(0);
      child = null;
    },
    60_000,
  );

  test(
    "a broken config fails startup with the validation error",
    async () => {
      tempRoot = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-main-bad-"));
      const configPath = path.join(tempRoot, "hub.json");
      await writeFile(configPath, JSON.stringify({ host: "0.0.0.0", users: [{ name: "t", passwordHash: "x" }] }));

      child = spawn("bun", ["run", CLI_PATH, "hub", "--config", configPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exitCode = await new Promise<number | null>(resolve => child!.on("exit", code => resolve(code)));
      expect(exitCode).toBe(1);
      expect(stderr).toContain("refusing to listen on non-loopback");
      child = null;
    },
    30_000,
  );
});
