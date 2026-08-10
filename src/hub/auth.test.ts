import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  clientKeyForRateLimit,
  deriveDeviceLabel,
  formatHubCookie,
  hashPassword,
  HUB_COOKIE_NAME,
  HUB_SESSION_MAX_AGE,
  HubSessionStore,
  isSameOriginRequest,
  LoginRateLimiter,
  readPresentedSession,
  safeReturnPath,
  sanitizeDeviceLabel,
  sessionHandle,
  verifyLogin,
  verifyPassword,
} from "./auth";
import { parseHubConfig } from "./config";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempStorePath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-sessions-"));
  tempDirectories.push(dir);
  return path.join(dir, "sessions.json");
}

describe("password hashing", () => {
  test("hash → verify round-trips and rejects the wrong password", async () => {
    const hash = await hashPassword("hunter2");
    expect(await verifyPassword("hunter2", hash)).toBe(true);
    expect(await verifyPassword("hunter3", hash)).toBe(false);
  });

  test("a malformed stored hash reads as wrong password, not a crash", async () => {
    expect(await verifyPassword("hunter2", "not-a-hash")).toBe(false);
  });
});

describe("verifyLogin", () => {
  test("accepts the right password, rejects wrong password and unknown user identically", async () => {
    const hash = await hashPassword("open sesame");
    const config = parseHubConfig({ users: [{ name: "tobias", passwordHash: hash }] });

    expect((await verifyLogin(config, "tobias", "open sesame"))?.name).toBe("tobias");
    expect(await verifyLogin(config, "tobias", "wrong")).toBeNull();
    expect(await verifyLogin(config, "nobody", "open sesame")).toBeNull();
  });
});

