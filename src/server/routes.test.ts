import { describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildFetchFallback, buildRoutes } from "./routes";
import { DOCUMENT_NOT_READABLE_ERROR } from "../shared/document-errors";
import { scanRoots } from "./roots";
import * as markdownRenderer from "../render/markdown";
import { NotificationFeed, CHILD_NOTIFICATIONS_PATH } from "../chat/notification-feed";
import { createWatchSession, FolderListingError } from "./watch-session";

// Minimal stub: the asset routes never touch the session, so a thrown
// getter is fine — it makes accidental coupling fail loudly.
const stubSession = () => {
  throw new Error("session should not be touched by asset routes");
};

function buildFontTestRoutes(
  basePath?: string,
  getSession: () => never = stubSession,
  manifestScope?: "base-path" | "origin",
  notificationFeed?: NotificationFeed,
  workerEvidence?: (id: string) => Promise<import("../chat/worker-dismissal-evidence").WorkerEvidenceSnapshot>,
) {
  const repoRoot = path.resolve(import.meta.dir, "..", "..");
  return buildRoutes({
    basePath,
    manifestScope,
    mode: "prod",
    assets: {
      mermaid: path.join(repoRoot, "node_modules/mermaid/dist/mermaid.min.js"),
      logo: path.join(repoRoot, "src/assets/uatu-logo.svg"),
      icon192: path.join(repoRoot, "src/assets/icon-192.png"),
      icon512: path.join(repoRoot, "src/assets/icon-512.png"),
      manifest: path.join(repoRoot, "src/assets/manifest.webmanifest"),
      fonts: {
        hackMono: path.join(repoRoot, "src/assets/fonts/HackNerdFontMono-Regular.woff2"),
        hackLicense: path.join(repoRoot, "src/assets/fonts/LICENSE-hack.md"),
        nerdFontsLicense: path.join(repoRoot, "src/assets/fonts/LICENSE-nerdfonts.txt"),
        notices: path.join(repoRoot, "src/assets/fonts/NOTICES.md"),
      },
    },
    getSession,
    chatService: { notificationFeed, workerEvidence } as never,
    getWorkspaceCredential: () => "test-credential",
    debug: false,
    getMetricsSnapshot: () => ({}),
  });
}

