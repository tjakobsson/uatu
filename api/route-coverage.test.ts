import { expect, test } from "bun:test";

import { readYaml } from "../scripts/validate-api";

type Operation = { operationId: string; domain: "hub" | "workspace"; method: string; path: string; childPath?: string; runtime: string };
type Exclusion = { id: string; path?: string; pathPattern?: string };

const root = new URL("../", import.meta.url);

test("workspace route table and fallback routes are classified", async () => {
  const [source, sessionsSource, inventory, excluded] = await Promise.all([
    Bun.file(new URL("src/server/routes.ts", root)).text(),
    Bun.file(new URL("src/terminal/sessions-route.ts", root)).text(),
    readYaml<{ operations: Operation[] }>("api/operations.yaml"),
    readYaml<{ exclusions: Exclusion[] }>("api/exclusions.yaml"),
  ]);
  const publicChildPaths = new Set(inventory.operations.filter(item => item.domain === "workspace").map(item => item.childPath ?? item.path));
  for (const path of ["/api/state", "/api/document", "/api/document/diff", "/api/events", "/api/search", "/api/auth", "/api/terminal", "/api/terminal/sessions", "/api/terminal/sessions/{terminalSessionId}"]) {
    expect(publicChildPaths.has(path)).toBe(true);
  }
  for (const marker of ["p(\"/api/state\")", "p(\"/api/document\")", "p(\"/api/document/diff\")", "p(\"/api/events\")", "p(\"/api/search\")", 'requestUrl.pathname === "/api/terminal"', 'requestUrl.pathname === "/api/auth"']) {
    expect(source).toContain(marker);
  }
  expect(sessionsSource).toContain('const SESSIONS_PATH = "/api/terminal/sessions"');
  for (const id of ["workspace-assets", "workspace-manifest", "workspace-debug", "workspace-terminal-cookie-auth", "e2e-reset", "e2e-terminal-token", "e2e-personal-state", "direct-child-api"]) {
    expect(excluded.exclusions.some(item => item.id === id)).toBe(true);
  }
  const literalRoutes = [...source.matchAll(/p\("([^"]+)"\)/g)].map(match => match[1]!);
  const classified = (path: string) =>
    publicChildPaths.has(path)
    || path.startsWith("/assets/")
    || path === "/manifest.webmanifest"
    || path === "/debug/metrics"
    || path.startsWith("/__e2e/")
    || path === "/api/personal-state";
  expect(literalRoutes.filter(path => !classified(path))).toEqual([]);
});

test("Hub dispatch families are public or explicitly excluded", async () => {
  const [source, inventory, excluded] = await Promise.all([
    Bun.file(new URL("src/hub/server.ts", root)).text(),
    readYaml<{ operations: Operation[] }>("api/operations.yaml"),
    readYaml<{ exclusions: Exclusion[] }>("api/exclusions.yaml"),
  ]);
  const hub = inventory.operations.filter(item => item.domain === "hub");
  const expected = [
    ["hubLogin", 'pathname === "/login"'],
    ["hubLogout", 'pathname === "/logout"'],
    ["hubGetState", 'pathname === "/api/hub/state"'],
    ["hubBrowse", 'pathname === "/api/hub/browse"'],
    ["hubCreateWorkspace", 'pathname === "/api/hub/workspaces"'],
    ["hubListDeviceSessions", 'pathname === "/api/hub/sessions"'],
    ["hubCreateCloneJob", 'pathname === "/api/hub/clone-jobs"'],
    ["hubStreamCloneJobEvents", "cloneJobEvents"],
    ["hubProbeCloneJobEvents", "cloneJobEvents"],
    ["hubSendCloneJobInput", "cloneJobAction"],
    ["hubCancelCloneJob", "cloneJobAction"],
    ["hubStartWorkspace", "const action ="],
    ["hubStopWorkspace", "const action ="],
    ["hubForgetWorkspace", "const forget ="],
    ["hubRevokeDeviceSession", "const revoke ="],
  ] as const;
  expect(hub.map(item => item.operationId).sort()).toEqual(expected.map(item => item[0]).sort());
  for (const [, marker] of expected) expect(source).toContain(marker);
  for (const id of ["hub-login-page", "hub-form-login", "hub-cookie-logout", "hub-dashboard", "hub-assets", "hub-manifest", "workspace-navigation"]) {
    expect(excluded.exclusions.some(item => item.id === id)).toBe(true);
  }
  const exactPaths = [...source.matchAll(/pathname === "([^"]+)"/g)].map(match => match[1]!);
  const publicPaths = new Set(hub.map(item => item.path));
  const excludedPaths = new Set(excluded.exclusions.flatMap(item => item.path ? [item.path] : []));
  const matchesExcludedPattern = (path: string) => excluded.exclusions.some(item =>
    item.pathPattern?.endsWith("*") && path.startsWith(item.pathPattern.slice(0, -1)),
  );
  expect(exactPaths.filter(path => !publicPaths.has(path) && !excludedPaths.has(path) && !matchesExcludedPattern(path))).toEqual([]);
});
