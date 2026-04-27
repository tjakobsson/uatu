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

describe("loadIgnoreMatcher", () => {
  test(".uatuignore patterns hide matching files", async () => {
    const rootPath = await makeTempDir();
    await writeFile(path.join(rootPath, ".uatuignore"), "*.lock\n");
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

  test(".gitignore is skipped when respectGitignore is false", async () => {
    const rootPath = await makeTempDir();
    await writeFile(path.join(rootPath, ".gitignore"), "*.log\n");
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: false });
    expect(matcher.shouldIgnore("debug.log")).toBe(false);
  });

  test(".uatuignore negation un-ignores something .gitignore excluded", async () => {
    const rootPath = await makeTempDir();
    await writeFile(path.join(rootPath, ".gitignore"), "*.log\n");
    await writeFile(path.join(rootPath, ".uatuignore"), "!debug.log\n");
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: true });
    expect(matcher.shouldIgnore("debug.log")).toBe(false);
    expect(matcher.shouldIgnore("error.log")).toBe(true);
  });

  test("missing .uatuignore and .gitignore do not throw", async () => {
    const rootPath = await makeTempDir();
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: true });
    expect(matcher.shouldIgnore("anything.md")).toBe(false);
  });

  test("isSingleFileRoot skips both ignore files", async () => {
    const rootPath = await makeTempDir();
    await writeFile(path.join(rootPath, ".gitignore"), "secret.md\n");
    await writeFile(path.join(rootPath, ".uatuignore"), "*.log\n");
    const matcher = await loadIgnoreMatcher({
      rootPath,
      respectGitignore: true,
      isSingleFileRoot: true,
    });
    expect(matcher.shouldIgnore("secret.md")).toBe(false);
    expect(matcher.shouldIgnore("debug.log")).toBe(false);
  });

  test("toChokidarIgnored converts absolute paths and never ignores the watched root itself", async () => {
    const rootPath = await makeTempDir();
    await writeFile(path.join(rootPath, ".uatuignore"), "*.log\n");
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: false });
    const ignored = matcher.toChokidarIgnored();
    expect(ignored(rootPath)).toBe(false);
    expect(ignored(path.join(rootPath, "debug.log"))).toBe(true);
    expect(ignored(path.join(rootPath, "README.md"))).toBe(false);
    // Outside the root: never ignore (not the matcher's responsibility).
    expect(ignored("/var/elsewhere/foo.log")).toBe(false);
  });
});
