import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BUNDLE_ASSET_PREFIX, createNavigationFetchHandler, isCacheableShellBody, prefersHtmlNavigation, relocateCssUrls, relocateShellHtml, resolveKnownDocument, shellCacheKey, spaShellResponse } from "./navigation";
import { BUILD } from "../shared/version";
import { resolveWatchRoots, scanRoots } from "./roots";
import { createWatchSession } from "./watch-session";

const tempDirectories: string[] = [];

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitUntil: condition not met in time");
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("prefersHtmlNavigation", () => {
  test("returns true for a typical browser top-level navigation Accept header", () => {
    const request = new Request("http://localhost/doc.md", {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      },
    });
    expect(prefersHtmlNavigation(request)).toBe(true);
  });

  test("returns false when Accept is */* only (curl default)", () => {
    const request = new Request("http://localhost/doc.md", {
      headers: { accept: "*/*" },
    });
    expect(prefersHtmlNavigation(request)).toBe(false);
  });

  test("returns false when Accept is missing", () => {
    const request = new Request("http://localhost/doc.md");
    expect(prefersHtmlNavigation(request)).toBe(false);
  });

  test("returns false for an <img> sub-resource Accept header", () => {
    const request = new Request("http://localhost/hero.svg", {
      headers: { accept: "image/avif,image/webp,*/*;q=0.8" },
    });
    expect(prefersHtmlNavigation(request)).toBe(false);
  });

  test("returns true when Accept lists text/html with q above other types", () => {
    const request = new Request("http://localhost/doc.md", {
      headers: { accept: "text/html;q=1.0,application/xml;q=0.5" },
    });
    expect(prefersHtmlNavigation(request)).toBe(true);
  });
});

describe("resolveKnownDocument", () => {
  test("returns the matching document for a known path", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-resolve-doc-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Hello\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const doc = resolveKnownDocument("/README.md", roots);
    expect(doc?.relativePath).toBe("README.md");
    expect(doc?.kind).toBe("markdown");
  });

  test("returns a binary file when it exists in the index", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-resolve-binary-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "logo.png"), "not really png");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const doc = resolveKnownDocument("/logo.png", roots);
    expect(doc?.relativePath).toBe("logo.png");
    expect(doc?.kind).toBe("binary");
  });

  test("returns null for an unknown path", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-resolve-unknown-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Hello\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    expect(resolveKnownDocument("/missing.md", roots)).toBeNull();
  });

  test("returns null for malformed percent-encoding", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-resolve-malformed-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Hello\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    expect(resolveKnownDocument("/%GG", roots)).toBeNull();
  });

  test("decodes percent-encoded path segments before lookup", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-resolve-encoded-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "hello world.md"), "# Hi\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const doc = resolveKnownDocument("/hello%20world.md", roots);
    expect(doc?.relativePath).toBe("hello world.md");
  });
});

