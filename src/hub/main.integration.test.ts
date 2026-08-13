// Boots the real `uatu hub` subcommand from source: config file in, URL line
// out, clean exit on SIGTERM. (Child-terminating shutdown is covered by the
// SessionManager stopAll test in hub.integration.test.ts — this exercises
// the process wiring around it.)

import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { hashPassword } from "./auth";

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
    "SIGTERM reaps an active clone process group before hub exit",
    async () => {
      tempRoot = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-main-clone-"));
      const binDir = path.join(tempRoot, "bin");
      const fakeGit = path.join(binDir, "git");
      const leaderPidFile = path.join(tempRoot, "leader.pid");
      const childPidFile = path.join(tempRoot, "child.pid");
      await mkdir(binDir, { recursive: true });
      await Bun.write(fakeGit, [
        "#!/bin/sh",
        "case \" $* \" in",
        "  *\" clone \"*) ;;",
        "  *) exec /usr/bin/git \"$@\" ;;",
        "esac",
        `printf '%s' "$$" > '${leaderPidFile}'`,
        "sleep 300 &",
        `printf '%s' "$!" > '${childPidFile}'`,
        "wait",
      ].join("\n"));
      await chmod(fakeGit, 0o755);
      const configPath = path.join(tempRoot, "hub.json");
      await writeFile(configPath, JSON.stringify({
        port: 4795,
        host: "127.0.0.1",
        users: [{ name: "t", passwordHash: await hashPassword("secret") }],
        stateDir: path.join(tempRoot, "state"),
      }));

      child = spawn("bun", ["run", CLI_PATH, "hub", "--config", configPath], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      await waitForUrl(child);
      const login = await fetch("http://127.0.0.1:4795/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "t", password: "secret" }),
      });
      const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
      const created = await fetch("http://127.0.0.1:4795/api/hub/clone-jobs", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:4795" },
        body: JSON.stringify({ url: "fake:repo.git", dest: path.join(tempRoot, "checkouts") }),
      });
      expect(created.status).toBe(202);
      await waitForFile(childPidFile);
      const leaderPid = Number.parseInt(await Bun.file(leaderPidFile).text(), 10);
      const descendantPid = Number.parseInt(await Bun.file(childPidFile).text(), 10);

      const exitCode = await new Promise<number | null>(resolve => {
        child!.on("exit", code => resolve(code));
        child!.kill("SIGTERM");
      });
      expect(exitCode).toBe(0);
      expect(processExists(leaderPid)).toBe(false);
      expect(processExists(descendantPid)).toBe(false);
      child = null;
    },
    30_000,
  );

  test(
    "starting without any configured users fails with the bootstrap instructions",
    async () => {
      tempRoot = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-main-nousers-"));
      const configPath = path.join(tempRoot, "hub.json");
      await writeFile(configPath, JSON.stringify({ port: 4796, users: [] }));

      child = spawn("bun", ["run", CLI_PATH, "hub", "--config", configPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exitCode = await new Promise<number | null>(resolve => child!.on("exit", code => resolve(code)));
      expect(exitCode).toBe(1);
      // The error names both bootstrap steps: hashing a password and
      // writing the single-user config.
      expect(stderr).toContain("hash-password");
      expect(stderr).toContain("passwordHash");
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

function waitForUrl(process: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("hub did not print a URL")), 20_000);
    let buffered = "";
    process.stdout!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const match = buffered.match(/https?:\/\/\S+/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[0]);
    });
    process.on("exit", code => {
      clearTimeout(timeout);
      reject(new Error(`hub exited early (code ${code})`));
    });
  });
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await Bun.file(filePath).exists()) return;
    await Bun.sleep(10);
  }
  throw new Error(`file was not created: ${filePath}`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
