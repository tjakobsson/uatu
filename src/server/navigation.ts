// SPA navigation dispatch for the catch-all fetch path: Accept-based routing
// between the SPA shell (browser navigations), the static-file fallback, and
// plain 404s — plus the cross-platform browser opener used at startup.

import { spawn } from "node:child_process";

import { stripBasePath } from "../shared/base-path";
import type { DocumentMeta, RootGroup } from "../shared/types";
import { BUILD } from "../shared/version";
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

// The route the raw HTMLBundle is registered under at every Bun.serve call
// site. Internal on purpose: under a non-root base path the bundle's HTML is
// unrelocated (root-absolute chunk refs, no base-path meta), so external
// traffic must reach the shell only through the relocating paths — "/" maps
// to the bundle ONLY at the default base path.
export const INTERNAL_SHELL_PATH = "/__uatu/shell";

// The reserved prefix bundle assets are served under at the DEFAULT base
// path. Bun's implicit HTMLBundle asset routes answer /chunk-*.js requests
// with an ETag but no Cache-Control (oven-sh/bun#19198), and static routes
// preempt the fetch fallback — so the shell's asset refs are rewritten under
// this prefix instead, where the fallback proxies them and pins the
// immutable header. Under a non-root base path the refs are prefixed with
// the base path itself and the same proxy branch already serves them.
export const BUNDLE_ASSET_PREFIX = "/__uatu/asset";

// Content-hashed bundle assets are immutable by construction — a new build
// mints new names. Compiled binaries emit /chunk-<hash>.js-style names;
// dev-mode Bun serves content-addressed /_bun/asset/… and /_bun/client/…
// paths. Both are immutable by construction.
export function isBundleAssetPath(pathname: string): boolean {
  return (
    /^\/[A-Za-z0-9_.-]+-[a-z0-9]{8}\.(js|css|woff2)$/.test(pathname) ||
    /^\/_bun\/(asset|client)\/[A-Za-z0-9_.-]+$/.test(pathname)
  );
}

// Cache the bundled SPA shell HTML on first use so subsequent navigation
// requests can return it without another self-fetch. The bundled HTML is
// reachable via the server's own INTERNAL_SHELL_PATH route (Bun's
// HTMLBundle handling produces it); a one-time real HTTP fetch lifts the
// body out of that route so the catch-all `fetch` handler can serve it for
// direct-link requests too. The key carries the build identity so an entry
// can never outlive the build it was assembled from — freshness must not
// rest on the assumption that a rebuild always restarts the process.
type ShellCache = { body: string; contentType: string };
const shellCache = new Map<string, ShellCache>();

export function shellCacheKey(hostname: string, port: number, basePath: string): string {
  return `${hostname}:${port}:${basePath}:${BUILD.commitSha}`;
}

