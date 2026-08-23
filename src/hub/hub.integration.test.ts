// Full-stack hub integration: a real hub server (Bun.serve) supervising a
// real `uatu serve` child (from source), driven over HTTP/SSE/WebSocket the
// way a browser would be — login cookie and all. Covers the auth gate, the
// proxy transports with token brokering, CSRF, the stopped-session page, and
// shutdown-terminates-children.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LocalProcessBackend } from "./backend";
import {
  EMPTY_CREDENTIAL_CONTEXT_RESOLVER,
  type CloneCredentialProcessContext,
  type ResolvedCloneCredential,
} from "./credential-context";
import { hashPassword, HubSessionStore, HUB_COOKIE_NAME } from "./auth";
import { CloneJobManager } from "./clone-jobs";
import { CloneProcessAdapter, type CloneProcessFactory } from "./clone-process";
import type { HubConfig } from "./config";
import { CredentialMetadataStore } from "./credential-store";
import { FolderManager } from "./folder-manager";
import { PathReservationCoordinator } from "./path-reservations";
import { PersonalWorkspaceStateStore } from "./personal-state";
import { WorkspaceRegistry } from "./registry";
import { startHubServer } from "./server";
import { SessionManager } from "./sessions";
import {
  assertOpenApiResponse,
  assertSchema,
  assertWebSocketFrame,
  loadContract,
  parseNdjson,
  parseSse,
} from "../../tests/contracts/contract-harness";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.ts");
const openApi = await loadContract(path.join(REPO_ROOT, "api", "openapi.yaml"));
const streaming = await loadContract(path.join(REPO_ROOT, "api", "streaming.yaml"));
const streamSchemas = streaming.schemas as Record<string, unknown>;

// Every assertContract call records its operationId; the final test compares
// the set against the whole contract, so a documented operation cannot ship
// without at least one black-box schema assertion here.
const coveredOperations = new Set<string>();

function operationIdFor(method: string, templatePath: string): string {
  const pathItem = (openApi.paths as Record<string, Record<string, { operationId?: string }>>)[templatePath];
  const operation = pathItem?.[method.toLowerCase()];
  if (!operation?.operationId) throw new Error(`no documented operation for ${method} ${templatePath}`);
  return operation.operationId;
}

async function assertContract(method: string, templatePath: string, response: Response): Promise<void> {
  await assertOpenApiResponse(openApi, { method, path: templatePath, response });
  coveredOperations.add(operationIdFor(method, templatePath));
}

let tempRoot = "";
let workspace = "";
let registry: WorkspaceRegistry;
let personalState: PersonalWorkspaceStateStore;
let sessions: SessionManager;
let sessionStore: HubSessionStore;
let sessionStorePath = "";
let server: ReturnType<typeof startHubServer>;
let origin = "";
let cookie = "";
let bearerId = "";
let cloneJobs: CloneJobManager;
let reservations: PathReservationCoordinator;
const managedCloneStarts: Array<CloneCredentialProcessContext | undefined> = [];
const managedCloneAssignments: string[] = [];
let managedAssignmentBarrier: Promise<void> | undefined;
let releaseManagedAssignment: (() => void) | undefined;
let enterManagedAssignment: (() => void) | undefined;

beforeAll(async () => {
  tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "uatu-hub-int-")));
  workspace = path.join(tempRoot, "workspaces", "myproject");
  execFileSync("mkdir", ["-p", workspace]);
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  await writeFile(path.join(workspace, "README.md"), "# Hub Test\n\nfirst body\n");

  const config: HubConfig = {
    port: 0 as number,
    host: "127.0.0.1",
    tls: null,
    users: [
      { name: "tobias", passwordHash: await hashPassword("open sesame") },
      { name: "alice", passwordHash: await hashPassword("alice secret") },
    ],
    stateDir: path.join(tempRoot, "state"),
  };

  registry = new WorkspaceRegistry(path.join(tempRoot, "registry.json"));
  await registry.load();
  personalState = new PersonalWorkspaceStateStore(path.join(tempRoot, "personal-state.json"));
  const credentialMetadata = new CredentialMetadataStore(path.join(tempRoot, "credentials.json"));
  await Promise.all([personalState.load(), credentialMetadata.load()]);
  sessionStorePath = path.join(tempRoot, "sessions.json");
  sessionStore = new HubSessionStore(sessionStorePath);
  await sessionStore.load();
  sessions = new SessionManager(registry, {
    local: new LocalProcessBackend({ uatuArgv: ["bun", "run", CLI_PATH] }),
  }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
  const realCloneProcess = new CloneProcessAdapter();
  const processFactory: CloneProcessFactory = {
    start(options) {
      if (options.url.startsWith("managed:")) {
        managedCloneStarts.push(options.credential);
        const exited = mkdir(options.target, { recursive: true }).then(() => {
          execFileSync("git", ["init"], { cwd: options.target, stdio: "ignore" });
          return 0;
        });
        return {
          pid: process.pid,
          exited,
          writeLine: () => true,
          async terminate() { await exited; },
        };
      }
      if (!options.url.startsWith("interactive:")) return realCloneProcess.start(options);
      let resolveExit!: (code: number) => void;
      const exited = new Promise<number>(resolve => {
        resolveExit = resolve;
      });
      let responses = 0;
      queueMicrotask(() => options.onOutput("Enter passphrase for key '/tmp/test-key': "));
      return {
        pid: process.pid,
        exited,
        writeLine() {
          responses += 1;
          if (responses === 1) {
            options.onOutput("\nCustom authentication challenge: ");
            return true;
          }
          void mkdir(options.target, { recursive: true }).then(() => {
            execFileSync("git", ["init"], { cwd: options.target, stdio: "ignore" });
            resolveExit(0);
          });
          return true;
        },
        async terminate() {
          resolveExit(143);
        },
      };
    },
  };
  reservations = new PathReservationCoordinator();
  cloneJobs = new CloneJobManager({
    processFactory,
    registry,
    sessions,
    credentials: {
      async resolve(remote, credentialId): Promise<ResolvedCloneCredential | undefined> {
        if (!credentialId) return undefined;
        if (credentialId === "locked-ssh") throw new Error("selected SSH credential is locked; unlock it before cloning: locked-ssh");
        if (credentialId !== "unlocked-ssh" && credentialId !== "alias-ssh") throw new Error(`unknown credential: ${credentialId}`);
        if (!remote.startsWith("managed:")) throw new Error("selected credential is not compatible with clone transport");
        return {
          credentialId,
          host: credentialId === "alias-ssh" ? "work_alias" : "github.com",
          process: {
            type: "ssh",
            host: "github.com",
            sshPath: "/managed/ssh",
            agentSocket: "/managed/agent.sock",
            publicKeyPath: "/managed/unlocked-ssh.pub",
          },
        };
      },
      async assign(workspaceId) {
        enterManagedAssignment?.();
        await managedAssignmentBarrier;
        managedCloneAssignments.push(workspaceId);
      },
      async unassign(workspaceId) {
        const index = managedCloneAssignments.indexOf(workspaceId);
        if (index >= 0) managedCloneAssignments.splice(index, 1);
      },
      runExclusive: operation => operation(),
    },
    reservations,
  });
  const folderManager = new FolderManager({
    journalPath: path.join(tempRoot, "pending-folder-mutation.json"),
    registry,
    sessions,
    personalState,
    credentials: credentialMetadata,
    reservations,
  });
  await folderManager.recover();
  server = startHubServer({
    config,
    registry,
    sessions,
    sessionStore,
    personalState,
    cloneJobs,
    folderManager,
    reservations,
  });
  origin = `http://127.0.0.1:${server.port}`;
}, 30_000);

