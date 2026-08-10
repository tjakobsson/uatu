// The client-side URL chokepoint. Every server-relative URL the SPA builds —
// fetches, EventSource, WebSocket paths, pushState document URLs, asset
// references — goes through appUrl() so the whole app relocates under a base
// path by changing exactly one value. The
// value is injected by the server as a <meta name="uatu-base-path"> tag when
// serving under a prefix (see server/navigation.ts relocateShellHtml);
// absence means the default "/" and appUrl() is the identity.
//
// A structural test (shared/app-url-discipline.test.ts) enforces that no
// module bypasses this helper with a root-relative URL literal.

import { joinBasePath, stripBasePath } from "./base-path";

let cachedBasePath: string | null = null;

// The session's base path ("/" by default), read once from the injected meta
// tag. Module-level cache rather than module-load read so unit tests (and
// the server, which also imports shared/) can import this without a DOM.
export function appBasePath(): string {
  if (cachedBasePath === null) {
    cachedBasePath =
      (typeof document !== "undefined"
        ? document.querySelector('meta[name="uatu-base-path"]')?.getAttribute("content")
        : null) ?? "/";
  }
  return cachedBasePath;
}

// Test seam: clears the cached base path so a test can install or remove the
// meta tag and observe both modes.
export function resetAppBasePathForTests(): void {
  cachedBasePath = null;
}

// Prefixes a root-relative app path ("/api/state", "/guides/setup.md") with
// the session's base path. Identity at the default "/".
export function appUrl(rootRelativePath: string): string {
  return joinBasePath(appBasePath(), rootRelativePath);
}

// Strips the base path from a location pathname, returning the root-relative
// remainder the app's routing logic reasons about — or null for a pathname
// outside the session's prefix (which the SPA should treat as "no document").
export function appPathname(pathname: string): string | null {
  return stripBasePath(pathname, appBasePath());
}

// Resolves a location pathname to the document-relative path the tree and
// history logic use ("guides/setup.md"). Outside-prefix pathnames and
// malformed percent-encoding both resolve to "" — "no document in the URL".
export function appDocumentRelativePath(pathname: string): string {
  const stripped = appPathname(pathname);
  if (stripped === null) {
    return "";
  }
  try {
    return decodeURIComponent(stripped).replace(/^\/+/, "");
  } catch {
    return "";
  }
}
