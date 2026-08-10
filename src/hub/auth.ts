// Hub authentication: password verification against the config's users
// list, the server-side session store, login rate limiting, and the CSRF
// origin check for state-changing endpoints.
//
// A session is a store record keyed by an opaque, unguessable id. The same
// id travels by two transports — the browser cookie and the native
// `Authorization: Bearer` header — and both resolve through the same store
// lookup, so revoking the record kills every transport at once. The store
// persists in the hub state dir; restart keeps sessions valid, deleting the
// file logs everyone out.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";

import type { HubConfig, HubUser } from "./config";

export const HUB_COOKIE_NAME = "uatu_hub";
export const HUB_SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export type HubSessionRecord = {
  id: string;
  user: string;
  issuedAt: number;
  deviceLabel: string;
  revokedAt?: number;
};

// The dashboard's per-session handle: a prefix long enough to be unique and
// unguessable, short enough to never authenticate (the gate resolves full
// ids only). Listing raw ids would hand the page live sibling credentials.
export const SESSION_HANDLE_LENGTH = 16;

export function sessionHandle(record: HubSessionRecord): string {
  return record.id.slice(0, SESSION_HANDLE_LENGTH);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isExpired(record: HubSessionRecord, now: number): boolean {
  return record.issuedAt + HUB_SESSION_MAX_AGE < now;
}

// --- session store ---------------------------------------------------------

export class HubSessionStore {
  private records = new Map<string, HubSessionRecord>();
  private saveCounter = 0;
  // Serializes writes so concurrent issue/revoke calls cannot interleave
  // their temp-file renames.
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  // Missing or corrupt means "no sessions" — login recreates the file. The
  // worst case of losing it is a re-login, and failing startup over a
  // half-written file would lock the operator out of fixing it via the UI.
  async load(): Promise<void> {
    this.records = new Map();
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch {
      return;
    }
    const list = (raw as { sessions?: unknown })?.sessions;
    if (!Array.isArray(list)) {
      return;
    }
    const now = nowSeconds();
    for (const entry of list) {
      const record = entry as Record<string, unknown>;
      if (
        typeof record?.id !== "string" || record.id === ""
        || typeof record.user !== "string"
        || typeof record.issuedAt !== "number"
        || (record.revokedAt !== undefined && typeof record.revokedAt !== "number")
      ) {
        continue;
      }
      const parsed: HubSessionRecord = {
        id: record.id,
        user: record.user,
        issuedAt: record.issuedAt,
        deviceLabel: typeof record.deviceLabel === "string" ? record.deviceLabel : "unknown device",
      };
      if (record.revokedAt !== undefined) {
        parsed.revokedAt = record.revokedAt as number;
      }
      // Expired-record compaction: dead entries are dropped on load (and on
      // every save) so the file tracks the live fleet, not history.
      if (isExpired(parsed, now)) {
        continue;
      }
      this.records.set(parsed.id, parsed);
    }
    // The file holds live credentials; tighten a copy restored with
    // permissive bits. chmod-after-read keeps a race-free-enough posture
    // for a single-operator state dir.
    await fs.chmod(this.filePath, 0o600).catch(() => undefined);
  }

  async issue(user: string, deviceLabel: string, now: number = nowSeconds()): Promise<HubSessionRecord> {
    const record: HubSessionRecord = {
      id: crypto.randomBytes(32).toString("base64url"),
      user,
      issuedAt: now,
      deviceLabel,
    };
    this.records.set(record.id, record);
    await this.persist();
    return record;
  }

  // The single verification path: unknown, revoked, or expired reads as
  // absent. (The user-still-configured check lives at the gate, next to the
  // config it needs.)
  resolve(id: string, now: number = nowSeconds()): HubSessionRecord | null {
    const record = this.records.get(id);
    if (!record || record.revokedAt !== undefined || isExpired(record, now)) {
      return null;
    }
    return record;
  }

  async revoke(id: string, now: number = nowSeconds()): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || record.revokedAt !== undefined) {
      return false;
    }
    record.revokedAt = now;
    await this.persist();
    return true;
  }

  // Active sessions for one user, newest first — the dashboard's device list.
  listForUser(user: string, now: number = nowSeconds()): HubSessionRecord[] {
    return [...this.records.values()]
      .filter(record => record.user === user && record.revokedAt === undefined && !isExpired(record, now))
      .sort((a, b) => b.issuedAt - a.issuedAt);
  }

  // Resolves a dashboard handle to the full record, scoped to one user's
  // sessions. Requires exactly one match — a short or colliding prefix must
  // never revoke the wrong session.
  findByHandle(user: string, handle: string, now: number = nowSeconds()): HubSessionRecord | null {
    if (handle.length < SESSION_HANDLE_LENGTH) {
      return null;
    }
    const matches = this.listForUser(user, now).filter(record => record.id.startsWith(handle));
    return matches.length === 1 ? matches[0]! : null;
  }

  private persist(): Promise<void> {
    const next = this.mutationChain.then(() => this.save(), () => this.save());
    this.mutationChain = next.catch(() => undefined);
    return next;
  }

  // Atomic temp+rename, owner-only — same discipline as the registry. A
  // crash mid-write leaves the previous file intact, never a torn one.
  private async save(): Promise<void> {
    const now = nowSeconds();
    const sessions = [...this.records.values()].filter(record => !isExpired(record, now));
    const serialized = `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`;
    const temp = `${this.filePath}.${process.pid}.${(this.saveCounter += 1)}.tmp`;
    try {
      await fs.writeFile(temp, serialized, { mode: 0o600 });
      await fs.rename(temp, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

// --- transports ------------------------------------------------------------

export type PresentedSession = {
  id: string;
  transport: "cookie" | "bearer";
};

// Reads the session id a request presents, by either transport. Bearer wins
// when both are present: it is the explicitly attached credential, while a
// cookie rides ambiently.
export function readPresentedSession(request: Request): PresentedSession | null {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
    if (match) {
      return { id: match[1]!, transport: "bearer" };
    }
  }
  const header = request.headers.get("cookie");
  if (header) {
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() !== HUB_COOKIE_NAME) continue;
      const value = part.slice(eq + 1).trim();
      if (value === "") continue;
      return { id: value, transport: "cookie" };
    }
  }
  return null;
}

