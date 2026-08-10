// Guard tests for the client-freshness header invariants: HTML entry points
// are never cached, bundle assets are content-hashed and served immutable.
// These run against a real Bun.serve wired exactly like cli.ts (HTMLBundle at
// INTERNAL_SHELL_PATH, "/" through spaShellResponse, the navigation handler
// as the fetch fallback) so a header set in one file and dropped in another
// fails here instead of in a user's browser.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Bun bundles the page on the fly for this import — the same HTMLBundle
// mechanism cli.ts and tests/e2e/server.ts use.
import index from "../index.html";
import {
  BUNDLE_ASSET_PREFIX,
  INTERNAL_SHELL_PATH,
  createNavigationFetchHandler,
  isBundleAssetPath,
  spaShellResponse,
} from "./navigation";

const IMMUTABLE = "public, max-age=31536000, immutable";

function extractRefs(html: string): string[] {
  return [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]!);
}

describe("client-freshness — served headers", () => {
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;

  beforeAll(() => {
    const navigationFetch = createNavigationFetchHandler({
      getUnscopedRoots: () => [],
      getEntries: () => [],
      getRespectGitignore: () => true,
      getServer: () => server,
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      routes: {
        [INTERNAL_SHELL_PATH]: index,
        "/": { GET: () => spaShellResponse(server) },
      },
      fetch: request => navigationFetch(request),
    });
    origin = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("the shell at / is served no-cache and references only prefix-managed bundle assets", async () => {
    const response = await fetch(`${origin}/`, { headers: { accept: "text/html" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");

    const refs = extractRefs(await response.text());
    const scriptAndStyleRefs = refs.filter(ref => /\.(js|css)(\?|$)/.test(ref));
    expect(scriptAndStyleRefs.length).toBeGreaterThan(0);
    for (const ref of scriptAndStyleRefs) {
      // Every bundle ref must route through the managed prefix — an
      // unprefixed ref would be answered by Bun's implicit asset routes,
      // which serve no Cache-Control at all (oven-sh/bun#19198).
      expect(ref.startsWith(`${BUNDLE_ASSET_PREFIX}/`)).toBe(true);
      expect(isBundleAssetPath(ref.slice(BUNDLE_ASSET_PREFIX.length))).toBe(true);
    }
  });

  test("every bundle asset the shell references is served immutable", async () => {
    const shell = await fetch(`${origin}/`, { headers: { accept: "text/html" } });
    const refs = extractRefs(await shell.text()).filter(ref =>
      ref.startsWith(`${BUNDLE_ASSET_PREFIX}/`),
    );
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const asset = await fetch(`${origin}${ref}`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("cache-control")).toBe(IMMUTABLE);
      if ((asset.headers.get("content-type") ?? "").includes("text/css")) {
        // CSS bodies carry their own asset url() refs (the bundled font
        // above all) — those must be prefix-managed too.
        const css = await asset.text();
        for (const [, target] of css.matchAll(/url\(\s*['"]?(\/[^'")]+)['"]?\s*\)/g)) {
          expect(isBundleAssetPath(target!)).toBe(false);
          if (target!.startsWith(`${BUNDLE_ASSET_PREFIX}/`)) {
            expect(isBundleAssetPath(target!.slice(BUNDLE_ASSET_PREFIX.length))).toBe(true);
          }
        }
      }
    }
  });

  test("non-asset probes under the reserved prefix answer 404, not a proxy loop", async () => {
    const probe = await fetch(`${origin}${BUNDLE_ASSET_PREFIX}/api/state`);
    expect(probe.status).toBe(404);
  });

  test("the shell under a base path is no-cache and its assets are immutable", async () => {
    const basePath = "/s/alpha/";
    let prefixed: ReturnType<typeof Bun.serve>;
    const navigationFetch = createNavigationFetchHandler({
      getUnscopedRoots: () => [],
      getEntries: () => [],
      getRespectGitignore: () => true,
      getServer: () => prefixed,
      basePath,
    });
    prefixed = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      routes: { [INTERNAL_SHELL_PATH]: index },
      fetch: request => navigationFetch(request),
    });
    try {
      const prefixedOrigin = `http://127.0.0.1:${prefixed.port}`;
      const shell = await fetch(`${prefixedOrigin}${basePath}`, {
        headers: { accept: "text/html" },
      });
      expect(shell.status).toBe(200);
      expect(shell.headers.get("cache-control")).toBe("no-cache");

      const refs = extractRefs(await shell.text()).filter(
        ref => ref.startsWith(basePath) && /\.(js|css)(\?|$)/.test(ref),
      );
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        const asset = await fetch(`${prefixedOrigin}${ref}`);
        expect(asset.status).toBe(200);
        expect(asset.headers.get("cache-control")).toBe(IMMUTABLE);
      }
    } finally {
      prefixed.stop(true);
    }
  });
});

describe("client-freshness — bundler output shape", () => {
  test("a production build emits only content-hashed bundle asset URLs", async () => {
    const outdir = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-freshness-"));
    try {
      const result = await Bun.build({
        entrypoints: [path.resolve(import.meta.dir, "..", "index.html")],
        outdir,
      });
      expect(result.success).toBe(true);

      const htmlOutput = result.outputs.find(output => output.path.endsWith(".html"));
      expect(htmlOutput).toBeDefined();
      const html = await Bun.file(htmlOutput!.path).text();

      const bundleRefs = extractRefs(html).filter(ref => /\.(js|css)(\?|$)/.test(ref));
      expect(bundleRefs.length).toBeGreaterThan(0);
      for (const ref of bundleRefs) {
        // A new build must mint a new URL: the filename carries a content
        // hash. This is the invariant that makes `immutable` safe.
        expect(ref).toMatch(/-[a-z0-9]{8,}\.(js|css)$/);
      }
    } finally {
      await fs.rm(outdir, { recursive: true, force: true });
    }
  });
});
