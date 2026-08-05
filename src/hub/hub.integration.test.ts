// Full-stack hub integration: a real hub server (Bun.serve) supervising a
// real `uatu serve` child (from source), driven over HTTP/SSE/WebSocket the
// way a browser would be — login cookie and all. Covers the auth gate, the
// proxy transports with token brokering, CSRF, the stopped-session page, and
// shutdown-terminates-children.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LocalProcessBackend } from "./backend";
import { hashPassword } from "./auth";
import type { HubConfig } from "./config";
import { PersonalWorkspaceStateStore } from "./personal-state";
import { WorkspaceRegistry } from "./registry";
import { startHubServer } from "./server";
import { SessionManager } from "./sessions";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.ts");

let tempRoot = "";
let workspace = "";
let registry: WorkspaceRegistry;
let personalState: PersonalWorkspaceStateStore;
let sessions: SessionManager;
let server: ReturnType<typeof startHubServer>;
let origin = "";
let cookie = "";

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-int-"));
  workspace = path.join(tempRoot, "workspaces", "myproject");
  execFileSync("mkdir", ["-p", workspace]);
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  await writeFile(path.join(workspace, "README.md"), "# Hub Test\n\nfirst body\n");

  const config: HubConfig = {
    port: 0 as number,
    host: "127.0.0.1",
    tls: null,
    users: [{ name: "tobias", passwordHash: await hashPassword("open sesame") }],
    stateDir: path.join(tempRoot, "state"),
    local: false,
  };

  registry = new WorkspaceRegistry(path.join(tempRoot, "registry.json"));
  await registry.load();
  personalState = new PersonalWorkspaceStateStore(path.join(tempRoot, "personal-state.json"));
  await personalState.load();
  sessions = new SessionManager(registry, {
    local: new LocalProcessBackend({ uatuArgv: ["bun", "run", CLI_PATH] }),
  });
  server = startHubServer({ config, registry, sessions, personalState, signingKey: "integration-signing-key-0123456789" });
  origin = `http://127.0.0.1:${server.port}`;
}, 30_000);