describe("Accept-based navigation dispatch", () => {
  const SHELL_MARKER = "<!-- spa-shell-test-marker -->";

  async function withDispatchServer<T>(
    rootDirectory: string,
    block: (origin: string) => Promise<T>,
    basePath?: string,
  ): Promise<T> {
    const session = createWatchSession(
      [{ kind: "dir", absolutePath: rootDirectory }],
      true,
      { usePolling: true },
    );
    await session.start();
    await waitUntil(() => session.getRoots().some(root => root.docs.length >= 1));

    let server: ReturnType<typeof Bun.serve> | null = null;
    try {
      const entries = [{ kind: "dir", absolutePath: rootDirectory } as const];
      const navigationHandler = createNavigationFetchHandler({
        getUnscopedRoots: () => session.getUnscopedRoots(),
        getEntries: () => entries,
        getRespectGitignore: () => true,
        getServer: () => server!,
        basePath,
      });
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        routes: {
          ["/__uatu/shell"]: () =>
            new Response(`<!doctype html><html><head></head><body>${SHELL_MARKER}<script src="/chunk-test.js"></script></body></html>`, {
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
          "/chunk-test.js": () =>
            new Response("// chunk", {
              headers: { "content-type": "application/javascript" },
            }),
        },
        fetch: navigationHandler,
      });

      const origin = `http://${server.hostname}:${server.port}`;
      return await block(origin);
    } finally {
      server?.stop(true);
      await session.stop();
    }
  }

  test("HTML-preferring navigation to a known doc returns the SPA shell, not raw markdown", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-dispatch-shell-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Hello\n");

    await withDispatchServer(tempDirectory, async origin => {
      const response = await fetch(`${origin}/README.md`, {
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        },
      });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain(SHELL_MARKER);
      expect(body).not.toContain("# Hello");
    });
  });

  test("Accept: */* request to the same path returns raw bytes via the static fallback", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-dispatch-raw-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Hello\n");

    await withDispatchServer(tempDirectory, async origin => {
      const response = await fetch(`${origin}/README.md`, {
        headers: { accept: "*/*" },
      });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toBe("# Hello\n");
      expect(body).not.toContain(SHELL_MARKER);
    });
  });

  test("HTML-preferring navigation to a binary file returns the SPA shell", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-dispatch-binary-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "logo.png"), "not really png");

    await withDispatchServer(tempDirectory, async origin => {
      const response = await fetch(`${origin}/logo.png`, {
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        },
      });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain(SHELL_MARKER);
      expect(body).not.toContain("not really png");
    });
  });

  // Regression guard for the exact attack vector this dispatch path was added
  // for: an SVG with an inline <script> served as `image/svg+xml` from the
  // app origin would execute at that origin on top-level navigation.
  test("HTML-preferring navigation to an SVG with inline script returns the SPA shell, not the raw SVG", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-dispatch-svg-"));
    tempDirectories.push(tempDirectory);
    const maliciousSvg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    await writeFile(path.join(tempDirectory, "logo.svg"), maliciousSvg);

    await withDispatchServer(tempDirectory, async origin => {
      const response = await fetch(`${origin}/logo.svg`, {
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        },
      });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain(SHELL_MARKER);
      expect(body).not.toContain("<script>alert(1)</script>");
      expect(response.headers.get("content-type") ?? "").not.toContain("image/svg+xml");
    });
  });

  test("HTML-preferring navigation to an unknown path serves the SPA shell so the SPA can render its own empty state", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-dispatch-unknown-html-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Hello\n");

    await withDispatchServer(tempDirectory, async origin => {
      const response = await fetch(`${origin}/typo-not-a-real-doc`, {
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        },
      });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain(SHELL_MARKER);
    });
  });

  test("Accept: */* request to an unknown path still returns 404", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-dispatch-unknown-curl-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Hello\n");

    await withDispatchServer(tempDirectory, async origin => {
      const response = await fetch(`${origin}/typo-not-a-real-doc`, {
        headers: { accept: "*/*" },
      });
      const body = await response.text();
      expect(response.status).toBe(404);
      expect(body).not.toContain(SHELL_MARKER);
      expect(body).toBe("Not Found");
    });
  });
});

describe("relocateShellHtml", () => {
  test("at / bundle-asset refs move under the managed prefix; app refs stay put", () => {
    const html = `<html><head><link rel="manifest" href="/manifest.webmanifest" /><link rel="stylesheet" href="/chunk-abcd1234.css" /></head><body><script src="/chunk-abcd1234.js"></script><script src="/_bun/client/index-0000000099fff035.js"></script><a href="/">home</a></body></html>`;
    const relocated = relocateShellHtml(html, "/");
    expect(relocated).toContain(`href="${BUNDLE_ASSET_PREFIX}/chunk-abcd1234.css"`);
    expect(relocated).toContain(`src="${BUNDLE_ASSET_PREFIX}/chunk-abcd1234.js"`);
    expect(relocated).toContain(`src="${BUNDLE_ASSET_PREFIX}/_bun/client/index-0000000099fff035.js"`);
    // App routes are NOT bundle assets and keep their URLs.
    expect(relocated).toContain(`href="/manifest.webmanifest"`);
    expect(relocated).toContain(`href="/"`);
  });

  test("prefixes root-absolute refs and injects the base-path meta", () => {
    const html = `<html><head><base id="preview-base" href="/" /></head><body><script src="/chunk-a.js"></script><a href="//example.com/x">ext</a></body></html>`;
    const relocated = relocateShellHtml(html, "/s/alpha/");
    expect(relocated).toContain(`<meta name="uatu-base-path" content="/s/alpha/" />`);
    expect(relocated).toContain(`src="/s/alpha/chunk-a.js"`);
    expect(relocated).toContain(`href="/s/alpha/"`);
    // Protocol-relative URLs stay untouched.
    expect(relocated).toContain(`href="//example.com/x"`);
  });
});

