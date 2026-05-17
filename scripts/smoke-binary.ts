#!/usr/bin/env bun
// Smoke test for the compiled `dist/uatu` binary. Boots it against
// `testdata/watch-docs` and verifies the SPA reaches a usable state
// end-to-end. Exists because the full e2e suite runs in *dev* mode
// (via `tests/e2e/server.ts`) and therefore misses bugs that only
// surface under `bun build --compile` — like the HTMLBundle chunks
// going unserved, or app.ts becoming a lazy `__esm()` module that
// never runs at boot. Both of those bit the feature-folder refactor
// in PR #58.
//
// Two layers of checks:
//   1. HTTP-level — chunk content-type, /api/state shape, SSE handshake
//      (cheap; catches the route-table / chunk-serving class of bug)
//   2. Browser-level — headless Chromium loads /, waits a few seconds,
//      and asserts the document-count and connection-state UI updates
//      (catches anything that prevents `loadInitialState()` from
//      actually running, which the HTTP probes can't detect)
//
// Runtime: ~5s. Intended for CI after `bun run build`.

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import path from "node:path";

const PORT = 4889;
const ROOT = path.resolve(import.meta.dir, "..");
const BINARY = path.join(ROOT, "dist", "uatu");
const WORKSPACE = path.join(ROOT, "testdata", "watch-docs");

let exitCode = 0;
const pass = (msg: string) => console.log(`  ✓ ${msg}`);
const fail = (msg: string) => {
  console.log(`  ✗ ${msg}`);
  exitCode = 1;
};

// Start the binary. Use node:child_process rather than Bun.spawn so the
// CI environment doesn't need to worry about subprocess inheritance
// quirks; the binary itself is still pure Bun.
//
// `--no-open` is non-negotiable: the default behavior pops a browser tab
// on the host, which is harmless in CI but obnoxious during local runs.
const proc = spawn(BINARY, ["watch", WORKSPACE, "--port", String(PORT), "--no-open"], {
  stdio: ["ignore", "pipe", "pipe"],
});

const cleanup = () => {
  if (!proc.killed) {
    proc.kill("SIGTERM");
  }
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

try {
  // Wait for the server to accept connections.
  const BASE = `http://127.0.0.1:${PORT}`;
  let ready = false;
  for (let i = 0; i < 50; i += 1) {
    try {
      const probe = await fetch(`${BASE}/api/state`);
      if (probe.ok) {
        ready = true;
        break;
      }
    } catch {
      // Server not up yet — keep waiting.
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) {
    fail("compiled binary did not start within 10s");
    process.exit(1);
  }
  pass("compiled binary boots and serves /api/state");

  // === Layer 1: HTTP-level checks ===

  // Pull the index HTML so we can find the chunk reference.
  const rootResponse = await fetch(`${BASE}/`);
  const rootBody = await rootResponse.text();

  // Chunk URL — Bun generates `/chunk-XXXX.js` references in the
  // compiled HTML. If `routes: buildRoutes(...)` hides the
  // HTMLBundle from Bun's bundler, this URL falls through to the
  // SPA navigation fallback and returns HTML — the bug from PR #58.
  const chunkMatch = rootBody.match(/\/chunk-[a-z0-9]+\.js/);
  if (!chunkMatch) {
    fail("no /chunk-*.js script tag found in served HTML");
  } else {
    const chunkResponse = await fetch(`${BASE}${chunkMatch[0]}`);
    const contentType = chunkResponse.headers.get("content-type") ?? "";
    if (!contentType.includes("javascript")) {
      fail(`${chunkMatch[0]}: expected JS content-type, got "${contentType}"`);
    } else {
      pass(`${chunkMatch[0]} is served as JS (${contentType})`);
    }
  }

  // /api/state shape — fixture is `testdata/watch-docs` which contains
  // 16 documents. We don't pin the count exactly because the fixture
  // can grow; we just verify it's non-empty so we know the watch session
  // actually indexed something.
  const stateBody = (await fetch(`${BASE}/api/state`).then(r => r.json())) as {
    roots?: { docs?: unknown[] }[];
  };
  const docCount = stateBody.roots?.[0]?.docs?.length ?? 0;
  if (docCount === 0) {
    fail(`/api/state returned zero documents (raw: ${JSON.stringify(stateBody).slice(0, 200)})`);
  } else {
    pass(`/api/state returns ${docCount} documents`);
  }

  // /api/events handshake — the SSE handler must produce a state event
  // immediately on connect.
  const sseResponse = await fetch(`${BASE}/api/events`);
  const sseType = sseResponse.headers.get("content-type") ?? "";
  if (!sseType.includes("text/event-stream")) {
    fail(`/api/events: expected text/event-stream, got "${sseType}"`);
  } else {
    const reader = sseResponse.body?.getReader();
    if (reader) {
      const firstChunk = await Promise.race([
        reader.read().then(({ value }) => new TextDecoder().decode(value ?? new Uint8Array())),
        new Promise<string>(resolve => setTimeout(() => resolve(""), 3000)),
      ]);
      await reader.cancel();
      if (!firstChunk.startsWith("event: state")) {
        fail(`/api/events first chunk did not start with "event: state" (got: ${firstChunk.slice(0, 80)})`);
      } else {
        pass("/api/events delivers an initial state event");
      }
    }
  }

  // === Layer 2: Browser-level check ===
  // This is what catches the lazy `__esm()` class of bug: the bundle
  // loaded, /api/state responds to curl, but the SPA never fetches it
  // because its module init was deferred and never triggered. We need a
  // real browser to confirm `loadInitialState()` actually fires.

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));

    await page.goto(`${BASE}/`, { waitUntil: "load", timeout: 10_000 });
    // Give the SPA a moment to fetch /api/state, settle the tree, and
    // open the SSE connection.
    await page.waitForTimeout(2500);

    const documentCount = (await page.locator("#document-count").textContent())?.trim() ?? "";
    const connectionLabel = (await page.locator(".connection-label").textContent())?.trim() ?? "";

    if (pageErrors.length > 0) {
      fail(`browser pageerror(s): ${pageErrors.join(" | ")}`);
    } else {
      pass("SPA loaded with no page errors");
    }

    const countMatch = documentCount.match(/^(\d+)\s+files?/);
    const reportedCount = countMatch ? Number.parseInt(countMatch[1], 10) : 0;
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
} finally {
  cleanup();
  // Give the child process a moment to exit cleanly so it doesn't leave
  // a half-released port behind for subsequent CI steps.
  await new Promise(resolve => setTimeout(resolve, 100));
}

if (exitCode === 0) {
  console.log("\nSmoke test passed.");
} else {
  console.log("\nSmoke test FAILED.");
}
process.exit(exitCode);
