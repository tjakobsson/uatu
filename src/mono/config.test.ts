import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadMonoConfig } from "./config";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-mono-config-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

async function writeConfig(payload: unknown): Promise<void> {
  await fs.writeFile(path.join(workspace, ".uatu.json"), JSON.stringify(payload), "utf8");
}

describe("loadMonoConfig", () => {
  it("returns an empty config when no .uatu.json exists", async () => {
    const result = await loadMonoConfig(workspace);
    expect(result.config).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it("returns an empty config when .uatu.json has no mono block", async () => {
    await writeConfig({ review: { baseRef: "origin/main" } });
    const result = await loadMonoConfig(workspace);
    expect(result.config).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it("reads fontFamily when valid", async () => {
    await writeConfig({ mono: { fontFamily: "Berkeley Mono, monospace" } });
    const result = await loadMonoConfig(workspace);
    expect(result.config).toEqual({ fontFamily: "Berkeley Mono, monospace" });
    expect(result.warnings).toEqual([]);
  });

  it("trims whitespace on fontFamily", async () => {
    await writeConfig({ mono: { fontFamily: "   JetBrains Mono   " } });
    const result = await loadMonoConfig(workspace);
    expect(result.config.fontFamily).toBe("JetBrains Mono");
  });

  it("rejects an empty fontFamily and warns", async () => {
    await writeConfig({ mono: { fontFamily: "   " } });
    const result = await loadMonoConfig(workspace);
    expect(result.config.fontFamily).toBeUndefined();
    expect(result.warnings).toContain("Ignored mono.fontFamily because it must be a non-empty string.");
  });

  it("rejects a non-string fontFamily and warns", async () => {
    await writeConfig({ mono: { fontFamily: 42 } });
    const result = await loadMonoConfig(workspace);
    expect(result.config.fontFamily).toBeUndefined();
    expect(result.warnings.length).toBe(1);
  });

  it("ignores unrelated keys in the mono block", async () => {
    await writeConfig({ mono: { fontFamily: "Hack Nerd Font Mono", fontSize: 14 } });
    const result = await loadMonoConfig(workspace);
    expect(result.config.fontFamily).toBe("Hack Nerd Font Mono");
    expect(result.warnings).toEqual([]);
  });

  it("does not throw on malformed JSON", async () => {
    await fs.writeFile(path.join(workspace, ".uatu.json"), "{ not-json", "utf8");
    const result = await loadMonoConfig(workspace);
    expect(result.config).toEqual({});
    // Parse warning is owned by review-load.ts — mono-config stays quiet.
    expect(result.warnings).toEqual([]);
  });
});
