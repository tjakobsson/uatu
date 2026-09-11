#!/usr/bin/env bun
// `bun run dev`: develop uatu the way users run it. Starts `uatu hub` from
// source with the checked-in dev config (dev/hub.json: user `dev`, password
// `dev`, state under .local/dev-hub), signs in through the Hub API, registers
// testdata/watch-docs if the hub doesn't have it yet, starts that session,
// and opens it in the browser. The browser signs in through the hub's login
// page the first time. See dev/README.md.
//
//   bun run dev             start the dev hub and open the session
//   bun run dev --no-open   start it without opening a browser
//
// Ctrl+C stops the hub, and the hub stops its session children.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { openBrowser } from "../src/server/navigation";

const ROOT = path.resolve(import.meta.dir, "..");
const CONFIG_PATH = path.join(ROOT, "dev", "hub.json");
const DEV_USER = { name: "dev", password: "dev" };
const HUB_URL_TIMEOUT_MS = 60_000;

let openInBrowser = true;
for (const arg of process.argv.slice(2)) {
  if (arg === "--no-open") {
    openInBrowser = false;
    continue;
  }
  console.error(`dev-hub: unknown argument: ${arg} (supported: --no-open)`);
  process.exit(2);
}

const workspacePath = await fs.realpath(path.join(ROOT, "testdata", "watch-docs"));

// The hub gets its own process group, so a terminal Ctrl+C reaches only this
// script, which forwards one SIGTERM per signal. The hub reads a second
// signal as "force exit", and a group-wide SIGINT plus a forwarded one would
// be two. The held stdin pipe with --exit-on-stdin-close is the backstop: if
// this script dies without forwarding, the hub sees EOF and shuts down with
// its children instead of holding the dev port. The cwd matters too:
// dev/hub.json's relative stateDir resolves against it.
const hub = spawn(
  process.execPath,
  [path.join(ROOT, "src", "cli.ts"), "hub", "--config", CONFIG_PATH, "--exit-on-stdin-close"],
  { cwd: ROOT, stdio: ["pipe", "pipe", "inherit"], detached: true },
);
const hubExited = new Promise<number>(resolve => {
  hub.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (hub.exitCode === null && hub.signalCode === null) hub.kill("SIGTERM");
  });
}

// The hub prints its origin (`http://127.0.0.1:4702/`) once it listens.
// Everything it writes to stdout passes through.
function waitForHubOrigin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(
      () => reject(new Error(`the hub printed no URL within ${HUB_URL_TIMEOUT_MS / 1000}s`)),
      HUB_URL_TIMEOUT_MS,
    );
    hub.stdout!.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      buffered += chunk.toString();
      const match = /^(https?:\/\/[^\s/]+)\/$/m.exec(buffered);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    void hubExited.then(code => {
      clearTimeout(timer);
      reject(new Error(`the hub exited during startup (code ${code})`));
    });
  });
}

async function hubJson<T>(response: Response, action: string): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(`${action} failed (${response.status}): ${body.error ?? "no error message"}`);
  }
  return body;
}

// Signs in as the dev user, makes sure testdata/watch-docs is registered and
// running, and returns its workspace id.
async function prepareWorkspace(origin: string): Promise<string> {
  const login = await fetch(`${origin}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...DEV_USER, deviceLabel: "bun run dev" }),
  });
  if (!login.ok) {
    throw new Error(`dev login failed (${login.status}); is dev/hub.json's passwordHash still the hash of '${DEV_USER.password}'?`);
  }
  const { sessionId } = (await login.json()) as { sessionId: string };
  const auth = { authorization: `Bearer ${sessionId}` };
  try {
    const state = await hubJson<{ workspaces: { id: string; path: string; running: boolean }[] }>(
      await fetch(`${origin}/api/hub/state`, { headers: auth }),
      "reading hub state",
    );
    const registered = state.workspaces.find(entry => entry.path === workspacePath);
    if (!registered) {
      // Registering starts the session and answers 200 once it serves; only
      // an explicit `running: false` means it committed without one.
      const created = await hubJson<{ id: string; running?: boolean }>(
        await fetch(`${origin}/api/hub/workspaces`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ path: workspacePath }),
        }),
        `registering ${workspacePath}`,
      );
      console.error(`dev-hub: registered ${workspacePath} as '${created.id}'`);
      if (created.running !== false) return created.id;
      await startSession(origin, auth, created.id);
      return created.id;
    }
    if (!registered.running) {
      await startSession(origin, auth, registered.id);
    }
    return registered.id;
  } finally {
    // The browser signs in with its own cookie. This bearer session only
    // did the setup, so revoke it instead of piling up device records.
    await fetch(`${origin}/logout`, { method: "POST", headers: auth }).catch(() => undefined);
  }
}

async function startSession(origin: string, auth: Record<string, string>, id: string): Promise<void> {
  await hubJson(
    await fetch(`${origin}/api/hub/sessions/${encodeURIComponent(id)}/start`, { method: "POST", headers: auth }),
    `starting '${id}'`,
  );
}

try {
  const origin = await waitForHubOrigin();
  const id = await prepareWorkspace(origin);
  const sessionUrl = `${origin}/s/${encodeURIComponent(id)}/`;
  console.error(`dev-hub: dashboard ${origin}/ (sign in as ${DEV_USER.name} / ${DEV_USER.password})`);
  console.error(`dev-hub: session   ${sessionUrl}`);
  if (openInBrowser && !(await openBrowser(sessionUrl))) {
    console.error(`dev-hub: unable to open a browser; open ${sessionUrl}`);
  }
} catch (error) {
  console.error(`dev-hub: ${error instanceof Error ? error.message : String(error)}`);
  if (hub.exitCode === null && hub.signalCode === null) hub.kill("SIGTERM");
  await hubExited;
  process.exit(1);
}

process.exit(await hubExited);
