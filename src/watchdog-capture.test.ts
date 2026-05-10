import { describe, expect, test } from "bun:test";

import { captureFds, captureStack } from "./watchdog-capture";

const platform = process.platform;

// `sample <pid> 5` runs for 5 seconds by design, plus our 10s capture cap
// allows it to finish — but the test must wait longer than that.
const DARWIN_SAMPLE_TIMEOUT_MS = 20_000;

describe("captureStack platform adapter", () => {
  test.if(platform === "darwin")(
    "darwin returns sample output for the current pid",
    async () => {
      const result = await captureStack(process.pid);
      expect(result.contents.length).toBeGreaterThan(0);
    },
    DARWIN_SAMPLE_TIMEOUT_MS,
  );

  test.if(platform === "linux")("linux reads /proc/<pid>/stack family for the current pid", async () => {
    const result = await captureStack(process.pid);
    expect(result.contents).toContain(`/proc/${process.pid}/`);
  });

  test("win32 writes a not-implemented sentinel", async () => {
    const result = await captureStack(1, "win32");
    expect(result.partial).toBe(true);
    expect(result.contents).toContain("not implemented on win32");
  });
});

describe("captureFds platform adapter", () => {
  test.if(platform === "darwin")("darwin returns lsof output for the current pid", async () => {
    const result = await captureFds(process.pid);
    expect(result.contents.length).toBeGreaterThan(0);
  });

  test.if(platform === "linux")("linux lists /proc/<pid>/fd entries", async () => {
    const result = await captureFds(process.pid);
    expect(result.contents).toContain(`fds for pid ${process.pid}`);
  });

  test("win32 writes a not-implemented sentinel", async () => {
    const result = await captureFds(1, "win32");
    expect(result.partial).toBe(true);
    expect(result.contents).toContain("not implemented on win32");
  });
});
