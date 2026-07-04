// SPA navigation dispatch for the catch-all fetch path: Accept-based routing
// between the SPA shell (browser navigations), the static-file fallback, and
// plain 404s — plus the cross-platform browser opener used at startup.

import { spawn } from "node:child_process";

import type { DocumentMeta, RootGroup } from "../shared/types";
import type { WatchEntry } from "./roots";
import { staticFileResponse } from "./static-files";

// Returns true when the request's Accept header expresses a preference for an
// HTML document over alternatives — the signal browsers send for top-level
// navigations (typed URL, refresh, link click) but not for sub-resource
// fetches (`<img>`, `<script>`, etc.). Treats absent headers and a pure
// `*/*` accept (typical of `curl`) as non-HTML-preferring so power users
// invoking `curl http://host/README.md` still receive raw bytes.
export function prefersHtmlNavigation(request: Request): boolean {
  const accept = request.headers.get("accept");
  if (!accept) {
    return false;
  }

  let htmlQuality = 0;
  let otherQuality = 0;

  for (const part of accept.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const [rawType, ...params] = trimmed.split(";");
    const type = (rawType ?? "").trim().toLowerCase();
    if (!type) {
      continue;
    }
    let quality = 1;
    for (const param of params) {
      const trimmedParam = param.trim();
      if (trimmedParam.startsWith("q=")) {
        const parsed = Number.parseFloat(trimmedParam.slice(2));
        if (Number.isFinite(parsed)) {
          quality = parsed;
        }
      }
    }

    if (type === "text/html" || type === "application/xhtml+xml") {
      if (quality > htmlQuality) {
        htmlQuality = quality;
      }
    } else if (type !== "*/*") {
      // `*/*` is intentionally excluded from `otherQuality`: we want
      // `text/html,...,*/*;q=0.8` (every browser navigation) to register as
      // HTML-preferring, and `*/*` alone (curl default) to be excluded
      // entirely — handled by the `htmlQuality > 0` guard below. A
      // contrived header like `text/html;q=0.001,*/*;q=0.99` would,
      // strictly per RFC 9110, prefer the wildcard; we accept that
      // off-spec edge because no real client sends it.
      if (quality > otherQuality) {
        otherQuality = quality;
      }
    }
  }

  return htmlQuality > 0 && htmlQuality >= otherQuality;
}

// Cache the bundled SPA shell HTML on first use so subsequent navigation
// requests can return it without another self-fetch. The bundled HTML is
// reachable via the server's own `/` route (Bun's HTMLBundle handling
// produces it); a one-time real HTTP fetch lifts the body out of that
// route so the catch-all `fetch` handler can serve it for direct-link
// requests too. Caching is safe because the bundle does not change at
// runtime — a rebuild restarts the process.
type ShellCache = { body: string; contentType: string };
const shellCache = new Map<string, ShellCache>();

export async function spaShellResponse(server: {
  hostname?: string | undefined;
  port?: number | undefined;
}): Promise<Response> {
  const hostname = server.hostname ?? "127.0.0.1";
  const port = server.port;
  if (port === undefined) {
    throw new Error("spaShellResponse: server has no port");
  }
  const key = `${hostname}:${port}`;
  const existing = shellCache.get(key);
  if (existing) {
    return new Response(existing.body, {
      headers: {
        "content-type": existing.contentType,
        "cache-control": "no-cache",
      },
    });
  }

  // Network failures here are near-impossible (the server we're calling is
  // ourselves, and we're inside its own request handler) but the catch keeps
  // a single transient blip from poisoning the cache and surfaces a real
  // error to the user instead of a bare 500 with no body.
  let body: string;
  let contentType: string;
  try {
    const fetched = await fetch(`http://${hostname}:${port}/`, {
      headers: { accept: "text/html" },
    });
    if (!fetched.ok) {
      return new Response(`SPA shell unavailable: ${fetched.status}`, { status: 502 });
    }
    body = await fetched.text();
    contentType = fetched.headers.get("content-type") ?? "text/html; charset=utf-8";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`SPA shell unavailable: ${message}`, { status: 502 });
  }

  shellCache.set(key, { body, contentType });
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "cache-control": "no-cache",
    },
  });
}

// The catch-all fetch handler is shared by `cli.ts` (production) and
// `tests/e2e/server.ts` (Playwright). Both need the same Accept-based
// dispatch (HTML-preferring navigations to known docs → SPA shell;
// everything else → static file fallback or 404), and the e2e server's
// roots/entries mutate at runtime via the `/__e2e/reset` endpoint, so the
// helper takes getters rather than captured snapshots.
export function createNavigationFetchHandler(deps: {
  getUnscopedRoots: () => RootGroup[];
  getEntries: () => WatchEntry[];
  getRespectGitignore: () => boolean;
  getServer: () => { hostname?: string | undefined; port?: number | undefined };
}): (request: Request) => Promise<Response> {
  return async request => {
    const requestUrl = new URL(request.url);
    const htmlPreferring = prefersHtmlNavigation(request);

    if (htmlPreferring) {
      const doc = resolveKnownDocument(requestUrl.pathname, deps.getUnscopedRoots());
      if (doc) {
        return await spaShellResponse(deps.getServer());
      }
    }

    const response = await staticFileResponse(requestUrl.pathname, deps.getEntries(), {
      respectGitignore: deps.getRespectGitignore(),
    });
    if (response) {
      return response;
    }

    // HTML-preferring navigation to an unknown path: serve the SPA shell so
    // the SPA stays mounted and can render its own "Document not found"
    // empty state. Without this, the browser navigates to a hard 404 and
    // tears down everything the SPA owns — most notably the terminal
    // WebSockets, which would be killed by a real navigation event.
    // Non-HTML-preferring requests (curl, sub-resource fetches) keep
    // receiving plain 404 so they aren't quietly served a stale HTML body.
    if (htmlPreferring) {
      return await spaShellResponse(deps.getServer());
    }

    return new Response("Not Found", { status: 404 });
  };
}

// Resolves a request pathname to a known document under the current root
// index. Returns `null` for unknown paths,
// malformed encoding, or paths outside any root. Mirrors the SPA's
// path-to-doc lookup so server-side navigation dispatch stays consistent
// with what the client would do once it boots.
export function resolveKnownDocument(
  pathname: string,
  roots: RootGroup[],
): DocumentMeta | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decoded.includes("\0")) {
    return null;
  }

  const relativePath = decoded.replace(/^\/+/, "");
  if (!relativePath) {
    return null;
  }

  for (const root of roots) {
    const doc = root.docs.find(candidate => candidate.relativePath === relativePath);
    if (doc) {
      return doc;
    }
  }
  return null;
}

export async function openBrowser(url: string): Promise<boolean> {
  const platform = process.platform;
  let command = "";
  let args: string[] = [];

  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  return await new Promise(resolve => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });

    child.once("error", () => resolve(false));
    child.unref();
    resolve(true);
  });
}
