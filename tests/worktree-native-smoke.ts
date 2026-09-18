// No model calls. Compiles the actual desktop WebViewHost into a small AppKit
// executable and exercises it against the real temporary-repository Hub fixture.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HubE2EInfo } from "./e2e/hub-server";

assert.equal(process.platform, "darwin", "This smoke check requires macOS");
const root = await mkdtemp(path.join(os.tmpdir(), "uatu-native-smoke-"));
const server = Bun.spawn(["bun", "run", "tests/e2e/hub-server.ts"], {
  env: { ...process.env, UATU_E2E_HUB_PORT: "0", UATU_E2E_HUB_CHILD_BASE_PORT: "5651",
    UATU_E2E_HUB_WORKSPACES: "atlas", UATU_E2E_HUB_WORKTREES: "1" },
  stdout: "pipe", stderr: "inherit",
});
const deadline = setTimeout(() => server.kill("SIGTERM"), 120_000);
try {
  let buffered = "";
  let hub: HubE2EInfo | undefined;
  for await (const chunk of server.stdout) {
    buffered += new TextDecoder().decode(chunk);
    const line = buffered.split("\n").find(line => line.startsWith("uatu-e2e-hub "));
    if (line) { hub = JSON.parse(line.slice("uatu-e2e-hub ".length)); break; }
  }
  assert(hub);
  const create = Bun.spawn(["bun", "run", "src/cli.ts", "worktree", "create", "--new-branch", "native/smoke", "--from", "main", "--start", "--json"], {
    env: { ...process.env, UATU_HUB_CONTEXT: hub.worktreeContextPath }, stdout: "pipe", stderr: "inherit",
  });
  const result = JSON.parse(await new Response(create.stdout).text());
  assert.equal(await create.exited, 0);
  const executable = path.join(root, "native-smoke");
  const compile = Bun.spawn(["xcrun", "swiftc", "-parse-as-library", "-o", executable,
    "tests/worktree-native-smoke.swift", ...["WebViewHost", "PageZoom", "ExternalLinkRouter"].map(name => `desktop/macos/UatuCodeDesktop/${name}.swift`)],
    { stdout: "inherit", stderr: "inherit" });
  assert.equal(await compile.exited, 0);
  const native = Bun.spawn([executable], { env: { ...process.env, UATU_SMOKE_ORIGIN: hub.origin,
    UATU_SMOKE_CHILD: result.result.checkout.workspaceId }, stdout: "inherit", stderr: "inherit" });
  const timeout = setTimeout(() => native.kill("SIGKILL"), 90_000);
  try { assert.equal(await native.exited, 0); } finally { clearTimeout(timeout); }
} finally {
  clearTimeout(deadline);
  server.kill("SIGTERM");
  await server.exited;
  await rm(root, { recursive: true, force: true });
}
