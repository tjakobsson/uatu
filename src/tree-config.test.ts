import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_TREE_CONFIG, loadTreeConfig } from "./tree-config";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "uatu-tree-config-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

async function writeConfig(payload: unknown): Promise<void> {
  await fs.writeFile(path.join(workspace, ".uatu.json"), JSON.stringify(payload), "utf8");
}

describe("loadTreeConfig", () => {
  it("returns the default config when no .uatu.json exists", async () => {
    const result = await loadTreeConfig(workspace);
    expect(result.config.exclude).toEqual([]);
    expect(result.config.respectGitignore).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("returns the default config when .uatu.json has no tree block", async () => {
    await writeConfig({ terminal: { fontSize: 14 } });
    const result = await loadTreeConfig(workspace);
    expect(result.config.exclude).toEqual([]);
    expect(result.config.respectGitignore).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("reads tree.exclude when it is a valid string array", async () => {
    await writeConfig({ tree: { exclude: ["bun.lock", "*.log", "!debug.log"] } });
    const result = await loadTreeConfig(workspace);
    expect(result.config.exclude).toEqual(["bun.lock", "*.log", "!debug.log"]);
    expect(result.warnings).toEqual([]);
  });

  it("trims whitespace and drops empty entries from tree.exclude", async () => {
    await writeConfig({ tree: { exclude: ["  bun.lock  ", "", "   ", "*.log"] } });
    const result = await loadTreeConfig(workspace);
    expect(result.config.exclude).toEqual(["bun.lock", "*.log"]);
  });

  it("warns and falls back when tree.exclude is not a string array", async () => {
    await writeConfig({ tree: { exclude: "bun.lock" } });
    const result = await loadTreeConfig(workspace);
    expect(result.config.exclude).toEqual([]);
    expect(result.warnings).toContain(
      "Ignored .uatu.json tree.exclude because it must be a string array.",
    );
  });

  it("warns and falls back when tree.exclude has a non-string entry", async () => {
    await writeConfig({ tree: { exclude: ["bun.lock", 42] } });
    const result = await loadTreeConfig(workspace);
    expect(result.config.exclude).toEqual([]);
    expect(result.warnings.length).toBe(1);
  });

  it("reads tree.respectGitignore: false when valid", async () => {
    await writeConfig({ tree: { respectGitignore: false } });
    const result = await loadTreeConfig(workspace);
    expect(result.config.respectGitignore).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("warns and falls back to true when tree.respectGitignore is not a boolean", async () => {
    await writeConfig({ tree: { respectGitignore: "true" } });
    const result = await loadTreeConfig(workspace);
    expect(result.config.respectGitignore).toBe(true);
    expect(result.warnings).toContain(
      "Ignored .uatu.json tree.respectGitignore because it must be a boolean.",
    );
  });

  it("warns when tree is not an object", async () => {
    await writeConfig({ tree: "exclude-everything" });
    const result = await loadTreeConfig(workspace);
    expect(result.config.exclude).toEqual([]);
    expect(result.warnings).toContain("Ignored .uatu.json tree because it must be an object.");
  });

  it("silently ignores a malformed .uatu.json", async () => {
    await fs.writeFile(path.join(workspace, ".uatu.json"), "{not json", "utf8");
    const result = await loadTreeConfig(workspace);
    expect(result.config.exclude).toEqual([]);
    expect(result.config.respectGitignore).toBe(true);
    // review-load.ts owns the parse-error warning; this module must not double-warn.
    expect(result.warnings).toEqual([]);
  });

  it("picks up mid-session edits on the next read", async () => {
    await writeConfig({ tree: { exclude: ["a.log"] } });
    const first = await loadTreeConfig(workspace);
    expect(first.config.exclude).toEqual(["a.log"]);

    await writeConfig({ tree: { exclude: ["a.log", "b.log"] } });
    const second = await loadTreeConfig(workspace);
    expect(second.config.exclude).toEqual(["a.log", "b.log"]);
  });

  it("freezes the default config so callers cannot mutate it", () => {
    expect(Object.isFrozen(DEFAULT_TREE_CONFIG)).toBe(true);
  });
});
