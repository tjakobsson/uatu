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
  // Signs in the way a native client would: plain JSON login, no cookie jar,
  // no browser. The returned session id is a Hub session like any other and
  // authorizes the worktree JSON family as a bearer credential.
  const login = await fetch(`${hub.origin}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: hub.user.name, password: hub.user.password }),
  });
  assert.equal(login.status, 200);
  const { sessionId } = await login.json() as { sessionId: string };
  const created = await fetch(`${hub.origin}/api/hub/worktrees/create`, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionId}`, "content-type": "application/json" },
    body: JSON.stringify({
      sourceWorkspaceId: hub.workspaces[0]!.id,
      mode: "new-branch",
      branch: "native/smoke",
      base: { kind: "local", ref: "main" },
      start: true,
    }),
  });
  assert.equal(created.status, 200);
  const result = await created.json() as { ok: boolean; started?: boolean; startError?: { message: string }; checkout?: { workspaceId?: string } };
  assert.equal(result.ok, true);
  // The WebView step waits for the child to be Connected; a child that never
  // started must fail here with the Hub's reason, not as a WebView timeout.
  assert.equal(result.started, true, `worktree created but not started: ${result.startError?.message ?? "no reason reported"}`);
  const workspaceId = result.checkout?.workspaceId;
  assert(workspaceId, "worktree creation did not report a workspace id");
  const executable = path.join(root, "native-smoke");
  const compile = Bun.spawn(["xcrun", "swiftc", "-parse-as-library", "-o", executable,
    "tests/worktree-native-smoke.swift", ...["WebViewHost", "PageZoom", "ExternalLinkRouter"].map(name => `desktop/macos/UatuCodeDesktop/${name}.swift`)],
    { stdout: "inherit", stderr: "inherit" });
  assert.equal(await compile.exited, 0);
  const native = Bun.spawn([executable], { env: { ...process.env, UATU_SMOKE_ORIGIN: hub.origin,
    UATU_SMOKE_CHILD: workspaceId }, stdout: "inherit", stderr: "inherit" });
  const timeout = setTimeout(() => native.kill("SIGKILL"), 90_000);
  try { assert.equal(await native.exited, 0); } finally { clearTimeout(timeout); }
} finally {
  clearTimeout(deadline);
  server.kill("SIGTERM");
  await server.exited;
  await rm(root, { recursive: true, force: true });
}
