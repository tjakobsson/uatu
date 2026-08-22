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

  it("rejects a prerelease of the minimum version", () => {
    // 1.3.5-canary.1 sorts below 1.3.5 and may predate the PTY work, so
    // parseInt-style truncation to "5" would wrongly advertise the terminal.
    const result = supportsBunTerminal("1.3.5-canary.1");
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toContain("1.3.5");
  });

  it.each([
    ["1.4.0-canary.1", true],
    ["2.0.0-rc.1", true],
    ["1.3.4-canary.1", false],
    ["1.3.5+build.7", true],
  ])("applies semver precedence to %s", (version, expected) => {
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