describe("relocateCssUrls", () => {
  test("at / bundle-asset url() refs move under the managed prefix; others stay put", () => {
    const css = `@font-face { src: url("/HackNerdFontMono-ab12cd34.woff2"); } a { background: url(/assets/uatu-logo.svg); }`;
    const out = relocateCssUrls(css, "/");
    expect(out).toContain(`url("${BUNDLE_ASSET_PREFIX}/HackNerdFontMono-ab12cd34.woff2")`);
    expect(out).toContain(`url(/assets/uatu-logo.svg)`);
  });

  test("prefixes root-absolute url() refs in every quoting style", () => {
    const css = `a { background: url(/img.png); } @font-face { src: url("/font.woff2") format("woff2"); } b { mask: url('/mask.svg'); } c { d: url(//cdn.example/x); }`;
    const out = relocateCssUrls(css, "/s/alpha/");
    expect(out).toContain(`url(/s/alpha/img.png)`);
    expect(out).toContain(`url("/s/alpha/font.woff2")`);
    expect(out).toContain(`url('/s/alpha/mask.svg')`);
    // Protocol-relative URLs stay untouched.
    expect(out).toContain(`url(//cdn.example/x)`);
  });
});

describe("shellCacheKey", () => {
  test("carries the build identity so a cache entry can never outlive its build", () => {
    const key = shellCacheKey("127.0.0.1", 4711, "/s/alpha/");
    expect(key).toContain("127.0.0.1:4711:/s/alpha/");
    expect(key).toContain(BUILD.commitSha);
  });
});

describe("shell cache vs in-process rebundling", () => {
  test("dev-mode shell bodies (/_bun/ refs) are never cacheable; compiled bodies are", () => {
    expect(isCacheableShellBody(`<script src="/_bun/client/index-00ff.js"></script>`)).toBe(false);
    expect(isCacheableShellBody(`<script src="${BUNDLE_ASSET_PREFIX}/_bun/client/index-00ff.js"></script>`)).toBe(false);
    expect(isCacheableShellBody(`<script src="/s/alpha/_bun/client/index-00ff.js"></script>`)).toBe(false);
    expect(isCacheableShellBody(`<script src="${BUNDLE_ASSET_PREFIX}/chunk-abcd1234.js"></script>`)).toBe(true);
    expect(isCacheableShellBody(`<script src="/s/alpha/chunk-abcd1234.js"></script>`)).toBe(true);
  });

  test("a dev-mode shell is re-fetched after an in-process rebundle; a compiled shell is cached", async () => {
    // Stand-in for Bun's dev-mode HTML server: the internal shell route can
    // start serving different content-addressed refs WITHOUT the process
    // (or BUILD.commitSha) changing.
    let devBody = `<html><head></head><body><script src="/_bun/client/index-aaaa.js"></script></body></html>`;
    let compiledBody = `<html><head></head><body><script src="/chunk-aaaa1111.js"></script></body></html>`;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      routes: {
        "/__uatu/shell": {
          GET: () =>
            new Response(devBody, { headers: { "content-type": "text/html; charset=utf-8" } }),
        },
      },
      fetch: () => new Response("nf", { status: 404 }),
    });
    const compiledServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      routes: {
        "/__uatu/shell": {
          GET: () =>
            new Response(compiledBody, { headers: { "content-type": "text/html; charset=utf-8" } }),
        },
      },
      fetch: () => new Response("nf", { status: 404 }),
    });
    try {
      const first = await (await spaShellResponse(server)).text();
      expect(first).toContain("index-aaaa");
      devBody = devBody.replace("index-aaaa", "index-bbbb");
      const second = await (await spaShellResponse(server)).text();
      // The rebundled refs must reach the browser — no process-lifetime cache.
      expect(second).toContain("index-bbbb");

      const firstCompiled = await (await spaShellResponse(compiledServer)).text();
      expect(firstCompiled).toContain("chunk-aaaa1111");
      compiledBody = compiledBody.replace("chunk-aaaa1111", "chunk-bbbb2222");
      const secondCompiled = await (await spaShellResponse(compiledServer)).text();
      // Compiled bundles cannot change in-process; the cache serves the copy.
      expect(secondCompiled).toContain("chunk-aaaa1111");
    } finally {
      server.stop(true);
      compiledServer.stop(true);
    }
  });
});

