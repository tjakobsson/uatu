import { describe, expect, test } from "bun:test";

import {
  clientKeyForRateLimit,
  createSessionCookieValue,
  formatHubCookie,
  hashPassword,
  HUB_COOKIE_NAME,
  isSameOriginRequest,
  LoginRateLimiter,
  readHubSession,
  verifyLogin,
  verifyPassword,
  verifySessionCookieValue,
} from "./auth";
import { parseHubConfig } from "./config";

const KEY = "test-signing-key-0123456789abcdef";

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

describe("session cookie", () => {
  test("sign → verify round-trips the user identity", () => {
    const value = createSessionCookieValue("tobias", KEY, 1_700_000_000);
    const session = verifySessionCookieValue(value, KEY, 1_700_000_100);
    expect(session).toEqual({ user: "tobias", issuedAt: 1_700_000_000 });
  });

  test("tampered payloads and signatures are rejected", () => {
    const now = Math.floor(Date.now() / 1000);
    const value = createSessionCookieValue("tobias", KEY, now);
    const [payload, signature] = value.split(".") as [string, string];
    const forgedPayload = Buffer.from(JSON.stringify({ user: "root", iat: 1 }), "utf8").toString("base64url");
    expect(verifySessionCookieValue(`${forgedPayload}.${signature}`, KEY)).toBeNull();
    expect(verifySessionCookieValue(`${payload}.AAAA`, KEY)).toBeNull();
    expect(verifySessionCookieValue("garbage", KEY)).toBeNull();
    expect(verifySessionCookieValue(value, "other-key-other-key-other-key-oth")).toBeNull();
  });

  test("expired and future-dated cookies are rejected server-side", () => {
    const now = 1_700_000_000;
    const fresh = createSessionCookieValue("tobias", KEY, now);
    // Just inside the lifetime: valid.
    expect(verifySessionCookieValue(fresh, KEY, now + 60 * 60 * 24 * 30 - 1)?.user).toBe("tobias");
    // Past the lifetime: Max-Age is advisory to browsers; the server is not.
    expect(verifySessionCookieValue(fresh, KEY, now + 60 * 60 * 24 * 30 + 1)).toBeNull();
    // Future-dated beyond clock skew: forged-looking, rejected.
    expect(verifySessionCookieValue(createSessionCookieValue("tobias", KEY, now + 3600), KEY, now)).toBeNull();
    // Small skew tolerated.
    expect(verifySessionCookieValue(createSessionCookieValue("tobias", KEY, now + 60), KEY, now)?.user).toBe("tobias");
  });

  test("verification survives a signer restart with the same key", () => {
    // Same key, fresh call — nothing in-memory is required to verify.
    const value = createSessionCookieValue("tobias", KEY);
    expect(verifySessionCookieValue(value, KEY)?.user).toBe("tobias");
  });

  test("readHubSession parses the cookie header", () => {
    const value = createSessionCookieValue("tobias", KEY);
    const request = new Request("http://hub/", {
      headers: { cookie: `other=1; ${HUB_COOKIE_NAME}=${value}; more=2` },
    });
    expect(readHubSession(request, KEY)?.user).toBe("tobias");
    expect(readHubSession(new Request("http://hub/"), KEY)).toBeNull();
  });

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
    expect(clientKeyForRateLimit("::1", "100.64.1.2, 127.0.0.1")).toBe("100.64.1.2");
    expect(clientKeyForRateLimit("::ffff:127.0.0.1", "203.0.113.9")).toBe("203.0.113.9");
    // Direct exposure: the header is attacker-controlled — ignored.
    expect(clientKeyForRateLimit("203.0.113.9", "1.2.3.4")).toBe("203.0.113.9");
    // No header behind loopback: fall back to the socket address.
    expect(clientKeyForRateLimit("127.0.0.1", null)).toBe("127.0.0.1");
    expect(clientKeyForRateLimit("127.0.0.1", "  ")).toBe("127.0.0.1");
    expect(clientKeyForRateLimit(null, "1.2.3.4")).toBe("unknown");
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
