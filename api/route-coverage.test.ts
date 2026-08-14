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
  // The fetch fallback dispatches on requestUrl.pathname comparisons rather
  // than p("...") literals — sweep those too, so a new fallback branch cannot
  // escape both the contract and the exclusion list unnoticed.
  const fallbackPaths = [
    ...[...source.matchAll(/requestUrl\.pathname === "([^"]+)"/g)].map(match => match[1]!),
    ...[...source.matchAll(/requestUrl\.pathname\.startsWith\("([^"]+)"\)/g)].map(match => match[1]!.replace(/\/$/, "")),
  ].filter(path => path.startsWith("/"));
  expect(fallbackPaths.length).toBeGreaterThan(0);
  expect(fallbackPaths.filter(path => !classified(path) && !classified(`${path}/`))).toEqual([]);
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
  // Regex dispatch families: every /^\/api\/hub\/.../ route regex in the hub
  // handler must match at least one documented hub path (with placeholders
  // substituted), so a new regex family cannot ship undocumented — and every
  // templated inventory path must be reachable through some swept regex.
  const routeRegexes = [...source.matchAll(/(\/\^\\\/api\\\/hub\\\/.*?\$\/)\.exec\(/g)]
    .map(match => new RegExp(match[1]!.slice(1, -1)));
  expect(routeRegexes.length).toBeGreaterThan(0);
  const samplePaths = hub.map(item => item.path.replace(/\{[^}]+\}/g, "sample"));
  for (const regex of routeRegexes) {
    expect(samplePaths.some(path => regex.test(path))).toBe(true);
  }
  const templatedPaths = hub.filter(item => item.path.includes("{")).map(item => item.path.replace(/\{[^}]+\}/g, "sample"));
  for (const path of templatedPaths) {
    expect(routeRegexes.some(regex => regex.test(path))).toBe(true);
  }
  // Prefix dispatch guards must stay guards: any pathname.startsWith("...")
  // in the hub handler must be a known non-route guard, a documented path
  // prefix, or an excluded pattern.
  const startsWithPrefixes = [...source.matchAll(/pathname\.startsWith\("([^"]+)"\)/g)].map(match => match[1]!);
  const knownGuards = new Set(["/api/", "/api/hub/"]);
  expect(startsWithPrefixes.filter(prefix =>
    !knownGuards.has(prefix) && !excludedPaths.has(prefix) && !matchesExcludedPattern(prefix),
  )).toEqual([]);
});