describe("buildRoutes — bundled font asset routes", () => {
  test("compact worker evidence uses existing authentication and base path without reading display history", async () => {
    const calls: string[] = [];
    const routes = buildFontTestRoutes("/s/test/", stubSession, "origin", undefined, async id => {
      calls.push(id); return { version: 1, conversationId: id, complete: true, entries: [] };
    });
    const handler = (routes["/s/test/api/chat/conversations/:conversationId/worker-evidence"] as { GET: (request: Request) => Promise<Response> }).GET;
    const request = (query = "") => Object.assign(new Request(`http://localhost/s/test/api/chat/conversations/opencode%3Aparent/worker-evidence${query}`), { params: { conversationId: "opencode:parent" } });
    expect((await handler(request())).status).toBe(401);
    expect((await handler(request("?t=test-credential&limit=100"))).status).toBe(400);
    const response = await handler(request("?t=test-credential"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 1, conversationId: "opencode:parent", complete: true, entries: [] });
    expect(calls).toEqual(["opencode:parent"]);
  });
  test("the internal notification stream authenticates, prefixes, and opens before an event", async () => {
    const feed = new NotificationFeed();
    const routes = buildFontTestRoutes("/s/test/", stubSession, "origin", feed);
    const handler = (routes[`/s/test${CHILD_NOTIFICATIONS_PATH}`] as { GET: (request: Request) => Response }).GET;
    expect(handler(new Request(`http://localhost/s/test${CHILD_NOTIFICATIONS_PATH}`)).status).toBe(401);
    const response = handler(new Request(`http://localhost/s/test${CHILD_NOTIFICATIONS_PATH}?t=test-credential`));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(": open");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"reason":"initial"');
    feed.publish({ type: "notification", notification: { id: "q", sourceId: "q", conversationId: "opencode:one", kind: "question-pending", createdAt: Date.now() } });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"id":"q"');
    await reader.cancel();
    feed.dispose();
  });
  test("the awaiting lookup names the newest unanswered request's conversation, or none", async () => {
    const feed = new NotificationFeed();
    const routes = buildFontTestRoutes("/s/test/", stubSession, "origin", feed);
    const handler = (routes["/s/test/api/chat/awaiting"] as { GET: (request: Request) => Response | Promise<Response> }).GET;
    const read = async () => (await handler(new Request("http://localhost/s/test/api/chat/awaiting?t=test-credential"))).json();
    expect((await handler(new Request("http://localhost/s/test/api/chat/awaiting"))).status).toBe(401);
    expect(await read()).toEqual({ conversationId: null });
    const ask = (id: string, conversationId: string, createdAt: number) =>
      feed.publish({ type: "notification", notification: { id, sourceId: id, conversationId, kind: "question-pending", createdAt } });
    ask("a", "opencode:one", Date.now() - 2_000);
    expect(await read()).toEqual({ conversationId: "opencode:one" });
    ask("b", "claude:two", Date.now() - 1_000);
    ask("c", "opencode:three", Date.now() - 3_000);
    expect(await read()).toEqual({ conversationId: "claude:two" });
    feed.publish({ type: "resolved", id: "b", conversationId: "claude:two" });
    expect(await read()).toEqual({ conversationId: "opencode:one" });
    feed.dispose();
  });
  test("serves the Hack WOFF2 with the right content-type and an immutable cache", async () => {
    const routes = buildFontTestRoutes();
    const response = routes["/assets/fonts/HackNerdFontMono-Regular.woff2"] as Response;

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("font/woff2");
    const cacheControl = response.headers.get("cache-control") ?? "";
    expect(cacheControl).toContain("immutable");
    expect(cacheControl).toContain("max-age=31536000");

    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBeGreaterThan(0);
    // WOFF2 files start with the "wOF2" signature (0x77 0x4F 0x46 0x32).
    expect(body[0]).toBe(0x77);
    expect(body[1]).toBe(0x4f);
    expect(body[2]).toBe(0x46);
    expect(body[3]).toBe(0x32);
  });

  test("serves the bundled license texts as plain readable responses", async () => {
    const routes = buildFontTestRoutes();
    const hack = routes["/assets/fonts/LICENSE-hack.md"] as Response;
    const nerdfonts = routes["/assets/fonts/LICENSE-nerdfonts.txt"] as Response;
    const notices = routes["/assets/fonts/NOTICES.md"] as Response;

    expect(hack.headers.get("content-type")).toContain("text/markdown");
    expect(nerdfonts.headers.get("content-type")).toContain("text/plain");
    expect(notices.headers.get("content-type")).toContain("text/markdown");

    const hackBody = await hack.text();
    expect(hackBody).toContain("MIT License");

    const nerdBody = await nerdfonts.text();
    expect(nerdBody).toContain("MIT License");

    const noticesBody = await notices.text();
    expect(noticesBody).toContain("Hack Nerd Font Mono");
  });
});