describe("base-path navigation dispatch", () => {
  const SHELL_MARKER = "<!-- spa-shell-test-marker -->";
  const BASE = "/s/alpha/";

  test("prefix root serves the relocated shell regardless of Accept", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-base-root-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Hello\n");

    await withBaseDispatchServer(tempDirectory, async origin => {
      const response = await fetch(`${origin}/s/alpha/`, { headers: { accept: "*/*" } });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain(SHELL_MARKER);
      expect(body).toContain(`content="/s/alpha/"`);
      expect(body).toContain(`src="/s/alpha/chunk-test.js"`);
    });
  });

  test("prefixed document navigation serves the relocated shell and raw fetch serves bytes", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-base-doc-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Hello\n");

    await withBaseDispatchServer(tempDirectory, async origin => {
      const navigated = await fetch(`${origin}/s/alpha/README.md`, {
        headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      });
      expect(navigated.status).toBe(200);
      expect(await navigated.text()).toContain(SHELL_MARKER);

      const raw = await fetch(`${origin}/s/alpha/README.md`, { headers: { accept: "*/*" } });
      expect(raw.status).toBe(200);
      expect(await raw.text()).toBe("# Hello\n");
    });
  });

  test("prefixed shell subresources pass through to the internal chunk routes", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-base-chunk-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Hello\n");

    await withBaseDispatchServer(tempDirectory, async origin => {
      const chunk = await fetch(`${origin}/s/alpha/chunk-test.js`, { headers: { accept: "*/*" } });
      expect(chunk.status).toBe(200);
      expect(await chunk.text()).toBe("// chunk");
    });
  });

  test("requests outside the prefix are 404", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-base-outside-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Hello\n");

    await withBaseDispatchServer(tempDirectory, async origin => {
      const response = await fetch(`${origin}/s/other/README.md`, {
        headers: { accept: "text/html" },
      });
      expect(response.status).toBe(404);
    });
  });

  // Mirror of withDispatchServer with the base path wired through — kept
  // local so the default-mode harness above stays untouched.
  async function withBaseDispatchServer<T>(
    rootDirectory: string,
    block: (origin: string) => Promise<T>,
  ): Promise<T> {
    const session = createWatchSession(
      [{ kind: "dir", absolutePath: rootDirectory }],
      true,
      { usePolling: true },
    );
    await session.start();
    await waitUntil(() => session.getRoots().some(root => root.docs.length >= 1));

    let server: ReturnType<typeof Bun.serve> | null = null;
    try {
      const entries = [{ kind: "dir", absolutePath: rootDirectory } as const];
      const navigationHandler = createNavigationFetchHandler({
        getUnscopedRoots: () => session.getUnscopedRoots(),
        getEntries: () => entries,
        getRespectGitignore: () => true,
        getServer: () => server!,
        basePath: BASE,
      });
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        routes: {
          ["/__uatu/shell"]: () =>
            new Response(`<!doctype html><html><head></head><body>${SHELL_MARKER}<script src="/chunk-test.js"></script></body></html>`, {
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
          "/chunk-test.js": () =>
            new Response("// chunk", {
              headers: { "content-type": "application/javascript" },
            }),
          "/chunk-test.css": () =>
            new Response(`@font-face { src: url("/font-test.woff2") format("woff2"); }`, {
              headers: { "content-type": "text/css; charset=utf-8" },
            }),
        },
        fetch: navigationHandler,
      });

      const origin = `http://${server.hostname}:${server.port}`;
      return await block(origin);
    } finally {
      server?.stop(true);
      await session.stop();
    }
  }

  test("CSS chunks passed through the prefix have their url() refs relocated", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-base-css-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Hello\n");

    await withBaseDispatchServer(tempDirectory, async origin => {
      const css = await fetch(`${origin}/s/alpha/chunk-test.css`, { headers: { accept: "text/css,*/*;q=0.1" } });
      expect(css.status).toBe(200);
      const body = await css.text();
      expect(body).toContain(`url("/s/alpha/font-test.woff2")`);
      expect(body).not.toContain(`url("/font-test.woff2")`);
    });
  });
});
