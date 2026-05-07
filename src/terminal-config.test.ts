import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadTerminalConfig } from "./terminal-config";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-terminal-config-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

async function writeConfig(payload: unknown): Promise<void> {
  await fs.writeFile(path.join(workspace, ".uatu.json"), JSON.stringify(payload), "utf8");
}

describe("loadTerminalConfig", () => {
  it("returns an empty config when no .uatu.json exists", async () => {
    const result = await loadTerminalConfig(workspace);
    expect(result.config).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it("returns an empty config when .uatu.json has no terminal block", async () => {
    await writeConfig({ review: { baseRef: "origin/main" } });
    const result = await loadTerminalConfig(workspace);
    expect(result.config).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it("reads fontFamily and fontSize when valid", async () => {
    await writeConfig({ terminal: { fontFamily: "Berkeley Mono, monospace", fontSize: 14 } });
    const result = await loadTerminalConfig(workspace);
    expect(result.config).toEqual({ fontFamily: "Berkeley Mono, monospace", fontSize: 14 });
    expect(result.warnings).toEqual([]);
  });

  it("trims whitespace on fontFamily", async () => {
    await writeConfig({ terminal: { fontFamily: "   FiraCode Nerd Font Mono   " } });
    const result = await loadTerminalConfig(workspace);
    expect(result.config.fontFamily).toBe("FiraCode Nerd Font Mono");
  });

  it("rejects an empty fontFamily and warns", async () => {
    await writeConfig({ terminal: { fontFamily: "   " } });
    const result = await loadTerminalConfig(workspace);
    expect(result.config.fontFamily).toBeUndefined();
    expect(result.warnings).toContain("Ignored terminal.fontFamily because it must be a non-empty string.");
  });

  it("rejects a non-string fontFamily and warns", async () => {
    await writeConfig({ terminal: { fontFamily: 42 } });
    const result = await loadTerminalConfig(workspace);
    expect(result.config.fontFamily).toBeUndefined();
    expect(result.warnings.length).toBe(1);
  });

  it("rejects an out-of-range fontSize and warns", async () => {
    await writeConfig({ terminal: { fontSize: 999 } });
    const result = await loadTerminalConfig(workspace);
    expect(result.config.fontSize).toBeUndefined();
    expect(result.warnings.length).toBe(1);
  });

  it("rejects a NaN fontSize and warns", async () => {
    await writeConfig({ terminal: { fontSize: "fourteen" } });
    const result = await loadTerminalConfig(workspace);
    expect(result.config.fontSize).toBeUndefined();
    expect(result.warnings.length).toBe(1);
  });

  it("ignores unrelated keys in the terminal block", async () => {
    await writeConfig({ terminal: { fontFamily: "Hack Nerd Font Mono", colorMode: "weird" } });
    const result = await loadTerminalConfig(workspace);
    expect(result.config.fontFamily).toBe("Hack Nerd Font Mono");
    expect(result.warnings).toEqual([]);
  });

  it("does not throw on malformed JSON", async () => {
    await fs.writeFile(path.join(workspace, ".uatu.json"), "{ not-json", "utf8");
    const result = await loadTerminalConfig(workspace);
    expect(result.config).toEqual({});
    // Parse warning is owned by review-load.ts — terminal-config stays quiet.
    expect(result.warnings).toEqual([]);
  });
});
