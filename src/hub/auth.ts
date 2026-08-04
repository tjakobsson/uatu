// Hub authentication: password verification against the config's users
// list, the signed session cookie, login rate limiting, and the CSRF origin
// check for state-changing endpoints.
//
// The cookie value is `base64url(payload).hmac(payload)` where payload is
// {"user": <name>, "iat": <seconds>} — enough to know who authenticated and
// when. The HMAC key persists in the hub state dir, so sessions survive hub
// restarts; rotating the key logs everyone out.

import crypto from "node:crypto";

import { constantTimeEqual } from "../terminal/auth";
import type { HubConfig, HubUser } from "./config";

export const HUB_COOKIE_NAME = "uatu_hub";
export const HUB_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export type HubSession = {
  user: string;
  issuedAt: number;
};

// --- password hashing ------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  // Bun.password defaults to argon2id with sane parameters.
  return await Bun.password.hash(password);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, passwordHash);
  } catch {
    // Malformed hash strings must read as "wrong password", not a crash.
    return false;
  }
}

// Verifies a login attempt without revealing whether the user exists: an
// unknown name still burns a hash verification against a dummy hash so the
// response time does not differ.
const DUMMY_HASH_PROMISE: Promise<string> = Bun.password.hash("uatu-hub-dummy-password");

export async function verifyLogin(config: HubConfig, name: string, password: string): Promise<HubUser | null> {
  const user = config.users.find(candidate => candidate.name === name);
  if (!user) {
    await verifyPassword(password, await DUMMY_HASH_PROMISE);
    return null;
  }
  return (await verifyPassword(password, user.passwordHash)) ? user : null;
}

// --- signed cookie ---------------------------------------------------------

function sign(payload: string, key: string): string {
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

export function createSessionCookieValue(user: string, key: string, nowSeconds: number = Math.floor(Date.now() / 1000)): string {
  const payload = Buffer.from(JSON.stringify({ user, iat: nowSeconds }), "utf8").toString("base64url");
  return `${payload}.${sign(payload, key)}`;
}

export function verifySessionCookieValue(value: string, key: string): HubSession | null {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (!constantTimeEqual(signature, sign(payload, key))) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const record = parsed as { user?: unknown; iat?: unknown };
  if (typeof record.user !== "string" || typeof record.iat !== "number") {
    return null;
  }
  return { user: record.user, issuedAt: record.iat };
}

// `Secure` is attached whenever the hub itself terminates TLS. In the
// loopback-behind-your-own-proxy mode the hub speaks plain HTTP and cannot
// know the browser-facing scheme; loopback exposure keeps the omission
// harmless there, and an https-terminating proxy still transports the
// cookie only over TLS.
export function formatHubCookie(value: string, options: { secure: boolean }): string {
  const parts = [
    `${HUB_COOKIE_NAME}=${value}`,
    "Path=/",
    `Max-Age=${HUB_COOKIE_MAX_AGE}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

// The logout Set-Cookie: same attributes, empty value, Max-Age=0 so the
// browser drops the session immediately.
export function formatHubCookieClear(options: { secure: boolean }): string {
  const parts = [`${HUB_COOKIE_NAME}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"];
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function readHubSession(request: Request, key: string): HubSession | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== HUB_COOKIE_NAME) continue;
    return verifySessionCookieValue(part.slice(eq + 1).trim(), key);
  }
  return null;
}

// --- CSRF ------------------------------------------------------------------

// State-changing endpoints are POST-only and, when an Origin header is
// present, it must match the hub's own origin (compared by Host — the
// scheme the browser saw may differ from what a fronting proxy forwards).
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    // Same-origin fetches and non-browser clients may omit Origin; the
    // SameSite=Lax cookie is the backstop for those.
    return true;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  return originHost === (request.headers.get("host") ?? "");
}

// --- login rate limiting ---------------------------------------------------

const WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 5;

export class LoginRateLimiter {
  private failures = new Map<string, number[]>();

  // Returns true when another attempt is allowed for this key right now.
  allow(key: string, now: number = Date.now()): boolean {
    const recent = (this.failures.get(key) ?? []).filter(at => now - at < WINDOW_MS);
    this.failures.set(key, recent);
    return recent.length < MAX_FAILURES_PER_WINDOW;
  }

  recordFailure(key: string, now: number = Date.now()): void {
    const recent = (this.failures.get(key) ?? []).filter(at => now - at < WINDOW_MS);
    recent.push(now);
    this.failures.set(key, recent);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
