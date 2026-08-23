// The hub's HTTP surface: auth gate, login flow, dashboard + its APIs, and
// the /s/<id>/ proxy dispatch. Assembled as a single fetch handler so the
// gate provably runs before anything session- or dashboard-shaped executes.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ServerWebSocket } from "bun";

import hubMonoFontAsset from "../assets/fonts/HackNerdFontMono-Regular.woff2" with { type: "file" };
import hubIcon192Asset from "../assets/icon-192.png" with { type: "file" };
import hubIcon512Asset from "../assets/icon-512.png" with { type: "file" };

import {
  clientKeyForRateLimit,
  formatHubCookie,
  formatHubCookieClear,
  isSameOriginRequest,
  LoginRateLimiter,
  readPresentedSession,
  safeReturnPath,
  sanitizeDeviceLabel,
  sessionHandle,
  verifyLogin,
  type HubSessionStore,
} from "./auth";
import type { HubConfig } from "./config";
import { CloneJobManager, type CloneJobEvent } from "./clone-jobs";
import { CloneProcessAdapter } from "./clone-process";
import type { CloneCredentialResolver } from "./credential-context";
import { normalizeProviderHost } from "./credential-types";
import {
  CredentialApi,
  CredentialOperationRateLimiter,
  credentialApiError,
  readCredentialJson,
  type CredentialApiServices,
} from "./credential-api";
import { cloneTargetName, gitInit, probeGitRepository, validCloneFolderName } from "./git";
import { FolderManagerError, type FolderManager } from "./folder-manager";
import { clonePage, dashboardPage, loginPage, settingsPage, stoppedSessionPage } from "./pages";
import type { PathReservationCoordinator } from "./path-reservations";
import {
  bridgeWebSocketHandlers,
  childUrlFor,
  proxyHttp,
  upgradeToBridge,
  type BridgeData,
  type UpgradableServer,
} from "./proxy";
import type { WorkspaceRegistry } from "./registry";
import type { PersonalWorkspaceStateStore } from "./personal-state";
import type { SessionManager } from "./sessions";
import type { TerminalSessionInfo } from "../terminal/server";
import type { HubApiCompatibility } from "../shared/types";
import {
  BUILD,
  formatBuildIdentifier,
  HUB_API_REVISION,
  WORKSPACE_API_REVISION,
} from "../shared/version";

export type HubDeps = {
  config: HubConfig;
  registry: WorkspaceRegistry;
  sessions: SessionManager;
  sessionStore: HubSessionStore;
  personalState: PersonalWorkspaceStateStore;
  folderManager?: Pick<FolderManager, "create" | "rename" | "remove">;
  reservations?: PathReservationCoordinator;
  cloneJobs?: CloneJobManager;
  cloneCredentials?: CloneCredentialResolver;
  credentialApi?: CredentialApiServices;
  gitCommand?: () => string;
};

type HubServer = UpgradableServer & {
  requestIP?(request: Request): { address: string } | null;
};

const SESSION_PATH = /^\/s\/([^/]+)(\/|$)/;
const CREDENTIAL_PATH = "/api/hub/credentials";
const CREDENTIAL_TOOL_PATH = "/api/hub/credential-tools";

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return Response.json(body, { status, headers });
}

const NO_STORE_HEADERS = { "cache-control": "no-store" };

function closedJsonObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be an object");
  const body = value as Record<string, unknown>;
  const accepted = new Set(allowed);
  if (Object.keys(body).some(key => !accepted.has(key))) throw new Error("request contains an unknown field");
  return body;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// The return-to target as the login form should carry it. "/" is the default
// the form falls back to anyway, so rendering it would only put a redundant
// value in the markup and the URL.
function formTarget(target: string): string | undefined {
  return target === "/" ? undefined : target;
}

