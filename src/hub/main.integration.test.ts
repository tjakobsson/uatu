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
          workspacesDir: path.join(tempRoot, "workspaces"),
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
    "a workspaces root inside a git repository fails startup",
    async () => {
      tempRoot = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-main-gitroot-"));
      const insideRepo = path.join(tempRoot, "repo", "workspaces");
      const { execFileSync } = await import("node:child_process");
      execFileSync("mkdir", ["-p", insideRepo]);
      execFileSync("git", ["init"], { cwd: path.join(tempRoot, "repo"), stdio: "ignore" });

      const configPath = path.join(tempRoot, "hub.json");
      await writeFile(
        configPath,
        JSON.stringify({
          port: 4797,
          users: [{ name: "t", passwordHash: "x" }],
          stateDir: path.join(tempRoot, "state"),
          workspacesDir: insideRepo,
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
      expect(stderr).toContain("inside a git repository");
      expect(stderr).toContain("CONTAINS your repositories");
      child = null;
    },
    30_000,
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