// Relocates the bundled shell HTML under a base path. Bun's HTMLBundle emits
// root-absolute chunk/asset references (src="/chunk-….js"), which a browser
// that loaded the page at /s/<id>/ would request outside the prefix — so
// every root-absolute src/href is prefixed (protocol-relative "//…" URLs are
// excluded), and a <meta name="uatu-base-path"> is injected for the SPA's
// boot-time URL helper. At the default base path only bundle-asset refs move
// (under BUNDLE_ASSET_PREFIX, so the fetch fallback serves them with pinned
// immutable caching); app-route refs (icons, manifest, "/") stay put.
export function relocateShellHtml(body: string, basePath: string): string {
  if (basePath === "/") {
    return body.replace(/(src|href)="(\/[^"]*)"/g, (match, attr: string, target: string) =>
      isBundleAssetPath(target) ? `${attr}="${BUNDLE_ASSET_PREFIX}${target}"` : match,
    );
  }
  return body
    .replace(/(src|href)="\/(?!\/)/g, `$1="${basePath}`)
    .replace("<head>", `<head><meta name="uatu-base-path" content="${basePath}" />`);
}

// Relocates root-absolute url() references inside a CSS body under the base
// path. Bun's CSS bundler emits root-absolute asset URLs (the bundled Nerd
// Font most importantly: url("/HackNerdFontMono-….woff2")), which a page
// loaded at /s/<id>/ would request outside the prefix — where nothing
// answers. Protocol-relative url(//…) stays untouched. At the default base
// path, bundle-asset url()s move under BUNDLE_ASSET_PREFIX for the same
// header-pinning reason as the shell's script/style refs.
export function relocateCssUrls(css: string, basePath: string): string {
  if (basePath === "/") {
    return css.replace(/url\(\s*(['"]?)(\/[^'")]*)\1\s*\)/g, (match, quote: string, target: string) =>
      isBundleAssetPath(target) ? `url(${quote}${BUNDLE_ASSET_PREFIX}${target}${quote})` : match,
    );
  }
  return css.replace(/url\(\s*(['"]?)\/(?!\/)/g, `url($1${basePath}`);
}

export async function spaShellResponse(
  server: {
    hostname?: string | undefined;
    port?: number | undefined;
  },
  basePath: string = "/",
): Promise<Response> {
  const hostname = server.hostname ?? "127.0.0.1";
  const port = server.port;
  if (port === undefined) {
    throw new Error("spaShellResponse: server has no port");
  }
  const key = shellCacheKey(hostname, port, basePath);
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
    const fetched = await fetch(`http://${hostname}:${port}${INTERNAL_SHELL_PATH}`, {
      headers: { accept: "text/html" },
    });
    if (!fetched.ok) {
      return new Response(`SPA shell unavailable: ${fetched.status}`, { status: 502 });
    }
    body = relocateShellHtml(await fetched.text(), basePath);
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
  basePath?: string;
}): (request: Request) => Promise<Response> {
  const basePath = deps.basePath ?? "/";

  // Proxies a root-relative asset request to Bun's own routes (HTMLBundle
  // chunks and content-addressed assets live there — the static table can't
  // express them) and pins cache headers on the way out. Returns null when
  // nothing upstream answers, so the caller falls through to its 404.
  const proxyBundleAsset = async (request: Request, assetPathname: string): Promise<Response | null> => {
    const server = deps.getServer();
    const hostname = server.hostname ?? "127.0.0.1";
    if (server.port === undefined) {
      return null;
    }
    try {
      const conditionalHeaders: Record<string, string> = {};
      // Forward conditional headers so Bun's internal ETag-bearing chunk
      // routes can answer 304 instead of re-shipping megabytes.
      const ifNoneMatch = request.headers.get("if-none-match");
      if (ifNoneMatch) conditionalHeaders["if-none-match"] = ifNoneMatch;
      const ifModifiedSince = request.headers.get("if-modified-since");
      if (ifModifiedSince) conditionalHeaders["if-modified-since"] = ifModifiedSince;

      const passthrough = await fetch(`http://${hostname}:${server.port}${assetPathname}`, {
        method: request.method,
        headers: { accept: request.headers.get("accept") ?? "*/*", ...conditionalHeaders },
      });
      if (passthrough.status === 304) {
        return new Response(null, { status: 304, headers: passthrough.headers });
      }
      // Bun's dev-mode asset routes ignore conditional headers, so honor
      // If-None-Match here: matching ETag → 304 without the body.
      const upstreamEtag = passthrough.headers.get("etag");
      if (
        ifNoneMatch &&
        upstreamEtag &&
        ifNoneMatch
          .split(",")
          .map(tag => tag.trim().replace(/^W\//, ""))
          .includes(upstreamEtag.replace(/^W\//, ""))
      ) {
        return new Response(null, { status: 304, headers: { etag: upstreamEtag } });
      }
      if (passthrough.ok) {
        const immutable = isBundleAssetPath(assetPathname);
        // CSS chunks carry root-absolute asset url() references (the
        // bundled font above all) that must relocate with the page.
        const contentType = passthrough.headers.get("content-type") ?? "";
        if (contentType.includes("text/css")) {
          const headers = new Headers(passthrough.headers);
          headers.delete("content-length");
          headers.delete("content-encoding");
          if (immutable) headers.set("cache-control", "public, max-age=31536000, immutable");
          return new Response(relocateCssUrls(await passthrough.text(), basePath), {
            status: passthrough.status,
            headers,
          });
        }
        if (immutable) {
          // Buffered rather than streamed so the response carries a
          // real Content-Length — fronting proxies and the hub's
          // compression path treat length-known bodies far better than
          // open-ended chunked streams. These are build assets; their
          // size is bounded by the binary itself.
          const body = new Uint8Array(await passthrough.arrayBuffer());
          const headers = new Headers(passthrough.headers);
          headers.set("cache-control", "public, max-age=31536000, immutable");
          headers.set("content-length", String(body.byteLength));
          return new Response(body, { status: passthrough.status, headers });
        }
        return passthrough;
      }
    } catch {
      // Self-fetch failures fall through to the plain 404.
    }
    return null;
  };

  return async request => {
    const requestUrl = new URL(request.url);
    // Root-relative dispatch below; requests outside the prefix have nothing
    // here (the fetch fallback already 404s them, but this handler is also
    // wired directly in tests).
    const pathname = stripBasePath(requestUrl.pathname, basePath);
    if (pathname === null) {
      return new Response("Not Found", { status: 404 });
    }
    const htmlPreferring = prefersHtmlNavigation(request);

    // The reserved bundle-asset namespace at the default base path — the
    // shell's asset refs are rewritten under it by relocateShellHtml so this
    // handler (not Bun's header-less implicit routes) serves them. Claimed
    // before the static-file fallback: nothing under /__uatu/ is a document.
    if (pathname.startsWith(`${BUNDLE_ASSET_PREFIX}/`)) {
      const assetPathname = pathname.slice(BUNDLE_ASSET_PREFIX.length);
      if (
        isBundleAssetPath(assetPathname) &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        const proxied = await proxyBundleAsset(request, assetPathname);
        if (proxied) {
          return proxied;
        }
      }
      return new Response("Not Found", { status: 404 });
    }

    // The prefix root is always the shell: under a base path the "/" static
    // HTMLBundle route only serves the internal, untransformed bundle, so
    // /s/<id>/ must resolve here regardless of the Accept header.
    if (basePath !== "/" && pathname === "/") {
      return await spaShellResponse(deps.getServer(), basePath);
    }

    if (htmlPreferring) {
      const doc = resolveKnownDocument(pathname, deps.getUnscopedRoots());
      if (doc) {
        return await spaShellResponse(deps.getServer(), basePath);
      }
    }

    const response = await staticFileResponse(pathname, deps.getEntries(), {
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
      return await spaShellResponse(deps.getServer(), basePath);
    }

    // Under a base path, the shell's subresources (Bun HTMLBundle chunks)
    // are served by the internal root-relative routes the static table can't
    // express. Pass unresolved GETs through to ourselves at the stripped
    // path — a chunk answers 200; anything else re-enters this fallback
    // outside the prefix and terminates at the 404 above.
    if (basePath !== "/" && (request.method === "GET" || request.method === "HEAD")) {
      const proxied = await proxyBundleAsset(request, pathname);
      if (proxied) {
        return proxied;
      }
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
