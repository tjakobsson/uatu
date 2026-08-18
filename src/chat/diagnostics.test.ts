import { describe, expect, test } from "bun:test";

import { describeProbe, formatDiagnostics } from "./diagnostics";
import type { ChatAvailability, ChatStartupDiagnostics } from "./types";

function unavailable(diagnostics?: Partial<ChatStartupDiagnostics>): Extract<ChatAvailability, { state: "unavailable" }> {
  return {
    state: "unavailable",
    reason: "startup-failed",
    message: "OpenCode did not become ready. OpenCode never accepted a health request at http://127.0.0.1:41823 within 30000ms (connection refused).",
    diagnostics: diagnostics === undefined ? undefined : {
      executable: "/mnt/c/Users/x/AppData/Roaming/npm/opencode",
      shadowedExecutables: ["/home/linuxbrew/.linuxbrew/bin/opencode"],
      version: null,
      endpoint: "http://127.0.0.1:41823",
      elapsedMs: 30_000,
      probes: 97,
      lastProbe: { kind: "refused" },
      stdout: "opencode server listening on http://127.0.0.1:41823",
      stderr: "",
      ...diagnostics,
    },
  };
}

describe("startup diagnostics formatting", () => {
  test("renders a block that names its own cause", () => {
    const report = formatDiagnostics(unavailable({}));
    expect(report).toContain("/mnt/c/Users/x/AppData/Roaming/npm/opencode");
    expect(report).toContain("/home/linuxbrew/.linuxbrew/bin/opencode");
    expect(report).toContain("could not be determined");
    expect(report).toContain("http://127.0.0.1:41823");
    expect(report).toContain("30.0s, 97 probes");
    expect(report).toContain("connection refused");
    expect(report).toContain("listening on");
    expect(report).toContain("(empty)");
  });

  test("falls back to the message when there is nothing to report", () => {
    const availability = unavailable();
    expect(formatDiagnostics(availability)).toBe(availability.message);
  });

  test("singularizes a lone probe", () => {
    expect(formatDiagnostics(unavailable({ probes: 1 }))).toContain("30.0s, 1 probe");
  });

  test("distinguishes every probe outcome kind", () => {
    expect(describeProbe({ kind: "none" })).toBe("no probe completed");
    expect(describeProbe({ kind: "refused" })).toBe("connection refused");
    expect(describeProbe({ kind: "abandoned" })).toBe("connection accepted but never answered");
    expect(describeProbe({ kind: "http-status", status: 401 })).toBe("HTTP 401");
    expect(describeProbe({ kind: "unhealthy-body", status: 200 })).toContain("non-healthy body");
    expect(describeProbe({ kind: "healthy", status: 200 })).toContain("healthy");
    expect(describeProbe({ kind: "unknown", error: "boom" })).toBe("unrecognized failure: boom");
  });
});
