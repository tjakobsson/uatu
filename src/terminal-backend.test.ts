import { describe, expect, it } from "bun:test";

import { resolveTerminalBackend, terminalBackendAvailable } from "./terminal-backend";

describe("terminalBackendAvailable", () => {
  it("resolves to true on this platform (Bun on POSIX)", async () => {
    // The backend is Bun's own `Bun.spawn(..., { terminal })`, available on
    // macOS and Linux on Bun ≥ 1.3.5. The test suite runs under Bun so this
    // should hold; if it ever fails on a supported platform, double-check
    // the Bun version and that the probe in `terminal-backend.ts` doesn't
    // need its watchdog deadline tweaked.
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
