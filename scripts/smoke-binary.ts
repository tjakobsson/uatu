#!/usr/bin/env bun
// Smoke test for the compiled `dist/uatu` binary, run the way users run it:
// `uatu hub` with a throwaway config, testdata/watch-docs registered through
// the Hub API, and its session loaded in a real browser. The hub spawns the
// session child from the same binary, so the compiled child is covered too.
// Exists because the full e2e suite runs in *dev* mode (via
// `tests/e2e/server.ts`) and therefore misses bugs that only surface under
// `bun build --compile` — like the HTMLBundle chunks going unserved, or
// app.ts becoming a lazy `__esm()` module that never runs at boot. Both of
// those bit the feature-folder refactor in PR #57.
//
// Three layers of checks:
//   0. CLI-level — a user-shaped `uatu serve` exits non-zero with the hub
//      bootstrap steps; the SSH guardian mode rejects EOF fail-closed
//   1. HTTP-level — the hub signs in, registers, and starts the workspace;
//      the session's chunk is served as JS, its /api/state has documents, and
//      the brokered live stream delivers document state (cheap; catches the
//      route-table / chunk-serving class of bug)
//   2. Browser-level — headless Chromium, signed in with the hub cookie,
//      loads the session and waits for the connection indicator and the
//      document count (catches anything that keeps `loadInitialState()` from
//      running, which the HTTP probes can't detect)
//
// Runtime: ~10s. Intended for CI after `bun run build`.

import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildLiveStreamQuery,
  LIVE_ENVELOPE_EVENT,
  LIVE_STREAM_PATH,
  parseLiveEnvelope,
} from "../src/shared/live-protocol";

const ROOT = path.resolve(import.meta.dir, "..");
// UATU_SMOKE_BINARY lets the release workflow smoke the cross-compiled
// linux-x64 artifact instead of the default host build.
const BINARY = path.resolve(ROOT, process.env.UATU_SMOKE_BINARY ?? path.join("dist", "uatu"));
const WORKSPACE = path.join(ROOT, "testdata", "watch-docs");
const USER = { name: "smoke", password: "smoke-password" };

let exitCode = 0;
const pass = (msg: string) => console.log(`  ✓ ${msg}`);
const fail = (msg: string) => {
  console.log(`  ✗ ${msg}`);
  exitCode = 1;
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Completed = { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: Error };

// Runs the binary to completion, killing it after timeoutMs. Without input,
// stdin is closed at once (EOF).
function runBinary(args: string[], options: { input?: string; timeoutMs?: number } = {}): Promise<Completed> {
  return new Promise(resolve => {
    const child = spawn(BINARY, args, { stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 10_000);
    child.once("error", error => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, error });
    });
    child.once("close", code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (options.input !== undefined) child.stdin!.end(options.input);
  });
}

async function checkSshSupervisorDispatch(): Promise<void> {
  const result = await runBinary(["--ssh-agent-supervisor"], { timeoutMs: 5_000 });
  if (result.timedOut) {
    fail("compiled SSH guardian mode did not reject EOF within 5s");
  } else if (result.error) {
    fail(`compiled SSH guardian mode failed to launch: ${result.error.message}`);
  } else if (result.code !== 2) {
    fail(`compiled SSH guardian mode returned ${result.code ?? "no exit code"} for EOF (expected 2)`);
  } else {
    pass("compiled SSH guardian mode rejects EOF fail-closed");
  }
}

async function checkServeRemoved(): Promise<void> {
  const result = await runBinary(["serve", WORKSPACE, "--no-open"], { timeoutMs: 10_000 });
  if (result.timedOut) {
    fail("user-shaped `uatu serve` did not exit; it started a session instead of refusing");
  } else if (result.code === 0 || result.code === null) {
    fail(`user-shaped \`uatu serve\` exited ${result.code ?? "without a code"} (expected non-zero)`);
  } else if (!result.stderr.includes("uatu hub hash-password") || result.stdout !== "") {
    fail(`user-shaped \`uatu serve\` did not print the hub bootstrap steps to stderr only (stderr: ${result.stderr.slice(0, 200)})`);
  } else {
    pass(`user-shaped \`uatu serve\` exits ${result.code} with the hub bootstrap steps`);
  }
}

await checkSshSupervisorDispatch();
await checkServeRemoved();

// A throwaway hub: its own config, user, and state dir under a temp root.
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-smoke-"));
const hashed = await runBinary(["hub", "hash-password"], { input: USER.password });
if (hashed.code !== 0 || !hashed.stdout.trim().startsWith("$argon2")) {
  fail(`\`uatu hub hash-password\` failed (code ${hashed.code}): ${hashed.stderr.slice(0, 200)}`);
  await fs.rm(tempRoot, { recursive: true, force: true });
  process.exit(1);
}
const configPath = path.join(tempRoot, "hub.json");
await fs.writeFile(
  configPath,
  JSON.stringify({
    host: "127.0.0.1",
    users: [{ name: USER.name, passwordHash: hashed.stdout.trim() }],
    stateDir: path.join(tempRoot, "state"),
  }),
);

