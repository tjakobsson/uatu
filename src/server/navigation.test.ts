import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createNavigationFetchHandler, prefersHtmlNavigation, resolveKnownDocument, spaShellResponse } from "./navigation";
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
      });
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        routes: {
          "/": () =>
            new Response(`<!doctype html><html><body>${SHELL_MARKER}</body></html>`, {
              headers: { "content-type": "text/html; charset=utf-8" },
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
