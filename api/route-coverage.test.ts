import { expect, test } from "bun:test";

import { readYaml } from "../scripts/validate-api";
import {
  CHILD_ACTIVITY_PATH,
  CHILD_DOCUMENT_EVENTS_PATH,
  CHILD_INVENTORY_EVENTS_PATH,
  childConversationEventsPath,
} from "../src/shared/live-protocol";

type Operation = { operationId: string; domain: "hub" | "workspace"; method: string; path: string; childPath?: string; runtime: string };
type Exclusion = { id: string; scope?: string; path?: string; pathPattern?: string; condition?: string };

const root = new URL("../", import.meta.url);

// An exclusion classifies a path explicitly when it names the path or a
// prefix pattern covering it. Conditional entries (unmatched navigation, the
// browser form variants) and the method catch-all describe fallbacks rather
// than routes, so they classify nothing here.
function explicitlyExcludes(exclusion: Exclusion, path: string): boolean {
  if (exclusion.condition !== undefined || exclusion.pathPattern === "*") return false;
  if (exclusion.path === path) return true;
  return exclusion.pathPattern?.endsWith("*") === true && path.startsWith(exclusion.pathPattern.slice(0, -1));
}

test("every workspace child route is an explicit internal exclusion", async () => {
  const [source, sessionsSource, inventory, excluded] = await Promise.all([
    Bun.file(new URL("src/server/routes.ts", root)).text(),
    Bun.file(new URL("src/terminal/sessions-route.ts", root)).text(),
    readYaml<{ operations: Operation[] }>("api/operations.yaml"),
    readYaml<{ exclusions: Exclusion[] }>("api/exclusions.yaml"),
  ]);
  // The workspace API left the public contract at workspace revision 16.
  expect(inventory.operations.filter(item => item.domain === "workspace").map(item => item.operationId)).toEqual([]);
  for (const id of ["workspace-api", "direct-child-api", "workspace-assets", "workspace-manifest", "workspace-debug", "workspace-terminal-cookie-auth", "e2e-reset", "e2e-terminal-token", "e2e-chat", "e2e-personal-state"]) {
    expect(excluded.exclusions.some(item => item.id === id)).toBe(true);
  }
  const candidates = excluded.exclusions.filter(item => item.scope !== "hub");
  // A child route is reachable through the Hub at /s/{workspaceId}<path>.
  // Test helpers exist only on the e2e harness's direct listener, so they
  // classify by their direct path.
  const classified = (path: string) => {
    const template = path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    return candidates.some(item => explicitlyExcludes(item, template) || explicitlyExcludes(item, `/s/{workspaceId}${template}`));
  };
  const literalRoutes = [...source.matchAll(/p\("([^"]+)"\)/g)].map(match => match[1]!);
  expect(literalRoutes.length).toBeGreaterThan(0);
  expect(literalRoutes.filter(path => !classified(path))).toEqual([]);
  // Routes registered through a shared constant escape the literal sweep.
  // Each one must be known here and classified below.
  const constantRoutes = [...source.matchAll(/p\(([A-Z][A-Z0-9_]*)\)/g)].map(match => match[1]!);
  expect(constantRoutes.filter(name => name !== "CHILD_ACTIVITY_PATH")).toEqual([]);
  // The fetch fallback dispatches on requestUrl.pathname comparisons rather
  // than p("...") literals. Sweep those too, so a new fallback branch cannot
  // escape both the contract and the exclusion list unnoticed.
  const fallbackPaths = [
    ...[...source.matchAll(/requestUrl\.pathname === "([^"]+)"/g)].map(match => match[1]!),
    ...[...source.matchAll(/requestUrl\.pathname\.startsWith\("([^"]+)"\)/g)].map(match => match[1]!.replace(/\/$/, "")),
  ].filter(path => path.startsWith("/"));
  expect(fallbackPaths.length).toBeGreaterThan(0);
  expect(fallbackPaths.filter(path => !classified(path) && !classified(`${path}/`))).toEqual([]);
  expect(sessionsSource).toContain('const SESSIONS_PATH = "/api/terminal/sessions"');
  expect(classified("/api/terminal/sessions")).toBe(true);
  expect(classified("/api/terminal/sessions/{terminalSessionId}")).toBe(true);
  // The SSE routes the Hub's live broker subscribes to, and the workspace
  // activity stream, are hub-to-child protocol. They must exist and be
  // classified like every other child route.
  for (const marker of ['p("/api/events")', 'p("/api/chat/conversations/events")', 'p("/api/chat/conversations/:conversationId/events")']) {
    expect(source).toContain(marker);
  }
  expect(source.includes(`p(${JSON.stringify(CHILD_ACTIVITY_PATH)})`) || source.includes("p(CHILD_ACTIVITY_PATH)")).toBe(true);
  for (const path of [CHILD_DOCUMENT_EVENTS_PATH, CHILD_INVENTORY_EVENTS_PATH, childConversationEventsPath("sample"), CHILD_ACTIVITY_PATH]) {
    expect(classified(path)).toBe(true);
  }
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
    ["hubCreateFolder", 'pathname === "/api/hub/folders/create"'],
    ["hubRenameFolder", 'pathname === "/api/hub/folders/rename"'],
    ["hubRemoveFolder", 'pathname === "/api/hub/folders/remove"'],
    ["hubCreateWorkspace", 'pathname === "/api/hub/workspaces"'],
    ["hubConfigureWorkspace", 'pathname === "/api/hub/workspaces/configure"'],
    ["hubCreateConfiguredWorkspace", 'pathname === "/api/hub/workspaces/create"'],
    ["hubUpdateWorkspaceDisplayName", "const displayNameUpdate ="],
    ["hubGetWorkspaceDefaults", 'pathname === "/api/hub/settings/workspace-defaults"'],
    ["hubUpdateWorkspaceDefaults", 'pathname === "/api/hub/settings/workspace-defaults"'],
    ["hubListDeviceSessions", 'pathname === "/api/hub/sessions"'],
    ["hubCreateCloneJob", 'pathname === "/api/hub/clone-jobs"'],
    ["hubStreamCloneJobEvents", "cloneJobEvents"],
    ["hubProbeCloneJobEvents", "cloneJobEvents"],
    ["hubSendCloneJobInput", "cloneJobAction"],
    ["hubCancelCloneJob", "cloneJobAction"],
    ["hubStreamLive", "pathname === LIVE_STREAM_PATH"],
    ["hubUpdateLiveSubscriptions", "LIVE_SUBSCRIPTIONS_PATH.exec(pathname)"],
    ["hubStartWorkspace", "const action ="],
    ["hubStopWorkspace", "const action ="],
    ["hubForgetWorkspace", "const forget ="],
    ["hubAssignWorkspaceCredentials", "workspaceCredentialAssignments"],
    ["hubRevokeDeviceSession", "const revoke ="],
    ["hubListCredentials", "CREDENTIAL_PATH && request.method === \"GET\""],
    ["hubListCredentialTools", "CREDENTIAL_TOOL_PATH && request.method === \"GET\""],
    ["hubGetCredentialPublicKey", "const publicKey ="],
    ["hubGenerateSshCredential", "const generation ="],
    ["hubImportSshCredential", "const generation ="],
    ["hubGenerateOpenPgpCredential", "const generation ="],
    ["hubImportOpenPgpCredential", "const generation ="],
    ["hubCreateTokenCredential", "`${CREDENTIAL_PATH}/token`"],
    ["hubSetCredentialTool", "const tool ="],
    ["hubTestCredentialTool", "const toolTest ="],
    ["hubUnlockCredential", "const action ="],
    ["hubLockCredential", "const action ="],
    ["hubEnableCredential", "const action ="],
    ["hubDisableCredential", "const action ="],
    ["hubAssignCredential", "const action ="],
    ["hubUnassignCredential", "const action ="],
    ["hubTestCredential", "const action ="],
    ["hubDeleteCredential", "const action ="],
  ] as const;
  expect(hub.map(item => item.operationId).sort()).toEqual(expected.map(item => item[0]).sort());
  for (const [, marker] of expected) expect(source).toContain(marker);
  for (const id of ["hub-login-page", "hub-form-login", "hub-cookie-logout", "hub-dashboard", "hub-clone-page", "hub-settings-page", "hub-assets", "hub-manifest", "workspace-navigation"]) {
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
  // handler, inline or bound to a constant, must match at least one documented hub path (with placeholders
  // substituted), so a new regex family cannot ship undocumented — and every
  // templated inventory path must be reachable through some swept regex.
  const routeRegexes = [
    ...[...source.matchAll(/(\/\^\\\/api\\\/hub\\\/.*?\$\/)\.exec\(/g)].map(match => new RegExp(match[1]!.slice(1, -1))),
    ...[...source.matchAll(/=\s*(\/\^\\\/api\\\/hub\\\/.*?\$\/);/g)].map(match => new RegExp(match[1]!.slice(1, -1))),
    /^\/api\/hub\/credentials\/[^/]+\/public-key$/,
    /^\/api\/hub\/credential-tools\/[^/]+(?:\/test)?$/,
    /^\/api\/hub\/credentials\/[^/]+\/(?:unlock|lock|enable|disable|assign|unassign|test|delete)$/,
  ];
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
