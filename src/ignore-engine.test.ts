import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadIgnoreMatcher } from "./ignore-engine";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-ignore-"));
  tempDirectories.push(dir);
  return dir;
}

async function writeUatuConfig(rootPath: string, payload: unknown): Promise<void> {
  await writeFile(path.join(rootPath, ".uatu.json"), JSON.stringify(payload), "utf8");
}

describe("loadIgnoreMatcher", () => {
  test("built-in defaults always hide node_modules", async () => {
    const rootPath = await makeTempDir();
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: false });
    expect(matcher.shouldIgnore("node_modules/foo.js")).toBe(true);
    expect(matcher.shouldIgnore("dist/bundle.js")).toBe(true);
    expect(matcher.shouldIgnore("README.md")).toBe(false);
  });

  test(".uatu.json tree.exclude patterns hide matching files", async () => {
    const rootPath = await makeTempDir();
    await writeUatuConfig(rootPath, { tree: { exclude: ["*.lock"] } });
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: false });
    expect(matcher.shouldIgnore("bun.lock")).toBe(true);
    expect(matcher.shouldIgnore("README.md")).toBe(false);
  });

  test(".gitignore patterns hide files when respectGitignore is true", async () => {
    const rootPath = await makeTempDir();
    await writeFile(path.join(rootPath, ".gitignore"), "*.log\n");
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: true });
    expect(matcher.shouldIgnore("debug.log")).toBe(true);
    expect(matcher.shouldIgnore("README.md")).toBe(false);
  });

  test("CLI --no-gitignore (respectGitignore: false) wins over .uatu.json tree.respectGitignore: true", async () => {
    const rootPath = await makeTempDir();
    await writeFile(path.join(rootPath, ".gitignore"), "*.log\n");
    await writeUatuConfig(rootPath, { tree: { respectGitignore: true } });
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: false });
    expect(matcher.shouldIgnore("debug.log")).toBe(false);
  });

  test(".uatu.json tree.respectGitignore: false disables .gitignore when CLI is permissive", async () => {
    const rootPath = await makeTempDir();
    await writeFile(path.join(rootPath, ".gitignore"), "*.log\n");
    await writeUatuConfig(rootPath, { tree: { respectGitignore: false } });
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: true });
    expect(matcher.shouldIgnore("debug.log")).toBe(false);
    // Built-in defaults still apply.
    expect(matcher.shouldIgnore("node_modules/foo.js")).toBe(true);
  });

  test(".uatu.json tree.exclude negation un-excludes something .gitignore excluded", async () => {
    const rootPath = await makeTempDir();
    await writeFile(path.join(rootPath, ".gitignore"), "*.log\n");
    await writeUatuConfig(rootPath, { tree: { exclude: ["!debug.log"] } });
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: true });
    expect(matcher.shouldIgnore("debug.log")).toBe(false);
    expect(matcher.shouldIgnore("error.log")).toBe(true);
  });

  test(".uatuignore is no longer honored", async () => {
    const rootPath = await makeTempDir();
    await writeFile(path.join(rootPath, ".uatuignore"), "*.lock\n");
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: false });
    expect(matcher.shouldIgnore("bun.lock")).toBe(false);
  });

  test("missing .gitignore and .uatu.json do not throw and only defaults apply", async () => {
    const rootPath = await makeTempDir();
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: true });
    expect(matcher.shouldIgnore("README.md")).toBe(false);
    expect(matcher.shouldIgnore("node_modules/anything")).toBe(true);
  });

  test("isSingleFileRoot skips .gitignore AND .uatu.json (defaults still apply)", async () => {
    const rootPath = await makeTempDir();
    await writeFile(path.join(rootPath, ".gitignore"), "secret.md\n");
    await writeUatuConfig(rootPath, { tree: { exclude: ["*.log"] } });
    const matcher = await loadIgnoreMatcher({
      rootPath,
      respectGitignore: true,
      isSingleFileRoot: true,
    });
    expect(matcher.shouldIgnore("secret.md")).toBe(false);
    expect(matcher.shouldIgnore("debug.log")).toBe(false);
    // Defaults still apply, even on single-file roots.
    expect(matcher.shouldIgnore("node_modules/foo.js")).toBe(true);
  });

  test("toChokidarIgnored converts absolute paths and never ignores the watched root itself", async () => {
    const rootPath = await makeTempDir();
    await writeUatuConfig(rootPath, { tree: { exclude: ["*.log"] } });
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: false });
    const ignored = matcher.toChokidarIgnored();
    expect(ignored(rootPath)).toBe(false);
    expect(ignored(path.join(rootPath, "debug.log"))).toBe(true);
    expect(ignored(path.join(rootPath, "README.md"))).toBe(false);
    // Outside the root: never ignore (not the matcher's responsibility).
    expect(ignored("/var/elsewhere/foo.log")).toBe(false);
  });

  test("toChokidarIgnored normalizes platform path separators to forward slashes", async () => {
    const rootPath = await makeTempDir();
    await writeUatuConfig(rootPath, { tree: { exclude: ["nested/secret.txt"] } });
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: false });
    const ignored = matcher.toChokidarIgnored();
    // Constructing the path with the platform separator should still match the
    // forward-slash pattern after normalization.
    const nestedSecret = path.join(rootPath, "nested", "secret.txt");
    expect(ignored(nestedSecret)).toBe(true);
    const nestedOther = path.join(rootPath, "nested", "other.txt");
    expect(ignored(nestedOther)).toBe(false);
  });

  test("malformed .uatu.json falls back to defaults silently (review-load owns parse warnings)", async () => {
    const rootPath = await makeTempDir();
    await writeFile(path.join(rootPath, ".uatu.json"), "{not json", "utf8");
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: false });
    expect(matcher.shouldIgnore("README.md")).toBe(false);
    expect(matcher.shouldIgnore("node_modules/anything")).toBe(true);
  });
});