describe("buildRoutes — base-path prefixing", () => {
  test("default table is byte-for-byte the unprefixed table", () => {
    const routes = buildFontTestRoutes();
    expect(Object.keys(routes)).toContain("/api/state");
    expect(Object.keys(routes)).toContain("/assets/mermaid.min.js");
    expect(Object.keys(routes).every(key => !key.startsWith("/s/"))).toBe(true);
  });

  test("a base path prefixes every route key", () => {
    const routes = buildFontTestRoutes("/s/alpha/");
    const keys = Object.keys(routes);
    expect(keys).toContain("/s/alpha/api/state");
    expect(keys).toContain("/s/alpha/api/events");
    expect(keys).toContain("/s/alpha/manifest.webmanifest");
    expect(keys).toContain("/s/alpha/debug/metrics");
    expect(keys.every(key => key.startsWith("/s/alpha/"))).toBe(true);
  });

  test("no service worker route exists", () => {
    // Deleted deliberately: installability comes from the manifest alone,
    // and uatu has nothing useful to do offline (pwa-install spec).
    expect(Object.keys(buildFontTestRoutes())).not.toContain("/sw.js");
    expect(Object.keys(buildFontTestRoutes("/s/alpha/"))).not.toContain("/s/alpha/sw.js");
  });

  test("the manifest is rewritten to live under the base path", async () => {
    const routes = buildFontTestRoutes("/s/alpha/");
    const handler = routes["/s/alpha/manifest.webmanifest"] as { GET: () => Promise<Response> };
    const response = await handler.GET();
    const manifest = (await response.json()) as {
      start_url: string;
      scope: string;
      icons: { src: string }[];
    };
    expect(manifest.start_url).toBe("/s/alpha/");
    expect(manifest.scope).toBe("/s/alpha/");
    expect(manifest.icons.every(icon => icon.src.startsWith("/s/alpha/assets/"))).toBe(true);
  });

  test("the default manifest serves the bundled file untouched", async () => {
    const routes = buildFontTestRoutes();
    const response = routes["/manifest.webmanifest"] as Response;
    const manifest = (await response.json()) as { start_url: string; scope: string };
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
  });

  test("origin manifest scope widens scope to / while start_url stays relocated", async () => {
    // Hub mode: the hub owns its origin root, so an installed session
    // webapp treats the dashboard, login, and sibling sessions as
    // in-scope — no iOS out-of-scope browser chrome between them.
    const routes = buildFontTestRoutes("/s/alpha/", stubSession, "origin");
    const handler = routes["/s/alpha/manifest.webmanifest"] as { GET: () => Promise<Response> };
    const response = await handler.GET();
    const manifest = (await response.json()) as {
      start_url: string;
      scope: string;
      icons: { src: string }[];
    };
    expect(manifest.scope).toBe("/");
    expect(manifest.start_url).toBe("/s/alpha/");
    expect(manifest.icons.every(icon => icon.src.startsWith("/s/alpha/assets/"))).toBe(true);
  });
});