afterAll(async () => {
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
    const proxied = await fetch(`${origin}/s/myproject/api/state`);
    expect(proxied.status).toBe(401);
    const navigation = await fetch(`${origin}/`, { headers: { accept: "text/html" }, redirect: "manual" });
    expect(navigation.status).toBe(303);
    expect(navigation.headers.get("location")).toContain("/login");
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
    expect(await wrongPassword.text()).toBe(await unknownUser.text());
  });

  test("login sets the signed hub cookie", async () => {
    const response = await fetch(`${origin}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "tobias", password: "open sesame" }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("uatu_hub=");
    expect(setCookie).toContain("HttpOnly");
    cookie = setCookie.split(";")[0]!;
  });

  test("workspace creation starts a real session and the dashboard sees it", async () => {
    const created = await fetch(`${origin}/api/hub/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ path: workspace }),
    });
    expect(created.status).toBe(200);
    expect(((await created.json()) as { id: string }).id).toBe("myproject");

    const state = await fetch(`${origin}/api/hub/state`, { headers: { cookie } });
    const payload = (await state.json()) as { version: string; workspaces: { id: string; running: boolean }[] };
    expect(payload.workspaces).toEqual([expect.objectContaining({ id: "myproject", running: true })]);
    // The authenticated state API reports the hub's uatu version.
    expect(typeof payload.version).toBe("string");
    expect(payload.version.length).toBeGreaterThan(0);
  }, 60_000);

  test("the dashboard page ships the version slot and the browser pane", async () => {
    const dashboard = await fetch(`${origin}/`, { headers: { cookie, accept: "text/html" } });
    expect(dashboard.status).toBe(200);
    const html = await dashboard.text();
    expect(html).toContain('id="hub-version"');
    expect(html).toContain('id="browser"');
    expect(html).toContain("Sign out");
    // The desktop wrapper's covered-chrome contract: pages pad below the
    // native titlebar/tab bar when the wrapper announces its height.
    expect(html).toContain("--titlebar-inset");
    // The started-but-loading gap indicator ships with the page.
    expect(html).toContain("nav-overlay");
  });

  test("HTTP proxying round-trips /api/state and the shell through the prefix", async () => {
    const state = await fetch(`${origin}/s/myproject/api/state`, { headers: { cookie } });
    expect(state.status).toBe(200);
    const payload = (await state.json()) as { roots: { docs: unknown[] }[] };
    expect(payload.roots.length).toBeGreaterThan(0);

    const shell = await fetch(`${origin}/s/myproject/`, { headers: { cookie, accept: "text/html" } });
    expect(shell.status).toBe(200);
    const html = await shell.text();
    expect(html).toContain('name="uatu-base-path"');
    expect(html).toContain("/s/myproject/");
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
  }, 30_000);

  test("terminal WebSocket bridges through the hub with the token brokered server-side", async () => {
    const created = await fetch(`${origin}/s/myproject/api/terminal/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    });
    expect(created.status).toBe(201);
    const sessionId = ((await created.json()) as { id: string }).id;
    // The browser-visible URL carries NO token — the hub injects the
    // child's credential during proxying.
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/s/myproject/api/terminal?sessionId=${sessionId}`, {
      headers: { cookie, origin },
    } as unknown as string[]);

    const gotOutput = await new Promise<boolean>(resolve => {
      const timeout = setTimeout(() => resolve(false), 15_000);
      let reconstructionReceived = false;
      ws.addEventListener("message", () => {
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
        ws.send(JSON.stringify({ type: "attach-ready", cols: 80, rows: 24 }));
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
    const missing = await fetch(
      `${origin}/api/hub/browse?path=${encodeURIComponent(path.join(tempRoot, "no-such-dir"))}`,
      { headers: { cookie } },
    );
    expect(missing.status).toBe(404);
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

  test("forget unregisters a stopped workspace and refuses a running one", async () => {
    // plain-folder was registered (and stopped) by the init-offer test above.
    const runningRefusal = await fetch(`${origin}/api/hub/workspaces/myproject/forget`, {
      method: "POST",
      headers: { cookie, origin },
    });
    expect(runningRefusal.status).toBe(409);
    expect(registry.byId("myproject")).toBeDefined();

    const forgotten = await fetch(`${origin}/api/hub/workspaces/plain-folder/forget`, {
      method: "POST",
      headers: { cookie, origin },
    });
    expect(forgotten.status).toBe(200);
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
  });

  test("git clone creates, registers, and serves a workspace; failures register nothing", async () => {
    // A source repo cloned into a browsed destination directory.
    const source = path.join(tempRoot, "cloneme");
    const dest = path.join(tempRoot, "checkouts");
    execFileSync("mkdir", ["-p", source]);
    execFileSync("git", ["init"], { cwd: source, stdio: "ignore" });
    await writeFile(path.join(source, "README.md"), "# Clone Me\n");

    const cloned = await fetch(`${origin}/api/hub/clone`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ url: source, dest }),
    });
    expect(cloned.status).toBe(200);
    const id = ((await cloned.json()) as { id: string }).id;
    expect(id).toBe("cloneme");
    expect(registry.byId(id)?.path).toBe(path.join(dest, "cloneme"));
    const state = await fetch(`${origin}/s/${id}/api/state`, { headers: { cookie } });
    expect(state.status).toBe(200);
    await sessions.stop(id);

    // Clone without a destination is rejected before touching git.
    const noDest = await fetch(`${origin}/api/hub/clone`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ url: source }),
    });
    expect(noDest.status).toBe(400);

    const failed = await fetch(`${origin}/api/hub/clone`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ url: path.join(tempRoot, "does-not-exist"), dest }),
    });
    expect(failed.status).toBe(500);
    expect(((await failed.json()) as { error: string }).error).toContain("git clone failed");
  }, 60_000);

  test("secure-context plumbing survives the proxy: SW scope, manifest, and state config", async () => {
    // The service worker must be claimable for exactly this session's scope
    // once the page is on a secure origin — the headers that authorize that
    // must transit the hub unaltered.
    const sw = await fetch(`${origin}/s/myproject/sw.js`, { headers: { cookie } });
    expect(sw.status).toBe(200);
    expect(sw.headers.get("service-worker-allowed")).toBe("/s/myproject/");

    const manifest = await fetch(`${origin}/s/myproject/manifest.webmanifest`, { headers: { cookie } });
    const manifestBody = (await manifest.json()) as { start_url: string; scope: string };
    expect(manifestBody.start_url).toBe("/s/myproject/");
    expect(manifestBody.scope).toBe("/s/myproject/");

    // The clipboard policy (and the rest of terminal config) rides
    // /api/state through the proxy like any other session state.
    const state = await fetch(`${origin}/s/myproject/api/state`, { headers: { cookie } });
    const payload = (await state.json()) as { terminal?: unknown };
    expect(payload).toHaveProperty("terminal");
  });

  test("proxied session traffic rejects foreign origins before any rewriting", async () => {
    // A same-site-but-different-origin page can carry the SameSite=Lax
    // cookie; the hub must refuse it before loopback-shaping the Origin
    // for the child.
    const proxied = await fetch(`${origin}/s/myproject/api/state`, {
      headers: { cookie, origin: "https://attacker.example" },
    });
    expect(proxied.status).toBe(403);

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

    const page = await fetch(`${origin}/s/myproject/`, { headers: { cookie, accept: "text/html" } });
    expect(page.status).toBe(503);
    expect(page.headers.get("cache-control")).toContain("no-store");
    const html = await page.text();
    expect(html).toContain("myproject");
    expect(html).toContain('href="/"');

    const unknown = await fetch(`${origin}/s/never-registered/`, { headers: { cookie, accept: "text/html" } });
    expect(unknown.status).toBe(503);
    expect(await unknown.text()).toContain("No workspace");
  });

  test("a valid cookie for a user removed from the config is rejected", async () => {
    const { createSessionCookieValue } = await import("./auth");
    const ghostCookie = `uatu_hub=${createSessionCookieValue("departed-user", "integration-signing-key-0123456789")}`;
    const response = await fetch(`${origin}/api/hub/state`, { headers: { cookie: ghostCookie } });
    expect(response.status).toBe(401);
    const proxied = await fetch(`${origin}/s/myproject/api/state`, { headers: { cookie: ghostCookie } });
    expect(proxied.status).toBe(401);
  });

  test("cookies gain Secure when a fronting proxy reports HTTPS", async () => {
    const response = await fetch(`${origin}/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ name: "tobias", password: "open sesame" }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie") ?? "").toContain("Secure");

    // Plain loopback without a proxy stays un-Secure so local plain-HTTP
    // login keeps working.
    const plain = await fetch(`${origin}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "tobias", password: "open sesame" }),
      redirect: "manual",
    });
    expect(plain.headers.get("set-cookie") ?? "").not.toContain("Secure");
  });

  test("logout clears the hub session cookie and re-gates everything", async () => {
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

    // A browser honoring that Set-Cookie no longer has credentials.
    const afterLogout = await fetch(`${origin}/api/hub/state`);
    expect(afterLogout.status).toBe(401);

    // Cross-origin logout is refused (cookie-bearing CSRF).
    const forged = await fetch(`${origin}/logout`, {
      method: "POST",
      headers: { cookie, origin: "https://attacker.example" },
      redirect: "manual",
    });
    expect(forged.status).toBe(403);

    // Our captured cookie value still verifies (logout is client-side
    // cookie removal, not key rotation) — keep using it for the tests below.
    const stillValid = await fetch(`${origin}/api/hub/state`, { headers: { cookie } });
    expect(stillValid.status).toBe(200);
  });

  test("resume brings the session back, and stopAll terminates every child", async () => {
    const start = await fetch(`${origin}/api/hub/sessions/myproject/start`, {
      method: "POST",
      headers: { cookie, origin },
    });
    expect(start.status).toBe(200);
    const state = await fetch(`${origin}/s/myproject/api/state`, { headers: { cookie } });
    expect(state.status).toBe(200);

    const running = sessions.get("myproject");
    expect(running).toBeDefined();
    await sessions.stopAll();
    expect(await running!.exited).not.toBeUndefined();
    expect(sessions.runningIds()).toEqual([]);
  }, 60_000);
});