describe("HubSessionStore", () => {
  test("issue → resolve round-trips; unknown, revoked, and expired read as absent", async () => {
    const store = new HubSessionStore(await tempStorePath());
    await store.load();
    const now = 1_700_000_000;
    const record = await store.issue("tobias", "Safari on macOS", now);
    expect(record.id.length).toBeGreaterThanOrEqual(32);
    expect(store.resolve(record.id, now + 60)).toEqual(record);
    // Unknown id.
    expect(store.resolve("no-such-id", now)).toBeNull();
    // Expired past the max age — the store enforces the lifetime, not the
    // browser's Max-Age.
    expect(store.resolve(record.id, now + HUB_SESSION_MAX_AGE + 1)).toBeNull();
    // Revoked — immediately dead.
    expect(await store.revoke(record.id, now + 120)).toBe(true);
    expect(store.resolve(record.id, now + 121)).toBeNull();
    // Double revocation is a no-op.
    expect(await store.revoke(record.id)).toBe(false);
  });

  test("sessions survive a restart via the persisted file", async () => {
    const filePath = await tempStorePath();
    const store = new HubSessionStore(filePath);
    await store.load();
    const record = await store.issue("tobias", "Safari on macOS");

    const reloaded = new HubSessionStore(filePath);
    await reloaded.load();
    expect(reloaded.resolve(record.id)?.user).toBe("tobias");
    // Revocation persists too.
    await reloaded.revoke(record.id);
    const again = new HubSessionStore(filePath);
    await again.load();
    expect(again.resolve(record.id)).toBeNull();
  });

  test("the store file is owner-only and written atomically", async () => {
    const filePath = await tempStorePath();
    const store = new HubSessionStore(filePath);
    await store.load();
    await store.issue("tobias", "device");
    expect(((await stat(filePath)).mode & 0o777)).toBe(0o600);
    // No temp files left behind.
    const { readdir } = await import("node:fs/promises");
    const siblings = await readdir(path.dirname(filePath));
    expect(siblings.filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a missing or corrupt file means no sessions, and login recreates it", async () => {
    const filePath = await tempStorePath();
    const missing = new HubSessionStore(filePath);
    await missing.load();
    expect(missing.listForUser("tobias")).toEqual([]);

    await writeFile(filePath, "{ not json", { mode: 0o600 });
    const corrupt = new HubSessionStore(filePath);
    await corrupt.load();
    expect(corrupt.listForUser("tobias")).toEqual([]);
    const record = await corrupt.issue("tobias", "device");
    expect(corrupt.resolve(record.id)?.user).toBe("tobias");
    expect(JSON.parse(await readFile(filePath, "utf8")).sessions).toHaveLength(1);
  });

  test("expired records are compacted out of the persisted file", async () => {
    const filePath = await tempStorePath();
    const store = new HubSessionStore(filePath);
    await store.load();
    const longDead = Math.floor(Date.now() / 1000) - HUB_SESSION_MAX_AGE - 60;
    await store.issue("tobias", "old device", longDead);
    const fresh = await store.issue("tobias", "new device");
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as { sessions: { id: string }[] };
    expect(persisted.sessions.map(record => record.id)).toEqual([fresh.id]);
  });

  test("listForUser returns only that user's active sessions, newest first", async () => {
    const store = new HubSessionStore(await tempStorePath());
    await store.load();
    const now = 1_700_000_000;
    const older = await store.issue("tobias", "laptop", now);
    const newer = await store.issue("tobias", "phone", now + 100);
    const other = await store.issue("alice", "tablet", now + 50);
    const revoked = await store.issue("tobias", "gone", now + 10);
    await store.revoke(revoked.id);
    expect(store.listForUser("tobias", now + 200).map(record => record.id)).toEqual([newer.id, older.id]);
    expect(store.listForUser("alice", now + 200).map(record => record.id)).toEqual([other.id]);
  });

  test("findByHandle needs a full-length, unique, same-user prefix", async () => {
    const store = new HubSessionStore(await tempStorePath());
    await store.load();
    const record = await store.issue("tobias", "laptop");
    const handle = sessionHandle(record);
    expect(store.findByHandle("tobias", handle)?.id).toBe(record.id);
    // Too-short prefixes never match — a lucky guess must not revoke.
    expect(store.findByHandle("tobias", handle.slice(0, 4))).toBeNull();
    // Another user cannot address this session.
    expect(store.findByHandle("alice", handle)).toBeNull();
  });
});

describe("readPresentedSession", () => {
  test("reads the cookie transport", () => {
    const request = new Request("http://hub/", {
      headers: { cookie: `other=1; ${HUB_COOKIE_NAME}=abc123; more=2` },
    });
    expect(readPresentedSession(request)).toEqual({ id: "abc123", transport: "cookie" });
    expect(readPresentedSession(new Request("http://hub/"))).toBeNull();
  });

  test("reads the bearer transport, which wins over a cookie", () => {
    const request = new Request("http://hub/", {
      headers: { authorization: "Bearer tok-1", cookie: `${HUB_COOKIE_NAME}=tok-2` },
    });
    expect(readPresentedSession(request)).toEqual({ id: "tok-1", transport: "bearer" });
    // Non-bearer Authorization schemes fall through to the cookie.
    const basic = new Request("http://hub/", {
      headers: { authorization: "Basic dXNlcjpwdw==", cookie: `${HUB_COOKIE_NAME}=tok-2` },
    });
    expect(readPresentedSession(basic)).toEqual({ id: "tok-2", transport: "cookie" });
  });
});

describe("device labels", () => {
  test("derives a readable label from common user agents", () => {
    expect(
      deriveDeviceLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
      ),
    ).toBe("Safari on macOS");
    expect(
      deriveDeviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iPhone");
    expect(deriveDeviceLabel("UatuCode Desktop/1.2")).toBe("UatuCode Desktop");
    expect(deriveDeviceLabel(null)).toBe("unknown device");
    expect(deriveDeviceLabel("")).toBe("unknown device");
  });

  test("sanitizeDeviceLabel prefers a clean explicit label and falls back to the UA", () => {
    expect(sanitizeDeviceLabel("My MacBook", null)).toBe("My MacBook");
    // Control characters are stripped; an effectively empty label falls back.
    expect(sanitizeDeviceLabel("a\u0000b", null)).toBe("ab");
    expect(sanitizeDeviceLabel("   ", "UatuCode Desktop/1.2")).toBe("UatuCode Desktop");
    expect(sanitizeDeviceLabel(42, null)).toBe("unknown device");
    // Overlong labels are capped.
    expect(sanitizeDeviceLabel("x".repeat(200), null).length).toBeLessThanOrEqual(64);
  });
});

describe("cookie formatting", () => {
  test("formatHubCookie sets the hardening attributes", () => {
    const secure = formatHubCookie("v", { secure: true });
    expect(secure).toContain("HttpOnly");
    expect(secure).toContain("SameSite=Lax");
    expect(secure).toContain("Secure");
    expect(secure).toContain("Path=/");
    const plain = formatHubCookie("v", { secure: false });
    expect(plain).not.toContain("Secure");
  });
});

describe("isSameOriginRequest", () => {
  test("accepts matching Origin, absent Origin, and rejects foreign origins", () => {
    const make = (origin?: string) =>
      new Request("https://hub.lan/api/hub/stop", {
        method: "POST",
        headers: { host: "hub.lan", ...(origin ? { origin } : {}) },
      });
    expect(isSameOriginRequest(make("https://hub.lan"))).toBe(true);
    expect(isSameOriginRequest(make())).toBe(true);
    expect(isSameOriginRequest(make("https://attacker.example"))).toBe(false);
    expect(isSameOriginRequest(make("null"))).toBe(false);
  });
});

describe("clientKeyForRateLimit", () => {
  test("uses X-Forwarded-For only when the socket peer is loopback", () => {
    // Behind a loopback proxy: the forwarded client identifies the bucket.
    expect(clientKeyForRateLimit("127.0.0.1", "100.64.1.2")).toBe("100.64.1.2");
    expect(clientKeyForRateLimit("::ffff:127.0.0.1", "203.0.113.9")).toBe("203.0.113.9");
    // Direct exposure: the header is attacker-controlled — ignored.
    expect(clientKeyForRateLimit("203.0.113.9", "1.2.3.4")).toBe("203.0.113.9");
    // No header behind loopback: fall back to the socket address.
    expect(clientKeyForRateLimit("127.0.0.1", null)).toBe("127.0.0.1");
    expect(clientKeyForRateLimit("127.0.0.1", "  ")).toBe("127.0.0.1");
    expect(clientKeyForRateLimit(null, "1.2.3.4")).toBe("unknown");
  });

  test("keys on the LAST hop — the one the trusted proxy appended", () => {
    // Append-style proxies (nginx $proxy_add_x_forwarded_for, Caddy) add
    // the peer they saw to the END; earlier hops are client-supplied. An
    // attacker varying a forged prefix must not mint fresh buckets.
    expect(clientKeyForRateLimit("::1", "6.6.6.6, 100.64.1.2")).toBe("100.64.1.2");
    expect(clientKeyForRateLimit("127.0.0.1", "a, b, 198.51.100.7")).toBe("198.51.100.7");
    expect(clientKeyForRateLimit("127.0.0.1", "spoofed, 100.64.1.2")).toBe(
      clientKeyForRateLimit("127.0.0.1", "other-spoof, 100.64.1.2"),
    );
  });
});

describe("LoginRateLimiter", () => {
  test("blocks after repeated failures inside the window and recovers after it", () => {
    const limiter = new LoginRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.allow("1.2.3.4", t0 + i)).toBe(true);
      limiter.recordFailure("1.2.3.4", t0 + i);
    }
    expect(limiter.allow("1.2.3.4", t0 + 10)).toBe(false);
    // A minute later the window has rolled.
    expect(limiter.allow("1.2.3.4", t0 + 70_000)).toBe(true);
    // Success resets immediately.
    limiter.recordFailure("5.6.7.8", t0);
    limiter.reset("5.6.7.8");
    expect(limiter.allow("5.6.7.8", t0 + 1)).toBe(true);
  });
});