describe("buildRoutes — watch context", () => {
  test("content search filters scoped and allRoots corpora by visibility while direct preview stays readable", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "uatu-search-visibility-"));
    const visible = path.join(directory, "visible.md"), ignored = path.join(directory, "ignored.md");
    const session = createWatchSession([{ kind: "dir", absolutePath: directory }], false);
    try {
      const git = Bun.spawn(["git", "init", "-q"], { cwd: directory, stdout: "ignore", stderr: "ignore" });
      expect(await git.exited).toBe(0);
      await writeFile(path.join(directory, ".gitignore"), "ignored.md\n");
      await writeFile(path.join(directory, ".uatu.json"), JSON.stringify({ ignore: { exclude: ["excluded.md"] } }));
      for (const file of [visible, ignored, path.join(directory, "excluded.md")]) await writeFile(file, "needle");
      await session.start();
      const deadline = Date.now() + 4000;
      while (session.findDocument(ignored)?.gitIgnoreStatus !== "ignored") { if (Date.now() > deadline) throw new Error("classification timeout"); await Bun.sleep(10); }
      const routes = buildFontTestRoutes(undefined, (() => session) as never);
      const search = routes["/api/search"] as { GET(request: Request): Response };
      for (const allRoots of ["0", "1"]) {
        const query = `q=needle&showIgnored=0&allRoots=${allRoots}`;
        const response = search.GET(new Request(`http://127.0.0.1/api/search?${query}`));
        const text = await response.text();
        expect(text).toContain('"relativePath":"visible.md"');
        expect(text).not.toContain('"relativePath":"ignored.md"');
        expect(text).not.toContain('"relativePath":"excluded.md"');
      }
      const shown = await search.GET(new Request("http://127.0.0.1/api/search?q=needle&showIgnored=1&allRoots=1")).text();
      expect(shown).toContain('"relativePath":"ignored.md"');
      const document = routes["/api/document"] as { GET(request: Request): Promise<Response> };
      expect((await document.GET(new Request(`http://127.0.0.1/api/document?id=${encodeURIComponent(ignored)}&showIgnored=0`))).status).toBe(200);
      expect((await document.GET(new Request(`http://127.0.0.1/api/document?id=${encodeURIComponent(path.join(directory, "excluded.md"))}&showIgnored=1`))).status).toBe(404);
    } finally { await session.stop(); await rm(directory, { recursive: true, force: true }); }
  });
  test("index recovery and repository refresh retain credential and origin gates", async () => {
    let calls = 0;
    const routes = buildFontTestRoutes(undefined, (() => ({ recover: async () => { calls++; }, requestRepositoryRefresh: () => { calls++; } })) as never);
    for (const endpoint of ["/api/index/recover", "/api/repositories/refresh"]) {
      const handler = routes[endpoint] as { POST: (request: Request) => Response | Promise<Response> };
      expect((await handler.POST(new Request(`http://127.0.0.1${endpoint}`, { method: "POST" }))).status).toBe(401);
      expect((await handler.POST(new Request(`http://127.0.0.1${endpoint}?t=test-credential`, { method: "POST", headers: { origin: "http://127.0.0.1:9999" } }))).status).toBe(403);
      expect((await handler.POST(new Request(`http://127.0.0.1${endpoint}?t=test-credential`, { method: "POST", headers: { origin: "http://127.0.0.1" } }))).ok).toBe(true);
    }
    expect(calls).toBe(2);
  });
  test("folder listing keeps the credential and origin gates and maps listing outcomes", async () => {
    const requested: unknown[] = [];
    const routes = buildFontTestRoutes(undefined, (() => ({
      listFolder: async (rootId: string, relative: string) => {
        requested.push([rootId, relative]);
        if (relative === "gone") return { status: "missing", revision: 7 };
        if (relative === "docs") throw new FolderListingError(404, "not an ignored folder");
        if (relative === "../x") throw new FolderListingError(400, "invalid folder path");
        return { status: "listed", revision: 6 };
      },
    })) as never);
    const handler = routes["/api/index/folder"] as { POST: (request: Request) => Promise<Response> };
    const post = (body: unknown, headers: Record<string, string> = { origin: "http://127.0.0.1" }, credential = "?t=test-credential") =>
      handler.POST(new Request(`http://127.0.0.1/api/index/folder${credential}`, { method: "POST", headers, body: JSON.stringify(body) }));
    expect((await post({ rootId: "/r", path: "build" }, {}, "")).status).toBe(401);
    expect((await post({ rootId: "/r", path: "build" }, { origin: "http://127.0.0.1:9999" })).status).toBe(403);
    expect((await post({ rootId: "/r" })).status).toBe(400);
    const listed = await post({ rootId: "/r", path: "build" });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ status: "listed", revision: 6 });
    const missing = await post({ rootId: "/r", path: "gone" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ status: "missing", revision: 7 });
    expect((await post({ rootId: "/r", path: "docs" })).status).toBe(404);
    expect((await post({ rootId: "/r", path: "../x" })).status).toBe(400);
    expect(requested).toHaveLength(4);
  });
  test("lets the session normalize a stale file scope", async () => {
    let receivedScope: unknown;
    const getSession = (() => ({
      getStatePayload: (_changedId: null, context: { scope: unknown }) => {
        receivedScope = context.scope;
        return { scope: { kind: "folder" } };
      },
    })) as never;
    const routes = buildFontTestRoutes(undefined, getSession);
    const handler = routes["/api/state"] as { GET: (request: Request) => Promise<Response> };
    const response = await handler.GET(new Request(
      "http://127.0.0.1/api/state?scope=file&documentId=%2Fremoved%2FREADME.md",
    ));

    expect(response.status).toBe(200);
    expect(receivedScope).toEqual({ kind: "file", documentId: "/removed/README.md" });
    expect(await response.json()).toEqual({ scope: { kind: "folder" } });
  });
});