export function createHubFetchHandler(deps: HubDeps) {
  const { config, registry, sessions, sessionStore, personalState } = deps;
  const cloneJobs = deps.cloneJobs ?? new CloneJobManager({
    processFactory: new CloneProcessAdapter({ gitCommand: deps.gitCommand }),
    registry,
    sessions,
    credentials: deps.cloneCredentials,
    reservations: deps.reservations,
  });
  const limiter = new LoginRateLimiter();
  const credentialLimiter = new CredentialOperationRateLimiter();
  const credentialApi = deps.credentialApi ? new CredentialApi(deps.credentialApi) : null;
  const withCredentialLocks = <T>(credentialIds: string[], operation: () => Promise<T>): Promise<T> => {
    const ids = [...new Set(credentialIds)].sort();
    const acquire = (index: number): Promise<T> => index === ids.length
      ? operation()
      : deps.credentialApi!.metadata.runExclusiveCredential(ids[index]!, () => acquire(index + 1));
    return acquire(0);
  };
  // Disable, lock, and delete are revocations: they run under the lifecycle
  // queues for current assignments and live session projections (acquired in
  // sorted order, so concurrent revocations cannot deadlock). Assignments
  // commit while holding the credential's lock (inside their single
  // workspace queue — workspace queues always outermost, credential lock
  // always innermost), so once the revocation holds that lock a fresh union
  // is authoritative; if it names a workspace we have not locked, the
  // attempt retries with the wider set.
  const REVOKE_RETRY = Symbol("revoke-retry");
  const revokeExclusive = async <T>(credentialId: string, operation: () => Promise<T>): Promise<T> => {
    const affectedWorkspaces = () => [...new Set([
      ...(deps.credentialApi?.metadata.snapshot().assignments ?? [])
        .filter(assignment => assignment.credentialId === credentialId)
        .map(assignment => assignment.workspaceId),
      ...sessions.runningWorkspaceIdsUsingCredential(credentialId),
    ])].sort();
    const attempt = (workspaceIds: string[]): Promise<T | typeof REVOKE_RETRY> => {
      const acquire = (index: number): Promise<T | typeof REVOKE_RETRY> =>
        index < workspaceIds.length
          ? sessions.runExclusive(workspaceIds[index]!, () => acquire(index + 1))
          : deps.credentialApi!.metadata.runExclusiveCredential(credentialId, async () =>
              affectedWorkspaces().every(id => workspaceIds.includes(id)) ? operation() : REVOKE_RETRY);
      return acquire(0);
    };
    let workspaceIds = affectedWorkspaces();
    for (;;) {
      const result = await attempt(workspaceIds);
      if (result !== REVOKE_RETRY) return result;
      workspaceIds = [...new Set([...workspaceIds, ...affectedWorkspaces()])].sort();
    }
  };
  const stopProviderCliSessions = async (credentialId: string): Promise<void> => {
    const workspaceIds = sessions.runningWorkspaceIdsUsingCredential(credentialId);
    const results = await Promise.allSettled(workspaceIds.map(id => sessions.stopWhileLifecycleQueueHeld(id)));
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) {
      throw new AggregateError(failures, "one or more workspace sessions failed to stop before provider credential revocation");
    }
  };

  // Whether the browser-facing connection is HTTPS: either the hub
  // terminates TLS itself, or a fronting proxy (tailscale serve, Caddy,
  // nginx) says so via X-Forwarded-Proto. The header can only ADD the
  // Secure attribute — a forged value on a plain-HTTP hop hardens the
  // cookie, never weakens it — so trusting it needs no proxy allowlist.
  const secureCookies = (request: Request): boolean =>
    config.tls !== null ||
    (request.headers.get("x-forwarded-proto") ?? "").toLowerCase().includes("https");

  // The gate's verdict: a presented session id — cookie or bearer, one
  // verification path — that resolves in the store (known, unrevoked,
  // unexpired) AND belongs to a user that still exists in the config.
  // Removing a user from the config (plus a restart) kills their
  // outstanding sessions even without explicit revocation.
  const authenticatedSession = (request: Request) => {
    const presented = readPresentedSession(request);
    if (!presented) return null;
    const record = sessionStore.resolve(presented.id);
    if (!record) return null;
    if (!config.users.some(user => user.name === record.user)) return null;
    return { user: record.user, sessionId: record.id, transport: presented.transport };
  };

  // CSRF: cookie-authenticated state changes need the same-origin check; a
  // bearer credential is attached explicitly by the client and cannot be
  // ridden by a cross-site page.
  const csrfOk = (request: Request, transport: "cookie" | "bearer"): boolean =>
    transport === "bearer" || isSameOriginRequest(request);

  const handleLogin = async (request: Request, server: HubServer): Promise<Response> => {
    // The validated return-to target, carried by the gate's redirect
    // (?next=…) and echoed by the form through BOTH its action and a hidden
    // field, so every branch of the POST — including the ones that answer
    // before the body is read — can honor it.
    const nextTarget = safeReturnPath(new URL(request.url).searchParams.get("next"));
    if (request.method === "GET") {
      if (authenticatedSession(request)) {
        return Response.redirect(nextTarget, 303);
      }
      return htmlResponse(loginPage({ next: formTarget(nextTarget) }));
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405, headers: NO_STORE_HEADERS });
    }
    // Where this request returns to. Seeded from the URL — the form posts to
    // /login?next=… precisely so the branches that answer before the body is
    // read still have it — and narrowed to the posted value once there is one.
    let returnTarget = nextTarget;
    // Every HTML failure renders through here. Passing the target at four
    // separate call sites is how it came to be dropped at all four; one
    // helper means a branch added later cannot quietly lose it again.
    const errorPage = (error: string, status: number): Response =>
      htmlResponse(loginPage({ error, next: formTarget(returnTarget) }), status);
    // JSON logins are the native-client path (no page to render, no
    // Origin header sent) — their failures answer as JSON so a client can
    // distinguish "wrong password" from transport trouble.
    const isJson = (request.headers.get("content-type") ?? "").includes("application/json");
    if (!isSameOriginRequest(request)) {
      return isJson
        ? json(403, { error: "cross-origin login rejected" }, NO_STORE_HEADERS)
        : errorPage("cross-origin login rejected", 403);
    }

    const ip = clientKeyForRateLimit(
      server.requestIP?.(request)?.address ?? null,
      request.headers.get("x-forwarded-for"),
    );
    if (!limiter.allow(ip)) {
      return isJson
        ? json(429, { error: "too many attempts — wait a minute and try again" }, NO_STORE_HEADERS)
        : errorPage("too many attempts — wait a minute and try again", 429);
    }

    let name = "";
    let password = "";
    let requestedLabel: unknown;
    // Browser form flow only — native JSON logins have no page to return to.
    let postedNext: string | null = null;
    try {
      if (isJson) {
        const body = (await request.json()) as { name?: unknown; password?: unknown; deviceLabel?: unknown };
        name = typeof body.name === "string" ? body.name : "";
        password = typeof body.password === "string" ? body.password : "";
        requestedLabel = body.deviceLabel;
      } else {
        const form = await request.formData();
        name = String(form.get("name") ?? "");
        password = String(form.get("password") ?? "");
        const rawNext = form.get("next");
        postedNext = typeof rawNext === "string" && rawNext ? rawNext : null;
        // The posted value is the more specific statement of intent, so it
        // wins over the URL's — including when it fails validation, where
        // narrowing to "/" is the point rather than a fallback to something
        // the attacker did not supply.
        if (postedNext) {
          returnTarget = safeReturnPath(postedNext);
        }
      }
    } catch {
      return isJson
        ? json(400, { error: "malformed login request" }, NO_STORE_HEADERS)
        : errorPage("malformed login request", 400);
    }

    const user = await verifyLogin(config, name, password);
    if (!user) {
      limiter.recordFailure(ip);
      // Deliberately identical for wrong password and unknown user.
      return isJson
        ? json(401, { error: "invalid credentials" }, NO_STORE_HEADERS)
        : errorPage("invalid credentials", 401);
    }
    limiter.reset(ip);

    const record = await sessionStore.issue(
      user.name,
      sanitizeDeviceLabel(requestedLabel, request.headers.get("user-agent")),
    );
    const setCookie = formatHubCookie(record.id, { secure: secureCookies(request) });
    if (isJson) {
      // The session id doubles as the bearer credential for native
      // clients; the cookie is set too so a web view sharing the client's
      // cookie jar is signed in at once.
      return Response.json(
        { sessionId: record.id, user: user.name },
        { status: 200, headers: { "set-cookie": setCookie, ...NO_STORE_HEADERS } },
      );
    }
    return new Response(null, {
      status: 303,
      headers: {
        // Back to the page the gate bounced from, when a validated target
        // rode the form or the URL; the dashboard otherwise.
        location: returnTarget,
        "set-cookie": setCookie,
        ...NO_STORE_HEADERS,
      },
    });
  };

  const hubState = async (): Promise<Response> => {
    const credentialState = deps.credentialApi?.metadata.snapshot();
    const credentialNames = new Map(credentialState?.credentials.map(credential => [credential.id, credential.name]));
    const workspaces = await Promise.all(
      registry.list().map(async entry => {
        const running = sessions.get(entry.id);
        let shells: Pick<TerminalSessionInfo, "attached" | "label">[] | undefined;
        if (running) {
          try {
            const url = childUrlFor(running, new URL(`http://x/s/${entry.id}/api/terminal/sessions`));
            // Bounded: a wedged child that accepts but never answers must
            // degrade to an omitted summary, not hang the whole dashboard
            // state endpoint. Two seconds is generous for a loopback call.
            const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
            if (response.ok) {
              const payload = (await response.json()) as { sessions?: TerminalSessionInfo[] };
              shells = (payload.sessions ?? []).map(({ attached, label }) => ({ attached, label }));
            }
          } catch {
            // Shell summary is best-effort decoration.
          }
        }
        const authentication = new Set<string>();
        const signing = new Set<string>();
        for (const assignment of credentialState?.assignments ?? []) {
          if (assignment.workspaceId !== entry.id) continue;
          const name = credentialNames.get(assignment.credentialId);
          if (name) (assignment.role === "authentication" ? authentication : signing).add(name);
        }
        return {
          id: entry.id,
          path: entry.path,
          backend: entry.backend,
          running: running !== undefined,
          credentialRestartRequired: sessions.credentialRestartRequired(entry.id),
          credentialAssignments: {
            authentication: [...authentication],
            signing: [...signing],
          },
          // The local-process backend always spawns this build's binary, so
          // every child speaks this constant. A backend that runs children
          // of other builds (the deferred container backend) must report
          // the child's own revision here instead of the hub's.
          workspaceApiRevision: WORKSPACE_API_REVISION,
          shells,
        };
      }),
    );
    const compatibility: HubApiCompatibility = {
      hubApiRevision: HUB_API_REVISION,
      workspaceApiRevision: WORKSPACE_API_REVISION,
    };
    return json(200, { version: formatBuildIdentifier(BUILD), ...compatibility, workspaces });
  };

  // GET /api/hub/browse?path=<abs> — one level of the hub host's directory
  // tree, for the dashboard's Add Folder drill-down (and the desktop's
  // clone-destination picker). Directories only, dot-directories hidden,
  // symlinks not followed (a symlinked dirent is not a directory dirent).
  // Filesystem visibility here is within the documented trust model: hub
  // users already hold shell access through the embedded terminal.
  const browse = async (url: URL): Promise<Response> => {
    const requested = url.searchParams.get("path") ?? os.homedir();
    if (!path.isAbsolute(requested)) {
      return json(400, { error: "path must be absolute" });
    }
    const resolved = path.resolve(requested);
    let dirents;
    try {
      dirents = await fs.readdir(resolved, { withFileTypes: true });
    } catch {
      return json(404, { error: `cannot read directory: ${resolved}` });
    }
    const dirs = await Promise.all(
      dirents
        .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith("."))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(async dirent => {
          const folder = path.join(resolved, dirent.name);
          // A repository root carries .git — a directory normally, a file
          // for linked worktrees. Decoration only; registration re-probes.
          const git = await fs
            .stat(path.join(folder, ".git"))
            .then(() => true)
            .catch(() => false);
          const registered = registry.byPath(folder);
          return { name: dirent.name, git, registeredId: registered?.id ?? null };
        }),
    );
    const parent = path.dirname(resolved);
    return json(200, { path: resolved, parent: parent === resolved ? null : parent, dirs });
  };

  // POST /api/hub/workspaces {path, init?} — registers any absolute folder
  // path. The git preflight mirrors the desktop launcher's rules: a
  // definitive not-a-repository answer yields a 409 {needsInit:true} the
  // client turns into a confirmation; confirming re-posts with init:true.
  // Declining posts nothing — no registration. An indeterminate probe skips
  // the offer and serves; the CLI's own preflight reports (and --force is
  // never passed).
  // body.start === false registers without starting a session — the
  // desktop's one-time recents import needs registered-but-stopped entries.
  const createWorkspace = async (request: Request): Promise<Response> => {
    let body: { path?: unknown; init?: unknown; start?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
    const requested = typeof body.path === "string" ? body.path : "";
    if (requested === "" || !path.isAbsolute(requested)) {
      return json(400, { error: "an absolute folder path is required" });
    }
    const folder = path.resolve(requested);
    let isDirectory = false;
    try {
      isDirectory = (await fs.stat(folder)).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      return json(404, { error: `no such folder: ${folder}` });
    }
    if (cloneJobs.isTargetReserved(folder)) {
      return json(409, { error: `folder is currently being cloned: ${folder}` });
    }

    const gitCommand = deps.gitCommand?.() ?? "git";
    const probe = await probeGitRepository(folder, gitCommand);
    if (probe.kind === "not-a-repository") {
      if (body.init !== true) {
        return json(409, { needsInit: true, error: `${folder} is not a git repository` });
      }
      const initialized = await gitInit(folder, gitCommand);
      if (!initialized.ok) {
        return json(500, { error: `git init failed: ${initialized.error}` });
      }
    }

    const { entry, created } = await registry.registerWithStatus(folder);
    if (body.start === false) {
      return json(200, { id: entry.id, running: false });
    }
    try {
      await sessions.start(entry.id, created ? async () => {
        if (!(await registry.remove(entry.id))) throw new Error(`workspace registration was not removed: ${entry.id}`);
        await deps.credentialApi?.metadata.removeWorkspaceAssignments(entry.id);
      } : undefined);
    } catch (error) {
      // A folder that fails to serve is not left registered — mirroring the
      // launcher rule that a declined/failed folder leaves no trace.
      return json(500, { error: error instanceof Error ? error.message : String(error) });
    }
    return json(200, { id: entry.id });
  };

  // A clone is a user-owned, addressable job: creation returns immediately;
  // output is replayable SSE; input and cancellation are POST mutations.
  const createCloneJob = async (request: Request, owner: string): Promise<Response> => {
    let body: Record<string, unknown>;
    try {
      body = closedJsonObject(await request.json(), ["url", "dest", "folderName", "credentialId", "retainAssignment"]);
    } catch {
      return json(400, { error: "invalid JSON body or unknown field" });
    }
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (url === "" || cloneTargetName(url) === null) {
      return json(400, { error: "a git clone URL is required" });
    }
    const dest = typeof body.dest === "string" ? body.dest : "";
    if (dest === "" || !path.isAbsolute(dest)) {
      return json(400, { error: "an absolute destination directory is required" });
    }
    const requestedFolderName = typeof body.folderName === "string" ? body.folderName.trim() : "";
    if (requestedFolderName !== "" && !validCloneFolderName(requestedFolderName)) {
      return json(400, { error: "checkout folder name must be a single folder name" });
    }
    if (body.credentialId !== undefined && (typeof body.credentialId !== "string" || body.credentialId.trim() === "")) {
      return json(400, { error: "credentialId must be a non-empty string" });
    }
    if (body.retainAssignment !== undefined && typeof body.retainAssignment !== "boolean") {
      return json(400, { error: "retainAssignment must be a boolean" });
    }
    const credentialId = typeof body.credentialId === "string" ? body.credentialId : undefined;
    if (body.retainAssignment === true && !credentialId) {
      return json(400, { error: "retainAssignment requires credentialId" });
    }
    try {
      const credential = await cloneJobs.resolveCredential(url, credentialId);
      // A clone-only host (a valid OpenSSH alias, say) can never back an
      // assignment; rejecting retention here beats cloning fully and then
      // rolling the registration back over an assign the metadata parser
      // was always going to refuse.
      if (body.retainAssignment === true && credential) {
        try {
          normalizeProviderHost(credential.host);
        } catch {
          throw new Error(`selected credential cannot retain an assignment for this clone host: ${credential.host}`);
        }
      }
      const resolvedDest = path.resolve(dest);
      await fs.mkdir(resolvedDest, { recursive: true });
      const target = path.join(await fs.realpath(resolvedDest), requestedFolderName || cloneTargetName(url)!);
      if (registry.byPath(target)) {
        return json(409, { error: `workspace is already registered: ${target}` });
      }
      if (await fs.stat(target).then(() => true).catch(() => false)) {
        return json(409, { error: `target already exists: ${target}` });
      }
      return json(202, cloneJobs.create(owner, url, target, {
        credential,
        retainAssignment: body.retainAssignment === true,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const requestError = /credential|clone URL|SSH or HTTPS/.test(message);
      const conflict = /already reserved|locked|disabled|unavailable/.test(message);
      return json(conflict ? 409 : requestError ? 400 : 500, { error: message });
    }
  };

  const cloneEvents = (request: Request, owner: string, jobId: string): Response => {
    if (!cloneJobs.has(owner, jobId)) return json(404, { error: "clone job not found" });
    const afterEventId = Number.parseInt(request.headers.get("last-event-id") ?? "0", 10);
    let unsubscribe: (() => void) | undefined;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: CloneJobEvent) => {
          try {
            controller.enqueue(encoder.encode(
              `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
            ));
            if (event.type === "result") controller.close();
          } catch {
            unsubscribe?.();
          }
        };
        unsubscribe = cloneJobs.subscribe(
          owner,
          jobId,
          Number.isFinite(afterEventId) ? afterEventId : 0,
          send,
        ) ?? undefined;
      },
      cancel() {
        unsubscribe?.();
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  };

  const folderError = (error: unknown): Response => {
    if (!(error instanceof FolderManagerError)) {
      return json(500, { error: "folder operation failed" }, NO_STORE_HEADERS);
    }
    const status = error.code === "invalid-input"
      ? 400
      : error.code === "not-found"
        ? 404
        : error.code === "conflict" || error.code === "not-empty"
          ? 409
          : 500;
    return json(status, { error: error.message }, NO_STORE_HEADERS);
  };

  const mutateFolder = async (
    request: Request,
    operation: "create" | "rename" | "remove",
  ): Promise<Response> => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid JSON body" }, NO_STORE_HEADERS);
    }
    try {
      if (operation === "create") {
        return json(200, await deps.folderManager!.create(body), NO_STORE_HEADERS);
      }
      const result = operation === "rename"
        ? await deps.folderManager!.rename(body)
        : await deps.folderManager!.remove(body);
      if (result.status === "needs-stop") {
        return json(409, {
          error: "affected workspace sessions must be stopped",
          needsStop: true,
          workspaceIds: result.workspaceIds,
        }, NO_STORE_HEADERS);
      }
      return json(200, result.value, NO_STORE_HEADERS);
    } catch (error) {
      return folderError(error);
    }
  };

  return async (request: Request, server: HubServer): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Un-gated: the login flow and the dashboard's static assets.
    if (pathname === "/login") {
      return handleLogin(request, server);
    }
    if (pathname === "/logout" && request.method === "POST") {
      const presented = readPresentedSession(request);
      // Cross-origin logout (a cookie-riding forced sign-out) is refused
      // before anything is revoked; an explicit bearer credential cannot
      // be cross-site-ridden and needs no Origin.
      if (presented?.transport !== "bearer" && !isSameOriginRequest(request)) {
        return json(403, { error: "cross-origin request rejected" });
      }
      // Server-side revocation: the presented session dies for every
      // transport immediately. An absent or already-dead id still clears
      // the cookie — logout is idempotent.
      if (presented) {
        await sessionStore.revoke(presented.id);
      }
      if (presented?.transport === "bearer") {
        return json(200, { revoked: true });
      }
      return new Response(null, {
        status: 303,
        headers: {
          location: "/login",
          "set-cookie": formatHubCookieClear({ secure: secureCookies(request) }),
        },
      });
    }
    if (pathname === "/hub-assets/mono.woff2") {
      return new Response(Bun.file(hubMonoFontAsset), {
        headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" },
      });
    }
    // The hub's own web-app manifest, ungated: install-time fetches may be
    // anonymous (Safari fetches it when adding to the home screen) and a
    // 401 would silently degrade installs — the manifest carries only
    // branding. Scope "/" makes the whole hub origin — login, dashboard,
    // and every /s/<id>/ session — one installed app, so navigating
    // between them never shows iOS's out-of-scope browser chrome.
    if (pathname === "/manifest.webmanifest") {
      return Response.json(
        {
          name: "UatuCode Hub",
          short_name: "Uatu Hub",
          description: "Self-hosted hub for UatuCode sessions.",
          start_url: "/",
          scope: "/",
          display: "standalone",
          background_color: "#ffffff",
          theme_color: "#0a1c38",
          icons: [
            { src: "/hub-assets/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
            { src: "/hub-assets/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
          ],
        },
        {
          headers: {
            "content-type": "application/manifest+json",
            "cache-control": "public, max-age=3600",
          },
        },
      );
    }
    if (pathname === "/hub-assets/icon-192.png" || pathname === "/hub-assets/icon-512.png") {
      const asset = pathname.endsWith("icon-192.png") ? hubIcon192Asset : hubIcon512Asset;
      return new Response(Bun.file(asset), {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
      });
    }

    // The gate. Everything below requires an authenticated hub session
    // belonging to a still-configured user — on every interface, loopback
    // included.
    const session = authenticatedSession(request);
    if (!session) {
      const wantsHtml = (request.headers.get("accept") ?? "").includes("text/html");
      if (request.method === "GET" && wantsHtml && !pathname.startsWith("/api/")) {
        // Carry the originally requested path so a successful sign-in
        // returns here instead of dumping the user on the dashboard —
        // critical for installed webapps launching straight into a
        // session URL. Validated again at login time; "/" is the noise
        // case not worth carrying.
        const next = safeReturnPath(pathname + url.search);
        return Response.redirect(next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`, 303);
      }
      return json(401, { error: "authentication required" }, NO_STORE_HEADERS);
    }

    // Proxied session traffic. Validate the browser's origin BEFORE any
    // rewriting: SameSite=Lax still attaches the cookie on same-site
    // cross-origin requests (another port, a sibling subdomain), and the
    // proxy deliberately replaces Origin with a loopback one the child
    // trusts — so an unchecked hostile Origin here would ride the rewrite
    // straight past the child's own gate to an interactive shell. Browsers
    // always send Origin on WebSocket upgrades and cross-origin fetches;
    // absent Origin (same-origin GETs, non-browser clients) passes.
    const sessionMatch = SESSION_PATH.exec(pathname);
    if (sessionMatch) {
      if (!csrfOk(request, session.transport)) {
        return json(403, { error: "cross-origin request rejected" }, NO_STORE_HEADERS);
      }
      let workspaceId: string;
      try {
        workspaceId = decodeURIComponent(sessionMatch[1]!);
      } catch {
        return json(400, { error: "malformed workspace id" });
      }
      const suffix = pathname.slice(sessionMatch[0].endsWith("/") ? sessionMatch[0].length - 1 : sessionMatch[0].length);
      if (suffix === "/api/personal-state") {
        if (!registry.byId(workspaceId)) {
          return json(404, { error: `unknown workspace: ${workspaceId}` });
        }
        if (request.method === "GET") {
          return json(200, personalState.get(session.user, workspaceId));
        }
        if (request.method !== "PATCH") {
          return new Response(JSON.stringify({ error: "method not allowed" }), {
            status: 405,
            headers: { "content-type": "application/json", allow: "GET, PATCH" },
          });
        }
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return json(400, { error: "invalid JSON body" });
        }
        try {
          const state = await sessions.runExclusive(workspaceId, async () => {
            if (!registry.byId(workspaceId)) throw new Error(`unknown workspace: ${workspaceId}`);
            return personalState.patch(session.user, workspaceId, body);
          });
          return json(200, state);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith("unknown workspace:")) return json(404, { error: message });
          if (/personal state|documentPath|follow|previewMode|compareTarget|filesFilter|lastPtyId|unknown/.test(message)) {
            return json(400, { error: message });
          }
          return json(500, { error: "failed to persist personal state" });
        }
      }
      const running = sessions.get(workspaceId);
      if (!running) {
        return htmlResponse(stoppedSessionPage(workspaceId, registry.byId(workspaceId) !== undefined), 503);
      }
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return upgradeToBridge(request, server, running);
      }
      return proxyHttp(request, running);
    }

    // Dashboard + its APIs.
    if (pathname === "/" && request.method === "GET") {
      return htmlResponse(dashboardPage(session.user));
    }
    if (pathname === "/clone" && request.method === "GET") {
      return htmlResponse(clonePage(session.user));
    }
    if (pathname === "/settings" && request.method === "GET") {
      return htmlResponse(settingsPage(session.user));
    }
    if (pathname === "/api/hub/state" && request.method === "GET") {
      return hubState();
    }
    if (pathname === "/api/hub/browse" && request.method === "GET") {
      return browse(url);
    }
    if (pathname === CREDENTIAL_PATH && request.method === "GET" && credentialApi) {
      return json(200, { credentials: await credentialApi.listCredentials() }, { "cache-control": "no-store" });
    }
    if (pathname === CREDENTIAL_TOOL_PATH && request.method === "GET" && credentialApi) {
      return json(200, { tools: credentialApi.listTools() }, { "cache-control": "no-store" });
    }
    const publicKey = new RegExp(`^${CREDENTIAL_PATH}/([^/]+)/public-key$`).exec(pathname);
    if (publicKey && request.method === "GET" && credentialApi) {
      try {
        return json(200, credentialApi.publicKey(decodeURIComponent(publicKey[1]!)), { "cache-control": "no-store" });
      } catch (error) {
        const mapped = credentialApiError(error);
        return json(mapped.status, { error: mapped.message }, { "cache-control": "no-store" });
      }
    }
    const cloneJobEvents = /^\/api\/hub\/clone-jobs\/([^/]+)\/events$/.exec(pathname);
    if (cloneJobEvents && (request.method === "GET" || request.method === "HEAD")) {
      const jobId = decodeURIComponent(cloneJobEvents[1]!);
      if (request.method === "HEAD") {
        return cloneJobs.has(session.user, jobId)
          ? new Response(null, { status: 204 })
          : json(404, { error: "clone job not found" });
      }
      return cloneEvents(request, session.user, jobId);
    }
    // The device-session list: the signed-in user's active sessions, with
    // per-session revocation handles. Handles are id prefixes — never the
    // full id, which is a live credential the page has no business holding.
    if (pathname === "/api/hub/sessions" && request.method === "GET") {
      return json(200, {
        sessions: sessionStore.listForUser(session.user).map(record => ({
          handle: sessionHandle(record),
          deviceLabel: record.deviceLabel,
          issuedAt: record.issuedAt,
          current: record.id === session.sessionId,
        })),
      });
    }

    // State-changing endpoints: POST-only + same-origin (CSRF) for
    // cookie-authenticated requests; bearer requests carry no ambient
    // credential and skip the Origin check.
    if (pathname.startsWith("/api/hub/")) {
      if (request.method !== "POST") {
        return json(405, { error: "method not allowed" });
      }
      if (!csrfOk(request, session.transport)) {
        return json(403, { error: "cross-origin request rejected" }, NO_STORE_HEADERS);
      }
      const workspaceCredentialAssignments = /^\/api\/hub\/workspaces\/([^/]+)\/credential-assignments$/.exec(pathname);
      if (workspaceCredentialAssignments && credentialApi) {
        const headers = NO_STORE_HEADERS;
        try {
          const workspaceId = decodeURIComponent(workspaceCredentialAssignments[1]!);
          const body = await readCredentialJson(request);
          const credentialIds = [body.authentication, body.signing].flatMap(value => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return [];
            return typeof (value as Record<string, unknown>).credentialId === "string"
              ? [(value as Record<string, string>).credentialId]
              : [];
          });
          const assignments = await sessions.runExclusive(workspaceId, () =>
            withCredentialLocks(credentialIds, () => credentialApi.assignWorkspace(workspaceId, body)));
          return json(200, { assignments }, headers);
        } catch (error) {
          const mapped = credentialApiError(error);
          return json(mapped.status, { error: mapped.message }, headers);
        }
      }
      if (credentialApi && (pathname.startsWith(`${CREDENTIAL_PATH}/`) || pathname.startsWith(`${CREDENTIAL_TOOL_PATH}/`))) {
        const headers = { "cache-control": "no-store" };
        try {
          const body = await readCredentialJson(request);
          const generation = new RegExp(`^${CREDENTIAL_PATH}/(ssh|openpgp)/(generate|import)$`).exec(pathname);
          if (generation) {
            const client = clientKeyForRateLimit(server.requestIP?.(request)?.address ?? null, request.headers.get("x-forwarded-for"));
            if (!credentialLimiter.allow(`${session.user}:${client}:generate`, 5)) return json(429, { error: "too many credential operations; wait a minute and try again" }, headers);
            const result = generation[1] === "ssh"
              ? generation[2] === "generate" ? await credentialApi.generateSsh(body) : await credentialApi.importSsh(body)
              : generation[2] === "generate" ? await credentialApi.generateOpenPgp(body) : await credentialApi.importOpenPgp(body);
            return json(200, { credential: result }, headers);
          }
          if (pathname === `${CREDENTIAL_PATH}/token`) {
            return json(200, { credential: await credentialApi.createToken(body) }, headers);
          }
          const toolTest = new RegExp(`^${CREDENTIAL_TOOL_PATH}/([^/]+)/test$`).exec(pathname);
          if (toolTest) return json(200, { tool: await credentialApi.testTool(decodeURIComponent(toolTest[1]!), body) }, headers);
          const tool = new RegExp(`^${CREDENTIAL_TOOL_PATH}/([^/]+)$`).exec(pathname);
          if (tool) return json(200, { tool: await credentialApi.setTool(decodeURIComponent(tool[1]!), body) }, headers);
          const action = new RegExp(`^${CREDENTIAL_PATH}/([^/]+)/(unlock|lock|enable|disable|assign|unassign|test|delete)$`).exec(pathname);
          if (action) {
            const credentialId = decodeURIComponent(action[1]!);
            const operation = action[2]!;
            if (operation === "unlock" || operation === "test") {
              const client = clientKeyForRateLimit(server.requestIP?.(request)?.address ?? null, request.headers.get("x-forwarded-for"));
              if (!credentialLimiter.allow(`${session.user}:${client}:passphrase`, 10)) return json(429, { error: "too many credential operations; wait a minute and try again" }, headers);
            }
            if (operation === "unlock") return json(200, { credential: await credentialApi.unlock(credentialId, body) }, headers);
            if (operation === "lock") return json(200, { credential: await revokeExclusive(credentialId, () => credentialApi.lock(credentialId, body)) }, headers);
            if (operation === "enable") {
              return json(200, { credential: await deps.credentialApi!.metadata.runExclusiveCredential(credentialId, () => credentialApi.setEnabled(credentialId, body, true)) }, headers);
            }
            if (operation === "disable") {
              return json(200, { credential: await revokeExclusive(credentialId, async () => {
                if (credentialApi.preflightProviderCliRevocation(credentialId, body, "disable")) {
                  await stopProviderCliSessions(credentialId);
                }
                return credentialApi.setEnabled(credentialId, body, false);
              }) }, headers);
            }
            if (operation === "assign") {
              const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
              const assignment = await sessions.runExclusive(workspaceId, () =>
                deps.credentialApi!.metadata.runExclusiveCredential(credentialId, () => credentialApi.assign(credentialId, body)));
              return json(200, { assignment }, headers);
            }
            if (operation === "unassign") {
              const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
              // stop: true makes stop-and-remove one lifecycle operation: the
              // unassignment runs inside the stop, so a concurrent start
              // cannot slip between them and keep the removed credential
              // projected into a live session.
              if (body.stop === true) {
                let removed = false;
                await sessions.stop(workspaceId, async () => {
                  removed = await credentialApi.unassign(credentialId, body);
                });
                return json(200, { removed }, headers);
              }
              const removed = await sessions.runExclusive(workspaceId, () => {
                // A running child keeps its projected credential
                // configuration, and the Hub-side helper serves tokens by
                // id — removing only the catalog assignment would report a
                // revocation that is not in effect. The page sends
                // stop: true for running workspaces; other clients must too.
                if (sessions.isRunning(workspaceId)) {
                  throw new Error("credential assignment removal conflicts with the running workspace session; stop it first or pass stop: true");
                }
                return credentialApi.unassign(credentialId, body);
              });
              return json(200, { removed }, headers);
            }
            if (operation === "test") return json(200, { results: await credentialApi.test(credentialId, body) }, headers);
            return json(200, { deleted: await revokeExclusive(credentialId, async () => {
              if (credentialApi.preflightProviderCliRevocation(credentialId, body, "delete")) {
                await stopProviderCliSessions(credentialId);
              }
              return credentialApi.delete(credentialId, body);
            }) }, headers);
          }
        } catch (error) {
          const mapped = credentialApiError(error);
          return json(mapped.status, { error: mapped.message }, headers);
        }
      }
      // Revoke one of the current user's sessions by handle. Revoking the
      // session serving this request behaves as sign-out: the response
      // clears the cookie and the client lands on /login.
      const revoke = /^\/api\/hub\/sessions\/([^/]+)\/revoke$/.exec(pathname);
      if (revoke) {
        const record = sessionStore.findByHandle(session.user, decodeURIComponent(revoke[1]!));
        if (!record) {
          return json(404, { error: "unknown session" });
        }
        await sessionStore.revoke(record.id);
        const current = record.id === session.sessionId;
        if (current && session.transport === "cookie") {
          return json(200, { revoked: true, current }, {
            "set-cookie": formatHubCookieClear({ secure: secureCookies(request) }),
          });
        }
        return json(200, { revoked: true, current });
      }
      if (pathname === "/api/hub/workspaces") {
        return createWorkspace(request);
      }
      if (deps.folderManager) {
        if (pathname === "/api/hub/folders/create") return mutateFolder(request, "create");
        if (pathname === "/api/hub/folders/rename") return mutateFolder(request, "rename");
        if (pathname === "/api/hub/folders/remove") return mutateFolder(request, "remove");
      }
      if (pathname === "/api/hub/clone-jobs") {
        return createCloneJob(request, session.user);
      }
      const cloneJobAction = /^\/api\/hub\/clone-jobs\/([^/]+)\/(input|cancel)$/.exec(pathname);
      if (cloneJobAction) {
        const jobId = decodeURIComponent(cloneJobAction[1]!);
        if (cloneJobAction[2] === "cancel") {
          const result = await cloneJobs.cancel(session.user, jobId);
          if (result === "not-found") return json(404, { error: "clone job not found" });
          if (result === "cleanup-failed") return json(500, { error: "clone job cleanup failed; review the job output and workspace state" });
          return json(200, { status: result });
        }
        let body: Record<string, unknown>;
        try {
          body = closedJsonObject(await request.json(), ["input"]);
        } catch {
          return json(400, { error: "invalid JSON body or unknown field" }, NO_STORE_HEADERS);
        }
        if (typeof body.input !== "string") return json(400, { error: "a terminal response is required" }, NO_STORE_HEADERS);
        const result = cloneJobs.input(session.user, jobId, body.input);
        if (result === "not-found") return json(404, { error: "clone job not found" }, NO_STORE_HEADERS);
        if (result === "inactive") return json(409, { error: "clone job is not accepting input" }, NO_STORE_HEADERS);
        if (result === "too-large") return json(413, { error: "terminal response is too large" }, NO_STORE_HEADERS);
        return json(200, { accepted: true }, NO_STORE_HEADERS);
      }
      const action = /^\/api\/hub\/sessions\/([^/]+)\/(start|stop)$/.exec(pathname);
      if (action) {
        const workspaceId = decodeURIComponent(action[1]!);
        if (!registry.byId(workspaceId)) {
          return json(404, { error: `unknown workspace: ${workspaceId}` });
        }
        if (action[2] === "start") {
          try {
            await sessions.start(workspaceId);
            return json(200, { id: workspaceId, running: true });
          } catch (error) {
            return json(500, { error: error instanceof Error ? error.message : String(error) });
          }
        }
        const stopped = await sessions.stop(workspaceId);
        return json(200, { id: workspaceId, running: false, wasRunning: stopped });
      }

      // Forget = unregister only. The folder stays on disk and reappears in
      // the folder listing as an unregistered candidate; a running session
      // must be stopped first so a forget can never orphan a live shell.
      const forget = /^\/api\/hub\/workspaces\/([^/]+)\/forget$/.exec(pathname);
      if (forget) {
        const workspaceId = decodeURIComponent(forget[1]!);
        const workspace = registry.byId(workspaceId);
        if (!workspace) {
          return json(404, { error: `unknown workspace: ${workspaceId}` });
        }
        if (cloneJobs.isTargetReserved(workspace.path)) {
          return json(409, { error: `workspace is being finalized by a clone job: ${workspaceId}` });
        }
        try {
          await sessions.runWhileStopped(workspaceId, () =>
            personalState.forgetWorkspace(
              workspaceId,
              () => registry.remove(workspaceId),
              async () => { await deps.credentialApi?.metadata.removeWorkspaceAssignments(workspaceId); },
            )
          );
          return json(200, { id: workspaceId, forgotten: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("before forgetting")) return json(409, { error: message });
          return json(500, { error: "failed to forget workspace" });
        }
      }
      return json(404, { error: "not found" });
    }

    return new Response("Not Found", { status: 404 });
  };
}