describe("safeReturnPath", () => {
  test("accepts same-origin absolute paths", () => {
    expect(safeReturnPath("/s/uatu/")).toBe("/s/uatu/");
    expect(safeReturnPath("/s/uatu/?scope=file&documentId=%2FREADME.md")).toBe(
      "/s/uatu/?scope=file&documentId=%2FREADME.md",
    );
    expect(safeReturnPath("/")).toBe("/");
  });

  test("rejects everything that could leave the origin", () => {
    // Absolute URL with a scheme.
    expect(safeReturnPath("https://evil.example/")).toBe("/");
    // Protocol-relative.
    expect(safeReturnPath("//evil.example/")).toBe("/");
    // Backslash variants browsers normalize to "//".
    expect(safeReturnPath("/\\evil.example")).toBe("/");
    expect(safeReturnPath("\\\\evil.example")).toBe("/");
    // Header-splitting / whitespace smuggling.
    expect(safeReturnPath("/ok\nSet-Cookie: x=y")).toBe("/");
    expect(safeReturnPath("/with space")).toBe("/");
    // Relative, empty, and non-string shapes.
    expect(safeReturnPath("relative/path")).toBe("/");
    expect(safeReturnPath("")).toBe("/");
    expect(safeReturnPath(null)).toBe("/");
    expect(safeReturnPath(undefined)).toBe("/");
    expect(safeReturnPath(42)).toBe("/");
  });
});
