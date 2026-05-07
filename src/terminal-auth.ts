// Auth helpers for the embedded terminal endpoint. Pulled out of cli.ts so
// they're testable without booting the CLI's `main()` (which has top-level
// side effects). Pure functions only — no I/O, no network, no module-level
// state.

import crypto from "node:crypto";

export const TERMINAL_COOKIE_NAME = "uatu_term";
// One-year Max-Age. The cookie expires earlier in practice — every uatu
// restart rotates the in-memory token, leaving the cookie stale until the
// user re-auths via /api/auth. Long Max-Age just means we don't *also* lose
// it to session-cookie behavior in PWA windows.
export const TERMINAL_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

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

export function formatTerminalCookie(token: string): string {
  // Localhost over HTTP — `Secure` would actually break things here. The
  // SameSite=Strict + Origin allowlist + HttpOnly together still close the
  // realistic attack surface for a localhost-bound dev tool.
  return [
    `${TERMINAL_COOKIE_NAME}=${encodeURIComponent(token)}`,
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

export type ServerOriginRef = { hostname?: string; port?: number };

export function isAllowedOrigin(origin: string | null, srv: ServerOriginRef): boolean {
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const port = String(srv.port ?? "");
  if (parsed.port !== port) return false;
  return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
}