// node:child_process rather than Bun.spawn so the CI environment doesn't
// need to worry about subprocess inheritance quirks; the binary itself is
// still pure Bun. `--port 0` picks a free port, reported by the URL line.
const hub = spawn(BINARY, ["hub", "--config", configPath, "--port", "0"], {
  stdio: ["ignore", "pipe", "pipe"],
});

// Capture what the hub says, so a boot failure in CI shows its exit code
// and stderr instead of a bare "did not start".
const captured: string[] = [];
hub.stderr?.on("data", (chunk: Buffer) => captured.push(chunk.toString()));
let exited: { code: number | null; signal: string | null } | undefined;
hub.on("exit", (code, signal) => {
  exited = { code, signal };
});
const origin = new Promise<string | null>(resolve => {
  let buffered = "";
  const timer = setTimeout(() => resolve(null), 20_000);
  hub.stdout?.on("data", (chunk: Buffer) => {
    captured.push(chunk.toString());
    buffered += chunk.toString();
    const match = /^(http:\/\/[^\s/]+)\/$/m.exec(buffered);
    if (match) {
      clearTimeout(timer);
      resolve(match[1]!);
    }
  });
  hub.once("exit", () => {
    clearTimeout(timer);
    resolve(null);
  });
});

// SIGTERM stops the hub, and the hub stops its session children. Wait for
// it so no child is left holding a port for later CI steps.
const cleanup = async () => {
  if (hub.exitCode === null && hub.signalCode === null) {
    hub.kill("SIGTERM");
    const stopped = await Promise.race([
      new Promise<boolean>(resolve => hub.once("exit", () => resolve(true))),
      sleep(15_000).then(() => false),
    ]);
    if (!stopped) hub.kill("SIGKILL");
  }
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
};
process.on("SIGINT", () => hub.kill("SIGTERM"));
process.on("SIGTERM", () => hub.kill("SIGTERM"));

// A failure that leaves nothing further to check. Thrown rather than
// exiting, so the finally block still stops the hub and its children.
class BootFailure extends Error {}

// Reads SSE frames until one satisfies `accept` or the deadline passes.
async function readUntilFrame(
  body: ReadableStream<Uint8Array>,
  accept: (event: string, data: string) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffered = "";
  try {
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        sleep(Math.max(0, deadline - Date.now())).then(() => null),
      ]);
      if (next === null || next.done) return false;
      buffered += decoder.decode(next.value, { stream: true });
      let boundary = buffered.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const event = /^event: (.*)$/m.exec(frame)?.[1] ?? "";
        const data = /^data: (.*)$/m.exec(frame)?.[1] ?? "";
        if (accept(event, data)) return true;
        boundary = buffered.indexOf("\n\n");
      }
    }
    return false;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

