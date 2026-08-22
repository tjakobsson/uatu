import { describe, expect, it } from "bun:test";

import { resolveTerminalBackend, supportsBunTerminal, terminalBackendAvailable } from "./backend";

describe("terminalBackendAvailable", () => {
  it("resolves to true on this platform (Bun on POSIX)", async () => {
    // The backend is Bun's own `Bun.spawn(..., { terminal })`, available on
    // macOS and Linux on Bun >= 1.3.5. The test suite runs under Bun so this
    // should hold; if it ever fails on a supported platform, check the Bun
    // version against MINIMUM_BUN_TERMINAL_VERSION.
    expect(await terminalBackendAvailable()).toBe(true);
  });

  it("returns the same cached result across calls", async () => {
    const a = await resolveTerminalBackend();
    const b = await resolveTerminalBackend();
    expect(a).toBe(b);
  });

  it("exposes a spawn() function when available", async () => {
    const result = await resolveTerminalBackend();
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(typeof result.spawn).toBe("function");
  });
});

describe("supportsBunTerminal", () => {
  // Availability is decided by version comparison rather than by spawning a
  // probe child. The old probe deadlocked boot on a macOS CI runner under Bun
  // 1.4.0, so these boundaries are the whole contract now.
  it("accepts the first version that honours the terminal option", () => {
    expect(supportsBunTerminal("1.3.5").available).toBe(true);
  });

  it("rejects the version just below it", () => {
    expect(supportsBunTerminal("1.3.4").available).toBe(false);
  });

  it.each([
    ["1.4.0", true],
    ["1.10.0", true],
    ["2.0.0", true],
    ["1.2.99", false],
    ["0.9.9", false],
  ])("resolves %s to available=%s", (version, expected) => {
    expect(supportsBunTerminal(version as string).available).toBe(expected);
  });

  it("fails closed on an unparseable version", () => {
    const result = supportsBunTerminal("not-a-version");
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toContain("unrecognized");
  });

  it("explains why an old Bun is rejected", () => {
    const result = supportsBunTerminal("1.3.0");
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toContain("1.3.5");
  });
});