describe("buildRoutes — /api/document failures", () => {
  async function documentStatus(
    prepare: (filePath: string) => Promise<void>,
  ): Promise<{ status: number; body: unknown; logged: unknown[][]; filePath: string }> {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const directory = await mkdtemp(path.join(os.tmpdir(), "uatu-routes-document-"));
    const filePath = path.join(directory, "notes.md");
    try {
      await writeFile(filePath, "# Notes\n");
      const roots = await scanRoots([{ kind: "dir", absolutePath: directory }]);
      await prepare(filePath);
      const getSession = (() => ({ getDocumentRoots: () => roots, ensureDocument: async () => roots[0]?.docs[0] })) as never;
      const handler = buildFontTestRoutes(undefined, getSession)["/api/document"] as {
        GET: (request: Request) => Promise<Response>;
      };
      const response = await handler.GET(new Request(`http://127.0.0.1/api/document?id=${encodeURIComponent(filePath)}`));
      return { status: response.status, body: await response.json(), logged: [...errorSpy.mock.calls], filePath };
    } finally {
      errorSpy.mockRestore();
      await chmod(filePath, 0o644).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }

  test("a file removed after indexing answers 404 and logs nothing", async () => {
    const result = await documentStatus(filePath => rm(filePath));
    expect({ status: result.status, body: result.body }).toEqual({ status: 404, body: { error: "document not found" } });
    expect(result.logged).toEqual([]);
  });

  test("an indexed file that became a directory answers 404 and logs nothing", async () => {
    const result = await documentStatus(async filePath => {
      await rm(filePath);
      await mkdir(filePath);
    });
    expect({ status: result.status, body: result.body }).toEqual({ status: 404, body: { error: "document not found" } });
    expect(result.logged).toEqual([]);
  });

  // chmod 0o000 cannot deny root a read, so as root this case would render
  // the file and prove nothing.
  test.skipIf(process.getuid?.() === 0)(
    "a file that exists but cannot be read answers 403 and logs nothing (skipped as root: chmod cannot deny root a read)",
    async () => {
      const result = await documentStatus(filePath => chmod(filePath, 0o000));
      expect({ status: result.status, body: result.body }).toEqual({
        status: 403,
        body: { error: DOCUMENT_NOT_READABLE_ERROR },
      });
      expect(result.logged).toEqual([]);
    },
  );

  test("a readable file whose renderer throws answers 500 and logs the document and cause", async () => {
    const renderSpy = spyOn(markdownRenderer, "renderMarkdownToHtml").mockImplementation(() => {
      throw new Error("renderer exploded");
    });
    try {
      const result = await documentStatus(async () => {});
      expect({ status: result.status, body: result.body }).toEqual({
        status: 500,
        body: { error: "document render failed" },
      });
      expect(result.logged).toHaveLength(1);
      const [message, cause] = result.logged[0]!;
      expect(String(message)).toContain(result.filePath);
      expect((cause as Error).message).toBe("renderer exploded");
    } finally {
      renderSpy.mockRestore();
    }
  });
});

describe("buildFetchFallback — base-path gating", () => {
  const makeFallback = (basePath: string) =>
    buildFetchFallback({
      getTerminalServer: () => null,
      getTerminalToken: () => "token",
      navigationFetch: async () => new Response("navigated", { status: 200 }),
      basePath,
    });

  const stubServer = { upgrade: () => false };

  test("requests outside the prefix are 404", async () => {
    const fallback = makeFallback("/s/alpha/");
    const outside = await fallback(new Request("http://127.0.0.1:4711/api/terminal"), stubServer);
    expect(outside?.status).toBe(404);
  });

  test("prefixed paths are dispatched at their root-relative meaning", async () => {
    const fallback = makeFallback("/s/alpha/");
    // /api/terminal with no PTY backend answers 503 — proof the handler ran
    // rather than the outside-prefix 404.
    const upgrade = await fallback(new Request("http://127.0.0.1:4711/s/alpha/api/terminal"), stubServer);
    expect(upgrade?.status).toBe(503);

    const navigated = await fallback(new Request("http://127.0.0.1:4711/s/alpha/anything"), stubServer);
    expect(navigated?.status).toBe(200);
    expect(await navigated?.text()).toBe("navigated");
  });

  test("the default base path dispatches unprefixed paths unchanged", async () => {
    const fallback = makeFallback("/");
    const upgrade = await fallback(new Request("http://127.0.0.1:4711/api/terminal"), stubServer);
    expect(upgrade?.status).toBe(503);
  });
});

describe("bundled font asset on disk", () => {
  test("HackNerdFontMono-Regular.woff2 is present and within the 1.5 MB budget", async () => {
    const repoRoot = path.resolve(import.meta.dir, "..", "..");
    const file = Bun.file(path.join(repoRoot, "src/assets/fonts/HackNerdFontMono-Regular.woff2"));

    expect(await file.exists()).toBe(true);
    expect(file.size).toBeGreaterThan(0);
    expect(file.size).toBeLessThanOrEqual(1.5 * 1024 * 1024);
  });
});