// A human-readable default device label derived from the login request's
// User-Agent — enough to tell "Safari on macOS" from "UatuCode Desktop" in
// the dashboard's session list. Native clients can pass an explicit label
// in the JSON login body instead.
export function deriveDeviceLabel(userAgent: string | null): string {
  const ua = userAgent ?? "";
  if (ua.trim() === "") {
    return "unknown device";
  }
  const app = /^([\w .-]+?)\/[\d.]+/.exec(ua)?.[1]?.trim();
  const browser = ua.includes("Firefox/")
    ? "Firefox"
    : ua.includes("Edg/")
      ? "Edge"
      : ua.includes("Chrome/") || ua.includes("CriOS/")
        ? "Chrome"
        : ua.includes("Safari/")
          ? "Safari"
          : null;
  const os = ua.includes("iPhone")
    ? "iPhone"
    : ua.includes("iPad")
      ? "iPad"
      : ua.includes("Android")
        ? "Android"
        : ua.includes("Mac OS X") || ua.includes("Macintosh")
          ? "macOS"
          : ua.includes("Windows")
            ? "Windows"
            : ua.includes("Linux")
              ? "Linux"
              : null;
  if (browser) {
    return os ? `${browser} on ${os}` : browser;
  }
  // Non-browser clients ("UatuCode Desktop/1.2"): the product token alone.
  if (app && app.toLowerCase() !== "mozilla") {
    return os ? `${app} on ${os}` : app;
  }
  return "unknown device";
}

const MAX_DEVICE_LABEL_LENGTH = 64;

export function sanitizeDeviceLabel(value: unknown, userAgent: string | null): string {
  if (typeof value === "string") {
    const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_DEVICE_LABEL_LENGTH);
    if (cleaned !== "") {
      return cleaned;
    }
  }
  return deriveDeviceLabel(userAgent);
}

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

// --- cookie formatting -----------------------------------------------------

// `Secure` is attached whenever the browser-facing connection is HTTPS —
// the hub terminating TLS itself, or a fronting proxy reporting it. In the
// loopback-behind-your-own-proxy plain-HTTP mode the hub cannot know the
// browser-facing scheme; loopback exposure keeps the omission harmless
// there, and an https-terminating proxy still transports the cookie only
// over TLS.
export function formatHubCookie(value: string, options: { secure: boolean }): string {
  const parts = [
    `${HUB_COOKIE_NAME}=${value}`,
    "Path=/",
    `Max-Age=${HUB_SESSION_MAX_AGE}`,
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

// Validates a post-login return-to target. Only a same-origin absolute path
// passes: a single leading "/" (not "//", which browsers treat as
// protocol-relative), no backslashes (browsers normalize "\" to "/"), no
// whitespace or control characters (Location-header hygiene). Anything else
// — including absolute URLs with a scheme — falls back to the dashboard.
export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    return "/";
  }
  if (!value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  if (value.includes("\\") || /[\s\u0000-\u001f]/.test(value)) {
    return "/";
  }
  return value;
}

// --- CSRF ------------------------------------------------------------------

// State-changing endpoints are POST-only and, when an Origin header is
// present, it must match the hub's own origin (compared by Host — the
// scheme the browser saw may differ from what a fronting proxy forwards).
// This check applies to cookie-authenticated requests: a bearer credential
// is attached explicitly by the client and cannot be ridden by a cross-site
// page, so bearer requests are exempt at the call sites.
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

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// The rate-limit bucket key for a login attempt. Behind the documented
// loopback proxies (tailscale serve, Caddy, nginx) every request's socket
// address is the proxy's loopback — one shared bucket would let a single
// remote client lock every user out with five failures a minute. When the
// socket peer IS loopback, the proxy's X-Forwarded-For identifies the real
// client; from any non-loopback peer the header is untrusted attacker
// input and the socket address is used.
//
// The LAST hop is the trustworthy one: append-style proxy configs (nginx's
// $proxy_add_x_forwarded_for, Caddy's default) add the peer they actually
// saw to the END of any client-supplied header, so earlier entries are
// attacker-controlled — keying on the first hop would let an
// unauthenticated client mint a fresh bucket per attempt.
export function clientKeyForRateLimit(socketAddress: string | null, forwardedFor: string | null): string {
  if (socketAddress && LOOPBACK_ADDRESSES.has(socketAddress) && forwardedFor) {
    const hops = forwardedFor.split(",").map(hop => hop.trim());
    const last = hops[hops.length - 1] ?? "";
    if (last !== "") {
      return last;
    }
  }
  return socketAddress ?? "unknown";
}

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
