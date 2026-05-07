import { describe, expect, it } from "bun:test";

import {
  TERMINAL_COOKIE_MAX_AGE,
  TERMINAL_COOKIE_NAME,
  constantTimeEqual,
  formatTerminalCookie,
  isAllowedOrigin,
  readCookie,
} from "./terminal-auth";

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

describe("formatTerminalCookie", () => {
  it("includes name, path, max-age, HttpOnly, SameSite=Strict", () => {
    const cookie = formatTerminalCookie("the-token");
    expect(cookie).toContain(`${TERMINAL_COOKIE_NAME}=the-token`);
    expect(cookie).toContain(`Max-Age=${TERMINAL_COOKIE_MAX_AGE}`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  it("does NOT set the Secure flag (would break http://localhost)", () => {
    const cookie = formatTerminalCookie("t");
    expect(cookie).not.toContain("Secure");
  });

  it("URL-encodes the token value", () => {
    const cookie = formatTerminalCookie("a b/c=");
    expect(cookie).toContain(`${TERMINAL_COOKIE_NAME}=a%20b%2Fc%3D`);
  });
});

describe("readCookie", () => {
  it("returns the value for the requested name", () => {
    expect(readCookie(`${TERMINAL_COOKIE_NAME}=hello`, TERMINAL_COOKIE_NAME)).toBe("hello");
  });

  it("URL-decodes the value", () => {
    expect(readCookie(`${TERMINAL_COOKIE_NAME}=a%20b%2Fc`, TERMINAL_COOKIE_NAME)).toBe("a b/c");
  });

  it("returns the right cookie when multiple are present", () => {
    const header = `other=zzz; ${TERMINAL_COOKIE_NAME}=token-here; another=yyy`;
    expect(readCookie(header, TERMINAL_COOKIE_NAME)).toBe("token-here");
  });

  it("returns empty string when the cookie is missing", () => {
    expect(readCookie("other=zzz", TERMINAL_COOKIE_NAME)).toBe("");
  });

  it("returns empty string for null header", () => {
    expect(readCookie(null, TERMINAL_COOKIE_NAME)).toBe("");
  });

  it("does not match cookie names that share a prefix", () => {
    expect(readCookie("uatu_terminal=oops", TERMINAL_COOKIE_NAME)).toBe("");
  });
});

describe("isAllowedOrigin", () => {
  const srv = { hostname: "127.0.0.1", port: 4711 };

  it("accepts http://127.0.0.1:<port>", () => {
    expect(isAllowedOrigin("http://127.0.0.1:4711", srv)).toBe(true);
  });

  it("accepts http://localhost:<port>", () => {
    expect(isAllowedOrigin("http://localhost:4711", srv)).toBe(true);
  });

  it("rejects mismatched port", () => {
    expect(isAllowedOrigin("http://127.0.0.1:9999", srv)).toBe(false);
  });

  it("rejects foreign hostname", () => {
    expect(isAllowedOrigin("http://attacker.example:4711", srv)).toBe(false);
  });

  it("rejects null / empty Origin (no header sent)", () => {
    expect(isAllowedOrigin(null, srv)).toBe(false);
    expect(isAllowedOrigin("", srv)).toBe(false);
  });

  it("rejects malformed Origin", () => {
    expect(isAllowedOrigin("not-a-url", srv)).toBe(false);
  });

  it("rejects non-http(s) schemes", () => {
    expect(isAllowedOrigin("file://127.0.0.1:4711", srv)).toBe(false);
    expect(isAllowedOrigin("ws://127.0.0.1:4711", srv)).toBe(false);
  });
});
