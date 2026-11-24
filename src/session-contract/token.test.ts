import { describe, expect, it } from "bun:test";

import { mintSessionToken } from "./token";

// Tests the session token a workspace session mints when it assembles its
// server. The token gates `/api/terminal` upgrades and chat controls;
// uniqueness, length, and alphabet all matter for the threat model.

describe("mintSessionToken", () => {
  it("mints a non-empty token", () => {
    const token = mintSessionToken();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("mints distinct tokens across calls", () => {
    const a = mintSessionToken();
    const b = mintSessionToken();
    const c = mintSessionToken();
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });

  it("uses base64url-safe characters only", () => {
    expect(mintSessionToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("token length is at least 32 characters (32 random bytes, base64url)", () => {
    // 32 bytes → 43 base64url chars (no padding).
    expect(mintSessionToken().length).toBeGreaterThanOrEqual(32);
    expect(Buffer.from(mintSessionToken(), "base64url").byteLength).toBe(32);
  });
});
