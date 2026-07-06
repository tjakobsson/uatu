import { describe, expect, it } from "bun:test";

import {
  TERMINAL_COOKIE_MAX_AGE,
  TERMINAL_COOKIE_PREFIX,
  authProbeResponse,
  constantTimeEqual,
  formatTerminalCookie,
  isAllowedOrigin,
  normalizedPort,
  readCookie,
  terminalCookieName,
} from "./auth";

// Most tests exercise a server reached at this address; the Host-derived
// cookie name for it is fixed here once.
const REQUEST_URL = new URL("http://127.0.0.1:4711/api/terminal");
const COOKIE_NAME = `${TERMINAL_COOKIE_PREFIX}_4711`;

describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });

  it("returns false for different strings of equal length", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });

  it("returns false for length mismatch (without throwing)", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
  });

  it("treats two empty strings as equal", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("normalizedPort", () => {
  it("returns the explicit port unchanged", () => {
    expect(normalizedPort(new URL("http://localhost:4711"))).toBe("4711");
  });

  it("resolves an absent port to the scheme default", () => {
    expect(normalizedPort(new URL("http://localhost"))).toBe("80");
    expect(normalizedPort(new URL("https://localhost"))).toBe("443");
  });

  it("agrees with URL's normalization of explicit default ports", () => {
    // WHATWG URL drops an explicit scheme-default port at parse time; the
    // helper must land on the same value as the implicit spelling.
    expect(normalizedPort(new URL("http://localhost:80"))).toBe("80");
    expect(normalizedPort(new URL("https://localhost:443"))).toBe("443");
  });
});

describe("terminalCookieName", () => {
  it("suffixes the Host port", () => {
    expect(terminalCookieName(new URL("http://localhost:4712/"))).toBe(
      `${TERMINAL_COOKIE_PREFIX}_4712`,
    );
  });

  it("normalizes an absent port to the scheme default", () => {
    expect(terminalCookieName(new URL("http://localhost/"))).toBe(`${TERMINAL_COOKIE_PREFIX}_80`);
  });

  it("derives distinct names for distinct host ports", () => {
    const a = terminalCookieName(new URL("http://localhost:4712/"));
    const b = terminalCookieName(new URL("http://localhost:4713/"));
    expect(a).not.toBe(b);
  });
});

describe("formatTerminalCookie", () => {
  it("includes the Host-derived name, path, max-age, HttpOnly, SameSite=Strict", () => {
    const cookie = formatTerminalCookie("the-token", REQUEST_URL);
    expect(cookie).toContain(`${COOKIE_NAME}=the-token`);
    expect(cookie).toContain(`Max-Age=${TERMINAL_COOKIE_MAX_AGE}`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  it("does NOT set the Secure flag (would break http://localhost)", () => {
    const cookie = formatTerminalCookie("t", REQUEST_URL);
    expect(cookie).not.toContain("Secure");
  });

  it("URL-encodes the token value", () => {
    const cookie = formatTerminalCookie("a b/c=", REQUEST_URL);
    expect(cookie).toContain(`${COOKIE_NAME}=a%20b%2Fc%3D`);
  });

  it("names the cookie for the Host port, not any listen port", () => {
    const cookie = formatTerminalCookie("t", new URL("http://localhost:4712/api/auth"));
    expect(cookie).toContain(`${TERMINAL_COOKIE_PREFIX}_4712=t`);
  });
});

describe("readCookie", () => {
  it("returns the value for the requested name", () => {
    expect(readCookie(`${COOKIE_NAME}=hello`, COOKIE_NAME)).toBe("hello");
  });

  it("URL-decodes the value", () => {
    expect(readCookie(`${COOKIE_NAME}=a%20b%2Fc`, COOKIE_NAME)).toBe("a b/c");
  });

  it("returns the right cookie when multiple are present", () => {
    const header = `other=zzz; ${COOKIE_NAME}=token-here; another=yyy`;
    expect(readCookie(header, COOKIE_NAME)).toBe("token-here");
  });

  it("returns empty string when the cookie is missing", () => {
    expect(readCookie("other=zzz", COOKIE_NAME)).toBe("");
  });

  it("returns empty string for null header", () => {
    expect(readCookie(null, COOKIE_NAME)).toBe("");
  });

  it("does not match cookie names that share a prefix", () => {
    expect(readCookie(`${COOKIE_NAME}1=oops`, COOKIE_NAME)).toBe("");
  });

  it("does not read a sibling port's cookie", () => {
    const other = `${TERMINAL_COOKIE_PREFIX}_4713`;
    expect(readCookie(`${other}=other-port-token`, COOKIE_NAME)).toBe("");
  });
});

describe("isAllowedOrigin", () => {
  it("accepts http://127.0.0.1:<host-port>", () => {
    expect(isAllowedOrigin("http://127.0.0.1:4711", REQUEST_URL)).toBe(true);
  });

  it("accepts http://localhost:<host-port>", () => {
    expect(isAllowedOrigin("http://localhost:4711", REQUEST_URL)).toBe(true);
  });

  it("accepts a port-mapped origin: Host port wins over any listen port", () => {
    // Container listens on 4711, host publishes 4712 — the browser's Origin
    // and Host agree on 4712 and the gate must not care what the server
    // itself is bound to.
    const mapped = new URL("http://localhost:4712/api/terminal");
    expect(isAllowedOrigin("http://localhost:4712", mapped)).toBe(true);
  });

  it("rejects a page served from another localhost port", () => {
    // The rogue-localhost-page case: SameSite lets the cookie ride along
    // cross-port, so this rejection is the load-bearing defense.
    expect(isAllowedOrigin("http://localhost:9999", REQUEST_URL)).toBe(false);
  });

  it("rejects a DNS-rebinding origin even when its port matches Host", () => {
    const rebound = new URL("http://evil.example:4712/api/terminal");
    expect(isAllowedOrigin("http://evil.example:4712", rebound)).toBe(false);
  });

  it("rejects foreign hostname", () => {
    expect(isAllowedOrigin("http://attacker.example:4711", REQUEST_URL)).toBe(false);
  });

  it("rejects null / empty Origin (no header sent)", () => {
    expect(isAllowedOrigin(null, REQUEST_URL)).toBe(false);
    expect(isAllowedOrigin("", REQUEST_URL)).toBe(false);
  });

  it("rejects malformed Origin", () => {
    expect(isAllowedOrigin("not-a-url", REQUEST_URL)).toBe(false);
  });

  it("rejects non-http(s) schemes", () => {
    expect(isAllowedOrigin("file://127.0.0.1:4711", REQUEST_URL)).toBe(false);
    expect(isAllowedOrigin("ws://127.0.0.1:4711", REQUEST_URL)).toBe(false);
  });

  it("compares default ports after normalization", () => {
    // Origin "http://localhost" (implicit 80) against a Host of
    // localhost:80 — URL normalizes the explicit spelling away, so both
    // sides resolve to "80".
    expect(isAllowedOrigin("http://localhost", new URL("http://localhost/"))).toBe(true);
    expect(isAllowedOrigin("http://localhost", new URL("https://localhost/"))).toBe(false);
  });
});

describe("authProbeResponse", () => {
  const expected = "secret-token-value";
  const probe = (init: { cookie?: string; query?: string; origin?: string }): Response => {
    const url = new URL(`http://127.0.0.1:4711/api/auth${init.query ?? ""}`);
    const headers = new Headers();
    if (init.cookie !== undefined) headers.set("Cookie", init.cookie);
    if (init.origin !== undefined) headers.set("Origin", init.origin);
    return authProbeResponse(new Request(url, { headers }), url, expected);
  };

  it("returns 204 for a valid auth cookie", () => {
    const response = probe({
      cookie: `${COOKIE_NAME}=${encodeURIComponent(expected)}`,
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 204 for a valid ?t= query token", () => {
    const response = probe({ query: `?t=${encodeURIComponent(expected)}` });
    expect(response.status).toBe(204);
  });

  it("returns 401 with no credentials", () => {
    expect(probe({}).status).toBe(401);
  });

  it("returns 401 for a wrong cookie and wrong query token", () => {
    const wrongCookie = probe({ cookie: `${COOKIE_NAME}=nope` });
    expect(wrongCookie.status).toBe(401);
    const wrongQuery = probe({ query: "?t=nope" });
    expect(wrongQuery.status).toBe(401);
    expect(wrongQuery.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 403 for valid credentials with a rejected Origin header", () => {
    const response = probe({
      query: `?t=${encodeURIComponent(expected)}`,
      origin: "http://localhost:9999",
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 204 for valid credentials with a matching Origin header", () => {
    const response = probe({
      query: `?t=${encodeURIComponent(expected)}`,
      origin: "http://127.0.0.1:4711",
    });
    expect(response.status).toBe(204);
  });

  it("synthesizes the origin from Host when the header is absent (same-origin GET)", () => {
    // A same-origin fetch omits Origin; scheme+Host describes the page's
    // origin exactly, so the probe must answer 204, not 403.
    const response = probe({ query: `?t=${encodeURIComponent(expected)}` });
    expect(response.status).toBe(204);
  });

  it("prefers a rejected credentials verdict (401) over the origin verdict", () => {
    const response = probe({ origin: "http://localhost:9999" });
    expect(response.status).toBe(401);
  });

  it("ignores a legacy fixed-name cookie", () => {
    const response = probe({ cookie: `${TERMINAL_COOKIE_PREFIX}=${encodeURIComponent(expected)}` });
    expect(response.status).toBe(401);
  });
});
