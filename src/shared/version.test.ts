import { describe, expect, test } from "bun:test";

import { formatBuildIdentifier, type BuildInfo } from "./version";

function makeBuild(overrides: Partial<BuildInfo>): BuildInfo {
  return {
    version: "0.1.0",
    branch: "main",
    commitSha: "6fa9c10abcdef",
    commitShort: "6fa9c10",
    buildTime: "2026-04-22T00:00:00Z",
    release: false,
    ...overrides,
  };
}

describe("formatBuildIdentifier", () => {
  test("release build shows version and short sha", () => {
    const build = makeBuild({ release: true });
    expect(formatBuildIdentifier(build)).toBe("v0.1.0 · 6fa9c10");
  });

  test("dev build shows branch and short sha", () => {
    const build = makeBuild({ branch: "main" });
    expect(formatBuildIdentifier(build)).toBe("main@6fa9c10");
  });

  test("dev build without git falls back to branch@unknown", () => {
    const build = makeBuild({ commitSha: "unknown", commitShort: "unknown" });
    expect(formatBuildIdentifier(build)).toBe("main@unknown");
  });
});
