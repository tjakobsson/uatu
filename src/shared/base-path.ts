// Base-path helpers shared by the CLI parser, the HTTP server, and the hub.
// A base path is always normalized to lead and trail with "/" — "/" itself
// for the default — so joining and stripping never have to reason about
// missing separators.

// Normalizes a base-path value to lead and trail with "/". Throws on
// anything that could relocate or split the prefix: a missing leading slash,
// whitespace, query/fragment characters, or dot segments.
export function normalizeBasePath(value: string): string {
  if (!value.startsWith("/")) {
    throw new Error(`invalid --base-path (must start with '/'): '${value}'`);
  }
  if (/\s/.test(value) || value.includes("?") || value.includes("#")) {
    throw new Error(`invalid --base-path (contains whitespace or reserved characters): '${value}'`);
  }
  const segments = value.split("/");
  if (segments.some(segment => segment === "." || segment === "..")) {
    throw new Error(`invalid --base-path (dot segments not allowed): '${value}'`);
  }
  if (value.includes("//")) {
    throw new Error(`invalid --base-path (empty path segment): '${value}'`);
  }
  return value.endsWith("/") ? value : `${value}/`;
}

// Prefixes a root-relative route path ("/api/state") with the base path.
// Identity at "/", so default-mode route tables are byte-for-byte unchanged.
export function joinBasePath(basePath: string, path: string): string {
  if (basePath === "/") {
    return path;
  }
  return basePath.slice(0, -1) + path;
}

// Strips the base path from a request pathname, returning the root-relative
// remainder ("/" for the prefix root) — or null when the pathname lies
// outside the prefix, which callers surface as 404: a prefixed server does
// not answer at its internal root-relative paths.
export function stripBasePath(pathname: string, basePath: string): string | null {
  if (basePath === "/") {
    return pathname;
  }
  if (pathname + "/" === basePath) {
    // "/s/uatu" (no trailing slash) is the prefix root too.
    return "/";
  }
  if (!pathname.startsWith(basePath)) {
    return null;
  }
  return pathname.slice(basePath.length - 1);
}