afterAll(async () => {
  await cloneJobs?.close();
  await sessions?.stopAll();
  server?.stop(true);
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

describe("hub end to end", () => {
  test("unauthenticated requests are blocked before any child contact", async () => {
    const api = await fetch(`${origin}/api/hub/state`);
    expect(api.status).toBe(401);
    expect(api.headers.get("cache-control")).toBe("no-store");
    const proxied = await fetch(`${origin}/s/myproject/api/state`);
    expect(proxied.status).toBe(401);
    const navigation = await fetch(`${origin}/`, { headers: { accept: "text/html" }, redirect: "manual" });
    expect(navigation.status).toBe(303);
    expect(navigation.headers.get("location")).toContain("/login");
  });

  test("the hub manifest and icons are reachable without a cookie", async () => {
    // Install-time fetches may be anonymous (Safari's Add to Home Screen);
    // a 401 would silently degrade installs. Scope "/" is what keeps the
    // whole hub origin inside the installed app.
    const manifest = await fetch(`${origin}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
    const body = (await manifest.json()) as Record<string, unknown>;
    expect(body.name).toBe("UatuCode Hub");
    expect(body.scope).toBe("/");
    expect(body.start_url).toBe("/");
    expect(body.display).toBe("standalone");
    const icons = body.icons as Array<{ src: string; sizes: string }>;
    expect(icons.map(icon => icon.sizes)).toEqual(["192x192", "512x512"]);
    for (const icon of icons) {
      const response = await fetch(`${origin}${icon.src}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
    }
  });

  test("login and dashboard pages link the hub manifest", async () => {
    const login = await fetch(`${origin}/login`, { headers: { accept: "text/html" } });
    expect(await login.text()).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  test("hub HTML pages are never cached", async () => {
    // client-freshness: every HTML entry point revalidates. The login page
    // is the anonymous one; the dashboard is asserted in the signed-in
    // proxying test below.
    const login = await fetch(`${origin}/login`, { headers: { accept: "text/html" } });
    expect(login.headers.get("cache-control")).toBe("no-store");
  });

  test("the login page carries no version string; the dashboard renders it for signed-in users", async () => {
    const { BUILD, formatBuildIdentifier } = await import("../shared/version");
    const login = await fetch(`${origin}/login`, { headers: { accept: "text/html" } });
    expect(login.status).toBe(200);
    expect(await login.text()).not.toContain(formatBuildIdentifier(BUILD));
  });

  test("wrong credentials are rejected without user-existence detail", async () => {
    const wrongPassword = await fetch(`${origin}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "tobias", password: "nope" }),
    });
    const unknownUser = await fetch(`${origin}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "nobody", password: "nope" }),
    });
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.headers.get("cache-control")).toBe("no-store");
    expect(unknownUser.headers.get("cache-control")).toBe("no-store");
    await assertContract("POST", "/login", wrongPassword);
    expect(await wrongPassword.text()).toBe(await unknownUser.text());
  });

  test("JSON login returns the session id and sets the session cookie", async () => {
    const response = await fetch(`${origin}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "tobias", password: "open sesame", deviceLabel: "integration test" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await assertContract("POST", "/login", response);
    const payload = (await response.json()) as { sessionId: string; user: string };
    expect(payload.user).toBe("tobias");
    expect(payload.sessionId.length).toBeGreaterThanOrEqual(32);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`uatu_hub=${payload.sessionId}`);
    expect(setCookie).toContain("HttpOnly");
    cookie = setCookie.split(";")[0]!;
    // Session ids never appear in URLs; the id in the body is the bearer
    // credential for native clients.
    bearerId = payload.sessionId;
  });

  test("the same session id resolves identically by cookie and bearer", async () => {
    const viaCookie = await fetch(`${origin}/api/hub/state`, { headers: { cookie } });
    const viaBearer = await fetch(`${origin}/api/hub/state`, {
      headers: { authorization: `Bearer ${bearerId}` },
    });
    expect(viaCookie.status).toBe(200);
    expect(viaBearer.status).toBe(200);
    // An unknown bearer id is a machine-readable JSON 401, not a redirect.
    const revokedProbe = await fetch(`${origin}/api/hub/state`, {
      headers: { authorization: "Bearer not-a-real-session" },
      redirect: "manual",
    });
    expect(revokedProbe.status).toBe(401);
    expect((revokedProbe.headers.get("content-type") ?? "")).toContain("application/json");
    await assertContract("GET", "/api/hub/state", viaCookie);
    await assertContract("GET", "/api/hub/state", revokedProbe);
  });

  test("sessions survive a hub restart via the persisted store", async () => {
    // A fresh store instance over the same file is what a restarted hub
    // process would build.
    const reloaded = new HubSessionStore(sessionStorePath);
    await reloaded.load();
    expect(reloaded.resolve(bearerId)?.user).toBe("tobias");
  });

  test("bearer state-changing requests skip the Origin check; cookie ones keep it", async () => {
    // A cross-origin POST with only a cookie is CSRF-shaped — refused.
    const forged = await fetch(`${origin}/api/hub/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://attacker.example" },
      body: JSON.stringify({ path: "/nowhere" }),
    });
    expect(forged.status).toBe(403);
    // The same request authenticated by bearer carries no ambient
    // credential — the Origin header is irrelevant.
    const viaBearer = await fetch(`${origin}/api/hub/workspaces`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearerId}`,
        origin: "https://attacker.example",
      },
      body: JSON.stringify({ path: "relative-is-invalid" }),
    });
    // 400 (validation) proves it passed the gate and the CSRF layer.
    expect(viaBearer.status).toBe(400);
  });

  test("the dashboard page links the hub manifest", async () => {
    const dashboard = await fetch(`${origin}/`, { headers: { accept: "text/html", cookie } });
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  test("login returns to the gated page that bounced, and never off-origin", async () => {
    // Gate → login carries the requested path...
    const bounced = await fetch(`${origin}/s/myproject/`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(bounced.status).toBe(303);
    expect(bounced.headers.get("location")).toBe(`/login?next=${encodeURIComponent("/s/myproject/")}`);

    // ...the login page echoes it as a hidden field...
    const loginPageResponse = await fetch(`${origin}/login?next=%2Fs%2Fmyproject%2F`, {
      headers: { accept: "text/html" },
    });
    const loginHtml = await loginPageResponse.text();
    expect(loginHtml).toContain('name="next" value="/s/myproject/"');
    // ...and in the form's action too, so a failure that answers before the
    // body is read can still re-render the form with it.
    expect(loginHtml).toContain(`action="/login?next=${encodeURIComponent("/s/myproject/")}"`);

    // ...and a successful form login lands back on it.
    const returned = await fetch(`${origin}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "tobias", password: "open sesame", next: "/s/myproject/" }),
      redirect: "manual",
    });
    expect(returned.status).toBe(303);
    expect(returned.headers.get("location")).toBe("/s/myproject/");

    // A malicious target falls back to the dashboard.
    for (const evil of ["https://evil.example/", "//evil.example/", "/\\evil.example"]) {
      const response = await fetch(`${origin}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name: "tobias", password: "open sesame", next: evil }),
        redirect: "manual",
      });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/");
    }
  });

  const FORM = { "content-type": "application/x-www-form-urlencoded" };
  const gatedLoginUrl = () => `${origin}/login?next=${encodeURIComponent("/s/myproject/")}`;

  test("a wrong password does not lose the requested page", async () => {
    // One failure only, then a success — which resets the bucket — so this
    // leaves the shared 127.0.0.1 rate-limit key where it found it.
    const failed = await fetch(gatedLoginUrl(), {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ name: "tobias", password: "wrong", next: "/s/myproject/" }),
      redirect: "manual",
    });
    expect(failed.status).toBe(401);
    expect(await failed.text()).toContain('name="next" value="/s/myproject/"');

    const retried = await fetch(gatedLoginUrl(), {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ name: "tobias", password: "open sesame", next: "/s/myproject/" }),
      redirect: "manual",
    });
    expect(retried.status).toBe(303);
    expect(retried.headers.get("location")).toBe("/s/myproject/");
  });

  test("a rate-limited login still carries the requested page", async () => {
    // The 429 answers BEFORE the body is parsed, so the only place its target
    // can come from is the URL the form posts to — which is the whole reason
    // the action carries it. Driven through a forwarded-for hop so it fills
    // its own rate-limit bucket: the socket is loopback, so the last hop is
    // the trusted key, and the shared 127.0.0.1 bucket is left alone.
    const headers = { ...FORM, "x-forwarded-for": "203.0.113.7" };
    const attempt = () =>
      fetch(gatedLoginUrl(), {
        method: "POST",
        headers,
        body: new URLSearchParams({ name: "tobias", password: "wrong", next: "/s/myproject/" }),
        redirect: "manual",
      });

    for (let i = 0; i < 5; i += 1) {
      expect((await attempt()).status).toBe(401);
    }
    const limited = await attempt();
    expect(limited.status).toBe(429);
    const html = await limited.text();
    expect(html).toContain('name="next" value="/s/myproject/"');
    expect(html).toContain(`action="/login?next=${encodeURIComponent("/s/myproject/")}"`);
  });

  test("a failed login does not echo an invalid return-to target", async () => {
    const failed = await fetch(`${origin}/login`, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ name: "tobias", password: "wrong", next: "https://evil.example/" }),
      redirect: "manual",
    });
    expect(failed.status).toBe(401);
    const html = await failed.text();
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain('name="next"');
    expect(html).toContain('action="/login"');

    // And the retry that follows lands on the dashboard, not the rejected target.
    const retried = await fetch(`${origin}/login`, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ name: "tobias", password: "open sesame" }),
      redirect: "manual",
    });
    expect(retried.status).toBe(303);
    expect(retried.headers.get("location")).toBe("/");
  });

  test("workspace creation starts a real session and the dashboard sees it", async () => {
    const created = await fetch(`${origin}/api/hub/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ path: workspace }),
    });
    expect(created.status).toBe(200);
    await assertContract("POST", "/api/hub/workspaces", created);
    expect(((await created.json()) as { id: string }).id).toBe("myproject");

    const state = await fetch(`${origin}/api/hub/state`, { headers: { cookie } });
    await assertContract("GET", "/api/hub/state", state);
    const payload = (await state.json()) as {
      version: string;
      hubApiRevision: number;
      workspaceApiRevision: number;
      workspaces: {
        id: string;
        running: boolean;
        credentialRestartRequired: boolean;
        credentialAssignments: { authentication: string[]; signing: string[] };
      }[];
    };
    expect(payload.workspaces).toEqual([expect.objectContaining({
      id: "myproject",
      running: true,
      credentialRestartRequired: false,
      credentialAssignments: { authentication: [], signing: [] },
    })]);
    // The authenticated state API reports the hub's uatu version.
    expect(typeof payload.version).toBe("string");
    expect(payload.version.length).toBeGreaterThan(0);
    const { HUB_API_REVISION, WORKSPACE_API_REVISION } = await import("../shared/version");
    expect(payload.hubApiRevision).toBe(HUB_API_REVISION);
    expect(payload.workspaceApiRevision).toBe(WORKSPACE_API_REVISION);
  }, 60_000);

  test("authenticated pages split dashboard, clone, and settings content", async () => {
    const dashboard = await fetch(`${origin}/`, { headers: { cookie, accept: "text/html" } });
    expect(dashboard.status).toBe(200);
    const html = await dashboard.text();
    expect(html).toContain('id="hub-version"');
    expect(html).toContain('id="sessions"');
    expect(html).toContain('id="workspaces"');
    expect(html).not.toContain('id="browser"');
    expect(html).not.toContain('id="credentials-pane"');
    expect(html).not.toContain('id="devices"');
    expect(html).toContain("Sign out");
    // The desktop wrapper's covered-chrome contract: pages pad below the
    // native titlebar/tab bar when the wrapper announces its height.
    expect(html).toContain("--titlebar-inset");
    // The started-but-loading gap indicator ships with the page.
    expect(html).toContain("nav-overlay");
    const clone = await fetch(`${origin}/clone`, { headers: { cookie, accept: "text/html" } });
    expect(clone.status).toBe(200);
    const cloneHtml = await clone.text();
    expect(cloneHtml).toContain('id="browser"');
    expect(cloneHtml).toContain('id="clone-form"');
    expect(cloneHtml).not.toContain('id="credentials-pane"');

    const settings = await fetch(`${origin}/settings`, { headers: { cookie, accept: "text/html" } });
    expect(settings.status).toBe(200);
    const settingsHtml = await settings.text();
    expect(settingsHtml).toContain('id="credentials-pane"');
    expect(settingsHtml).toContain('id="devices"');
    expect(settingsHtml).toContain("uatu.hub.notice.shared-uid-v1:dG9iaWFz");
    expect(cloneHtml).toContain("uatu.hub.notice.shared-uid-v1:dG9iaWFz");
    expect(settingsHtml).not.toContain('id="browser"');
  });

  test("split pages authenticate and preserve their return target", async () => {
    for (const path of ["/clone", "/settings"]) {
      const gated = await fetch(`${origin}${path}`, { headers: { accept: "text/html" }, redirect: "manual" });
      expect(gated.status).toBe(303);
      expect(gated.headers.get("location")).toBe(`/login?next=${encodeURIComponent(path)}`);

      const login = await fetch(`${origin}${gated.headers.get("location")}`, {
        method: "POST",
        headers: FORM,
        body: new URLSearchParams({ name: "tobias", password: "open sesame", next: path }),
        redirect: "manual",
      });
      expect(login.status).toBe(303);
      expect(login.headers.get("location")).toBe(path);
    }
  });

  test("HTTP proxying round-trips /api/state and the shell through the prefix", async () => {
    const state = await fetch(`${origin}/s/myproject/api/state`, { headers: { cookie } });
    expect(state.status).toBe(200);
    await assertContract("GET", "/s/{workspaceId}/api/state", state);
    const payload = (await state.json()) as {
      workspaceApiRevision: number;
      roots: { docs: unknown[] }[];
    };
    expect(payload.roots.length).toBeGreaterThan(0);
    const { WORKSPACE_API_REVISION } = await import("../shared/version");
    expect(payload.workspaceApiRevision).toBe(WORKSPACE_API_REVISION);

    const shell = await fetch(`${origin}/s/myproject/`, { headers: { cookie, accept: "text/html" } });
    expect(shell.status).toBe(200);
    // client-freshness: the proxy must preserve the child's no-cache on the
    // shell HTML, and the hub's own dashboard HTML must revalidate too.
    expect(shell.headers.get("cache-control")).toBe("no-cache");
    const html = await shell.text();
    expect(html).toContain('name="uatu-base-path"');
    expect(html).toContain("/s/myproject/");

    const dashboard = await fetch(`${origin}/`, { headers: { cookie, accept: "text/html" } });
    expect(dashboard.headers.get("cache-control")).toBe("no-store");
  });

  test("stylesheet assets (the bundled font) resolve through the prefix", async () => {
    const shell = await fetch(`${origin}/s/myproject/`, { headers: { cookie, accept: "text/html" } });
    const html = await shell.text();
    const cssPath = /href="(\/s\/myproject\/[^"]+\.css)"/.exec(html)?.[1];
    expect(cssPath).toBeDefined();

    const css = await fetch(`${origin}${cssPath}`, { headers: { cookie } });
    expect(css.status).toBe(200);
    const cssBody = await css.text();
    // No url() reference may remain root-absolute — those would resolve
    // outside the prefix and 404 (the tofu-glyph bug).
    expect(/url\(\s*['"]?\/(?!\/|s\/myproject\/)/.test(cssBody)).toBe(false);

    const fontUrl = /url\((['"]?)(\/s\/myproject\/[^'")]+\.woff2)\1\)/.exec(cssBody)?.[2];
    if (fontUrl) {
      const font = await fetch(`${origin}${fontUrl}`, { headers: { cookie } });
      expect(font.status).toBe(200);
      expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
  });

  test("bundle chunks are gzipped, immutable-cached, and revalidate as 304 through the hub", async () => {
    const shell = await fetch(`${origin}/s/myproject/`, { headers: { cookie, accept: "text/html" } });
    const html = await shell.text();
    const chunkPath = /src="(\/s\/myproject\/[^"]+\.js)"/.exec(html)?.[1];
    expect(chunkPath).toBeDefined();

    const compressed = await fetch(`${origin}${chunkPath}`, {
      headers: { cookie, "accept-encoding": "gzip" },
      // Bun's fetch would transparently decompress; inspect raw headers.
      decompress: false,
    } as RequestInit);
    expect(compressed.status).toBe(200);
    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    expect(compressed.headers.get("cache-control") ?? "").toContain("immutable");
    const wireBytes = (await compressed.arrayBuffer()).byteLength;

    const identity = await fetch(`${origin}${chunkPath}`, { headers: { cookie } });
    const fullBytes = (await identity.arrayBuffer()).byteLength;
    expect(wireBytes).toBeLessThan(fullBytes / 2);

    const etag = identity.headers.get("etag");
    expect(etag).toBeTruthy();
    const revalidated = await fetch(`${origin}${chunkPath}`, {
      headers: { cookie, "if-none-match": etag! },
    });
    expect(revalidated.status).toBe(304);
  });

  test("SSE passes a live file event through the hub unbuffered", async () => {
    const controller = new AbortController();
    const response = await fetch(`${origin}/s/myproject/api/events`, {
      headers: { cookie, accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const sawEvent = (async () => {
      for (;;) {
        const next = await reader.read();
        if (next.done) return false;
        received += decoder.decode(next.value, { stream: true });
        if (received.includes("state")) return true;
      }
    })();

    // Give the SSE connection a moment, then trigger a file event.
    await new Promise(resolve => setTimeout(resolve, 300));
    await writeFile(path.join(workspace, "README.md"), "# Hub Test\n\nlive change\n");

    const result = await Promise.race([
      sawEvent,
      new Promise<false>(resolve => setTimeout(() => resolve(false), 15_000)),
    ]);
    controller.abort();
    expect(result).toBe(true);
    const observed = parseSse(received).find(event => event.event === "state");
    expect(observed).toBeDefined();
    const workspaceState = (openApi.components as Record<string, unknown> as { schemas: Record<string, unknown> }).schemas.WorkspaceState;
    assertSchema(openApi, workspaceState, observed!.data, "workspaceStreamState state event");
    // A live SSE response cannot go through assertContract (cloning would
    // wait for the stream to end); the event-payload assertion above is the
    // black-box validation for this operation.
    coveredOperations.add("workspaceStreamState");
  }, 30_000);

  test("NDJSON search emits only documented items and a terminal done item", async () => {
    const response = await fetch(`${origin}/s/myproject/api/search?q=Hub`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("application/x-ndjson");
    await assertContract("GET", "/s/{workspaceId}/api/search", response);
    const items = parseNdjson(await response.text());
    expect(items.length).toBeGreaterThan(0);
    for (const [index, item] of items.entries()) {
      assertSchema(streaming, streamSchemas.SearchStreamItem, item, `workspaceSearch item ${index + 1}`);
    }
    expect(items.at(-1)).toEqual(expect.objectContaining({ kind: "done" }));
  });

  test("terminal WebSocket bridges through the hub with the token brokered server-side", async () => {
    const created = await fetch(`${origin}/s/myproject/api/terminal/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    });
    expect(created.status).toBe(201);
    await assertContract("POST", "/s/{workspaceId}/api/terminal/sessions", created);
    const sessionId = ((await created.json()) as { id: string }).id;
    // The browser-visible URL carries NO token — the hub injects the
    // child's credential during proxying.
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/s/myproject/api/terminal?sessionId=${sessionId}`, {
      headers: { cookie, origin },
    } as unknown as string[]);

    const gotOutput = await new Promise<boolean>(resolve => {
      const timeout = setTimeout(() => resolve(false), 15_000);
      let reconstructionReceived = false;
      ws.addEventListener("message", event => {
        // Binary PTY frames pass; any text control frame must be a
        // documented variant with a valid schema.
        assertWebSocketFrame(event.data, { exit: streamSchemas.TerminalExit } as Record<string, unknown>, true);
        if (!reconstructionReceived) {
          reconstructionReceived = true;
          ws.send(new TextEncoder().encode("echo bridged\r\n"));
          return;
        }
        clearTimeout(timeout);
        resolve(true);
      });
      ws.addEventListener("close", () => {
        clearTimeout(timeout);
        resolve(false);
      });
      ws.addEventListener("open", () => {
        const control = JSON.stringify({ type: "attach-ready", cols: 80, rows: 24 });
        assertWebSocketFrame(control, { "attach-ready": streamSchemas.TerminalAttachReady }, true);
        ws.send(control);
      });
    });
    expect(gotOutput).toBe(true);

    // While the shell lives, the dashboard state carries the live shell
    // summary sourced from the child's terminal-sessions inventory.
    const state = await fetch(`${origin}/api/hub/state`, { headers: { cookie } });
    const payload = (await state.json()) as {
      workspaces: { id: string; shells?: { attached: boolean; label: string }[] }[];
    };
    const entry = payload.workspaces.find(candidate => candidate.id === "myproject");
    expect(entry?.shells?.length).toBeGreaterThan(0);
    expect(typeof entry?.shells?.[0]?.label).toBe("string");

    // 4001 = user-terminate; must transit the bridge to the child intact
    // (the child kills the PTY rather than parking a detached session).
    ws.close(4001, "kill");
    await new Promise(resolve => setTimeout(resolve, 300));
    // The 101 upgrade never yields a Response object; the frame-level
    // assertions above are the black-box validation for this operation.
    coveredOperations.add("workspaceAttachTerminal");
  }, 30_000);

  test("the directory browser lists child directories with git status and registration", async () => {
    const browseRoot = path.join(tempRoot, "workspaces");
    const plain = path.join(browseRoot, "plain-folder");
    execFileSync("mkdir", ["-p", plain]);
    // Dot-directories are hidden from the browser.
    execFileSync("mkdir", ["-p", path.join(browseRoot, ".dotted")]);

    const response = await fetch(`${origin}/api/hub/browse?path=${encodeURIComponent(browseRoot)}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    await assertContract("GET", "/api/hub/browse", response);
    const payload = (await response.json()) as {
      path: string;
      parent: string | null;
      dirs: { name: string; git: boolean; registeredId: string | null }[];
    };
    expect(payload.path).toBe(browseRoot);
    expect(payload.parent).toBe(tempRoot);
    const myproject = payload.dirs.find(dir => dir.name === "myproject");
    expect(myproject?.git).toBe(true);
    expect(myproject?.registeredId).toBe("myproject");
    const plainEntry = payload.dirs.find(dir => dir.name === "plain-folder");
    expect(plainEntry?.git).toBe(false);
    expect(plainEntry?.registeredId).toBeNull();
    expect(payload.dirs.some(dir => dir.name === ".dotted")).toBe(false);

    // A relative path is rejected; an unreadable one is a 404.
    const relative = await fetch(`${origin}/api/hub/browse?path=relative%2Fplace`, { headers: { cookie } });
    expect(relative.status).toBe(400);
    await assertContract("GET", "/api/hub/browse", relative);
    const missing = await fetch(
      `${origin}/api/hub/browse?path=${encodeURIComponent(path.join(tempRoot, "no-such-dir"))}`,
      { headers: { cookie } },
    );
    expect(missing.status).toBe(404);
    await assertContract("GET", "/api/hub/browse", missing);
  });

  test("folder mutations use the existing authentication and same-origin gate", async () => {
    const parent = path.join(tempRoot, "folder-auth");
    await mkdir(parent);
    const body = JSON.stringify({ parent, name: "blocked" });
    const unauthenticated = await fetch(`${origin}/api/hub/folders/create`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body,
    });
    expect(unauthenticated.status).toBe(401);
    await assertContract("POST", "/api/hub/folders/create", unauthenticated);

    const crossOrigin = await fetch(`${origin}/api/hub/folders/create`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://attacker.example" },
      body,
    });
    expect(crossOrigin.status).toBe(403);
    await assertContract("POST", "/api/hub/folders/create", crossOrigin);
    expect(await Bun.file(path.join(parent, "blocked")).exists()).toBe(false);

    const bearer = await fetch(`${origin}/api/hub/folders/create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearerId}`,
        origin: "https://attacker.example",
      },
      body: JSON.stringify({ parent: "relative", name: "invalid" }),
    });
    expect(bearer.status).toBe(400);
    await assertContract("POST", "/api/hub/folders/create", bearer);
    expect(await bearer.json()).toEqual({ error: "parent must be an absolute path" });
  });

  test("workspace registration holds the shared path reservation through persistence", async () => {
    const folder = path.join(tempRoot, "registration-reservation");
    await mkdir(folder);
    execFileSync("git", ["init"], { cwd: folder, stdio: "ignore" });
    const canonicalFolder = await realpath(folder);
    const originalRegister = registry.registerWithStatus.bind(registry);
    let reservedDuringRegistration = false;
    registry.registerWithStatus = async (...args) => {
      reservedDuringRegistration = reservations.isReserved(canonicalFolder);
      return originalRegister(...args);
    };
    try {
      const response = await fetch(`${origin}/api/hub/workspaces`, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({ path: folder, start: false }),
      });
      expect(response.status).toBe(200);
      expect(reservedDuringRegistration).toBe(true);
      expect(reservations.isReserved(canonicalFolder)).toBe(false);
    } finally {
      registry.registerWithStatus = originalRegister;
    }
  });

  test("folder mutation routes enforce closed validation and typed missing errors", async () => {
    const headers = { "content-type": "application/json", cookie, origin };
    const malformed = await fetch(`${origin}/api/hub/folders/create`, {
      method: "POST",
      headers,
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid JSON body" });

    const invalidBodies = [
      ["create", { parent: tempRoot, name: ".hidden" }],
      ["create", { parent: tempRoot, name: "valid", extra: true }],
      ["rename", { path: "relative", name: "valid" }],
      ["remove", { path: tempRoot, stop: "yes" }],
    ] as const;
    for (const [operation, body] of invalidBodies) {
      const response = await fetch(`${origin}/api/hub/folders/${operation}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(Object.keys(await response.json())).toEqual(["error"]);
    }

    const missing = await fetch(`${origin}/api/hub/folders/remove`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: path.join(tempRoot, "folder-never-existed") }),
    });
    expect(missing.status).toBe(404);
    await assertContract("POST", "/api/hub/folders/remove", missing);
    expect(await missing.json()).toEqual({ error: "folder was not found" });

    // A filesystem authorization failure is the contract's 403, not a 500.
    const locked = path.join(tempRoot, "folder-locked");
    await mkdir(locked, { mode: 0o500 });
    const denied = await fetch(`${origin}/api/hub/folders/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ parent: locked, name: "child" }),
    });
    expect(denied.status).toBe(403);
    await assertContract("POST", "/api/hub/folders/create", denied);
    expect(await denied.json()).toEqual({ error: "filesystem permission denied" });
  });

  test("folder routes create, rename, and remove without overwriting or recursive deletion", async () => {
    const parent = path.join(tempRoot, "folder-basic");
    await mkdir(parent);
    const headers = { "content-type": "application/json", cookie, origin };
    const post = (operation: string, body: unknown) => fetch(`${origin}/api/hub/folders/${operation}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const createdPath = path.join(parent, "created");
    const created = await post("create", { parent, name: "created" });
    expect(created.status).toBe(200);
    await assertContract("POST", "/api/hub/folders/create", created);
    expect(await created.json()).toEqual({ path: createdPath });

    await mkdir(path.join(parent, "occupied"));
    const collision = await post("rename", { path: createdPath, name: "occupied" });
    expect(collision.status).toBe(409);
    await assertContract("POST", "/api/hub/folders/rename", collision);
    expect(await collision.json()).toEqual({ error: "destination already exists" });
    expect((await stat(createdPath)).isDirectory()).toBe(true);

    const renamedPath = path.join(parent, "renamed");
    const renamed = await post("rename", { path: createdPath, name: "renamed" });
    expect(renamed.status).toBe(200);
    await assertContract("POST", "/api/hub/folders/rename", renamed);
    expect(await renamed.json()).toEqual({ path: renamedPath, workspaceIds: [] });

    await writeFile(path.join(renamedPath, "content.txt"), "kept");
    const nonEmpty = await post("remove", { path: renamedPath });
    expect(nonEmpty.status).toBe(409);
    await assertContract("POST", "/api/hub/folders/remove", nonEmpty);
    expect(await nonEmpty.json()).toEqual({ error: "folder is not empty" });
    await rm(path.join(renamedPath, "content.txt"));
    await writeFile(path.join(renamedPath, ".hidden"), "kept too");
    const hidden = await post("remove", { path: renamedPath });
    expect(hidden.status).toBe(409);
    expect(await hidden.json()).toEqual({ error: "folder is not empty" });
    expect(await Bun.file(path.join(renamedPath, ".hidden")).text()).toBe("kept too");
    await rm(path.join(renamedPath, ".hidden"));

    const removed = await post("remove", { path: renamedPath });
    expect(removed.status).toBe(200);
    await assertContract("POST", "/api/hub/folders/remove", removed);
    expect(await removed.json()).toEqual({ path: renamedPath });
    await expect(stat(renamedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("registered descendant renames and registered removal return closed identity payloads", async () => {
    const source = path.join(tempRoot, "folder-registered-source");
    const firstPath = path.join(source, "api-descendant-first");
    const secondPath = path.join(source, "nested", "api-descendant-second");
    await Promise.all([mkdir(firstPath, { recursive: true }), mkdir(secondPath, { recursive: true })]);
    const [first, second] = await Promise.all([registry.register(firstPath), registry.register(secondPath)]);
    const headers = { "content-type": "application/json", cookie, origin };

    const renamedPath = path.join(tempRoot, "folder-registered-renamed");
    const renamed = await fetch(`${origin}/api/hub/folders/rename`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: source, name: path.basename(renamedPath) }),
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ path: renamedPath, workspaceIds: [first.id, second.id] });
    expect(registry.byId(first.id)?.path).toBe(path.join(renamedPath, "api-descendant-first"));
    expect(registry.byId(second.id)?.path).toBe(path.join(renamedPath, "nested", "api-descendant-second"));

    const removablePath = path.join(tempRoot, "api-registered-removal");
    await mkdir(removablePath);
    const removable = await registry.register(removablePath);
    const removed = await fetch(`${origin}/api/hub/folders/remove`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: removablePath }),
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ path: removablePath, workspaceId: removable.id });
    expect(registry.byId(removable.id)).toBeUndefined();
  });

  test("registered folder mutation reports every running or starting descendant and can stop them", async () => {
    const source = path.join(tempRoot, "folder-active-source");
    const runningPath = path.join(source, "api-running-descendant");
    const startingPath = path.join(source, "api-starting-descendant");
    await Promise.all([mkdir(runningPath, { recursive: true }), mkdir(startingPath, { recursive: true })]);
    execFileSync("git", ["init"], { cwd: runningPath, stdio: "ignore" });
    execFileSync("git", ["init"], { cwd: startingPath, stdio: "ignore" });
    const running = await registry.register(runningPath);
    const starting = await registry.register(startingPath);
    await sessions.start(running.id);
    const startPromise = sessions.start(starting.id);
    expect(sessions.isStarting(starting.id)).toBe(true);
    const headers = { "content-type": "application/json", cookie, origin };

    const conflict = await fetch(`${origin}/api/hub/folders/rename`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: source, name: "folder-active-renamed" }),
    });
    await startPromise;
    expect(conflict.status).toBe(409);
    await assertContract("POST", "/api/hub/folders/rename", conflict);
    expect(await conflict.json()).toEqual({
      error: "affected workspace sessions must be stopped",
      needsStop: true,
      workspaceIds: [running.id, starting.id].sort(),
    });
    expect((await stat(source)).isDirectory()).toBe(true);

    const renamedPath = path.join(tempRoot, "folder-active-renamed");
    const confirmed = await fetch(`${origin}/api/hub/folders/rename`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: source, name: path.basename(renamedPath), stop: true }),
    });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toEqual({ path: renamedPath, workspaceIds: [running.id, starting.id] });
    expect(sessions.isRunning(running.id)).toBe(false);
    expect(sessions.isRunning(starting.id)).toBe(false);
  }, 60_000);

  test("folder mutations and clone jobs share hierarchy reservations", async () => {
    const destination = path.join(tempRoot, "folder-clone-race");
    await mkdir(destination);
    const cloned = await fetch(`${origin}/api/hub/clone-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ url: "interactive:reserved-clone", dest: destination }),
    });
    expect(cloned.status).toBe(202);
    const jobId = ((await cloned.json()) as { jobId: string }).jobId;
    const canonicalDestination = await realpath(destination);
    const headers = { "content-type": "application/json", cookie, origin };

    const exact = await fetch(`${origin}/api/hub/folders/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ parent: canonicalDestination, name: "reserved-clone" }),
    });
    expect(exact.status).toBe(409);
    expect(await exact.json()).toEqual({ error: "folder path is reserved by another operation" });
    const ancestor = await fetch(`${origin}/api/hub/folders/remove`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: canonicalDestination }),
    });
    expect(ancestor.status).toBe(409);
    expect(await ancestor.json()).toEqual({ error: "folder path is reserved by another operation" });

    const cancelled = await fetch(`${origin}/api/hub/clone-jobs/${jobId}/cancel`, {
      method: "POST",
      headers: { cookie, origin },
    });
    expect(cancelled.status).toBe(200);
  });

  test("start:false registers without starting a session (recents import)", async () => {
    const imported = path.join(tempRoot, "workspaces", "imported-only");
    execFileSync("mkdir", ["-p", imported]);
    execFileSync("git", ["init"], { cwd: imported, stdio: "ignore" });

    const created = await fetch(`${origin}/api/hub/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ path: imported, start: false }),
    });
    expect(created.status).toBe(200);
    const payload = (await created.json()) as { id: string; running: boolean };
    expect(payload.running).toBe(false);
    expect(registry.byId(payload.id)?.path).toBe(imported);
    expect(sessions.isRunning(payload.id)).toBe(false);
  });

  test("registration requires an absolute path to an existing directory", async () => {
    for (const requested of ["relative/place", "", "docs"]) {
      const response = await fetch(`${origin}/api/hub/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin },
        body: JSON.stringify({ path: requested }),
      });
      expect(response.status).toBe(400);
    }
    const missing = await fetch(`${origin}/api/hub/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ path: path.join(tempRoot, "no-such-folder") }),
    });
    expect(missing.status).toBe(404);
  });

  test("a non-git folder gets the init offer and declining registers nothing", async () => {
    const plain = path.join(tempRoot, "workspaces", "plain-folder");
    execFileSync("mkdir", ["-p", plain]);

    const first = await fetch(`${origin}/api/hub/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ path: plain }),
    });
    expect(first.status).toBe(409);
    await assertContract("POST", "/api/hub/workspaces", first);
    expect(((await first.json()) as { needsInit?: boolean }).needsInit).toBe(true);
    // Declining is the client doing nothing further — nothing registered.
    expect(registry.byPath(plain)).toBeUndefined();

    const confirmed = await fetch(`${origin}/api/hub/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ path: plain, init: true }),
    });
    expect(confirmed.status).toBe(200);
    const id = ((await confirmed.json()) as { id: string }).id;
    expect(registry.byId(id)?.path).toBe(plain);
    expect(await Bun.file(path.join(plain, ".git", "HEAD")).exists()).toBe(true);

    await sessions.stop(id);
  }, 60_000);

  test("registering a canonical path reconciles a legacy alias registration", async () => {
    const real = path.join(tempRoot, "workspaces", "alias-repo");
    execFileSync("mkdir", ["-p", real]);
    execFileSync("git", ["init"], { cwd: real, stdio: "ignore" });
    const alias = path.join(tempRoot, "legacy-workspaces");
    await symlink(path.join(tempRoot, "workspaces"), alias);
    // A pre-canonicalization registry entry persisted through the symlinked
    // ancestor; the exact-path lookup must find it — not mint a second
    // stable id for the same repository with separated personal state.
    const legacy = await registry.register(path.join(alias, "alias-repo"));

    const registered = await fetch(`${origin}/api/hub/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ path: real, start: false }),
    });
    expect(registered.status).toBe(200);
    expect(((await registered.json()) as { id: string }).id).toBe(legacy.id);
    expect(registry.byPath(real)?.id).toBe(legacy.id);
    expect(registry.list().filter(entry => entry.id.startsWith("alias-repo"))).toHaveLength(1);
  });

  test("forget unregisters a stopped workspace and refuses a running one", async () => {
    // plain-folder was registered (and stopped) by the init-offer test above.
    const runningRefusal = await fetch(`${origin}/api/hub/workspaces/myproject/forget`, {
      method: "POST",
      headers: { cookie, origin },
    });
    expect(runningRefusal.status).toBe(409);
    await assertContract("POST", "/api/hub/workspaces/{workspaceId}/forget", runningRefusal);
    expect(registry.byId("myproject")).toBeDefined();

    const forgotten = await fetch(`${origin}/api/hub/workspaces/plain-folder/forget`, {
      method: "POST",
      headers: { cookie, origin },
    });
    expect(forgotten.status).toBe(200);
    await assertContract("POST", "/api/hub/workspaces/{workspaceId}/forget", forgotten);
    expect(registry.byId("plain-folder")).toBeUndefined();

    // The folder survives on disk and shows unregistered in the browser.
    const browse = await fetch(
      `${origin}/api/hub/browse?path=${encodeURIComponent(path.join(tempRoot, "workspaces"))}`,
      { headers: { cookie } },
    );
    const payload = (await browse.json()) as { dirs: { name: string; registeredId: string | null }[] };
    const entry = payload.dirs.find(dir => dir.name === "plain-folder");
    expect(entry).toBeDefined();
    expect(entry?.registeredId).toBeNull();

    const unknown = await fetch(`${origin}/api/hub/workspaces/never-was/forget`, {
      method: "POST",
      headers: { cookie, origin },
    });
    expect(unknown.status).toBe(404);
    await assertContract("POST", "/api/hub/workspaces/{workspaceId}/forget", unknown);
  });

  test("git clone job streams completion, registers, and serves a workspace; failures register nothing", async () => {
    // A source repo cloned into a browsed destination directory.
    const source = path.join(tempRoot, "cloneme");
    const dest = path.join(tempRoot, "checkouts");
    execFileSync("mkdir", ["-p", source]);
    execFileSync("git", ["init"], { cwd: source, stdio: "ignore" });
    await writeFile(path.join(source, "README.md"), "# Clone Me\n");

    const cloned = await fetch(`${origin}/api/hub/clone-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ url: source, dest }),
    });
    expect(cloned.status).toBe(202);
    await assertContract("POST", "/api/hub/clone-jobs", cloned);
    const cloneJobId = ((await cloned.json()) as { jobId: string }).jobId;
    const cloneEvents = await fetch(`${origin}/api/hub/clone-jobs/${cloneJobId}/events`, { headers: { cookie } });
    expect(cloneEvents.status).toBe(200);
    await assertContract("GET", "/api/hub/clone-jobs/{jobId}/events", cloneEvents);
    const cloneStream = await cloneEvents.text();
    expect(cloneStream).toContain("id: 1");
    expect(cloneStream).toContain("event: phase");
    expect(cloneStream).toContain('"status":"succeeded"');
    // Every clone SSE payload must match its documented streaming schema.
    const cloneEventSchemas: Record<string, unknown> = {
      output: streamSchemas.CloneOutput,
      phase: streamSchemas.ClonePhase,
      result: streamSchemas.CloneResult,
    };
    for (const event of parseSse(cloneStream)) {
      const schema = cloneEventSchemas[event.event];
      if (!schema) throw new Error(`undocumented clone SSE event ${event.event}`);
      assertSchema(streaming, schema, event.data, `cloneJobEvents ${event.event}`);
    }
    const id = (JSON.parse(cloneStream.match(/data: (\{"status":"succeeded"[^\n]+\})/)?.[1] ?? "{}") as { workspaceId: string }).workspaceId;
    expect(id).toBe("cloneme");
    const canonicalDest = await realpath(dest);
    expect(registry.byId(id)?.path).toBe(path.join(canonicalDest, "cloneme"));
    const state = await fetch(`${origin}/s/${id}/api/state`, { headers: { cookie } });
    expect(state.status).toBe(200);
    await sessions.stop(id);

    // Clone without a destination is rejected before touching git.
    const noDest = await fetch(`${origin}/api/hub/clone-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ url: source }),
    });
    expect(noDest.status).toBe(400);

    const existingTarget = path.join(dest, "existing-target");
    await mkdir(existingTarget, { recursive: true });
    const existing = await fetch(`${origin}/api/hub/clone-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ url: source, dest, folderName: "existing-target" }),
    });
    expect(existing.status).toBe(409);
    expect(((await existing.json()) as { error: string }).error).toContain("target already exists");

    const aliasedDest = path.join(tempRoot, "checkouts-alias");
    await symlink(dest, aliasedDest);
    const aliasClone = await fetch(`${origin}/api/hub/clone-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ url: "interactive:alias.git", dest: aliasedDest, folderName: "alias-checkout" }),
    });
    expect(aliasClone.status).toBe(202);
    const aliasJobId = ((await aliasClone.json()) as { jobId: string }).jobId;
    const duplicateAlias = await fetch(`${origin}/api/hub/clone-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ url: source, dest, folderName: "alias-checkout" }),
    });
    expect(duplicateAlias.status).toBe(409);
    expect(((await duplicateAlias.json()) as { error: string }).error).toContain("already reserved");
    await fetch(`${origin}/api/hub/clone-jobs/${aliasJobId}/cancel`, {
      method: "POST",
      headers: { cookie, origin },
    });

    const failed = await fetch(`${origin}/api/hub/clone-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ url: path.join(tempRoot, "does-not-exist"), dest }),
    });
    expect(failed.status).toBe(202);
    const failedJobId = ((await failed.json()) as { jobId: string }).jobId;
    const failedEvents = await fetch(`${origin}/api/hub/clone-jobs/${failedJobId}/events`, { headers: { cookie } });
    expect(await failedEvents.text()).toContain('"status":"clone-failed"');
    expect(registry.list().some(entry => entry.path.includes("does-not-exist"))).toBe(false);

    const custom = await fetch(`${origin}/api/hub/clone-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ url: source, dest, folderName: "custom-checkout" }),
    });
    expect(custom.status).toBe(202);
    const customJobId = ((await custom.json()) as { jobId: string }).jobId;
    const customEvents = await fetch(`${origin}/api/hub/clone-jobs/${customJobId}/events`, { headers: { cookie } });
    const customStream = await customEvents.text();
    expect(customStream).toContain('"status":"succeeded"');
    expect(customStream).toContain(path.join(canonicalDest, "custom-checkout"));

    const nested = await fetch(`${origin}/api/hub/clone-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ url: source, dest, folderName: "nested/checkout" }),
    });
    expect(nested.status).toBe(400);
    expect(((await nested.json()) as { error: string }).error).toContain("single folder name");
  }, 60_000);

  test("forget cannot pass a clone registration before retained assignment commits", async () => {
    const dest = path.join(tempRoot, "forget-race-checkouts");
    managedAssignmentBarrier = new Promise(resolve => {
      releaseManagedAssignment = resolve;
    });
    const assignmentEntered = new Promise<void>(resolve => {
      enterManagedAssignment = resolve;
    });

    const created = await fetch(`${origin}/api/hub/clone-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({
        url: "managed:forget-race.git",
        dest,
        credentialId: "unlocked-ssh",
        retainAssignment: true,
      }),
    });
    let jobId = "";
    try {
      expect(created.status).toBe(202);
      jobId = ((await created.json()) as { jobId: string }).jobId;
      await assignmentEntered;
      expect(registry.byId("forget-race")).toBeDefined();

      const forgotten = await fetch(`${origin}/api/hub/workspaces/forget-race/forget`, {
        method: "POST",
        headers: { cookie, origin },
      });
      expect(forgotten.status).toBe(409);
      expect(((await forgotten.json()) as { error: string }).error).toContain("clone job");
      expect(registry.byId("forget-race")).toBeDefined();
      expect(managedCloneAssignments).not.toContain("forget-race");
    } finally {
      releaseManagedAssignment?.();
      managedAssignmentBarrier = undefined;
      releaseManagedAssignment = undefined;
      enterManagedAssignment = undefined;
    }
    const events = await fetch(`${origin}/api/hub/clone-jobs/${jobId}/events`, { headers: { cookie } });
    expect(await events.text()).toContain('"status":"succeeded"');
    expect(managedCloneAssignments).toContain("forget-race");
    await sessions.stop("forget-race");
  }, 60_000);

  test("clone creation validates managed selection before starting and retains only the selected credential", async () => {
    const dest = path.join(tempRoot, "managed-checkouts");
    const startsBefore = managedCloneStarts.length;
    const locked = await fetch(`${origin}/api/hub/clone-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ url: "managed:locked.git", dest, credentialId: "locked-ssh" }),
    });
    expect(locked.status).toBe(409);
    expect(((await locked.json()) as { error: string }).error).toContain("locked");
    expect(managedCloneStarts).toHaveLength(startsBefore);

    const invalidRetain = await fetch(`${origin}/api/hub/clone-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ url: "managed:no-selection.git", dest, retainAssignment: true }),
    });
    expect(invalidRetain.status).toBe(400);
    expect(managedCloneStarts).toHaveLength(startsBefore);

    // A clone-only host (an OpenSSH alias) can never back an assignment;
    // retention is rejected before any clone process starts, instead of a
    // full clone followed by registration rollback over a doomed assign.
    const aliasRetain = await fetch(`${origin}/api/hub/clone-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ url: "managed:alias.git", dest, credentialId: "alias-ssh", retainAssignment: true }),
    });
    expect(aliasRetain.status).toBe(400);
    expect(((await aliasRetain.json()) as { error: string }).error).toContain("clone host");
    expect(managedCloneStarts).toHaveLength(startsBefore);

    const selected = await fetch(`${origin}/api/hub/clone-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({
        url: "managed:selected.git",
        dest,
        credentialId: "unlocked-ssh",
        retainAssignment: true,
      }),
    });
    expect(selected.status).toBe(202);
    const selectedId = ((await selected.json()) as { jobId: string }).jobId;
    const selectedStream = await fetch(`${origin}/api/hub/clone-jobs/${selectedId}/events`, { headers: { cookie } });
    expect(await selectedStream.text()).toContain('"status":"succeeded"');
    expect(managedCloneStarts.at(-1)).toMatchObject({ type: "ssh", agentSocket: "/managed/agent.sock" });
    expect(managedCloneAssignments).toContain("selected");
    await sessions.stop("selected");

    const unselected = await fetch(`${origin}/api/hub/clone-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ url: "managed:unselected.git", dest }),
    });
    expect(unselected.status).toBe(202);
    const unselectedId = ((await unselected.json()) as { jobId: string }).jobId;
    const unselectedStream = await fetch(`${origin}/api/hub/clone-jobs/${unselectedId}/events`, { headers: { cookie } });
    expect(await unselectedStream.text()).toContain('"status":"succeeded"');
    expect(managedCloneStarts.at(-1)).toBeUndefined();
    expect(managedCloneAssignments).not.toContain("unselected");
    await sessions.stop("unselected");
  });

  test("clone jobs accept private prompt input and enforce owner and CSRF gates", async () => {
    const dest = path.join(tempRoot, "interactive-checkouts");
    const unknownCreateField = await fetch(`${origin}/api/hub/clone-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ url: "interactive:unknown.git", dest, extra: true }),
    });
    expect(unknownCreateField.status).toBe(400);
    const created = await fetch(`${origin}/api/hub/clone-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ url: "interactive:prompted.git", dest }),
    });
    expect(created.status).toBe(202);
    const jobId = ((await created.json()) as { jobId: string }).jobId;

    const aliceSession = await sessionStore.issue("alice", "integration test");
    const aliceCookie = `${HUB_COOKIE_NAME}=${aliceSession.id}`;
    const visibleHead = await fetch(`${origin}/api/hub/clone-jobs/${jobId}/events`, {
      method: "HEAD",
      headers: { cookie },
    });
    expect(visibleHead.status).toBe(204);
    await assertContract("HEAD", "/api/hub/clone-jobs/{jobId}/events", visibleHead);
    const hiddenHead = await fetch(`${origin}/api/hub/clone-jobs/${jobId}/events`, {
      method: "HEAD",
      headers: { cookie: aliceCookie },
    });
    expect(hiddenHead.status).toBe(404);
    await assertContract("HEAD", "/api/hub/clone-jobs/{jobId}/events", hiddenHead);
    const hidden = await fetch(`${origin}/api/hub/clone-jobs/${jobId}/events`, {
      headers: { cookie: aliceCookie },
    });
    expect(hidden.status).toBe(404);
    const deniedInput = await fetch(`${origin}/api/hub/clone-jobs/${jobId}/input`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: aliceCookie, origin },
      body: JSON.stringify({ input: "stolen" }),
    });
    expect(deniedInput.status).toBe(404);
    expect(deniedInput.headers.get("cache-control")).toBe("no-store");
    await assertContract("POST", "/api/hub/clone-jobs/{jobId}/input", deniedInput);
    const deniedCancel = await fetch(`${origin}/api/hub/clone-jobs/${jobId}/cancel`, {
      method: "POST",
      headers: { cookie: aliceCookie, origin },
    });
    expect(deniedCancel.status).toBe(404);

    const streamResponse = await fetch(`${origin}/api/hub/clone-jobs/${jobId}/events`, { headers: { cookie } });
    const csrfInput = await fetch(`${origin}/api/hub/clone-jobs/${jobId}/input`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://evil.example" },
      body: JSON.stringify({ input: "must-not-dispatch" }),
    });
    expect(csrfInput.status).toBe(403);
    expect(csrfInput.headers.get("cache-control")).toBe("no-store");
    const firstInput = await fetch(`${origin}/api/hub/clone-jobs/${jobId}/input`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ input: "" }),
    });
    expect(firstInput.status).toBe(200);
    expect(firstInput.headers.get("cache-control")).toBe("no-store");
    await assertContract("POST", "/api/hub/clone-jobs/{jobId}/input", firstInput);
    const secondInput = await fetch(`${origin}/api/hub/clone-jobs/${jobId}/input`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ input: "private-custom-response" }),
    });
    expect(secondInput.status).toBe(200);
    expect(secondInput.headers.get("cache-control")).toBe("no-store");
    const unknownInputField = await fetch(`${origin}/api/hub/clone-jobs/${jobId}/input`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ input: "not-sent", extra: true }),
    });
    expect(unknownInputField.status).toBe(400);
    expect(unknownInputField.headers.get("cache-control")).toBe("no-store");
    const stream = await streamResponse.text();
    expect(stream).toContain("Enter passphrase");
    expect(stream).toContain("Custom authentication challenge");
    expect(stream).toContain('"status":"succeeded"');
    expect(stream).not.toContain("private-custom-response");

    const replay = await fetch(`${origin}/api/hub/clone-jobs/${jobId}/events`, { headers: { cookie } });
    const replayText = await replay.text();
    expect(replayText).toContain('"status":"succeeded"');
    expect(replayText).not.toContain("private-custom-response");
    const afterFirst = await fetch(`${origin}/api/hub/clone-jobs/${jobId}/events`, {
      headers: { cookie, "last-event-id": "1" },
    });
    const afterFirstText = await afterFirst.text();
    expect(afterFirstText).not.toContain("id: 1\n");
    expect(afterFirstText).toContain('"status":"succeeded"');

    const crossOrigin = await fetch(`${origin}/api/hub/clone-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://evil.example" },
      body: JSON.stringify({ url: "interactive:csrf.git", dest }),
    });
    expect(crossOrigin.status).toBe(403);

    const bearerCreated = await fetch(`${origin}/api/hub/clone-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearerId}` },
      body: JSON.stringify({ url: "interactive:bearer.git", dest }),
    });
    expect(bearerCreated.status).toBe(202);
    const bearerJobId = ((await bearerCreated.json()) as { jobId: string }).jobId;
    const cancelled = await fetch(`${origin}/api/hub/clone-jobs/${bearerJobId}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearerId}` },
    });
    expect(cancelled.status).toBe(200);
    await assertContract("POST", "/api/hub/clone-jobs/{jobId}/cancel", cancelled);
    const cancelledEvents = await fetch(`${origin}/api/hub/clone-jobs/${bearerJobId}/events`, {
      headers: { authorization: `Bearer ${bearerId}` },
    });
    expect(await cancelledEvents.text()).toContain('"status":"cancelled"');
  }, 60_000);

  test("secure-context plumbing survives the proxy: manifest and state config", async () => {
    // Hub-spawned sessions declare the whole hub origin as PWA scope
    // (--manifest-scope origin) while start_url stays under the prefix,
    // so an installed webapp treats the dashboard and sibling sessions
    // as in-app. There is no service worker to plumb — installability
    // rides the manifest alone.
    const sw = await fetch(`${origin}/s/myproject/sw.js`, { headers: { cookie } });
    expect(sw.status).toBe(404);

    const manifest = await fetch(`${origin}/s/myproject/manifest.webmanifest`, { headers: { cookie } });
    const manifestBody = (await manifest.json()) as { start_url: string; scope: string };
    expect(manifestBody.start_url).toBe("/s/myproject/");
    expect(manifestBody.scope).toBe("/");

    // Terminal availability rides /api/state through the proxy like any
    // other session state.
    const state = await fetch(`${origin}/s/myproject/api/state`, { headers: { cookie } });
    const payload = (await state.json()) as { terminal?: unknown };
    expect(payload).toHaveProperty("terminal");
  });

  test("workspace document, personal-state, and terminal inventory operations honor the contract", async () => {
    const state = await fetch(`${origin}/s/myproject/api/state`, { headers: { cookie } });
    const statePayload = (await state.json()) as { roots: { docs: { id: string }[] }[] };
    const documentId = statePayload.roots[0]?.docs[0]?.id;
    expect(documentId).toBeDefined();

    const rendered = await fetch(`${origin}/s/myproject/api/document?id=${encodeURIComponent(documentId!)}`, { headers: { cookie } });
    expect(rendered.status).toBe(200);
    await assertContract("GET", "/s/{workspaceId}/api/document", rendered);
    const missingDocument = await fetch(`${origin}/s/myproject/api/document?id=no-such-document`, { headers: { cookie } });
    expect(missingDocument.status).toBe(404);
    await assertContract("GET", "/s/{workspaceId}/api/document", missingDocument);

    const diff = await fetch(`${origin}/s/myproject/api/document/diff?id=${encodeURIComponent(documentId!)}`, { headers: { cookie } });
    expect(diff.status).toBe(200);
    await assertContract("GET", "/s/{workspaceId}/api/document/diff", diff);

    const personal = await fetch(`${origin}/s/myproject/api/personal-state`, { headers: { cookie } });
    expect(personal.status).toBe(200);
    await assertContract("GET", "/s/{workspaceId}/api/personal-state", personal);
    const patched = await fetch(`${origin}/s/myproject/api/personal-state`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ follow: true }),
    });
    expect(patched.status).toBe(200);
    await assertContract("PATCH", "/s/{workspaceId}/api/personal-state", patched);
    const rejectedPatch = await fetch(`${origin}/s/myproject/api/personal-state`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ follow: "sideways" }),
    });
    expect(rejectedPatch.status).toBe(400);
    await assertContract("PATCH", "/s/{workspaceId}/api/personal-state", rejectedPatch);

    const inventory = await fetch(`${origin}/s/myproject/api/terminal/sessions`, { headers: { cookie } });
    expect(inventory.status).toBe(200);
    await assertContract("GET", "/s/{workspaceId}/api/terminal/sessions", inventory);

    // A bearer client sends no Origin header at all; the hub must broker a
    // loopback Origin so the child's origin gate passes (the generated-client
    // path that used to 403).
    const created = await fetch(`${origin}/s/myproject/api/terminal/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearerId}` },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    });
    expect(created.status).toBe(201);
    const terminalSessionId = ((await created.json()) as { id: string }).id;
    const deleted = await fetch(`${origin}/s/myproject/api/terminal/sessions/${terminalSessionId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${bearerId}` },
    });
    expect(deleted.status).toBe(204);
    await assertContract("DELETE", "/s/{workspaceId}/api/terminal/sessions/{terminalSessionId}", deleted);
  }, 30_000);

  test("proxied session traffic rejects foreign origins before any rewriting", async () => {
    // A same-site-but-different-origin page can carry the SameSite=Lax
    // cookie; the hub must refuse it before loopback-shaping the Origin
    // for the child.
    const proxied = await fetch(`${origin}/s/myproject/api/state`, {
      headers: { cookie, origin: "https://attacker.example" },
    });
    expect(proxied.status).toBe(403);
    await assertContract("GET", "/s/{workspaceId}/api/state", proxied);

    const sessionId = crypto.randomUUID();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/s/myproject/api/terminal?sessionId=${sessionId}`, {
      headers: { cookie, origin: "https://attacker.example" },
    } as unknown as string[]);
    const outcome = await new Promise<string>(resolve => {
      const timeout = setTimeout(() => resolve("timeout"), 10_000);
      ws.addEventListener("message", () => {
        clearTimeout(timeout);
        resolve("message");
      });
      ws.addEventListener("open", () => {
        // An open without messages still means the bridge was built; wait
        // for close/message to classify.
      });
      ws.addEventListener("close", () => {
        clearTimeout(timeout);
        resolve("closed");
      });
      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        resolve("closed");
      });
    });
    expect(outcome).toBe("closed");
  }, 20_000);

  test("a stale browser-supplied ?t= is overwritten by the brokered token", async () => {
    // The SPA may have captured a stale token in session storage from an
    // earlier direct visit; through the hub, the auth probe must still
    // succeed because the hub replaces — not merely fills — the t param.
    const probe = await fetch(`${origin}/s/myproject/api/auth?t=stale-garbage-token`, {
      headers: { cookie },
    });
    expect(probe.status).toBe(204);
    await assertContract("GET", "/s/{workspaceId}/api/auth", probe);
  });

  test("chat status is authenticated through the hub without exposing the OpenCode child endpoint", async () => {
    const unauthenticated = await fetch(`${origin}/s/myproject/api/chat/status`);
    expect(unauthenticated.status).toBe(401);
    const response = await fetch(`${origin}/s/myproject/api/chat/status`, { headers: { cookie } });
    expect(response.status).toBe(200);
    await assertContract("GET", "/s/{workspaceId}/api/chat/status", response);
    const text = await response.text();
    expect(text).not.toContain("OPENCODE_SERVER_PASSWORD");
    expect(text).not.toMatch(/127\.0\.0\.1:\d+/);

    const csrf = await fetch(`${origin}/s/myproject/api/chat/conversations/local/prompts`, {
      method: "POST",
      headers: { cookie, origin: "https://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ requestId: "csrf-test", text: "must not run" }),
    });
    expect(csrf.status).toBe(403);
    await assertContract("POST", "/s/{workspaceId}/api/chat/conversations/{conversationId}/prompts", csrf);
  });

  test("chat retry is authenticated and returns availability without leaking the child endpoint", async () => {
    const unauthenticated = await fetch(`${origin}/s/myproject/api/chat/retry`, { method: "POST" });
    expect(unauthenticated.status).toBe(401);

    // Retry spawns a process, so it takes the same origin gate as the other
    // chat mutations — a cookie alone must not be enough for a foreign page.
    const csrf = await fetch(`${origin}/s/myproject/api/chat/retry`, {
      method: "POST",
      headers: { cookie, origin: "https://attacker.example" },
    });
    expect(csrf.status).toBe(403);
    await assertContract("POST", "/s/{workspaceId}/api/chat/retry", csrf);

    const response = await fetch(`${origin}/s/myproject/api/chat/retry`, { method: "POST", headers: { cookie } });
    expect(response.status).toBe(200);
    await assertContract("POST", "/s/{workspaceId}/api/chat/retry", response);
    const text = await response.text();
    expect(text).not.toContain("OPENCODE_SERVER_PASSWORD");
    expect(text).not.toMatch(/127\.0\.0\.1:\d+/);
  });

  test("workspace folder names with edge whitespace round-trip exactly", async () => {
    const spaced = path.join(tempRoot, "workspaces", " padded ");
    execFileSync("mkdir", ["-p", spaced]);
    execFileSync("git", ["init"], { cwd: spaced, stdio: "ignore" });

    const browse = await fetch(
      `${origin}/api/hub/browse?path=${encodeURIComponent(path.join(tempRoot, "workspaces"))}`,
      { headers: { cookie } },
    );
    const payload = (await browse.json()) as { dirs: { name: string }[] };
    expect(payload.dirs.some(dir => dir.name === " padded ")).toBe(true);

    const created = await fetch(`${origin}/api/hub/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ path: spaced }),
    });
    expect(created.status).toBe(200);
    const id = ((await created.json()) as { id: string }).id;
    expect(registry.byId(id)?.path).toBe(spaced);
    await sessions.stop(id);
    await fetch(`${origin}/api/hub/workspaces/${encodeURIComponent(id)}/forget`, {
      method: "POST",
      headers: { cookie, origin },
    });
  }, 60_000);

  test("cross-origin state changes are rejected", async () => {
    const response = await fetch(`${origin}/api/hub/sessions/myproject/stop`, {
      method: "POST",
      headers: { cookie, origin: "https://attacker.example" },
    });
    expect(response.status).toBe(403);
  });

  test("stop parks the workspace and its prefix serves the stopped page", async () => {
    const stop = await fetch(`${origin}/api/hub/sessions/myproject/stop`, {
      method: "POST",
      headers: { cookie, origin },
    });
    expect(stop.status).toBe(200);
    await assertContract("POST", "/api/hub/sessions/{workspaceId}/stop", stop);

    const page = await fetch(`${origin}/s/myproject/`, { headers: { cookie, accept: "text/html" } });
    expect(page.status).toBe(503);
    expect(page.headers.get("cache-control")).toContain("no-store");
    const html = await page.text();
    expect(html).toContain("myproject");
    expect(html).toContain('href="/"');

    const unknown = await fetch(`${origin}/s/never-registered/`, { headers: { cookie, accept: "text/html" } });
    expect(unknown.status).toBe(503);
    expect(await unknown.text()).toContain("No workspace");

    // Every chat operation remains hub-authenticated and reports the same
    // documented stopped-workspace response before any child/provider access.
    const stoppedOperations: Array<[string, string, string, unknown?]> = [
      ["GET", "/s/myproject/api/chat/models", "/s/{workspaceId}/api/chat/models"],
      ["GET", "/s/myproject/api/chat/modes", "/s/{workspaceId}/api/chat/modes"],
      ["GET", "/s/myproject/api/chat/commands", "/s/{workspaceId}/api/chat/commands"],
      ["GET", "/s/myproject/api/chat/conversations", "/s/{workspaceId}/api/chat/conversations"],
      ["POST", "/s/myproject/api/chat/conversations", "/s/{workspaceId}/api/chat/conversations", {}],
      ["GET", "/s/myproject/api/chat/conversations/local", "/s/{workspaceId}/api/chat/conversations/{conversationId}"],
      ["PATCH", "/s/myproject/api/chat/conversations/local", "/s/{workspaceId}/api/chat/conversations/{conversationId}", { requestId: "stopped-rename", title: "Renamed" }],
      ["GET", "/s/myproject/api/chat/conversations/local/events", "/s/{workspaceId}/api/chat/conversations/{conversationId}/events"],
      ["GET", "/s/myproject/api/chat/attachments/11111111-2222-4333-8444-555555555555", "/s/{workspaceId}/api/chat/attachments/{attachmentId}"],
      ["POST", "/s/myproject/api/chat/conversations/local/cancel", "/s/{workspaceId}/api/chat/conversations/{conversationId}/cancel", { requestId: "stopped" }],
      ["DELETE", "/s/myproject/api/chat/conversations/local/queue/held-1", "/s/{workspaceId}/api/chat/conversations/{conversationId}/queue/{messageId}", { requestId: "stopped-unqueue" }],
      ["POST", "/s/myproject/api/chat/conversations/local/permissions/request", "/s/{workspaceId}/api/chat/conversations/{conversationId}/permissions/{interactionId}", { requestId: "stopped", outcome: "rejected" }],
      ["POST", "/s/myproject/api/chat/conversations/local/questions/request", "/s/{workspaceId}/api/chat/conversations/{conversationId}/questions/{interactionId}", { requestId: "stopped", outcome: { kind: "rejected" } }],
    ];
    for (const [method, requestPath, contractPath, body] of stoppedOperations) {
      const response = await fetch(`${origin}${requestPath}`, {
        method,
        headers: { cookie, origin, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(response.status).toBe(503);
      await assertContract(method, contractPath, response);
    }

    // The attachment upload is multipart, so it probes the same
    // stopped-workspace contract outside the JSON loop.
    const uploadForm = new FormData();
    uploadForm.append("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "probe.png", { type: "image/png" }));
    const stoppedUpload = await fetch(`${origin}/s/myproject/api/chat/conversations/local/attachments`, {
      method: "POST",
      headers: { cookie, origin },
      body: uploadForm,
    });
    expect(stoppedUpload.status).toBe(503);
    await assertContract("POST", "/s/{workspaceId}/api/chat/conversations/{conversationId}/attachments", stoppedUpload);
  });

  test("a live session for a user removed from the config is rejected", async () => {
    const ghost = await sessionStore.issue("departed-user", "old laptop");
    const ghostCookie = `uatu_hub=${ghost.id}`;
    const response = await fetch(`${origin}/api/hub/state`, { headers: { cookie: ghostCookie } });
    expect(response.status).toBe(401);
    const proxied = await fetch(`${origin}/s/myproject/api/state`, { headers: { cookie: ghostCookie } });
    expect(proxied.status).toBe(401);
    const viaBearer = await fetch(`${origin}/api/hub/state`, {
      headers: { authorization: `Bearer ${ghost.id}` },
    });
    expect(viaBearer.status).toBe(401);
  });

  test("the dashboard sessions API lists devices and revokes by handle", async () => {
    // A second device signs in.
    const second = await fetch(`${origin}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "tobias", password: "open sesame", deviceLabel: "other laptop" }),
    });
    expect(second.status).toBe(200);
    const secondId = ((await second.json()) as { sessionId: string }).sessionId;

    const listing = await fetch(`${origin}/api/hub/sessions`, { headers: { cookie } });
    expect(listing.status).toBe(200);
    await assertContract("GET", "/api/hub/sessions", listing);
    const payload = (await listing.json()) as {
      sessions: { handle: string; deviceLabel: string; issuedAt: number; current: boolean }[];
    };
    const current = payload.sessions.find(entry => entry.current);
    expect(current?.deviceLabel).toBe("integration test");
    const other = payload.sessions.find(entry => entry.deviceLabel === "other laptop");
    expect(other).toBeDefined();
    expect(other?.current).toBe(false);
    // Handles are prefixes, never whole ids — the page must not hold live
    // sibling credentials.
    expect(other!.handle.length).toBeLessThan(secondId.length);
    expect(secondId.startsWith(other!.handle)).toBe(true);

    // Revoking the other device kills it for every transport, immediately.
    const revoke = await fetch(`${origin}/api/hub/sessions/${encodeURIComponent(other!.handle)}/revoke`, {
      method: "POST",
      headers: { cookie, origin },
    });
    expect(revoke.status).toBe(200);
    await assertContract("POST", "/api/hub/sessions/{sessionHandle}/revoke", revoke);
    expect(((await revoke.json()) as { current: boolean }).current).toBe(false);
    const dead = await fetch(`${origin}/api/hub/state`, {
      headers: { authorization: `Bearer ${secondId}` },
    });
    expect(dead.status).toBe(401);
    // The current session is untouched.
    expect((await fetch(`${origin}/api/hub/state`, { headers: { cookie } })).status).toBe(200);

    // The settings page ships the devices pane.
    const settings = await fetch(`${origin}/settings`, { headers: { cookie, accept: "text/html" } });
    expect(await settings.text()).toContain('id="devices"');
  });

  test("cookies gain Secure when a fronting proxy reports HTTPS", async () => {
    const response = await fetch(`${origin}/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ name: "tobias", password: "open sesame" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie") ?? "").toContain("Secure");

    // Plain loopback without a proxy stays un-Secure so local plain-HTTP
    // login keeps working.
    const plain = await fetch(`${origin}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "tobias", password: "open sesame" }),
    });
    expect(plain.headers.get("set-cookie") ?? "").not.toContain("Secure");
  });

  test("bearer logout returns the documented JSON revocation result", async () => {
    const login = await fetch(`${origin}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "alice", password: "alice secret", deviceLabel: "bearer logout" }),
    });
    expect(login.status).toBe(200);
    const sessionId = ((await login.json()) as { sessionId: string }).sessionId;
    const response = await fetch(`${origin}/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionId}` },
    });
    expect(response.status).toBe(200);
    await assertContract("POST", "/logout", response);
    expect(((await response.json()) as { revoked: boolean }).revoked).toBe(true);
    const dead = await fetch(`${origin}/api/hub/state`, {
      headers: { authorization: `Bearer ${sessionId}` },
    });
    expect(dead.status).toBe(401);
  });

  test("logout revokes the session server-side for every transport", async () => {
    // Cross-origin logout is refused BEFORE anything is revoked
    // (cookie-bearing forced sign-out).
    const forged = await fetch(`${origin}/logout`, {
      method: "POST",
      headers: { cookie, origin: "https://attacker.example" },
      redirect: "manual",
    });
    expect(forged.status).toBe(403);
    expect((await fetch(`${origin}/api/hub/state`, { headers: { cookie } })).status).toBe(200);

    const response = await fetch(`${origin}/logout`, {
      method: "POST",
      headers: { cookie, origin },
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/login");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("uatu_hub=;");
    expect(setCookie).toContain("Max-Age=0");

    // Revocation is server-side: the captured cookie value is dead even if
    // a client kept a copy, and the same id presented as bearer dies too.
    const replayed = await fetch(`${origin}/api/hub/state`, { headers: { cookie } });
    expect(replayed.status).toBe(401);
    const viaBearer = await fetch(`${origin}/api/hub/state`, {
      headers: { authorization: `Bearer ${bearerId}` },
    });
    expect(viaBearer.status).toBe(401);

    // Re-login for the remaining tests.
    const relogin = await fetch(`${origin}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "tobias", password: "open sesame" }),
    });
    expect(relogin.status).toBe(200);
    const payload = (await relogin.json()) as { sessionId: string };
    cookie = `uatu_hub=${payload.sessionId}`;
    bearerId = payload.sessionId;
  });

  test("resume brings the session back, and stopAll terminates every child", async () => {
    const start = await fetch(`${origin}/api/hub/sessions/myproject/start`, {
      method: "POST",
      headers: { cookie, origin },
    });
    expect(start.status).toBe(200);
    await assertContract("POST", "/api/hub/sessions/{workspaceId}/start", start);
    const state = await fetch(`${origin}/s/myproject/api/state`, { headers: { cookie } });
    expect(state.status).toBe(200);

    const running = sessions.get("myproject");
    expect(running).toBeDefined();
    await sessions.stopAll();
    expect(await running!.exited).not.toBeUndefined();
    expect(sessions.runningIds()).toEqual([]);
  }, 60_000);

  test("every documented HTTP operation was black-box validated", () => {
    const documented = new Set<string>();
    for (const pathItem of Object.values(openApi.paths as Record<string, Record<string, unknown>>)) {
      for (const candidate of Object.values(pathItem)) {
        const operation = candidate as { operationId?: unknown; tags?: unknown } | null;
        const operationId = operation?.operationId;
        if (typeof operationId === "string" && !(Array.isArray(operation?.tags) && operation.tags.includes("Hub credentials"))) {
          documented.add(operationId);
        }
      }
    }
    expect(documented.size).toBeGreaterThan(20);
    const missing = [...documented].filter(id => !coveredOperations.has(id));
    expect(missing).toEqual([]);
  });
});
