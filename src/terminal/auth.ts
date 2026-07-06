// Auth helpers for the embedded terminal endpoint. Pulled out of cli.ts so
// they're testable without booting the CLI's `main()` (which has top-level
// side effects). Pure functions only — no I/O, no network, no module-level
// state.

import crypto from "node:crypto";

export const TERMINAL_COOKIE_PREFIX = "uatu_term";
// One-year Max-Age. The cookie expires earlier in practice — every uatu
// restart rotates the in-memory token, leaving the cookie stale until the
// user re-auths via /api/auth. Long Max-Age just means we don't *also* lose
// it to session-cookie behavior in PWA windows.
export const TERMINAL_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

// The WHATWG URL parser reports `""` for a scheme-default port (and
// normalizes an explicit `:80`/`:443` away), so Origin-vs-Host comparisons
// need both sides resolved to a concrete port number first.
export function normalizedPort(url: URL): string {
  if (url.port !== "") return url.port;
  return url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80";
}

// Cookies are scoped per-host, NOT per-port — every uatu instance on
// `localhost:<port>` shares one jar. Deriving the cookie name from the
// port of the request's Host header keeps N instances' credentials
// independent, and using the *Host* port (not the listen port) keeps the
// name consistent with the address the browser actually stores cookies
// under when the server sits behind a port mapping.
export function terminalCookieName(requestUrl: URL): string {
  return `${TERMINAL_COOKIE_PREFIX}_${normalizedPort(requestUrl)}`;
}

// Constant-time string comparison. `crypto.timingSafeEqual` requires equal
// lengths, so we early-out on length-mismatch before the byte compare; that
// leak (which is the length itself) is unavoidable and not security-relevant
// since the expected token has a fixed length.
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

export function formatTerminalCookie(token: string, requestUrl: URL): string {
  // Localhost over HTTP — `Secure` would actually break things here. The
  // SameSite=Strict + Origin allowlist + HttpOnly together still close the
  // realistic attack surface for a localhost-bound dev tool.
  return [
    `${terminalCookieName(requestUrl)}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${TERMINAL_COOKIE_MAX_AGE}`,
    "HttpOnly",
    "SameSite=Strict",
  ].join("; ");
}

export function readCookie(header: string | null, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

// GET /api/auth probe: three verdicts, mirroring the WebSocket upgrade gate
// so the client can classify a close-before-open failure (the browser
// exposes no HTTP status on a failed upgrade):
//   204 — credentials valid AND the requester's origin passes the gate
//         (upgrade failure was a sessionId collision → reconnect fresh)
//   403 — credentials valid, origin rejected (show the origin diagnostic,
//         NOT the paste-token form)
//   401 — credentials invalid (paste-token form)
// Browsers omit the Origin header on same-origin GETs (they always send it
// on WebSocket upgrades), so an absent Origin is synthesized from the
// request's own scheme+Host — exact for the client's same-origin fetch.
// Deliberately ignores sessionId — a collision is the 204 case by
// definition. `no-store` because a cached answer would defeat the
// disambiguation.
export function authProbeResponse(request: Request, requestUrl: URL, expected: string): Response {
  let status: number;
  if (!hasValidTerminalCredentials(request, requestUrl, expected)) {
    status = 401;
  } else {
    const effectiveOrigin = request.headers.get("Origin") ?? requestUrl.origin;
    status = isAllowedOrigin(effectiveOrigin, requestUrl) ? 204 : 403;
  }
  return new Response(null, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

// Shared credential check for the terminal's REST surface (auth probe,
// session inventory, session kill): auth cookie or `t` query token. The
// WebSocket upgrade gate applies the same check plus Origin and sessionId
// concerns.
export function hasValidTerminalCredentials(
  request: Request,
  requestUrl: URL,
  expected: string,
): boolean {
  const queryToken = requestUrl.searchParams.get("t") ?? "";
  const cookieToken = readCookie(request.headers.get("Cookie"), terminalCookieName(requestUrl));
  return constantTimeEqual(queryToken, expected) || constantTimeEqual(cookieToken, expected);
}

// Origin gate for the terminal surface. The real question is "was this page
// served by me?", and the request's Host header answers it directly: the
// browser sets Host from the address it used to reach the server, so
// comparing the Origin's port against the HOST port (never the listen port)
// keeps the gate correct behind port mappings (container publishes
// 4711→4712) with zero configuration. The hostname stays pinned to loopback
// names: SameSite treats different localhost ports as same-site, so this
// check is the only thing stopping a page served from any other localhost
// port from riding the auth cookie into a shell — and the pin also defeats
// DNS-rebinding origins that would otherwise match Host exactly. Non-browser
// clients can forge both headers but still need the token; Origin checks
// defend against browsers, which forge neither.
export function isAllowedOrigin(origin: string | null, requestUrl: URL): boolean {
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (normalizedPort(parsed) !== normalizedPort(requestUrl)) return false;
  return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
}
