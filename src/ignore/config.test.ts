import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_IGNORE_CONFIG, loadIgnoreConfig } from "./config";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-ignore-config-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

async function writeConfig(payload: unknown): Promise<void> {
  await fs.writeFile(path.join(workspace, ".uatu.json"), JSON.stringify(payload), "utf8");
}

describe("loadIgnoreConfig", () => {
  it("returns the default config when no .uatu.json exists", async () => {
    const result = await loadIgnoreConfig(workspace);
    expect(result.config.exclude).toEqual([]);
    expect(result.config.respectGitignore).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("returns the default config when .uatu.json has no ignore block", async () => {
    await writeConfig({ terminal: { fontSize: 14 } });
    const result = await loadIgnoreConfig(workspace);
    expect(result.config.exclude).toEqual([]);
    expect(result.config.respectGitignore).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("reads ignore.exclude when it is a valid string array", async () => {
    await writeConfig({ ignore: { exclude: ["bun.lock", "*.log", "!debug.log"] } });
    const result = await loadIgnoreConfig(workspace);
    expect(result.config.exclude).toEqual(["bun.lock", "*.log", "!debug.log"]);
    expect(result.warnings).toEqual([]);
  });

  it("trims whitespace and drops empty entries from ignore.exclude", async () => {
    await writeConfig({ ignore: { exclude: ["  bun.lock  ", "", "   ", "*.log"] } });
    const result = await loadIgnoreConfig(workspace);
    expect(result.config.exclude).toEqual(["bun.lock", "*.log"]);
  });

  it("warns and falls back when ignore.exclude is not a string array", async () => {
    await writeConfig({ ignore: { exclude: "bun.lock" } });
    const result = await loadIgnoreConfig(workspace);
    expect(result.config.exclude).toEqual([]);
    expect(result.warnings).toContain(
      "Ignored .uatu.json ignore.exclude because it must be a string array.",
    );
  });

  it("warns and falls back when ignore.exclude has a non-string entry", async () => {
    await writeConfig({ ignore: { exclude: ["bun.lock", 42] } });
    const result = await loadIgnoreConfig(workspace);
    expect(result.config.exclude).toEqual([]);
    expect(result.warnings.length).toBe(1);
  });

  it("reads ignore.respectGitignore: false when valid", async () => {
    await writeConfig({ ignore: { respectGitignore: false } });
    const result = await loadIgnoreConfig(workspace);
    expect(result.config.respectGitignore).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("warns and falls back to true when ignore.respectGitignore is not a boolean", async () => {
    await writeConfig({ ignore: { respectGitignore: "true" } });
    const result = await loadIgnoreConfig(workspace);
    expect(result.config.respectGitignore).toBe(true);
    expect(result.warnings).toContain(
      "Ignored .uatu.json ignore.respectGitignore because it must be a boolean.",
    );
  });

  it("warns when ignore is not an object", async () => {
    await writeConfig({ ignore: "exclude-everything" });
    const result = await loadIgnoreConfig(workspace);
    expect(result.config.exclude).toEqual([]);
    expect(result.warnings).toContain("Ignored .uatu.json ignore because it must be an object.");
  });

  it("warns on a malformed .uatu.json and falls back to defaults", async () => {
    await fs.writeFile(path.join(workspace, ".uatu.json"), "{not json", "utf8");
    const result = await loadIgnoreConfig(workspace);
    expect(result.config.exclude).toEqual([]);
    expect(result.config.respectGitignore).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Invalid .uatu.json");
  });

  it("warns on an empty .uatu.json", async () => {
    await fs.writeFile(path.join(workspace, ".uatu.json"), "", "utf8");
    const result = await loadIgnoreConfig(workspace);
    expect(result.config.exclude).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Invalid .uatu.json");
  });

  it("warns on a whitespace-only .uatu.json", async () => {
    await fs.writeFile(path.join(workspace, ".uatu.json"), "  \n\t\n", "utf8");
    const result = await loadIgnoreConfig(workspace);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Invalid .uatu.json");
  });

  it("picks up mid-session edits on the next read", async () => {
    await writeConfig({ ignore: { exclude: ["a.log"] } });
    const first = await loadIgnoreConfig(workspace);
    expect(first.config.exclude).toEqual(["a.log"]);

    await writeConfig({ ignore: { exclude: ["a.log", "b.log"] } });
    const second = await loadIgnoreConfig(workspace);
    expect(second.config.exclude).toEqual(["a.log", "b.log"]);
  });

  it("does not read a legacy tree block", async () => {
    await writeConfig({ tree: { exclude: ["bun.lock"], respectGitignore: false } });
    const result = await loadIgnoreConfig(workspace);
    expect(result.config.exclude).toEqual([]);
    expect(result.config.respectGitignore).toBe(true);
    // Unknown keys are silently unread — no warning machinery for the rename.
    expect(result.warnings).toEqual([]);
  });

  it("freezes the default config so callers cannot mutate it", () => {
    expect(Object.isFrozen(DEFAULT_IGNORE_CONFIG)).toBe(true);
  });
});