try {
  const BASE = await origin;
  if (!BASE) {
    throw new BootFailure(
      exited
        ? `compiled hub exited during boot (code ${exited.code}, signal ${exited.signal ?? "none"})`
        : "compiled hub printed no URL within 20s",
    );
  }
  pass(`compiled hub listens at ${BASE}/`);

  // === Layer 1: HTTP-level checks ===

  const login = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...USER, deviceLabel: "smoke" }),
  });
  if (!login.ok) {
    throw new BootFailure(`hub login returned ${login.status}`);
  }
  const { sessionId } = (await login.json()) as { sessionId: string };
  const cookiePair = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const [cookieName, cookieValue] = [cookiePair.slice(0, cookiePair.indexOf("=")), cookiePair.slice(cookiePair.indexOf("=") + 1)];
  const cookie = { cookie: cookiePair };
  pass("hub login returns a session and cookie");

  // Registering starts the session: the hub spawns this same binary as the
  // workspace's child and answers 200 once it serves. Only an explicit
  // `running: false` means the registration committed without a session.
  const registered = await fetch(`${BASE}/api/hub/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${sessionId}` },
    body: JSON.stringify({ path: WORKSPACE }),
  });
  const workspace = (await registered.json().catch(() => ({}))) as { id?: string; running?: boolean; error?: string };
  if (!registered.ok || !workspace.id || workspace.running === false) {
    throw new BootFailure(`registering testdata/watch-docs returned ${registered.status}: ${JSON.stringify(workspace).slice(0, 200)}`);
  }
  const SESSION = `${BASE}/s/${encodeURIComponent(workspace.id)}/`;
  pass(`hub registered and started testdata/watch-docs as '${workspace.id}'`);

  // Chunk URL — Bun generates `chunk-XXXX.js` references in the compiled
  // HTML, relocated under the session's base path. If `routes:
  // buildRoutes(...)` hides the HTMLBundle from Bun's bundler, this URL falls
  // through to the SPA navigation fallback and returns HTML — the bug from
  // PR #57.
  const shell = await fetch(SESSION, { headers: { ...cookie, accept: "text/html" } });
  const shellBody = await shell.text();
  const chunkRef = /["']([^"']*\/chunk-[a-z0-9]+\.js)["']/.exec(shellBody)?.[1];
  if (!shell.ok || !chunkRef) {
    fail(`session shell (${shell.status}) has no chunk-*.js script tag`);
  } else {
    const chunkUrl = new URL(chunkRef, SESSION);
    const chunkResponse = await fetch(chunkUrl, { headers: cookie });
    const contentType = chunkResponse.headers.get("content-type") ?? "";
    if (!contentType.includes("javascript")) {
      fail(`${chunkUrl.pathname}: expected JS content-type, got "${contentType}"`);
    } else {
      pass(`${chunkUrl.pathname} is served as JS (${contentType})`);
    }
  }

  // /api/state shape — we don't pin the fixture's document count because it
  // can grow; non-empty proves the child actually indexed something.
  const stateBody = (await fetch(`${SESSION}api/state`, { headers: cookie }).then(r => r.json())) as {
    roots?: { docs?: unknown[] }[];
  };
  const docCount = stateBody.roots?.[0]?.docs?.length ?? 0;
  if (docCount === 0) {
    fail(`session /api/state returned zero documents (raw: ${JSON.stringify(stateBody).slice(0, 200)})`);
  } else {
    pass(`session /api/state returns ${docCount} documents`);
  }

  // The brokered live stream — the page's only live transport — must open
  // and deliver the workspace's document state.
  const query = buildLiveStreamQuery({ ws: workspace.id, activity: false, subs: [{ topic: "document" }], reconnect: false });
  const live = await fetch(`${BASE}${LIVE_STREAM_PATH}?${query}`, { headers: { ...cookie, accept: "text/event-stream" } });
  const liveType = live.headers.get("content-type") ?? "";
  if (!live.ok || !liveType.includes("text/event-stream") || !live.body) {
    fail(`${LIVE_STREAM_PATH}: expected a text/event-stream, got ${live.status} "${liveType}"`);
  } else {
    const delivered = await readUntilFrame(
      live.body,
      (event, data) => {
        if (event !== LIVE_ENVELOPE_EVENT) return false;
        const envelope = parseLiveEnvelope(data);
        return envelope?.topic === "document" && envelope.event.kind === "data";
      },
      10_000,
    );
    if (delivered) {
      pass(`${LIVE_STREAM_PATH} delivers the session's document state`);
    } else {
      fail(`${LIVE_STREAM_PATH} delivered no document state within 10s`);
    }
  }

  // === Layer 2: Browser-level check ===
  // This is what catches the lazy `__esm()` class of bug: the bundle
  // loaded, /api/state responds to curl, but the SPA never fetches it
  // because its module init was deferred and never triggered. We need a
  // real browser to confirm `loadInitialState()` actually fires.

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.addCookies([{ name: cookieName, value: cookieValue, url: BASE }]);
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));

    await page.goto(SESSION, { waitUntil: "load", timeout: 10_000 });
    // Wait for the SPA to settle: live stream connected and the document
    // tree populated. Both come from `loadInitialState()` + the first
    // document state — if either never runs, these waits time out, which is
    // exactly the signal we want.
    await expect(page.locator("#connection-state .connection-label"))
      .toHaveText("Connected", { timeout: 10_000 });
    await expect(page.locator("#document-count"))
      .not.toHaveText("0 files", { timeout: 10_000 });

    const documentCount = (await page.locator("#document-count").textContent())?.trim() ?? "";
    const connectionLabel = (await page.locator(".connection-label").textContent())?.trim() ?? "";

    if (pageErrors.length > 0) {
      fail(`browser pageerror(s): ${pageErrors.join(" | ")}`);
    } else {
      pass("SPA loaded with no page errors");
    }

    const countMatch = documentCount.match(/^(\d+)\s+files?/);
    const reportedCount = countMatch ? Number.parseInt(countMatch[1]!, 10) : 0;
    if (reportedCount === 0) {
      fail(`SPA never populated #document-count (got "${documentCount}")`);
    } else {
      pass(`SPA populated #document-count: "${documentCount}"`);
    }

    if (connectionLabel !== "Connected") {
      fail(`SPA connection-label: "${connectionLabel}" (expected "Connected")`);
    } else {
      pass("SPA connection-label: Connected");
    }
  } finally {
    await browser.close();
  }
} catch (error) {
  if (error instanceof BootFailure) {
    fail(error.message);
    console.log(`\n--- ${BINARY} output ---\n${captured.join("").trimEnd() || "(nothing on stdout/stderr)"}\n--- end output ---`);
  } else {
    fail(`smoke aborted: ${error instanceof Error ? error.message : String(error)}`);
  }
} finally {
  await cleanup();
}

if (exitCode === 0) {
  console.log("\nSmoke test passed.");
} else {
  console.log("\nSmoke test FAILED.");
}
process.exit(exitCode);
