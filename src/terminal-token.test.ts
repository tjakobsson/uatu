import { describe, expect, it } from "bun:test";

import { createWatchSession } from "./server";

// Tests the per-session token minted in `createWatchSession`. The token
// gates `/api/terminal` upgrades; uniqueness, length, and stability across
// the lifetime of a session all matter for the threat model.

describe("createWatchSession terminal token", () => {
  it("mints a non-empty token for every session", () => {
    const session = createWatchSession([], false, { terminalEnabled: true });
    expect(typeof session.getTerminalToken()).toBe("string");
    expect(session.getTerminalToken().length).toBeGreaterThan(0);
  });

  it("mints distinct tokens across sessions", () => {
    const a = createWatchSession([], false, { terminalEnabled: true }).getTerminalToken();
    const b = createWatchSession([], false, { terminalEnabled: true }).getTerminalToken();
    const c = createWatchSession([], false, { terminalEnabled: true }).getTerminalToken();
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });

  it("returns the same token across multiple calls within one session", () => {
    const session = createWatchSession([], false, { terminalEnabled: true });
    expect(session.getTerminalToken()).toBe(session.getTerminalToken());
  });

  it("uses base64url-safe characters only", () => {
    const session = createWatchSession([], false, { terminalEnabled: true });
    expect(session.getTerminalToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("mints a token even when the terminal feature is disabled", () => {
    // The token isn't surfaced to clients in this case (no `?t=` in URL,
    // /api/state.terminal === "disabled"), but minting it unconditionally
    // keeps the createWatchSession shape stable and lets other consumers
    // not gate on terminalEnabled.
    const session = createWatchSession([], false, { terminalEnabled: false });
    expect(typeof session.getTerminalToken()).toBe("string");
    expect(session.getTerminalToken().length).toBeGreaterThan(0);
  });

  it("token length is at least 32 characters (32 random bytes, base64url)", () => {
    const session = createWatchSession([], false, { terminalEnabled: true });
    // 32 bytes → 43 base64url chars (no padding).
    expect(session.getTerminalToken().length).toBeGreaterThanOrEqual(32);
  });
});
