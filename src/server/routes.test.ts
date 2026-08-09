import { describe, expect, test } from "bun:test";
import path from "node:path";

import { buildFetchFallback, buildRoutes } from "./routes";

// Minimal stub: the asset routes never touch the session, so a thrown
// getter is fine — it makes accidental coupling fail loudly.
const stubSession = () => {
  throw new Error("session should not be touched by asset routes");
};

function buildFontTestRoutes(
  basePath?: string,
  getSession: () => never = stubSession,
  manifestScope?: "base-path" | "origin",
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
    debug: false,
    getMetricsSnapshot: () => ({}),
  });
}

describe("buildRoutes — bundled font asset routes", () => {
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
  test("lets the session normalize a stale file scope", async () => {
    let receivedScope: unknown;
    const getSession = (() => ({
      getStatePayload: (_changedId: null, context: { scope: unknown }) => {
        receivedScope = context.scope;
        return { scope: { kind: "folder" } };
      },
    })) as never;
    const routes = buildFontTestRoutes(undefined, getSession);
    const handler = routes["/api/state"] as { GET: (request: Request) => Response };
    const response = handler.GET(new Request(
      "http://127.0.0.1/api/state?scope=file&documentId=%2Fremoved%2FREADME.md",
    ));

    expect(response.status).toBe(200);
    expect(receivedScope).toEqual({ kind: "file", documentId: "/removed/README.md" });
    expect(await response.json()).toEqual({ scope: { kind: "folder" } });
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