// Starts the hub's Bun.serve with TLS when configured and the WebSocket
// bridge handlers wired.
export function startHubServer(deps: HubDeps) {
  const cloneJobs = deps.cloneJobs ?? new CloneJobManager({
    processFactory: new CloneProcessAdapter({ gitCommand: deps.gitCommand }),
    registry: deps.registry,
    sessions: deps.sessions,
    credentials: deps.cloneCredentials,
    reservations: deps.reservations,
  });
  const handler = createHubFetchHandler({ ...deps, cloneJobs });
  const server = Bun.serve<BridgeData>({
    hostname: deps.config.host,
    port: deps.config.port,
    // SSE and long-lived terminal sockets must never be idle-reaped.
    idleTimeout: 0,
    ...(deps.config.tls
      ? { tls: { cert: Bun.file(deps.config.tls.cert), key: Bun.file(deps.config.tls.key) } }
      : {}),
    fetch: (request, server) => handler(request, server),
    websocket: {
      open(socket: ServerWebSocket<BridgeData>) {
        bridgeWebSocketHandlers.open(socket);
      },
      message(socket: ServerWebSocket<BridgeData>, data: string | Buffer) {
        bridgeWebSocketHandlers.message(socket, data);
      },
      close(socket: ServerWebSocket<BridgeData>, code: number, reason: string) {
        bridgeWebSocketHandlers.close(socket, code, reason);
      },
    },
  });
  return Object.assign(server, { cloneJobs });
}
